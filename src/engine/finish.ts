import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Role } from '../agents/adapters.ts'
import { diagnosticName, globalFixerName, globalReviewerName, preflightFixerName } from '../agents/names.ts'
import { fill, mainRef, type ProjectConfig } from '../config/project.ts'
import { markDone } from '../herdr/layout.ts'
import { nextLoopRound } from '../mission/loop.ts'
import { freshLoops, saveState, type MissionState, type PendingAsk, type PreflightResult, type PreflightState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { render } from '../prompts/render.ts'
import type { Effects } from './effects.ts'
import { block, blockDbNotDown, goto, proofWorktree, informOrchestrator, log, notify, proofDbDown, testDbDown, type StepResult } from './engine.ts'
import { openGate } from './gates.ts'
import {
  applyPendingAmendment,
  arbitrationPending,
  ASK_TIMEOUT_MS,
  askAgent,
  awaitAgent,
  ensureAgent,
  exists,
  findingsOf,
  fileSize,
  consumeArbitrations,
  forbidden,
  onCorrections,
  pendingAmendment,
  settle,
  settleStop,
  stopAgent,
  stopAgentsTab,
  stopSection,
  stopWithoutCommit,
  type AgentSite,
  type AskHolder,
} from './tasks.ts'

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const globalDir = (s: MissionState): string => join(missionDir(s.id), 'global')
const preflightDir = (s: MissionState): string => join(missionDir(s.id), 'preflight')
const logsDir = (s: MissionState): string => join(missionDir(s.id), 'logs')
/** Global reviewer: re-reads the branch, then each fix from the global review and the preflight. */
const globalReviewer = (s: MissionState): string => globalReviewerName(s.id, s.loopGeneration)

const constraints = (s: MissionState, cfg: ProjectConfig): string => `Those of the spec (\`${specPath(s)}\`), and these forbidden items:\n${forbidden(cfg)}`

async function firstLine(path: string): Promise<string> {
  return (await readFile(path, 'utf8').catch(() => '')).replace(/^﻿/, '').split('\n')[0]!.trim()
}

const VERDICTS: Record<string, 'approved' | 'changes'> = { 'VERDICT: APPROVED': 'approved', 'VERDICT: CORRECTIONS': 'changes' }
const causeOf = (line: string): 'BRANCH' | 'MAIN' | 'ENVIRONMENT' | undefined =>
  /^CAUSE: (BRANCH|MAIN|ENVIRONMENT)$/.exec(line)?.[1] as 'BRANCH' | 'MAIN' | 'ENVIRONMENT' | undefined

async function markPane(s: MissionState, e: Effects, name: string): Promise<void> {
  const pane = s.herdr.panes[name]
  if (!pane) return
  try {
    await markDone(e.herdr, pane, '✓')
  } catch (err) {
    log(s, e, `could not mark ✓ on ${pane}: ${errMsg(err)}`)
  }
  await stopAgent(s, e, 'end of mission', name)
}

type Agent = { site: AgentSite; name: string; role: Role; model: string }

/**
 * One brief to an agent, including resume (same rules as the task loop). A brief in progress
 * (`h.pendingAsk`) is never resent to a living agent: its outcome is awaited. If the agent is gone and
 * `delivered` finds its work, that work is taken as is; otherwise the agent is restarted and the same brief is resent.
 * Returns the handled brief, or the step result (waiting on a gate, blocked).
 */
async function converse(
  s: MissionState,
  e: Effects,
  h: AskHolder,
  a: Agent,
  make: () => Promise<PendingAsk>,
  delivered: (pa: PendingAsk) => Promise<boolean>,
): Promise<PendingAsk | StepResult> {
  const what = a.site.what
  if (h.blockedGate) {
    const g = s.gates.find((x) => x.id === h.blockedGate)
    if (g?.status === 'pending') return 'wait'
    delete h.blockedGate
    if (g?.status === 'refused') return block(s, e, `${what}: blocked agent, gate ${g.id} refused${g.note ? ` (${g.note})` : ''}`)
    log(s, e, `${what}: agent unblocked, waiting for it to finish without resending`)
  }
  let pa = h.pendingAsk
  if (pa) {
    if (await e.herdr.agentGet(pa.agent)) {
      log(s, e, `${what}: resume, waiting for ${pa.agent} without resending ${pa.file}`)
      const r = await awaitAgent(s, e, h, what, a.role, pa)
      return r === 'done' ? pa : r
    }
    delete h.pendingAsk
    log(s, e, `${what}: resume, ${pa.agent} gone during ${pa.file}`)
    if (await delivered(pa)) return pa
  } else {
    pa = await make()
  }
  await ensureAgent(s, e, a.site, a.name, a.role, a.model)
  const r = await askAgent(s, e, h, what, a.role, pa)
  return r === 'done' ? pa : r
}

const reviewerDelivered = async (pa: PendingAsk): Promise<boolean> => !!pa.out && (await firstLine(pa.out)) in VERDICTS
const implementerDelivered =
  (s: MissionState, e: Effects) =>
  async (pa: PendingAsk): Promise<boolean> =>
    !!pa.fromSha && (await e.git.headSha(s.worktree as string)) !== pa.fromSha

/** Fix file for a fresh implementer (global review or preflight): written once per round. */
async function writeFix(
  s: MissionState,
  cfg: ProjectConfig,
  dir: string,
  file: string,
  origin: string,
  findings: string,
  failure: string,
  stopDecision?: string,
): Promise<void> {
  const reportPath = join(dir, 'report.md')
  const head =
    `Correction requested by ${origin}, for the whole branch. Spec: \`${specPath(s)}\`, plan: \`${planPath(s)}\`. ` +
    `There is no task brief: your scope is what is described below.\n` +
    `Append your report to the end of \`${reportPath}\`, without erasing earlier reports.\n\n`
  const body = await render('correction', { findings, failure, forbidden: forbidden(cfg), reportPath, language: cfg.language })
  await mkdir(dir, { recursive: true })
  await writeFile(file, head + body + (stopDecision ? stopSection(stopDecision) : '') + consumeArbitrations(s))
}

/** Re-review by `rg<id>` of the diff since its last reviewed head. */
async function rereviewAsk(s: MissionState, e: Effects, cfg: ProjectConfig, dir: string, round: number, findings: string): Promise<PendingAsk> {
  const wt = s.worktree as string
  const base = s.loops.globalReview.reviewedSha ?? (await e.git.mergeBase(wt, mainRef(cfg)))
  await mkdir(dir, { recursive: true })
  const diffPath = join(dir, `correction-${round}.diff`)
  const head = (await e.git.diffPackage(wt, base, diffPath)).head
  const out = join(dir, `rerevue-${round}.md`)
  const file = join(dir, `consigne-rerevue-${round}.md`)
  await writeFile(
    file,
    await render('rereview', {
      briefPath: join(globalDir(s), 'review-brief.md'),
      reportPath: join(dir, 'report.md'),
      constraints: constraints(s, cfg),
      baseSha: base,
      headSha: head,
      diffPath,
      outPath: out,
      findings,
    }),
  )
  return { agent: globalReviewer(s), file, out, head }
}

const reviewerAgent = (s: MissionState, cfg: ProjectConfig, what: string): Agent => ({
  site: { what, pane: 'RG' },
  name: globalReviewer(s),
  role: 'reviewer',
  model: cfg.models.reviewer,
})
const fixerAgent = (cfg: ProjectConfig, what: string, name: string, pane: string, fixer: 'new' | 'strong' | undefined): Agent => {
  const model = fixer === 'strong' ? cfg.models.implementerStrong : cfg.models.implementer
  return { site: { what, pane }, name, role: 'implementer', model }
}

// ---------------------------------------------------------------- global review (step 8)

const GR = 'global review'

/**
 * Step 8: fresh reviewer `rg<id>` on `merge-base(origin/main)..HEAD`; corrections → fresh implementer
 * `cg<id>-<r>` → control → tests of the touched tasks → re-review by `rg<id>`. Approved → `preflight`.
 */
export async function stepGlobalReview(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  // An amendment waits for the end of a correction loop already in progress (R14).
  const busy = G.round > 0 || G.pendingAsk !== undefined || G.blockedGate !== undefined
  if (!busy && (await applyPendingAmendment(s, e, cfg))) return 'continue'
  if (!s.worktree || !s.herdr.tabs['agents'] || !s.herdr.tabs['checks']) {
    return block(s, e, 'global review impossible: worktree or agents/checks tabs unknown')
  }
  if (G.stopGate) {
    const r = await settleStop(s, e, G, GR)
    if (r !== 'approved') return r
    return nextGlobalRound(s, e, G.lastFailure)
  }
  switch (G.phase) {
    case undefined:
    case 'rereview':
      return globalReview(s, e, cfg)
    case 'fix':
      return globalFix(s, e, cfg)
    case 'control': {
      const r = await e.git.controlCommits(s.worktree, G.fixBase ?? '', cfg.forbiddenPaths, mainRef(cfg))
      if (!r.ok && r.code === 'no-commit') {
        const stop = await stopWithoutCommit(s, e, G, GR, join(globalDir(s), 'report.md'))
        if (stop) return stop
      }
      if (!r.ok) return block(s, e, `${GR} (round ${G.round}): commit check failed\n${r.reason}`)
      G.phase = 'test'
      return 'continue'
    }
    case 'test':
      return globalTests(s, e, cfg)
  }
}

async function globalReview(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  const wt = s.worktree as string
  const dir = globalDir(s)
  const first = async (): Promise<PendingAsk> => {
    await mkdir(dir, { recursive: true })
    const base = await e.git.mergeBase(wt, mainRef(cfg))
    const diffPath = join(dir, 'branch.diff')
    const head = (await e.git.diffPackage(wt, base, diffPath)).head
    const out = join(dir, 'review.md')
    const file = join(dir, 'review-brief.md')
    const vars = { baseSha: base, headSha: head, diffPath, specPath: specPath(s), planPath: planPath(s), constraints: constraints(s, cfg), outPath: out }
    await writeFile(file, await render('global-review', vars))
    log(s, e, `${GR}: branch ${base}..${head}`)
    return { agent: globalReviewer(s), file, out, head }
  }
  const make = G.phase === 'rereview' ? async () => rereviewAsk(s, e, cfg, dir, G.round, await findingsOf(G.lastReview)) : first
  const pa = await converse(s, e, G, reviewerAgent(s, cfg, GR), make, reviewerDelivered)
  if (typeof pa === 'string') return pa
  const out = pa.out as string
  const line = await firstLine(out)
  const v = VERDICTS[line]
  if (!v) return block(s, e, `${GR}: unreadable verdict in ${out} ("${line}")`)
  G.reviewedSha = pa.head ?? (await e.git.headSha(wt))
  G.lastReview = out
  if (v === 'approved') {
    log(s, e, `${GR} approved${G.round > 0 ? ` at round ${G.round}` : ''}`)
    s.loops.globalReview = { round: 0, reviewedSha: G.reviewedSha, lastReview: out }
    s.loops.preflight = freshLoops().preflight
    return goto(s, e, 'preflight')
  }
  const r = await nextGlobalRound(s, e)
  await onCorrections(s, e, GR, out, G.round)
  return r
}

/** New global-review round: findings from the last review, or the red test output (`failure`). */
async function nextGlobalRound(s: MissionState, e: Effects, failure?: string): Promise<StepResult> {
  const G = s.loops.globalReview
  const d = nextLoopRound(G.round)
  G.round = d.round
  if (d.blocked) return block(s, e, `${GR}: ${d.blocked}${failure ? `\n${failure}` : ''}`)
  G.fixer = d.fixer === 'strong' ? 'strong' : 'new'
  if (failure) G.lastFailure = failure
  else delete G.lastFailure
  delete G.fixBase
  G.phase = 'fix'
  log(s, e, `${GR}: correction round ${G.round} (${G.fixer}), ${failure ? 'red tests' : 'review findings'}`)
  return 'continue'
}

async function globalFix(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  const dir = globalDir(s)
  const file = join(dir, `fixes-${G.round}.md`)
  if (!(await exists(file))) {
    if (arbitrationPending(s)) return 'wait'
    const failure = G.lastFailure ?? ''
    await writeFix(s, cfg, dir, file, 'the global review', failure ? '' : await findingsOf(G.lastReview), failure, G.stopDecision)
  }
  delete G.stopDecision
  G.fixBase ??= await e.git.headSha(s.worktree as string)
  const name = globalFixerName(s.id, s.loopGeneration, G.round)
  const fixBase = G.fixBase
  const make = async (): Promise<PendingAsk> => {
    G.reportSize = await fileSize(join(dir, 'report.md'))
    return { agent: name, file, fromSha: fixBase, report: { path: join(dir, 'report.md'), size: G.reportSize } }
  }
  const pa = await converse(s, e, G, fixerAgent(cfg, GR, name, `CG${G.round}`, G.fixer), make, implementerDelivered(s, e))
  if (typeof pa === 'string') return pa
  await markPane(s, e, name)
  G.phase = 'control'
  return 'continue'
}

/**
 * Tasks whose files overlap the fix; none → all of them. Each command is run only once.
 * Commits from main brought in by the fixer's rebase do not count as part of the fix.
 */
async function touchedTasks(s: MissionState, e: Effects, cfg: ProjectConfig, fixBase: string): Promise<MissionState['tasks']> {
  const wt = s.worktree as string
  const fixed = new Set(await e.git.branchFiles(wt, fixBase, mainRef(cfg)))
  const touched: MissionState['tasks'] = []
  for (const t of s.tasks) {
    if (!t.baseSha || !t.reviewedSha) continue
    if ((await e.git.changedFiles(wt, t.baseSha, t.reviewedSha)).some((f) => fixed.has(f))) touched.push(t)
  }
  const list = touched.length > 0 ? touched : s.tasks
  const seen = new Set<string>()
  return list.filter((t) => !seen.has(t.testCommand) && seen.add(t.testCommand))
}

async function globalTests(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  const wt = s.worktree as string
  const tab = s.herdr.tabs['checks'] as string
  for (const t of await touchedTasks(s, e, cfg, G.fixBase ?? (await e.git.headSha(wt)))) {
    const r = await e.runInPane(e.herdr, tab, wt, `RG · tests T${t.n}`, ['bash', '-c', t.testCommand], logsDir(s))
    if (r.exitCode !== 0) {
      return nextGlobalRound(s, e, `Tests for task ${t.n}\nCommand: ${t.testCommand}\nExit code: ${r.exitCode}\nFull log: ${r.logPath}\n\n${r.tail}`)
    }
  }
  G.phase = 'rereview'
  return 'continue'
}

// ---------------------------------------------------------------- preflight (step 9)

const PF = 'preflight'

type FalsePositive = ProjectConfig['falsePositives'][number]

/**
 * First known false positive that applies: `label` equal (or absent), `pattern` found on a log line,
 * not already applied to this check (`used`). An `ignore` rule applies only when no file touched by the branch
 * appears in the log (R5).
 */
export function findFalsePositive(
  result: { label: string; log: string },
  cfg: ProjectConfig,
  touchedFiles: string[],
  used: number[] = [],
): { index: number; rule: FalsePositive } | undefined {
  const lines = result.log.split('\n')
  for (const [index, rule] of cfg.falsePositives.entries()) {
    if (used.includes(index)) continue
    if (rule.label !== undefined && rule.label !== result.label) continue
    const re = new RegExp(rule.pattern)
    if (!lines.some((l) => re.test(l))) continue
    if (rule.action === 'ignore' && touchedFiles.some((f) => result.log.includes(f))) continue
    return { index, rule }
  }
  return undefined
}

export function triage(
  result: { label: string; log: string },
  cfg: ProjectConfig,
  touchedFiles: string[],
  used: number[] = [],
): 'retry' | 'ignore' | { cleanup: string[] } | 'diagnose' {
  const fp = findFalsePositive(result, cfg, touchedFiles, used)
  if (!fp) return 'diagnose'
  if (fp.rule.action === 'cleanup') return { cleanup: fp.rule.cleanup ?? [] }
  return fp.rule.action
}

/** The preflight run restarts from the first check (after a fix, or for a resume after a block). */
function restartRun(P: PreflightState): void {
  P.results = []
  P.used = []
  P.fetched = false
  delete P.phase
  delete P.failing
  delete P.gate
}

/**
 * Step 9. Guarantee: every exit from the step (to `pr`, `blocked`, `tasks` after an amendment, or an exception)
 * stops the mission test database. During a correction loop, the database stays up from one round to the next.
 */
export async function stepPreflight(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  let failed = false
  try {
    return await preflight(s, e, cfg)
  } catch (err) {
    failed = true
    throw err
  } finally {
    if (failed) {
      // Stop errors are reported by `Engine.fail`, which retries on the saved state.
      await testDbDown(s, e, cfg)
      await proofDbDown(s, e, cfg)
    } else if (s.step !== 'preflight') {
      const err = await testDbDown(s, e, cfg)
      if (err) await blockDbNotDown(s, e, s.id, err)
    }
  }
}

async function preflight(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const busy = P.round > 0 || P.phase !== undefined || P.pendingAsk !== undefined || P.blockedGate !== undefined
  if (!busy && pendingAmendment(s)) {
    // The database is removed BEFORE the amendment is applied: on failure, the mission stays at preflight (R14).
    const err = await testDbDown(s, e, cfg)
    if (err) return blockDbNotDown(s, e, s.id, err)
    if (await applyPendingAmendment(s, e, cfg)) return 'continue'
  }
  if (!s.worktree || !s.herdr.tabs['agents'] || !s.herdr.tabs['checks'] || !s.herdr.tabs['process']) {
    return block(s, e, 'preflight impossible: worktree or agents/checks/process tabs unknown')
  }
  if (P.stopGate) {
    const r = await settleStop(s, e, P, PF)
    if (r !== 'approved') return r
    return startFix(s, e, P.fixFindings ?? '', P.fixFailure ?? '')
  }
  switch (P.phase) {
    case undefined:
      return nextCheck(s, e, cfg)
    case 'diagnose':
      return diagnose(s, e, cfg)
    case 'proof':
      return proveOnMain(s, e, cfg)
    case 'gate':
      return mainGate(s, e)
    case 'fix':
      return preflightFix(s, e, cfg)
    case 'control': {
      const r = await e.git.controlCommits(s.worktree, P.fixBase ?? '', cfg.forbiddenPaths, mainRef(cfg))
      if (!r.ok && r.code === 'no-commit') {
        const stop = await stopWithoutCommit(s, e, P, PF, join(preflightDir(s), 'report.md'))
        if (stop) return stop
      }
      if (!r.ok) return block(s, e, `${PF} (round ${P.round}): commit check failed\n${r.reason}`)
      P.phase = 'rereview'
      return 'continue'
    }
    case 'rereview':
      return preflightRereview(s, e, cfg)
  }
}

async function nextCheck(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const wt = s.worktree as string
  const vars = { id: s.id, worktree: wt }
  if (cfg.testDb && !s.testDbUp) {
    // Saved before launch: a half-created database is still removed after an engine stop.
    s.testDbUp = true
    await saveState(s)
    const r = await e.runInPane(e.herdr, s.herdr.tabs['process'] as string, wt, 'test database', fill(cfg.testDb.up, vars), logsDir(s))
    if (r.exitCode !== 0) return block(s, e, `${PF}: test database not created (code ${r.exitCode}), log: ${r.logPath}\n${r.tail}`)
    log(s, e, `${PF}: test database ${s.id} created`)
    return 'continue'
  }
  const check = cfg.preflight[P.results.length]
  if (!check) {
    const err = await testDbDown(s, e, cfg)
    if (err) return blockDbNotDown(s, e, s.id, err)
    await markPane(s, e, globalReviewer(s))
    P.validatedSha = await e.git.headSha(wt)
    const red = P.results.filter((r) => r.exitCode !== 0).map((r) => r.label)
    log(s, e, `${PF} finished: ${P.results.length} checks${red.length ? `, accepted red: ${red.join(', ')}` : ', all green'}`)
    return goto(s, e, 'pr')
  }
  if (!P.fetched) {
    // The build filters on `...[origin/main]` (R6): origin/main is up to date before the first check of the run.
    await e.git.fetchMain(wt, cfg.mainBranch)
    P.fetched = true
  }
  const r = await e.runInPane(e.herdr, s.herdr.tabs['checks'] as string, wt, `${PF} · ${check.label}`, fill(check.command, vars), logsDir(s))
  const result: PreflightResult = { label: check.label, exitCode: r.exitCode, durationMs: r.durationMs, logPath: r.logPath }
  if (r.exitCode === 0) {
    P.results.push(result)
    P.used = []
    return 'continue'
  }
  if (P.acceptedRed.includes(check.label)) {
    P.results.push({ ...result, note: `also red on ${mainRef(cfg)}, PR accepted anyway` })
    P.used = []
    log(s, e, `${PF}: ${check.label} red, already accepted (also red on main)`)
    return 'continue'
  }
  const text = await readFile(r.logPath, 'utf8').catch(() => r.tail)
  const touched = await e.git.changedFiles(wt, await e.git.mergeBase(wt, mainRef(cfg)))
  const fp = findFalsePositive({ label: check.label, log: text }, cfg, touched, P.used)
  if (fp) {
    P.used.push(fp.index)
    log(s, e, `${PF}: ${check.label} red, known false positive (${fp.rule.action}): ${fp.rule.explanation}`)
    if (fp.rule.action === 'ignore') {
      P.results.push({ ...result, note: `false positive ignored: ${fp.rule.explanation}` })
      P.used = []
    } else if (fp.rule.action === 'cleanup' && fp.rule.cleanup?.length) {
      const c = await e.runInPane(e.herdr, s.herdr.tabs['process'] as string, wt, 'cleanup', fill(fp.rule.cleanup, vars), logsDir(s))
      log(s, e, `${PF}: cleanup finished (code ${c.exitCode}), ${check.label} rerun`)
    }
    // retry and cleanup: the same check is rerun on the next turn.
    return 'continue'
  }
  P.failing = { ...result, tail: r.tail }
  P.diag += 1
  P.phase = 'diagnose'
  log(s, e, `${PF}: ${check.label} red (code ${r.exitCode}), diagnosis ${P.diag}`)
  return 'continue'
}

async function diagnose(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const f = P.failing
  if (!f) return block(s, e, `${PF}: diagnosis requested with no known red check`)
  const dir = preflightDir(s)
  const n = P.diag
  const name = diagnosticName(s.id, s.loopGeneration, n)
  const make = async (): Promise<PendingAsk> => {
    await mkdir(dir, { recursive: true })
    const out = join(dir, `diagnostic-${n}.md`)
    const file = join(dir, `consigne-diagnostic-${n}.md`)
    const command = cfg.preflight.find((c) => c.label === f.label)?.command.join(' ') ?? '?'
    const body = await render('diagnostic', { logPath: f.logPath, outPath: out })
    await writeFile(
      file,
      `${body}\n## Check\n\n- Label: \`${f.label}\`\n- Command: \`${command}\`\n- Exit code: ${f.exitCode}\n- Branch compared with: \`${mainRef(cfg)}\`\n`,
    )
    return { agent: name, file, out }
  }
  const agent: Agent = { site: { what: PF, pane: `RD${n}` }, name, role: 'diagnostic', model: cfg.models.reviewer }
  const pa = await converse(s, e, P, agent, make, async (x) => !!x.out && causeOf(await firstLine(x.out)) !== undefined)
  if (typeof pa === 'string') return pa
  await markPane(s, e, name)
  const out = pa.out as string
  const line = await firstLine(out)
  const cause = causeOf(line)
  if (!cause) return block(s, e, `${PF}: unreadable cause in ${out} ("${line}")`)
  P.diagnosis = out
  log(s, e, `${PF}: ${f.label} red, cause ${cause} (${out})`)
  switch (cause) {
    case 'BRANCH':
      return startFix(s, e, '', await diagnosisBrief(s, cfg, false))
    case 'MAIN':
      P.phase = 'proof'
      return 'continue'
    case 'ENVIRONMENT':
      restartRun(P)
      return block(s, e, `${PF}: check "${f.label}" red, cause ${cause} (diagnosis: ${out})\n${await findingsOf(out)}`)
  }
}

/** The diagnosis becomes the fixing implementer's brief. */
async function diagnosisBrief(s: MissionState, cfg: ProjectConfig, greenOnMain: boolean): Promise<string> {
  const P = s.loops.preflight
  const f = P.failing!
  return (
    `Red preflight check: "${f.label}" (exit code ${f.exitCode}), full log: ${f.logPath}\n` +
    (greenOnMain ? `The same check is green on ${mainRef(cfg)}: the cause is in the branch.\n` : '') +
    `\nDiagnosis (${P.diagnosis}):\n\n${await findingsOf(P.diagnosis)}`
  )
}

async function startFix(s: MissionState, e: Effects, findings: string, failure: string): Promise<StepResult> {
  const P = s.loops.preflight
  const d = nextLoopRound(P.round)
  P.round = d.round
  if (d.blocked) return block(s, e, `${PF}: ${d.blocked}${P.failing ? ` (check "${P.failing.label}")` : ''}`)
  P.fixer = d.fixer === 'strong' ? 'strong' : 'new'
  P.fixFindings = findings
  P.fixFailure = failure
  delete P.fixBase
  P.phase = 'fix'
  log(s, e, `${PF}: correction round ${P.round} (${P.fixer})`)
  return 'continue'
}

/**
 * Proof that a red already exists on main: a temporary detached worktree on `origin/<main>`, prepare, test
 * database `<id>-main`, then the same command. Worktree and database are removed whatever happens.
 */
async function proveOnMain(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const f = P.failing
  const check = f && cfg.preflight.find((c) => c.label === f.label)
  if (!f || !check) return block(s, e, `${PF}: cannot prove on main, red check unknown`)
  const wt = s.worktree as string
  const tab = s.herdr.tabs['process'] as string
  const path = proofWorktree(s.id)
  const vars = { id: `${s.id}-main`, worktree: path }
  const logs = logsDir(s)
  let downError: string | undefined
  const cleanup = async (): Promise<void> => {
    if (cfg.testDb && s.proofDbUp) {
      try {
        const r = await e.runInPane(e.herdr, tab, wt, 'proof on main · stop database', fill(cfg.testDb.down, vars), logs)
        if (r.exitCode === 0) s.proofDbUp = false
        else downError = `code ${r.exitCode}, log: ${r.logPath}`
      } catch (err) {
        downError = errMsg(err)
      }
      if (downError) log(s, e, `${PF}: failed to stop database ${vars.id} (${downError})`)
    }
    try {
      await e.git.worktreeRemove(s.repoPath, path)
    } catch (err) {
      log(s, e, `${PF}: failed to remove worktree ${path}: ${errMsg(err)}`)
    }
  }
  if (s.proofDbUp || (await exists(path))) {
    log(s, e, `${PF}: leftovers from an interrupted proof in ${path}, cleanup`)
    await cleanup()
  }
  let failure: string | undefined
  let proof: Awaited<ReturnType<Effects['runInPane']>> | undefined
  try {
    await e.git.worktreeAddDetached(s.repoPath, path, mainRef(cfg))
    const prep = await e.runInPane(e.herdr, tab, path, 'proof on main · prepare', fill(cfg.prepare, vars), logs)
    if (prep.exitCode !== 0) failure = `prepare failed (code ${prep.exitCode}), log: ${prep.logPath}`
    if (!failure && cfg.testDb) {
      // Saved before launch: `closed` and `Engine.fail` remove it too.
      s.proofDbUp = true
      await saveState(s)
      const up = await e.runInPane(e.herdr, tab, path, 'proof on main · test database', fill(cfg.testDb.up, vars), logs)
      if (up.exitCode !== 0) failure = `test database ${vars.id} not created (code ${up.exitCode}), log: ${up.logPath}`
    }
    if (!failure) proof = await e.runInPane(e.herdr, tab, path, `proof on main · ${f.label}`, fill(check.command, vars), logs)
  } finally {
    await cleanup()
  }
  if (s.proofDbUp) return blockDbNotDown(s, e, vars.id, downError ?? 'stop not confirmed')
  if (failure || !proof) {
    restartRun(P)
    return block(s, e, `${PF}: cannot prove on ${mainRef(cfg)} for "${f.label}": ${failure ?? 'no result'}`)
  }
  if (proof.exitCode === 0) {
    log(s, e, `${PF}: ${f.label} green on ${mainRef(cfg)}, red caused by the branch`)
    return startFix(s, e, '', await diagnosisBrief(s, cfg, true))
  }
  const g = openGate(
    s,
    'pr-despite-main',
    `Check "${f.label}" is red on the branch and also on ${mainRef(cfg)} (proof: ${proof.logPath}; branch: ${f.logPath}). ` +
      `Open the PR anyway?`,
    P.diagnosis,
  )
  P.gate = g.id
  P.phase = 'gate'
  log(s, e, `${PF}: ${f.label} also red on ${mainRef(cfg)}, gate ${g.id} (pr-despite-main) open`)
  await notify(s, e, `Gate pr-despite-main to approve: "${f.label}" is also red on main`)
  await informOrchestrator(
    s,
    e,
    `Check "${f.label}" is also red on ${mainRef(cfg)} (diagnosis: ${P.diagnosis}). Gate ${g.id} (pr-despite-main) is open: the user decides whether to open the PR anyway (herness approve|reject ${s.id} --gate ${g.id}).`,
  )
  return 'continue'
}

async function mainGate(s: MissionState, e: Effects): Promise<StepResult> {
  const P = s.loops.preflight
  const f = P.failing
  const g = s.gates.find((x) => x.id === P.gate)
  if (!f || !g) return block(s, e, `${PF}: pr-despite-main gate not found`)
  if (g.status === 'pending') return 'wait'
  if (g.status === 'refused') {
    restartRun(P)
    return block(s, e, `${PF}: check "${f.label}" also red on main, PR refused by the user${g.note ? ` (${g.note})` : ''}`)
  }
  P.acceptedRed.push(f.label)
  P.results.push({ label: f.label, exitCode: f.exitCode, durationMs: f.durationMs, logPath: f.logPath, note: `also red on origin/main, PR opened anyway (gate ${g.id})` })
  P.used = []
  delete P.failing
  delete P.gate
  delete P.phase
  log(s, e, `${PF}: ${f.label} accepted red (gate ${g.id}), next checks`)
  return 'continue'
}

async function preflightFix(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const dir = preflightDir(s)
  const file = join(dir, `fixes-${P.round}.md`)
  if (!(await exists(file)) && arbitrationPending(s)) return 'wait'
  if (!(await exists(file))) await writeFix(s, cfg, dir, file, 'the preflight', P.fixFindings ?? '', P.fixFailure ?? '', P.stopDecision)
  delete P.stopDecision
  P.fixBase ??= await e.git.headSha(s.worktree as string)
  const name = preflightFixerName(s.id, s.loopGeneration, P.round)
  const fixBase = P.fixBase
  const make = async (): Promise<PendingAsk> => {
    P.reportSize = await fileSize(join(dir, 'report.md'))
    return { agent: name, file, fromSha: fixBase, report: { path: join(dir, 'report.md'), size: P.reportSize } }
  }
  const pa = await converse(s, e, P, fixerAgent(cfg, PF, name, `CP${P.round}`, P.fixer), make, implementerDelivered(s, e))
  if (typeof pa === 'string') return pa
  await markPane(s, e, name)
  // The branch changed: a red accepted earlier (also red on main) goes through triage and the proof again.
  P.acceptedRed = []
  P.phase = 'control'
  return 'continue'
}

async function preflightRereview(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const findings = P.fixFindings || P.fixFailure || '(none)'
  const pa = await converse(s, e, P, reviewerAgent(s, cfg, PF), () => rereviewAsk(s, e, cfg, preflightDir(s), P.round, findings), reviewerDelivered)
  if (typeof pa === 'string') return pa
  const out = pa.out as string
  const line = await firstLine(out)
  const v = VERDICTS[line]
  if (!v) return block(s, e, `${PF}: unreadable re-review verdict in ${out} ("${line}")`)
  s.loops.globalReview.reviewedSha = pa.head ?? (await e.git.headSha(s.worktree as string))
  P.lastReview = out
  if (v === 'changes') {
    const r = await startFix(s, e, await findingsOf(out), '')
    await onCorrections(s, e, PF, out, P.round)
    return r
  }
  restartRun(P)
  log(s, e, `${PF}: correction ${P.round} approved, preflight replayed in full`)
  return 'continue'
}

// ---------------------------------------------------------------- PR (step 10)

/** Formats a duration as `4 s` or `2 min 05 s`. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} s`
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
}

/** Title (first `# `) and first non-heading paragraph of the spec. */
export function specSummary(md: string): { title: string | undefined; context: string } {
  const lines = md.replace(/^﻿/, '').split('\n')
  const title = lines.find((l) => /^# /.test(l))?.slice(2).trim()
  const paragraphs = lines.join('\n').split(/\n\s*\n/).map((p) => p.trim())
  const context = paragraphs.find((p) => p !== '' && !p.startsWith('#')) ?? ''
  return { title, context }
}

async function prBody(s: MissionState, cfg: ProjectConfig, context: string): Promise<string> {
  const P = s.loops.preflight
  const preflight = P.results.map((r) => {
    const accepted = P.acceptedRed.includes(r.label) ? ' — already red on main, accepted' : r.note && r.exitCode !== 0 ? ` — ${r.note}` : ''
    return `- ${r.label} ${r.exitCode === 0 ? '✓' : '✗'} (${formatDuration(r.durationMs)})${accepted}`
  })
  return render('pr-body', {
    ticket: s.source.kind === 'text' ? 'written request' : s.source.ref,
    context: context || '(see the spec)',
    changes: s.tasks.map((t) => `- Task ${t.n}: ${t.title}`).join('\n') || '(no task)',
    tests: s.tasks.map((t) => `- Task ${t.n}: \`${t.testCommand}\``).join('\n') || '(none)',
    preflight: preflight.join('\n') || `(no check configured for ${cfg.name})`,
    specFile: specPath(s),
    planFile: planPath(s),
  })
}

/**
 * Step 10. Refused off the mission branch. The engine rebases the branch onto `origin/<main>` itself if
 * main has moved (conflict → rebase aborted and mission blocked); a head other than the one validated by the last
 * full preflight (rebase, resolved by hand) → preflight replayed. Then push and open the PR. Idempotent: a PR already
 * recorded or already open on GitHub is reused, an already pushed branch is not pushed again.
 */
export async function stepPr(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  if (s.prUrl) {
    await stopAgentsTab(s, e, 'all', 'PR open')
    return goto(s, e, 'pr-open')
  }
  const wt = s.worktree
  const branch = s.branch
  if (!wt || !branch || !s.type || !s.slug) return block(s, e, 'PR impossible: worktree, branch, type or slug unknown')
  if (branch === cfg.mainBranch) return block(s, e, `PR refused: the mission branch is the main branch (${branch})`)
  const current = await e.git.currentBranch(wt)
  if (current !== branch) return block(s, e, `PR refused: the worktree is on ${current}, not on the mission branch ${branch}`)
  const main = mainRef(cfg)
  await e.git.fetchMain(wt, cfg.mainBranch)
  if (!(await e.git.isAncestor(wt, main, 'HEAD'))) {
    if (s.loops.prRebases >= 1) {
      return block(s, e, `PR: main moved again during preflight; resume the mission to retry (${main} is not an ancestor of the branch after an automatic rebase and its preflight)`)
    }
    const r = await e.git.rebaseOnto(wt, main)
    if (!r.ok) return block(s, e, `PR: conflict while rebasing the branch onto ${main}; rebase aborted, the branch is unchanged. Resolve the conflict, then resume the mission.`)
    s.loops.prRebases += 1
    if (r.changedCode) log(s, e, `PR: branch rebased onto ${main}`)
  }
  // Rebase (automatic or resolved by hand) or any other commit: only the head validated by preflight goes to the PR.
  const head = await e.git.headSha(wt)
  if (head !== s.loops.preflight.validatedSha) {
    log(s, e, `PR: head ${head} not validated by preflight (${s.loops.preflight.validatedSha ?? 'none'}), full preflight replayed`)
    s.loops.preflight = freshLoops().preflight
    // The reviewed branch is the same, replayed on a new base: re-reviews start from the new head.
    s.loops.globalReview.reviewedSha = head
    return goto(s, e, 'preflight')
  }
  if ((await e.git.unpushedCount(wt, main)) > 0) {
    await e.git.push(wt, branch)
    log(s, e, `PR: branch ${branch} pushed`)
  } else {
    log(s, e, `PR: branch ${branch} already pushed`)
  }
  let url = await e.forge.findPr(wt, branch)
  if (url) {
    log(s, e, `PR: PR already open for ${branch}, reused`)
  } else {
    const spec = specSummary(await readFile(join(wt, specPath(s)), 'utf8').catch(() => ''))
    const bodyFile = join(missionDir(s.id), 'pr-body.md')
    await mkdir(missionDir(s.id), { recursive: true })
    await writeFile(bodyFile, await prBody(s, cfg, spec.context))
    url = await e.forge.createPr(wt, { base: cfg.mainBranch, title: `${s.type}(${s.slug}): ${spec.title ?? s.slug}`, bodyFile })
  }
  s.prUrl = url
  log(s, e, `PR open: ${url}`)
  await notify(s, e, `PR open: ${url}`)
  await stopAgentsTab(s, e, 'all', 'PR open')
  await informOrchestrator(s, e, `The PR is open on branch ${branch}: ${url}. The mission is finished.`)
  return goto(s, e, 'pr-open')
}
