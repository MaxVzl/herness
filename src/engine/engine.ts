import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fill, type ProjectConfig } from '../config/project.ts'
import { errorLogPath, logHernessError, type ErrorContext } from '../errlog.ts'
import { drainInbox, type InboxMessage } from '../mission/inbox.ts'
import { parsePlan } from '../mission/plan.ts'
import { loadState, saveState, type Gate, type GateKind, type MissionState, type Step } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { proposedPlanPath } from '../mission/amendment.ts'
import type { Effects } from './effects.ts'
import { checkEnv } from './envcheck.ts'
import { markDone } from '../herdr/layout.ts'
import { applyDecision, openGate } from './gates.ts'
import { stepGlobalReview, stepPr, stepPreflight } from './finish.ts'
import { amendmentWouldResume, applyAmendment, applyPendingAmendment, stepTasks, stopAgentsTab, taskDir, unblocksMission } from './tasks.ts'

export type StepResult = 'continue' | 'wait' | 'stop'
/** A step reads and updates the in-memory state; the engine saves it after each call. */
export type StepFn = (s: MissionState, e: Effects, cfg: ProjectConfig) => Promise<StepResult>

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** Temporary detached worktree for the proof on main. */
export const proofWorktree = (id: string): string => join(missionDir(id), 'preuve-main')
const fileExists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

export function log(s: MissionState, e: Effects, msg: string): void {
  s.log.push({ at: e.now().toISOString(), msg })
}

/** Message from the engine to the orchestrator session, without waiting; never throws. */
export async function informOrchestrator(s: MissionState, e: Effects, text: string): Promise<void> {
  const agent = s.orchestrator.agent
  if (!agent) return
  try {
    await e.herdr.agentPrompt(agent, `[herness] ${text}`, { wait: false })
  } catch (err) {
    log(s, e, `message to the orchestrator not delivered: ${errMsg(err)}`)
  }
}

export async function notify(s: MissionState, e: Effects, body: string): Promise<void> {
  try {
    await e.herdr.notify(`herness ${s.id}`, body, 'request')
  } catch (err) {
    log(s, e, `notification not shown: ${errMsg(err)}`)
  }
}

/** Moves the mission to `blocked`, and tells the user and the orchestrator. */
export async function block(s: MissionState, e: Effects, reason: string): Promise<StepResult> {
  if (s.step !== 'blocked') s.blockedFrom = s.step
  s.step = 'blocked'
  s.blockedReason = reason
  log(s, e, `mission blocked: ${reason}`)
  await notify(s, e, `Mission blocked: ${reason.split('\n')[0]}`)
  await informOrchestrator(s, e, `Mission blocked: ${reason}`)
  return 'continue'
}

async function dbDown(s: MissionState, e: Effects, cfg: ProjectConfig, flag: 'testDbUp' | 'proofDbUp', id: string, worktree: string): Promise<string | null> {
  if (!s[flag] || !cfg.testDb) return null
  const cwd = s.worktree ?? s.repoPath
  // `{worktree}`: the worktree whose .env points at this database (the mission's, or the proof's).
  const [cmd, ...args] = fill(cfg.testDb.down, { id, worktree })
  if (!cmd) return null
  let error: string
  try {
    const r = await e.run(cmd, args, { cwd, reject: false })
    if (r.exitCode === 0) {
      s[flag] = false
      return null
    }
    error = `code ${r.exitCode}: ${(r.stderr || r.stdout).trim()}`
  } catch (err) {
    error = errMsg(err)
  }
  log(s, e, `failed to stop test database ${id} (${error})`)
  return error
}

