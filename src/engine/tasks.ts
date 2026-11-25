import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentArgs, type Role } from '../agents/adapters.ts'
import * as names from '../agents/names.ts'
import { fill, mainRef, type ProjectConfig } from '../config/project.ts'
import { markDone, release, releaseTab, slot } from '../herdr/layout.ts'
import { nextTaskPhase, type LoopEvent } from '../mission/loop.ts'
import { proposalHash, proposedPlanPath, proposedSpecPath, readProposal, type Proposal } from '../mission/amendment.ts'
import { checkAmendment, parsePlan, type PlanTask } from '../mission/plan.ts'
import { freshLoops, saveState, type Gate, type MissionState, type PendingAsk, type Step, type TaskState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { render } from '../prompts/render.ts'
import type { Effects } from './effects.ts'
import { block, commitIfChanged, goto, informOrchestrator, log, notify, type StepResult } from './engine.ts'
import { openGate } from './gates.ts'

/** How long to wait for an agent on one brief: a task (TDD, tests, commit) can take a long time. */
export const ASK_TIMEOUT_MS: Record<Role, number> = { implementer: 4 * 3_600_000, reviewer: 2 * 3_600_000, diagnostic: 2 * 3_600_000, orchestrator: 3_600_000 }

/** Shared forbidden items (global constraints). */
const GENERATED_FILES = 'editing generated project files'
const GLOBAL_FORBIDDEN = [
  '`git push`',
  '`git stash`',
  '`--no-verify`',
  'changing branch',
  '`rebase`',
  '`reset --hard`',
  'leaving the worktree',
  GENERATED_FILES,
  '`docker compose`',
  '`--author`',
  '`git -c user.*`',
  '`GIT_AUTHOR_*` / `GIT_COMMITTER_*`',
  '`git config`',
]

const ACTIVE_STEPS_AFTER_TASKS: Step[] = ['global-review', 'preflight', 'pr']

export const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

export const taskDir = (s: MissionState, t: TaskState): string => join(missionDir(s.id), 'tasks', String(t.n))
const implName = (s: MissionState, t: TaskState): string => names.implName(s.id, t.n)
const strongName = (s: MissionState, t: TaskState): string => names.strongName(s.id, t.n)
const reviewerName = (s: MissionState, t: TaskState): string => names.reviewerName(s.id, t.n)

export function forbidden(cfg: ProjectConfig): string {
  const strip = (x: string) => x.replace(/`/g, '')
  const items = [...cfg.forbiddenCommands.map((c) => `\`${c}\``), ...GLOBAL_FORBIDDEN]
  const seen = new Set<string>()
  const lines: string[] = []
  for (const it of items) {
    if (seen.has(strip(it))) continue
    seen.add(strip(it))
    const generated = it === GENERATED_FILES && cfg.forbiddenPaths.length > 0
    lines.push(`- ${generated ? `${it} (${cfg.forbiddenPaths.map((p) => `\`${p}\``).join(', ')})` : it}`)
  }
  return lines.join('\n')
}

async function approvedPlan(s: MissionState): Promise<PlanTask[]> {
  const parsed = parsePlan(await readFile(join(missionDir(s.id), 'plan.approved.md'), 'utf8'))
  if (!parsed.ok) throw new Error(`invalid plan.approved.md: ${parsed.errors.join('; ')}`)
  return parsed.tasks
}

/** Body of a review report without its verdict line. */
export async function findingsOf(path: string | undefined): Promise<string> {
  if (!path) return '(none)'
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.split('\n').slice(1).join('\n').trim() || '(none)'
}

// Second alternative: the 0.8 wording. Escaped so the English guard does not see the accented word.
const LEGACY_CONTRADICTION = 'impos\u00e9 par le plan'
const CONTRADICTS_PLAN = new RegExp(`imposed by the plan|${LEGACY_CONTRADICTION}`, 'i')

/**
 * CORRECTIONS verdict (task, global review, preflight re-review): the orchestrator is told in one line; findings
 * that contradict the plan ("imposed by the plan", or `LEGACY_CONTRADICTION`) open an `arbitration` gate, and fixes
 * wait for the user's decision (`arbitrationPending`), whose note goes into the fix file.
 */
export async function onCorrections(s: MissionState, e: Effects, what: string, reviewPath: string, round: number): Promise<void> {
  await informOrchestrator(s, e, `${what}: review CORRECTIONS (round ${round}), findings in ${reviewPath}`)
  if (s.step === 'blocked') return
  const raw = await readFile(reviewPath, 'utf8').catch(() => '')
  const lines = raw.split('\n').slice(1).map((l) => l.trim()).filter((l) => CONTRADICTS_PLAN.test(l))
  if (lines.length === 0) return
  const g = openGate(s, 'arbitration', lines.join('\n'), reviewPath)
  log(s, e, `${what}: finding(s) contradict the plan, gate ${g.id} (arbitration) open`)
  await notify(s, e, `Arbitration to decide (${what}): ${lines[0]}`)
  await informOrchestrator(
    s,
    e,
    `${what}: the review contradicts the plan (${lines.length} finding(s)). Gate ${g.id} (arbitration) open: explain the situation to the user, who decides (herness approve|reject ${s.id} --gate ${g.id}, with a note). Fixes wait for that decision.`,
  )
}