/** Stops the mission test database if it is running; never throws. Returns the error, or null if the database is stopped. */
export function testDbDown(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<string | null> {
  return dbDown(s, e, cfg, 'testDbUp', s.id, s.worktree ?? s.repoPath)
}

/** Stops the `<id>-main` database of a proof on main that is still up; never throws. */
export function proofDbDown(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<string | null> {
  return dbDown(s, e, cfg, 'proofDbUp', `${s.id}-main`, proofWorktree(s.id))
}

/** Blocks the mission because a test database could not be removed (`testDbUp`/`proofDbUp` stay true). */
export async function blockDbNotDown(s: MissionState, e: Effects, id: string, error: string): Promise<StepResult> {
  const previous = s.step === 'blocked' && s.blockedReason ? `\n(previous block: ${s.blockedReason})` : ''
  return block(s, e, `test database ${id} not removed: ${error}${previous}`)
}

export function latestGate(s: MissionState, kind: GateKind): Gate | undefined {
  return s.gates.filter((g) => g.kind === kind).at(-1)
}

export function goto(s: MissionState, e: Effects, step: Step): StepResult {
  log(s, e, `step ${s.step} → ${step}`)
  s.step = step
  return 'continue'
}

/**
 * Idempotent commit: a file already committed (by an agent, or before a restart) is not committed again.
 * Returns `missing` if a file is absent from the worktree (nothing is committed), `clean` if everything is already committed.
 */
export async function commitIfChanged(
  s: MissionState,
  e: Effects,
  rels: string | string[],
  message: string,
  what: string,
): Promise<'committed' | 'clean' | 'missing'> {
  const wt = s.worktree as string
  const files = typeof rels === 'string' ? [rels] : rels
  const missing: string[] = []
  for (const rel of files) if (!(await fileExists(join(wt, rel)))) missing.push(rel)
  if (missing.length > 0) {
    log(s, e, `${what}: file missing from the worktree, no commit: ${missing.map((m) => join(wt, m)).join(', ')}`)
    return 'missing'
  }
  const changed: string[] = []
  for (const rel of files) if (!(await e.git.isClean(wt, rel))) changed.push(rel)
  if (changed.length === 0) {
    log(s, e, `${what} already committed, no commit: ${files.join(', ')}`)
    return 'clean'
  }
  await e.git.commitFiles(wt, changed, message)
  return 'committed'
}

const stepEnv: StepFn = async (s, e) => {
  const res = await checkEnv(s.repoPath, e)
  const kos = res.filter((r) => r.status === 'KO')
  if (kos.length === 0) return goto(s, e, 'prepare')
  return block(s, e, `environment incomplete:\n${kos.map((k) => `- ${k.label}: ${k.detail}`).join('\n')}`)
}

const stepPrepare: StepFn = async (s, e, cfg) => {
  const tab = s.herdr.tabs['process']
  if (!s.worktree || !tab) return block(s, e, 'cannot prepare: worktree or process tab unknown')
  const r = await e.runInPane(e.herdr, tab, s.worktree, 'prepare', fill(cfg.prepare, { worktree: s.worktree, id: s.id }), join(missionDir(s.id), 'logs'))
  if (r.exitCode === 0) return goto(s, e, 'classify')
  return block(s, e, `worktree prepare failed (code ${r.exitCode}), log: ${r.logPath}\n${r.tail}`)
}

const stepClassify: StepFn = async (s, e, cfg) => {
  if (!s.type || !s.slug) return 'wait'
  if (!s.worktree) return block(s, e, 'cannot rename branch: worktree unknown')
  const target = `${cfg.branchPrefixes[s.type]}/${s.id}-${s.slug}`
  // Resume: the rename may have happened before the engine stopped, without being recorded.
  if ((await e.git.currentBranch(s.worktree)) === target) {
    log(s, e, `branch already named ${target}`)
  } else {
    await e.git.renameBranch(s.worktree, `herness/${s.id}`, target)
    log(s, e, `branch renamed to ${target}`)
  }
  s.branch = target
  // The orchestrator prompt only knows `herness/<id>`: it learns the name the PR will track.
  await informOrchestrator(s, e, `Mission branch renamed to ${target}: the PR will track it.`)
  return goto(s, e, 'brainstorm')
}

const stepBrainstorm: StepFn = async (s, e) => {
  const g = latestGate(s, 'spec')
  return g && g.status !== 'refused' ? goto(s, e, 'spec') : 'wait'
}

const stepSpec: StepFn = async (s, e) => {
  const g = latestGate(s, 'spec')
  if (!g || g.status === 'refused') return goto(s, e, 'brainstorm')
  if (g.status === 'pending') return 'wait'
  if (!s.worktree) return block(s, e, 'cannot commit the spec: worktree unknown')
  const r = await commitIfChanged(s, e, specPath(s), `docs(${s.id}): spec ${s.slug}`, 'spec')
  if (r === 'missing') return block(s, e, `approved spec missing from the worktree: ${join(s.worktree, specPath(s))}`)
  return goto(s, e, 'plan')
}

const stepPlan: StepFn = async (s, e) => {
  const g = latestGate(s, 'plan')
  if (!g || g.status !== 'approved') return 'wait'
  if (!s.worktree) return block(s, e, 'cannot read the plan: worktree unknown')
  const rel = planPath(s)
  let md: string
  try {
    md = await readFile(join(s.worktree, rel), 'utf8')
  } catch {
    return block(s, e, `approved plan missing from the worktree: ${join(s.worktree, rel)}`)
  }
  const parsed = parsePlan(md)
  if (!parsed.ok) return block(s, e, `approved plan invalid (${rel}):\n- ${parsed.errors.join('\n- ')}`)
  await mkdir(missionDir(s.id), { recursive: true })
  await writeFile(join(missionDir(s.id), 'plan.approved.md'), md)
  s.tasks = parsed.tasks.map((t) => ({ n: t.n, title: t.title, testCommand: t.testCommand, phase: 'pending', round: 0 }))
  if ((await commitIfChanged(s, e, rel, `docs(${s.id}): plan ${s.slug}`, 'plan')) === 'missing') {
    return block(s, e, `approved plan missing from the worktree: ${join(s.worktree, rel)}`)
  }
  return goto(s, e, 'tasks')
}

const waiting: StepFn = async () => 'wait'
const stopped: StepFn = async () => 'stop'

/** After the tasks, an approved amendment is applied before the step and can send the mission back to `tasks`. */
const afterAmendment =
  (next: StepFn): StepFn =>
  async (s, e, cfg) => {
    if (await applyPendingAmendment(s, e, cfg)) return 'continue'
    return next(s, e, cfg)
  }

/** One function per step. */
export const steps: Record<Step, StepFn> = {
  env: stepEnv,
  prepare: stepPrepare,
  classify: stepClassify,
  brainstorm: stepBrainstorm,
  spec: stepSpec,
  plan: stepPlan,
  // Deferred calls: `tasks.ts` and `finish.ts` import this module (circular import).
  tasks: (s, e, cfg) => stepTasks(s, e, cfg),
  // These two steps apply amendments themselves, outside the correction loop in progress (R14).
  'global-review': (s, e, cfg) => stepGlobalReview(s, e, cfg),
  preflight: (s, e, cfg) => stepPreflight(s, e, cfg),
  pr: afterAmendment((s, e, cfg) => stepPr(s, e, cfg)),
  blocked: waiting,
  'pr-open': stopped,
  closed: stopped,
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Archives `correctifs-<n>.md` files in the directory: a replayed round writes a fresh one. */
async function archiveCorrections(s: MissionState, e: Effects, dir: string, gateId: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const m = /^correctifs-(\d+)\.md$/.exec(name)
    if (!m) continue
    await rename(join(dir, name), join(dir, `correctifs-${m[1]}.avant-${gateId}.md`))
    log(s, e, `${join(dir, name)} archived before resume`)
  }
}

/**
 * Approved `resume-blocked` gate (R12/R13), or an approved amendment on a mission blocked in the task loop:
 * the mission restarts from the step where it stopped, with a fresh round budget for the loop involved
 * (current task, global review or preflight). `why`: the user's decision, for the orchestrator.
 */
async function resumeBlocked(s: MissionState, e: Effects, gateId: string, why = 'the mission resume'): Promise<void> {
  const from = s.blockedFrom
  if (s.step !== 'blocked' || !from) {
    log(s, e, `resume ${gateId} ignored: mission ${s.step === 'blocked' ? 'with no known origin step' : 'not blocked'}`)
    return
  }
  const dir = missionDir(s.id)
  if (from === 'tasks') {
    const t = s.tasks.find((x) => x.phase !== 'done')
    if (t) {
      t.round = 0
      await archiveCorrections(s, e, taskDir(s, t), gateId)
      // No commit since the base: replaying the check would block again. The implementer receives the brief again
      // (possibly rewritten by an amendment) instead of waiting on instructions that are already closed.
      if ((t.phase === 'control' || t.phase === 'implement') && t.baseSha && s.worktree && (await e.git.headSha(s.worktree)) === t.baseSha) {
        log(s, e, `task ${t.n}: no commit since ${t.baseSha}, ${t.phase} → implement, the implementer receives the brief again`)
        t.phase = 'implement'
        delete t.pendingAsk
      }
    }
  } else if (from === 'global-review') {
    s.loops.globalReview.round = 0
    await archiveCorrections(s, e, join(dir, 'global'), gateId)
  } else if (from === 'preflight') {
    s.loops.preflight.round = 0
    await archiveCorrections(s, e, join(dir, 'preflight'), gateId)
  }
  // Fresh budget for the automatic rebase of the PR step too.
  s.loops.prRebases = 0
  const reason = s.blockedReason
  delete s.blockedReason
  delete s.blockedFrom
  log(s, e, `resume approved (${gateId}): back to step ${from}`)
  s.step = from
  await informOrchestrator(s, e, `The user approved ${why} (block: ${reason ?? '?'}). Back to step ${from}.`)
}

/** True when a correction (task, global review or preflight) is in phase `fix`: it may be waiting for arbitration. */
function correctionWaiting(s: MissionState): boolean {
  return s.tasks.some((t) => t.phase === 'fix') || s.loops.globalReview.phase === 'fix' || s.loops.preflight.phase === 'fix'
}

/** True when a task, the global review or the preflight is still holding this `agent-stopped` gate. */
function stopGateHeld(s: MissionState, id: string): boolean {
  return s.tasks.some((t) => t.stopGate === id) || s.loops.globalReview.stopGate === id || s.loops.preflight.stopGate === id
}

/** Approved `abandon` gate: test databases removed, then mission `closed`; a failure blocks the mission. */
async function abandonMission(s: MissionState, e: Effects, cfg: ProjectConfig, gateId: string): Promise<void> {
  const test = await testDbDown(s, e, cfg)
  const proof = await proofDbDown(s, e, cfg)
  if (test || proof) {
    await blockDbNotDown(s, e, test ? s.id : `${s.id}-main`, [test, proof].filter(Boolean).join('; '))
    return
  }
  log(s, e, `abandon approved (${gateId}): mission closed`)
  s.step = 'closed'
  await stopAgentsTab(s, e, 'all', 'abandon approved')
  await informOrchestrator(s, e, `The user approved the abandon (gate ${gateId}): the mission is closed.`)
}

export class Engine {
  /** Errors already written to the journal during this process, by origin and message. */
  private loggedErrors = new Set<string>()

  constructor(
    private readonly id: string,
    private readonly e: Effects,
    private readonly cfg: ProjectConfig,
  ) {}

  /** Does not write the same error twice for the same origin. `true` if the entry is in the journal. */
  private async recordError(ctx: ErrorContext, err: unknown): Promise<boolean> {
    const sig = `${ctx.origin}\0${errMsg(err)}`
    if (this.loggedErrors.has(sig)) return true
    const ok = await logHernessError(ctx, err)
    if (ok) this.loggedErrors.add(sig)
    return ok
  }

  private print(s: MissionState, from: number): void {
    if (!process.stdout.isTTY) return
    for (const l of s.log.slice(from)) console.log(`${l.at} ${l.msg}`)
  }

  private async handle(s: MissionState, m: InboxMessage): Promise<void> {
    const { e, cfg } = this
    switch (m.type) {
      case 'decision': {
        const r = applyDecision(s, m)
        if (!r.ok) {
          log(s, e, `decision ignored: ${r.reason}`)
          return
        }
        const g = r.gate
        if (g.kind === 'abandon') {
          if (g.status === 'approved') await abandonMission(s, e, cfg, g.id)
          else {
            log(s, e, `abandon rejected (${g.id})${g.note ? `: ${g.note}` : ''}`)
            await informOrchestrator(s, e, `The user rejected the abandon (gate ${g.id})${g.note ? `, with the note: ${g.note}` : ''}. The mission continues.`)
          }
          return
        }
        if (g.kind === 'resume-blocked') {
          if (g.status === 'approved') await resumeBlocked(s, e, g.id)
          else log(s, e, `resume rejected (${g.id}): the mission stays blocked${g.note ? ` (${g.note})` : ''}`)
          return
        }
        if (g.kind === 'arbitration' && !correctionWaiting(s)) {
          // Consumed: its note will not enter a later corrections file unrelated to it.
          s.consumedArbitrages.push(g.id)
          log(s, e, `arbitration ${g.id} ${g.status === 'approved' ? 'approved' : 'rejected'} with no effect: no correction was waiting for a decision`)
          const hint = s.step === 'blocked' ? ` The mission stays blocked: the user resumes it with herness resume ${s.id} then approval, or unblocks it by approving an amendment.` : ''
          await informOrchestrator(s, e, `arbitration ${g.id} with no effect: no correction was waiting for a decision.${hint}`)
          return
        }
        if (g.kind === 'agent-stopped' && !stopGateHeld(s, g.id)) {
          // An amendment already resumed the task: nothing is waiting for this decision anymore.
          log(s, e, `gate ${g.id} (agent-stopped) ${g.status === 'approved' ? 'approved' : 'rejected'} with no effect: the task already resumed with its amended instructions`)
          return
        }
        if (g.status === 'approved') {
          log(s, e, `gate ${g.id} (${g.kind}) approved`)
          await informOrchestrator(s, e, `The user approved gate ${g.id} (${g.kind})${g.note ? `, with the note: ${g.note}` : ''}.`)
          if (g.kind === 'amendment' && s.step === 'blocked' && s.blockedFrom === 'tasks') await this.amendBlocked(s, g.id)
        } else {
          log(s, e, `gate ${g.id} (${g.kind}) rejected: ${g.note ?? ''}`)
          const again = g.kind === 'spec' || g.kind === 'plan' ? ` Fix it, then request approval again with request_approval('${g.kind}').` : ''
          await informOrchestrator(s, e, `The user rejected gate ${g.id} (${g.kind}). Reason: ${g.note ?? '(none)'}.${again}`)
        }
        return
      }
      case 'request-gate': {
        const summary = m.kind === 'amendment' ? m.summary + (await this.blockedAmendmentNote(s)) : m.summary
        if (m.kind === 'resume-blocked' && s.step !== 'blocked') {
          log(s, e, `resume request ignored: the mission is not blocked (step ${s.step})`)
          return
        }
        const dup = s.gates.find((x) => x.kind === m.kind && x.status === 'pending')
        if (dup) {
          dup.summary = summary
          if (m.path !== undefined) dup.path = m.path
          if (m.hash !== undefined) dup.hash = m.hash
          log(s, e, `gate request ${m.kind}: gate ${dup.id} is already pending, updated`)
          await informOrchestrator(s, e, `Gate ${dup.id} (${m.kind}) is already pending the user's decision; summary updated, no new gate opened.`)
          return
        }
        const g = openGate(s, m.kind, summary, m.path, m.hash)
        log(s, e, `gate ${g.id} (${g.kind}) opened: ${g.summary}`)
        await notify(s, e, `Gate ${g.kind} to approve: ${g.summary}`)
        await informOrchestrator(s, e, `Gate ${g.id} (${g.kind}) opened, waiting for the user's decision (herness approve|reject ${s.id} --gate ${g.id}).`)
        return
      }
      case 'classified': {
        if (s.branch && s.branch !== `herness/${s.id}`) {
          log(s, e, `classification ${m.workType}/${m.slug} ignored: branch already named ${s.branch}`)
          return
        }
        if (!(m.workType in cfg.branchPrefixes)) {
          log(s, e, `classification ignored: unknown type "${m.workType}" (${Object.keys(cfg.branchPrefixes).join(', ')})`)
          return
        }
        if (!SLUG.test(m.slug)) {
          log(s, e, `classification ignored: invalid slug "${m.slug}"`)
          return
        }
        s.type = m.workType
        s.slug = m.slug
        log(s, e, `mission classified: ${m.workType} / ${m.slug}`)
        const at = (rel: string): string => (s.worktree ? join(s.worktree, rel) : rel)
        await informOrchestrator(s, e, `Mission classified ${m.workType} / ${m.slug}. Write the spec at ${at(specPath(s))} and the plan at ${at(planPath(s))} (exact paths).`)
        return
      }
      case 'orchestrator-started':
        s.orchestrator.started = true
        log(s, e, 'opening prompt sent to the orchestrator')
        return
      case 'pause':
        s.paused = true
        log(s, e, 'pause')
        return
      case 'resume':
        s.paused = false
        log(s, e, 'resume')
        return
      case 'abandon': {
        // Only the user closes: the request opens an `abandon` gate.
        const dup = s.gates.find((x) => x.kind === 'abandon' && x.status === 'pending')
        if (dup) {
          log(s, e, `abandon request: gate ${dup.id} is already pending`)
          return
        }
        const g = openGate(s, 'abandon', m.reason)
        log(s, e, `gate ${g.id} (abandon) opened: ${m.reason}`)
        await notify(s, e, `Abandon to approve: ${m.reason}`)
        await informOrchestrator(s, e, `Gate ${g.id} (abandon) opened, waiting for the user's decision (herness approve|reject ${s.id} --gate ${g.id}).`)
        return
      }
    }
  }

  /**
   * Amendment approved while the mission is blocked in the task loop: it is applied immediately. If
   * the task is what blocks the mission and the amendment changes its text, approving the change counts as a decision
   * to continue: the mission resumes as after an approved resume. Otherwise it stays blocked.
   */
  private async amendBlocked(s: MissionState, gateId: string): Promise<void> {
    const { e } = this
    const r = await applyAmendment(s, e, this.cfg)
    if (r.status === 'none') log(s, e, `amendment ${gateId} approved: not applicable yet, the mission stays blocked`)
    if (r.status !== 'applied') return
    if (unblocksMission(s, r.resumed)) {
      await resumeBlocked(s, e, gateId, `amendment ${gateId}, which restarts task ${r.resumed}`)
      return
    }
    log(s, e, `amendment ${gateId} applied, the mission stays blocked (${s.blockedReason ?? '?'})`)
    await informOrchestrator(s, e, `Amendment ${gateId} applied, mission still blocked: herness resume ${s.id} to restart it.`)
  }

  /** Blocked mission: what approving an amendment will change, appended to its gate summary. */
  private async blockedAmendmentNote(s: MissionState): Promise<string> {
    if (s.step !== 'blocked') return ''
    const plan = await readFile(proposedPlanPath(s.id), 'utf8').catch(() => '')
    const n = plan ? await amendmentWouldResume(s, plan) : undefined
    return n !== undefined ? ` (mission blocked: approving this amendment will restart task ${n})` : ' (mission blocked: approving does not clear the block)'
  }

  async tick(): Promise<StepResult> {
    const s = await loadState(this.id)
    const from = s.log.length
    const msgs = await drainInbox(this.id)
    for (const m of msgs) await this.handle(s, m)
    if (msgs.length > 0) await saveState(s)
    let r: StepResult
    if (s.step === 'pr-open' || s.step === 'closed') r = 'stop'
    else if (s.paused) r = 'wait'
    else {
      r = await steps[s.step](s, this.e, this.cfg)
      await saveState(s)
    }
    this.print(s, from)
    return r
  }

  /** Unexpected error: the mission moves to `blocked` (test database stopped) and the engine continues. */
  private async fail(err: unknown): Promise<void> {
    const msg = `engine error: ${errMsg(err)}`
    console.error(`herness ${this.id}: ${msg}`)
    let logged = false
    try {
      const s = await loadState(this.id)
      const wrote = await this.recordError({ mission: this.id, origin: 'engine', step: s.step }, err)
      logged = wrote
      const dbErrors = [await testDbDown(s, this.e, this.cfg), await proofDbDown(s, this.e, this.cfg)].filter((x) => x !== null)
      const base = dbErrors.length ? `${msg}\ntest database(s) not removed: ${dbErrors.join('; ')}` : msg
      await block(s, this.e, wrote ? `${base}\ndetail: ${errorLogPath()}` : base)
      await saveState(s)
    } catch (err2) {
      if (!logged) await this.recordError({ mission: this.id, origin: 'engine' }, err)
      console.error(`herness ${this.id}: could not record the block: ${errMsg(err2)}`)
      await this.recordError({ mission: this.id, origin: 'engine: recording the block' }, err2)
    }
  }

  /**
   * Engine startup: a command started by a previous engine (label ending with "…" in the checks
   * and process tabs) may still be running; it is interrupted (double ctrl+c) and marked ✗.
   */
  private async interruptStaleCommands(): Promise<void> {
    const { e } = this
    const s = await loadState(this.id)
    const stale: string[] = []
    for (const kind of ['checks', 'process']) {
      const tab = s.herdr.tabs[kind]
      if (!tab) continue
      try {
        const panes = (await e.herdr.paneList(tab.split(':')[0] as string)).filter((p) => p.tabId === tab && p.label?.endsWith('…'))
        for (const p of panes) {
          await e.herdr.paneSendKeys(p.paneId, 'ctrl+c')
          await e.herdr.paneSendKeys(p.paneId, 'ctrl+c')
          await e.herdr.paneRename(p.paneId, (p.label ?? '').replace(/\s*…$/, ''))
          await markDone(e.herdr, p.paneId, '✗')
          stale.push(p.label ?? p.paneId)
        }
      } catch (err) {
        log(s, e, `tab ${kind}: running commands not interrupted (${errMsg(err)})`)
      }
    }
    if (stale.length) log(s, e, `engine startup: command(s) from a previous engine interrupted: ${stale.join(', ')}`)
    await saveState(s)
  }

  /** Engine startup: stops agents that are already finished; the whole mission if it is already closed. */
  private async releaseFinishedAgents(): Promise<void> {
    const s = await loadState(this.id)
    await stopAgentsTab(s, this.e, s.step === 'pr-open' || s.step === 'closed' ? 'all' : 'done', 'engine startup')
    await saveState(s)
  }

  async run(): Promise<void> {
    try {
      await this.interruptStaleCommands()
    } catch (err) {
      console.error(`herness ${this.id}: could not clean panes at startup: ${errMsg(err)}`)
      await logHernessError({ mission: this.id, origin: 'engine: startup (pane cleanup)' }, err)
    }
    try {
      await this.releaseFinishedAgents()
    } catch (err) {
      console.error(`herness ${this.id}: could not stop finished agents at startup: ${errMsg(err)}`)
      await logHernessError({ mission: this.id, origin: 'engine: startup (stopping finished agents)' }, err)
    }
    for (;;) {
      let r: StepResult
      try {
        r = await this.tick()
      } catch (err) {
        await this.fail(err)
        r = 'wait'
      }
      if (r === 'stop') return
      if (r === 'wait') await this.e.sleep(1000)
    }
  }
}