/** An `arbitration` gate is waiting for the user: no fix file is written. */
export const arbitrationPending = (s: MissionState): boolean => s.gates.some((g) => g.kind === 'arbitration' && g.status === 'pending')

/** Arbitration decisions not yet passed on, to add to the fix file; marked consumed. */
export function consumeArbitrations(s: MissionState): string {
  const arbitrations = s.gates.filter((g) => g.kind === 'arbitration' && (g.status === 'approved' || g.status === 'refused') && !s.consumedArbitrages.includes(g.id))
  const notes = arbitrations.filter((g) => g.note).map((g) => `- ${g.summary.split('\n')[0]} → ${g.status === 'approved' ? 'approved' : 'refused'}: ${g.note}`)
  s.consumedArbitrages.push(...arbitrations.map((g) => g.id))
  return notes.length ? `\n\n## User decision\n\n${notes.join('\n')}\n` : ''
}

/** Holder of an `agent-stopped` gate: a task, the global review, or the preflight. */
export type StopHolder = { stopGate?: string | undefined; stopDecision?: string | undefined; reportSize?: number | undefined }

/** Size of a file in bytes, 0 if it is absent. */
export const fileSize = (path: string): Promise<number> => stat(path).then((x) => x.size, () => 0)

/** The last lines added to the report after `since` bytes, or `null` if nothing was added. */
export async function reportTail(path: string, since = 0, lines = 40): Promise<string | null> {
  const raw = await readFile(path).catch(() => Buffer.alloc(0))
  if (raw.length <= since) return null
  const added = raw.subarray(since).toString('utf8')
  if (!added.trim()) return null
  return added.trimEnd().split('\n').slice(-lines).join('\n')
}

/**
 * "No commit" check: if the implementer completed the report since its brief was sent (`reportSize`), it stopped
 * on purpose (its brief tells it to when something blocks). An `agent-stopped` gate is opened and the orchestrator
 * explains the report to the user. Returns `null` otherwise: the check then blocks the mission as before.
 */
export async function stopWithoutCommit(s: MissionState, e: Effects, h: StopHolder, what: string, reportPath: string): Promise<StepResult | null> {
  const tail = await reportTail(reportPath, h.reportSize ?? 0)
  if (tail === null) return null
  const g = openGate(s, 'agent-stopped', `${what}: the implementer stopped without a commit\n${tail}`, reportPath)
  h.stopGate = g.id
  log(s, e, `${what}: the implementer stopped without a commit, gate ${g.id} (agent-stopped) open (${reportPath})`)
  await notify(s, e, `${what}: the implementer stopped without a commit, gate ${g.id} to decide`)
  await informOrchestrator(
    s,
    e,
    `${what}: the implementer stopped without a commit and left a report (${reportPath}). Gate ${g.id} (agent-stopped) is open. ` +
      `Read that report and explain it to the user. If the plan is the cause, propose an amendment (propose_amendment): once approved, it is applied at once and the implementer restarts from the amended brief. ` +
      `Otherwise, the user approves to restart the implementer with the decision as a note (herness approve ${s.id} --gate ${g.id} --note "…"), or refuses to block the mission (herness reject ${s.id} --gate ${g.id} --note "…").`,
  )
  return 'continue'
}

/**
 * The holder's `agent-stopped` gate: `wait` while it is pending, mission blocked if it is refused. Once approved,
 * the decision (note, or "continue") is kept for the next fix file and this returns `approved`.
 */
export async function settleStop(s: MissionState, e: Effects, h: StopHolder, what: string): Promise<'approved' | StepResult> {
  const id = h.stopGate
  const g = s.gates.find((x) => x.id === id)
  if (g?.status === 'pending') return 'wait'
  delete h.stopGate
  if (g?.status === 'obsolete') return 'continue'
  if (!g || g.status === 'refused') {
    return block(s, e, `${what}: the implementer stopped without a commit, gate ${id} refused${g?.note ? ` (${g.note})` : ''}`)
  }
  h.stopDecision = g.note?.trim() || 'continue'
  log(s, e, `${what}: stop without a commit, gate ${g.id} approved (${h.stopDecision}), correction round`)
  return 'approved'
}

/** Findings of a correction round born from a stop without a commit: the user's decision replaces them. */
export const STOP_FINDINGS = '(none: you stopped without a commit; follow the user decision below)'

/** "User decision" section of a fix file after a stop without a commit. */
export function stopSection(decision: string, amendedTask?: string): string {
  const amended = amendedTask
    ? `\n## Amended task instructions\n\nThe plan has been amended since your brief: here is the current text of your task, which replaces the one in the brief.\n\n${amendedTask}\n`
    : ''
  return `\n\n## User decision\n\nYou had stopped without a commit; the user read your report and decided.\n\nUser decision: ${decision}\n${amended}`
}

/** Where and under which name an agent is started: `what` for the log ("task 1"), `pane` prefix of the pane label. */
export type AgentSite = { what: string; pane: string }
const siteOf = (t: TaskState): AgentSite => ({ what: `task ${t.n}`, pane: `T${t.n}` })

/** Starts an agent in a free pane of the agents tab and records it in the state. */
export async function startAgent(s: MissionState, e: Effects, site: AgentSite, name: string, role: Role, model: string): Promise<void> {
  const tab = s.herdr.tabs['agents'] as string
  const wt = s.worktree as string
  const pane = await slot(e.herdr, tab, wt, `${site.pane} · ${model}`)
  await e.agents.start(name, role, pane, agentArgs(role, { model, worktree: wt, missionDir: missionDir(s.id) }))
  s.herdr.panes[name] = pane
  log(s, e, `${site.what}: agent ${name} started (${model})`)
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Stops the named agent. Absent from the registry: nothing. A failure is logged, never thrown. */
export async function stopAgent(s: MissionState, e: Effects, what: string, name: string): Promise<void> {
  const pane = s.herdr.panes[name]
  if (!pane) return
  try {
    if (await release(e.herdr, pane)) log(s, e, `${what}: agent ${name} stopped`)
  } catch (err) {
    log(s, e, `${what}: agent ${name} not stopped (${errText(err)})`)
  }
}

/** Stops agents on the agents tab: those marked ✓ or ✗ (`done`), or all of them (`all`). Never throws. */
export async function stopAgentsTab(s: MissionState, e: Effects, which: 'done' | 'all', why: string): Promise<void> {
  const tab = s.herdr.tabs['agents']
  if (!tab) return
  try {
    const { released, failed } = await releaseTab(e.herdr, tab, which)
    if (released.length > 0) log(s, e, `${why}: agent(s) stopped in ${released.join(', ')}`)
    for (const message of failed) log(s, e, `${why}: could not stop (${message})`)
  } catch (err) {
    log(s, e, `${why}: could not stop (${errText(err)})`)
  }
}

/** Starts the agent if it is not alive (first pass, or the engine restarted). */
export async function ensureAgent(s: MissionState, e: Effects, site: AgentSite, name: string, role: Role, model: string): Promise<void> {
  if (await e.herdr.agentGet(name)) return
  await startAgent(s, e, site, name, role, model)
}

/** Holder of a brief in progress: a task, the global review, or the preflight. */
export type AskHolder = { pendingAsk?: PendingAsk | undefined; blockedGate?: string | undefined }

/**
 * Gives a brief file to an agent. The brief is saved in state BEFORE it is sent: an engine restarted during the
 * wait waits for the agent (`resumeAsk`) instead of sending the brief again.
 */
export async function askAgent(s: MissionState, e: Effects, h: AskHolder, what: string, role: Role, pending: PendingAsk): Promise<'done' | StepResult> {
  h.pendingAsk = pending
  await saveState(s)
  const r = await e.agents.ask(pending.agent, pending.file, ASK_TIMEOUT_MS[role])
  return settle(s, e, h, what, pending.agent, await proven(s, e, what, pending, r))
}

/** Wait for a brief already sent (resume after an engine restart or an unblock), without resending it. */
export async function awaitAgent(s: MissionState, e: Effects, h: AskHolder, what: string, role: Role, pa: PendingAsk): Promise<'done' | StepResult> {
  const r = await e.agents.wait(pa.agent, ASK_TIMEOUT_MS[role])
  return settle(s, e, h, what, pa.agent, await proven(s, e, what, pa, r))
}

/** Waiting for a report: poll interval, and how long to stay idle with no report before checking anyway. */
export const PROOF = { pollMs: 15_000, idleGraceMs: 10 * 60_000 }

/**
 * herdr judges that an agent is finished from its screen: a cursor-agent looks idle during a long command (a
 * vitest run, for example). For an implementer, `done` therefore counts as finished only once its report is
 * complete (its brief requires that before `DONE`). Otherwise the engine checks again; after `idleGraceMs` idle
 * with no report (the count restarts when the agent is working), it checks anyway, as before.
 */
async function proven(s: MissionState, e: Effects, what: string, pa: PendingAsk, r: 'done' | 'blocked' | 'timeout'): Promise<'done' | 'blocked' | 'timeout'> {
  const report = pa.report
  if (r !== 'done' || !report) return r
  let idle = 0
  for (;;) {
    if ((await fileSize(report.path)) > report.size) return 'done'
    if (idle >= PROOF.idleGraceMs) {
      log(s, e, `${what}: ${pa.agent} idle for ${PROOF.idleGraceMs / 60_000} min without a report, checking the work`)
      return 'done'
    }
    if (idle === 0) log(s, e, `${what}: ${pa.agent} seen idle without a report, waiting for the real end`)
    await e.sleep(PROOF.pollMs)
    const state = (await e.herdr.agentGet(pa.agent))?.state
    // Agent gone: resume knows how to observe its work.
    if (state === undefined) return 'done'
    if (state === 'blocked') return 'blocked'
    idle = state === 'working' ? 0 : idle + PROOF.pollMs
  }
}

/**
 * Handles the outcome of a brief. `done` and `timeout` (mission blocked) clear `pendingAsk`. `blocked` keeps it
 * and opens an `agent-blocked` gate: nothing is sent to the agent, the user unblocks it in its pane, then once
 * the gate is approved the engine waits for the agent (`resumeAsk`) without resending the brief.
 */
export async function settle(s: MissionState, e: Effects, h: AskHolder, what: string, name: string, r: 'done' | 'blocked' | 'timeout'): Promise<'done' | StepResult> {
  if (r !== 'blocked') delete h.pendingAsk
  if (r === 'done') return 'done'
  if (r === 'timeout') return block(s, e, `agent ${name} timed out (${what})`)
  const tail = await e.herdr.agentRead(name, 40).catch(() => '')
  const g = openGate(s, 'agent-blocked', `Agent ${name} (${what}) blocked, to unblock in its pane:\n${tail}`)
  h.blockedGate = g.id
  log(s, e, `gate ${g.id} (agent-blocked) open for ${name}`)
  await notify(s, e, `Agent ${name} blocked: approve gate ${g.id} once unblocked`)
  await informOrchestrator(
    s,
    e,
    `Agent ${name} (${what}) is waiting for an intervention in its pane. Gate ${g.id} (agent-blocked) open: the user unblocks it, then approves (herness approve ${s.id} --gate ${g.id}).`,
  )
  return 'wait'
}

async function markTaskPanes(s: MissionState, e: Effects, t: TaskState): Promise<void> {
  for (const name of [implName(s, t), strongName(s, t), reviewerName(s, t)]) {
    const pane = s.herdr.panes[name]
    if (!pane) continue
    try {
      await markDone(e.herdr, pane, '✓')
    } catch (err) {
      log(s, e, `could not mark ✓ on ${pane}: ${errText(err)}`)
    }
    await stopAgent(s, e, `task ${t.n}`, name)
  }
}

/** Applies one event of the task loop (pure decision of `nextTaskPhase`). */
async function apply(s: MissionState, e: Effects, t: TaskState, ev: LoopEvent, detail = ''): Promise<StepResult> {
  const d = nextTaskPhase(t, ev)
  t.round = d.round
  if (d.blocked) return block(s, e, `task ${t.n}: ${d.blocked}${detail ? `\n${detail}` : ''}`)
  if (d.fixer !== 'none') t.fixer = d.fixer
  log(s, e, `task ${t.n}: ${ev}, ${t.phase} → ${d.phase}${d.fixer !== 'none' ? ` (round ${d.round}, ${d.fixer})` : ''}`)
  t.phase = d.phase
  if (d.phase === 'done') await markTaskPanes(s, e, t)
  return 'continue'
}

/** First approved `amendment` gate not yet handled. */
export function pendingAmendment(s: MissionState): Gate | undefined {
  return s.gates.find((x) => x.kind === 'amendment' && x.status === 'approved' && !s.appliedAmendments.includes(x.id))
}

/**
 * Global review and preflight start over: their directories are archived as `<dir>.<n>` (nothing old is reread
 * as a report or a fix of the new pass) and the generation changes, so agent names change too: agents from the
 * previous loop, with their context, are never reused.
 */
async function resetLoops(s: MissionState, e: Effects): Promise<void> {
  await stopAgentsTab(s, e, 'all', 'new generation of the closing loops')
  for (const name of ['global', 'preflight']) {
    const dir = join(missionDir(s.id), name)
    if (!(await exists(dir))) continue
    let n = 1
    while (await exists(`${dir}.${n}`)) n++
    await rename(dir, `${dir}.${n}`)
    log(s, e, `directory ${dir} archived as ${dir}.${n}`)
  }
  s.loops = freshLoops()
  s.loopGeneration += 1
}

/**
 * Why an amendment must still wait, or `undefined`: a brief is in progress with an agent (`pendingAsk`), or an
 * `agent-blocked`/`agent-stopped` gate is pending. Exception: the in-progress task's `agent-stopped` gate, which
 * is waiting precisely for its brief to be corrected.
 */
function amendmentHold(s: MissionState): string | undefined {
  const asks = [...s.tasks.map((t) => t.pendingAsk), s.loops.globalReview.pendingAsk, s.loops.preflight.pendingAsk]
  if (asks.some((a) => a !== undefined)) return 'a brief is in progress with an agent'
  const current = s.tasks.find((t) => t.phase !== 'done' && t.phase !== 'pending')
  const waiting = s.gates.filter((g) => g.status === 'pending' && (g.kind === 'agent-blocked' || g.kind === 'agent-stopped'))
  const other = waiting.find((g) => !(g.kind === 'agent-stopped' && current?.stopGate === g.id))
  return other ? `gate ${other.id} (${other.kind}) pending` : undefined
}

const RESUME =
  '## Resume\n\nThe plan was amended during your task: the task text below replaces your previous instructions. ' +
  'Work is already present in the tree: keep it, adapt it to the new instructions, then run the tests and commit.\n\n'

/** Mark of a brief rewritten by amendment `gateId` (resume after an engine stop). */
const resumeMark = (gateId: string): string => `<!-- amendment ${gateId} -->`

/**
 * Writes the task brief; `resume` (the amendment gate): amended brief during the task, Resume section at the top.
 */
async function writeBrief(s: MissionState, cfg: ProjectConfig, t: TaskState, body: PlanTask, resume?: string): Promise<string> {
  const dir = taskDir(s, t)
  await mkdir(dir, { recursive: true })
  let brief = await render('brief', {
    taskBody: taskText(t.n, body),
    specPath: specPath(s),
    planPath: planPath(s),
    testCommand: t.testCommand,
    commitFormat: fill([cfg.commitFormat], { id: s.id })[0] as string,
    forbidden: forbidden(cfg),
    reportPath: join(dir, 'report.md'),
    language: cfg.language,
  })
  if (resume) brief = brief.replace(/^# Task brief\n\n/, `# Task brief\n\n${RESUME}${resumeMark(resume)}\n\n`)
  const file = join(dir, 'brief.md')
  await writeFile(file, brief)
  return file
}

/**
 * Proposal of an amendment interrupted after `plan.proposed.md` was removed but before state was saved:
 * `plan.approved.md` (and the worktree spec) is already the approved proposal, except for the hash.
 */
async function interruptedProposal(s: MissionState, e: Effects, g: Gate): Promise<Proposal | null> {
  const plan = await readFile(join(missionDir(s.id), 'plan.approved.md'), 'utf8').catch(() => undefined)
  if (plan === undefined || g.hash === undefined) return null
  const spec = s.worktree ? await readFile(join(s.worktree, specPath(s)), 'utf8').catch(() => undefined) : undefined
  const candidates: Proposal[] = [{ plan, hash: proposalHash(plan) }]
  if (spec !== undefined) candidates.push({ plan, spec, hash: proposalHash(plan, spec) })
  const found = candidates.find((c) => c.hash === g.hash)
  if (found) log(s, e, `amendment ${g.id} interrupted (proposal already removed, approved plan is current): resuming application`)
  return found ?? null
}

/** Applies the first approved `amendment` gate not yet handled (see `applyAmendment`). True if state changed. */
export async function applyPendingAmendment(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<boolean> {
  return (await applyAmendment(s, e, cfg)).status !== 'none'
}

/**
 * Applies the first approved `amendment` gate not yet handled, as soon as no agent has a brief in progress
 * (`amendmentHold`). The proposal (`plan.proposed.md`, `spec.proposed.md` in the mission directory) must be the
 * one the user approved (same hash); it is then copied into the worktree, committed, then removed.
 * If the in-progress task changes, its brief is rewritten with a Resume section and it goes back to `implement`
 * (same round); an `agent-stopped` gate it was waiting on is no longer waited on. `none`: nothing to do, or wait.
 */
export type AmendmentResult = { status: 'none' | 'rejected' } | { status: 'applied'; resumed?: number | undefined }

export async function applyAmendment(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<AmendmentResult> {
  const none = { status: 'none' } as const
  const g = pendingAmendment(s)
  if (!g) return none
  if (amendmentHold(s) !== undefined) return none
  if (!s.worktree) return none
  const reject = async (reason: string): Promise<AmendmentResult> => {
    s.appliedAmendments.push(g.id)
    log(s, e, `amendment ${g.id} not applied: ${reason}`)
    await informOrchestrator(s, e, `Amendment ${g.id} not applied: ${reason}`)
    return { status: 'rejected' }
  }
  const proposal = (await readProposal(s.id)) ?? (await interruptedProposal(s, e, g))
  if (!proposal) return reject(`proposal not found (${proposedPlanPath(s.id)})`)
  if (g.hash === undefined || g.hash !== proposal.hash) {
    return reject('the proposal changed after the request; ask for validation again with propose_amendment')
  }
  const next = parsePlan(proposal.plan)
  const approved = await approvedPlan(s)
  const done = s.tasks
    .filter((t) => t.phase === 'done')
    .map((t) => ({ n: t.n, body: approved.find((x) => x.n === t.n)?.body ?? '' }))
  const cur = currentTask(s)
  const curBody = cur && approved.find((x) => x.n === cur.n)
  const check = checkAmendment(done, next, curBody ? { n: curBody.n, body: curBody.body } : undefined)
  if (!check.ok || !next.ok) return reject(check.ok ? 'invalid amended plan' : check.reason)
  // Safe resume after an engine stop at any point: every write before state is saved can be replayed, and the
  // proposal is removed only once the amendment is recorded as applied.
  // Copy into the worktree and commit: only the engine writes in the worktree after the plan is approved.
  const docs: [string, string][] = [[planPath(s), proposal.plan]]
  if (proposal.spec !== undefined) docs.push([specPath(s), proposal.spec])
  for (const [rel, body] of docs) {
    await mkdir(dirname(join(s.worktree, rel)), { recursive: true })
    await writeFile(join(s.worktree, rel), body)
  }
  const headBefore = await e.git.headSha(s.worktree)
  if ((await commitIfChanged(s, e, docs.map(([rel]) => rel), `docs(${s.id}): amend the plan`, 'amendment of the plan')) === 'committed') {
    // The documents commit is not part of the in-progress task's work: its base moves past it, otherwise
    // the check would see a commit, a gone agent would count as delivered, and the review would reread the documents.
    const headAfter = await e.git.headSha(s.worktree)
    for (const t of s.tasks) {
      if (t.phase === 'done' || t.phase === 'pending' || t.baseSha !== headBefore) continue
      t.baseSha = headAfter
      log(s, e, `task ${t.n}: base moved after the amendment commit (${headBefore} → ${headAfter})`)
    }
    // Saved at once: replayed, the commit would already be done and the base would no longer move.
    await saveState(s)
  }
  const before = new Map(s.tasks.map((t) => [t.n, t]))
  s.tasks = next.tasks.map((nt) => {
    const old = before.get(nt.n)
    if (old?.phase === 'done') return old
    return { ...(old ?? { n: nt.n, phase: 'pending' as const, round: 0 }), title: nt.title, testCommand: nt.testCommand }
  })
  const added = next.tasks.filter((nt) => !before.has(nt.n)).map((nt) => nt.n)
  const dropped = [...before.keys()].filter((n) => !next.tasks.some((nt) => nt.n === n))
  const resumed = await resumeAmendedTask(s, e, cfg, g.id, approved, next.tasks)
  await writeFile(join(missionDir(s.id), 'plan.approved.md'), proposal.plan)
  s.appliedAmendments.push(g.id)
  log(s, e, `amendment ${g.id} applied: tasks added ${added.join(', ') || 'none'}${dropped.length ? `, removed ${dropped.join(', ')}` : ''}${proposal.spec !== undefined ? ', spec amended' : ''}`)
  if (ACTIVE_STEPS_AFTER_TASKS.includes(s.step)) {
    // Global review and preflight will be replayed after the new tasks. The test database is removed by
    // the preflight step before the amendment is applied.
    await resetLoops(s, e)
    goto(s, e, 'tasks')
  }
  await saveState(s)
  await rm(proposedPlanPath(s.id), { force: true })
  await rm(proposedSpecPath(s.id), { force: true })
  await informOrchestrator(
    s,
    e,
    `Amendment ${g.id} applied to the plan (tasks added: ${added.join(', ') || 'none'}).${resumed ? ` In-progress task ${resumed} resumes with its amended brief.` : ''}`,
  )
  return { status: 'applied', resumed }
}

/** Task text as the brief contains it. */
const taskText = (n: number, body: PlanTask): string => `### Task ${n}: ${body.title}\n\n${body.body}`

/** In-progress task: neither `pending` nor `done`. */
const currentTask = (s: MissionState): TaskState | undefined => s.tasks.find((x) => x.phase !== 'done' && x.phase !== 'pending')

/**
 * Does `body` differ from the task's brief? Reference: its `brief.md` (idempotent, survives an engine stop);
 * without a brief, the previous approved plan.
 */
async function taskChanged(s: MissionState, t: TaskState, body: PlanTask, approved?: PlanTask[]): Promise<boolean> {
  const brief = await readFile(join(taskDir(s, t), 'brief.md'), 'utf8').catch(() => undefined)
  if (brief !== undefined) return !brief.includes(taskText(t.n, body))
  const old = approved?.find((x) => x.n === t.n)
  return !!old && (old.body !== body.body || old.title !== body.title)
}

/** The mission is blocked by task `n` itself (check, stop without a commit, rounds exhausted…). */
const blockedByTask = (s: MissionState, n: number): boolean =>
  s.step === 'blocked' && s.blockedFrom === 'tasks' && (s.blockedReason ?? '').startsWith(`task ${n}:`)

/**
 * Blocked mission: the task that approving this amended plan would restart (it blocks the mission and the
 * amendment changes its text), otherwise `undefined`. Used to announce the gate's effect when it opens.
 */
export async function amendmentWouldResume(s: MissionState, plan: string): Promise<number | undefined> {
  const t = currentTask(s)
  if (!t || !blockedByTask(s, t.n)) return undefined
  const parsed = parsePlan(plan)
  const body = parsed.ok ? parsed.tasks.find((x) => x.n === t.n) : undefined
  if (!body) return undefined
  return (await taskChanged(s, t, body, await approvedPlan(s).catch(() => undefined))) ? t.n : undefined
}

/** A mission blocked by task `resumed` can start again after the amendment that restarted it. */
export const unblocksMission = (s: MissionState, resumed: number | undefined): boolean => resumed !== undefined && blockedByTask(s, resumed)

/**
 * In-progress task whose text the amendment changes: brief rewritten with a resume, back to `implement` on the
 * same round, `agent-stopped` gate obsolete. Returns its number, or `undefined` if nothing changes.
 */
async function resumeAmendedTask(
  s: MissionState,
  e: Effects,
  cfg: ProjectConfig,
  gateId: string,
  approved: PlanTask[],
  next: PlanTask[],
): Promise<number | undefined> {
  const t = currentTask(s)
  if (!t) return undefined
  const body = next.find((x) => x.n === t.n)
  if (!body) return undefined
  // Brief already rewritten for this amendment by an attempt interrupted before the save: do it all again.
  const rewritten = (await readFile(join(taskDir(s, t), 'brief.md'), 'utf8').catch(() => '')).includes(resumeMark(gateId))
  if (!rewritten && !(await taskChanged(s, t, body, approved))) return undefined
  const file = await writeBrief(s, cfg, t, body, gateId)
  log(s, e, `task ${t.n}: amended brief, brief rewritten (${file}), ${t.phase} → implement (round ${t.round})`)
  t.phase = 'implement'
  if (t.stopGate) {
    const g = s.gates.find((x) => x.id === t.stopGate)
    if (g?.status === 'pending') {
      g.status = 'obsolete'
      g.decidedAt = e.now().toISOString()
    }
    log(s, e, `task ${t.n}: gate ${t.stopGate} (agent-stopped) obsolete, the task resumes with the amended brief`)
    await informOrchestrator(s, e, `Gate ${t.stopGate} (agent-stopped) is obsolete: the amendment resumed task ${t.n} with its amended brief. Nothing left to approve on this gate.`)
    delete t.stopGate
  }
  delete t.stopDecision
  return t.n
}

async function stepPending(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const wt = s.worktree as string
  t.baseSha = await e.git.headSha(wt)
  const body = (await approvedPlan(s)).find((x) => x.n === t.n)
  if (!body) return block(s, e, `task ${t.n} missing from plan.approved.md`)
  const brief = await writeBrief(s, cfg, t, body)
  const name = implName(s, t)
  // Idempotent: a stop between start and save does not start a second agent.
  await ensureAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementer)
  t.implementer = name
  t.phase = 'implement'
  log(s, e, `task ${t.n}: base ${t.baseSha}, brief ${brief}`)
  return 'continue'
}

async function stepImplement(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const wt = s.worktree as string
  const dir = taskDir(s, t)
  const name = implName(s, t)
  if (!(await e.herdr.agentGet(name))) {
    // Resume after a restart: the agent is gone.
    if ((await e.git.headSha(wt)) !== t.baseSha) {
      log(s, e, `task ${t.n}: resume, ${name} gone but commits exist since ${t.baseSha}`)
      return apply(s, e, t, 'implemented')
    }
    log(s, e, `task ${t.n}: resume, ${name} gone with no commit, restarting with the same brief`)
    await startAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementer)
    t.implementer = name
  }
  t.reportSize = await fileSize(join(dir, 'report.md'))
  const report = { path: join(dir, 'report.md'), size: t.reportSize }
  const r = await askAgent(s, e, t, `task ${t.n}`, 'implementer', { agent: name, file: join(dir, 'brief.md'), fromSha: t.baseSha as string, report })
  if (r !== 'done') return r
  return finishImplement(s, e, t)
}

async function finishImplement(s: MissionState, e: Effects, t: TaskState): Promise<StepResult> {
  const report = join(taskDir(s, t), 'report.md')
  if (!(await exists(report))) log(s, e, `task ${t.n}: report missing (${report})`)
  return apply(s, e, t, 'implemented')
}

async function stepControl(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const r = await e.git.controlCommits(s.worktree as string, t.baseSha as string, cfg.forbiddenPaths, mainRef(cfg))
  if (r.ok) return apply(s, e, t, 'control-ok')
  if (r.code === 'no-commit') {
    const stop = await stopWithoutCommit(s, e, t, `task ${t.n}`, join(taskDir(s, t), 'report.md'))
    if (stop) return stop
  }
  return apply(s, e, t, 'control-ko', r.reason)
}

async function stepTest(s: MissionState, e: Effects, t: TaskState): Promise<StepResult> {
  const tab = s.herdr.tabs['checks']
  if (!tab) return block(s, e, `tests for task ${t.n} impossible: checks tab unknown`)
  const r = await e.runInPane(e.herdr, tab, s.worktree as string, `T${t.n} · tests`, ['bash', '-c', t.testCommand], join(missionDir(s.id), 'logs'))
  if (r.exitCode === 0) {
    delete t.lastFailure
    return apply(s, e, t, 'tests-green')
  }
  t.lastFailure = `Command: ${t.testCommand}\nExit code: ${r.exitCode}\nFull log: ${r.logPath}\n\n${r.tail}`
  return apply(s, e, t, 'tests-red')
}

async function stepReview(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const wt = s.worktree as string
  const dir = taskDir(s, t)
  const name = reviewerName(s, t)
  const common = {
    briefPath: join(dir, 'brief.md'),
    reportPath: join(dir, 'report.md'),
    constraints: `Those of the spec (\`${specPath(s)}\`), and these forbidden items:\n${forbidden(cfg)}`,
  }
  let prompt: string
  let outPath: string
  let head: string
  await mkdir(dir, { recursive: true })
  if (!t.reviewedSha) {
    const diffPath = join(dir, 'task.diff')
    head = (await e.git.diffPackage(wt, t.baseSha as string, diffPath)).head
    outPath = join(dir, 'review.md')
    prompt = join(dir, 'review-brief.md')
    await writeFile(prompt, await render('review', { ...common, baseSha: t.baseSha as string, headSha: head, diffPath, outPath }))
  } else {
    const diffPath = join(dir, `correction-${t.round}.diff`)
    head = (await e.git.diffPackage(wt, t.reviewedSha, diffPath)).head
    outPath = join(dir, `rerevue-${t.round}.md`)
    prompt = join(dir, `consigne-rerevue-${t.round}.md`)
    const findings = await findingsOf(t.lastReview)
    await writeFile(prompt, await render('rereview', { ...common, baseSha: t.reviewedSha, headSha: head, diffPath, outPath, findings }))
  }
  await ensureAgent(s, e, siteOf(t), name, 'reviewer', cfg.models.reviewer)
  t.reviewer = name
  const r = await askAgent(s, e, t, `task ${t.n}`, 'reviewer', { agent: name, file: prompt, out: outPath, head })
  if (r !== 'done') return r
  return finishReview(s, e, t, outPath, head)
}

/** First line of the review report: the matching event, or `undefined` if unreadable. */
export async function readVerdict(outPath: string): Promise<{ first: string; ev: LoopEvent | undefined }> {
  const first = (await readFile(outPath, 'utf8').catch(() => '')).replace(/^\uFEFF/, '').split('\n')[0]!.trim()
  const ev: LoopEvent | undefined = first === 'VERDICT: APPROVED' ? 'review-approved' : first === 'VERDICT: CORRECTIONS' ? 'review-changes' : undefined
  return { first, ev }
}

async function finishReview(s: MissionState, e: Effects, t: TaskState, outPath: string, head: string): Promise<StepResult> {
  const { first, ev } = await readVerdict(outPath)
  if (!ev) return block(s, e, `task ${t.n}: unreadable review verdict in ${outPath} ("${first}")`)
  t.reviewedSha = head
  t.lastReview = outPath
  const r = await apply(s, e, t, ev)
  if (ev === 'review-changes') await onCorrections(s, e, `task ${t.n}`, outPath, t.round)
  return r
}

/** Current task text if an amendment changed it since its brief was written, otherwise `undefined`. */
async function amendedTaskText(s: MissionState, t: TaskState): Promise<string | undefined> {
  const body = (await approvedPlan(s)).find((x) => x.n === t.n)
  if (!body) return undefined
  return (await taskChanged(s, t, body)) ? taskText(t.n, body) : undefined
}

async function stepFix(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  if (arbitrationPending(s)) return 'wait'
  const dir = taskDir(s, t)
  const file = join(dir, `correctifs-${t.round}.md`)
  // Written once: a resume sends the same file again.
  if (!(await exists(file))) {
    const stop = t.stopDecision
    const failure = stop ? '' : (t.lastFailure ?? '')
    const findings = stop ? STOP_FINDINGS : failure ? '' : await findingsOf(t.lastReview)
    const body = await render('correction', { findings, failure, forbidden: forbidden(cfg), reportPath: join(dir, 'report.md'), language: cfg.language })
    const head =
      `Brief of the original task: \`${join(dir, 'brief.md')}\` (read it first if you do not already know it).\n` +
      `Append your report to the end of \`${join(dir, 'report.md')}\`, without erasing earlier reports.\n\n`
    const decision = stop ? stopSection(stop, await amendedTaskText(s, t)) : ''
    await mkdir(dir, { recursive: true })
    await writeFile(file, head + body + decision + consumeArbitrations(s))
  }
  delete t.stopDecision
  let name: string
  if (t.fixer === 'strong') {
    name = strongName(s, t)
    await ensureAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementerStrong)
  } else {
    name = implName(s, t)
    await ensureAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementer)
  }
  t.implementer = name
  const fromSha = await e.git.headSha(s.worktree as string)
  t.reportSize = await fileSize(join(dir, 'report.md'))
  const report = { path: join(dir, 'report.md'), size: t.reportSize }
  const r = await askAgent(s, e, t, `task ${t.n}`, 'implementer', { agent: name, file, fromSha, report })
  if (r !== 'done') return r
  return apply(s, e, t, 'fixed')
}

/**
 * Resume of a brief sent before an engine restart: nothing is resent to a live agent, its outcome is awaited.
 * Agent gone: implement/fix → commits since the head from before the send means the work was delivered,
 * otherwise restart and resend; review → an already written verdict is used, otherwise the reviewer is restarted and the brief resent.
 */
async function resumeAsk(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState, pa: PendingAsk): Promise<StepResult> {
  const role: Role = t.phase === 'review' ? 'reviewer' : 'implementer'
  const headNow = async () => pa.head ?? (await e.git.headSha(s.worktree as string))
  if (await e.herdr.agentGet(pa.agent)) {
    log(s, e, `task ${t.n}: resume, waiting for ${pa.agent} without resending ${pa.file}`)
    const r = await awaitAgent(s, e, t, `task ${t.n}`, role, pa)
    if (r !== 'done') return r
    if (t.phase === 'implement') return finishImplement(s, e, t)
    if (t.phase === 'fix') return apply(s, e, t, 'fixed')
    if (t.phase === 'review' && pa.out) return finishReview(s, e, t, pa.out, await headNow())
    return 'continue'
  }
  delete t.pendingAsk
  log(s, e, `task ${t.n}: resume, ${pa.agent} gone during ${pa.file}`)
  switch (t.phase) {
    case 'implement':
      return stepImplement(s, e, cfg, t)
    case 'fix':
      if (pa.fromSha && (await e.git.headSha(s.worktree as string)) !== pa.fromSha) return apply(s, e, t, 'fixed')
      return stepFix(s, e, cfg, t)
    case 'review':
      if (pa.out && (await readVerdict(pa.out)).ev) return finishReview(s, e, t, pa.out, await headNow())
      return stepReview(s, e, cfg, t)
    default:
      return 'continue'
  }
}

/** Step 7: one transition of the first task that is not `done`; no task left → `global-review`. */
export async function stepTasks(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  if (await applyPendingAmendment(s, e, cfg)) return 'continue'
  const t = s.tasks.find((x) => x.phase !== 'done')
  if (!t) return goto(s, e, 'global-review')
  if (!s.worktree || !s.herdr.tabs['agents']) return block(s, e, 'task loop impossible: worktree or agents tab unknown')

  if (t.blockedGate) {
    const g = s.gates.find((x) => x.id === t.blockedGate)
    if (g?.status === 'pending') return 'wait'
    delete t.blockedGate
    if (g?.status === 'refused') return block(s, e, `task ${t.n}: blocked agent, gate ${g.id} refused${g.note ? ` (${g.note})` : ''}`)
    log(s, e, `task ${t.n}: agent unblocked, waiting for it to finish without resending`)
  }
  if (t.stopGate) {
    const r = await settleStop(s, e, t, `task ${t.n}`)
    if (r !== 'approved') return r
    return apply(s, e, t, 'stopped')
  }
  if (t.pendingAsk) return resumeAsk(s, e, cfg, t, t.pendingAsk)

  switch (t.phase) {
    case 'pending': return stepPending(s, e, cfg, t)
    case 'implement': return stepImplement(s, e, cfg, t)
    case 'control': return stepControl(s, e, cfg, t)
    case 'test': return stepTest(s, e, t)
    case 'review': return stepReview(s, e, cfg, t)
    case 'fix': return stepFix(s, e, cfg, t)
    case 'done': return 'continue'
  }
}
