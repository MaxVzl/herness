import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { Engine } from '../../src/engine/engine.ts'
import { openGate } from '../../src/engine/gates.ts'
import { drainInbox, postInbox } from '../../src/mission/inbox.ts'
import { freshLoops, loadState, newState, saveState, type MissionState, type TaskState } from '../../src/mission/state.ts'
import { missionDir, specPath } from '../../src/paths.ts'
import { fakeEffects, type FakeEffects, type FakeOverrides } from '../fakes.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-pr-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const SPEC = '# Export CSV of the records\n\n## Intention\n\nAllow the CSV export\nof the records for the month.\n\nSecond paragraph.\n'
const task = (patch: Partial<TaskState>): TaskState => ({ n: 1, title: 'Model', testCommand: 'pnpm test a', phase: 'done', round: 0, ...patch })

async function setup(opts: { over?: FakeOverrides; patch?: Partial<MissionState> } = {}) {
  const over = opts.over ?? {}
  const fx: FakeEffects = fakeEffects({ ...over, git: { currentBranch: async () => 'feature/T-1-export-csv', ...over.git } })
  const loops = freshLoops()
  // Head validated by the last full preflight (= the fake `headSha`).
  loops.preflight.validatedSha = 'sha-head'
  loops.preflight.results = [
    { label: 'lint', exitCode: 0, durationMs: 4200, logPath: '/l/lint.log' },
    { label: 'test', exitCode: 1, durationMs: 125000, logPath: '/l/test.log', note: 'also red on origin/main' },
  ]
  loops.preflight.acceptedRed = ['test']
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'github', ref: 'https://github.com/o/r/issues/12' }, project: 'demo', repoPath: join(home, 'repo') }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'feature/T-1-export-csv',
    type: 'feat',
    slug: 'export-csv',
    step: 'pr',
    tasks: [task({ n: 1, title: 'Model', testCommand: 'pnpm test a' }), task({ n: 2, title: 'Export', testCommand: 'pnpm test b' })],
    loops,
    herdr: { workspace: 'w1', tabs: { agents: 'w1:t2', checks: 'w1:t3', process: 'w1:t4' }, panes: {} },
    orchestrator: { agent: 'oT-1' },
    ...opts.patch,
  }
  await saveState(s)
  const file = join(wt, specPath(s))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, SPEC)
  return { fx, eng: new Engine('T-1', fx, demo) }
}

const prompts = (fx: FakeEffects) => fx.callsOf('herdr.agentPrompt').map((c) => c[1] as string)
const notes = (fx: FakeEffects) => fx.callsOf('herdr.notify').map((c) => c[1] as string)

test('stepPr pushes, creates the PR and moves to pr-open', async () => {
  const { fx, eng } = await setup({ over: { git: { unpushedCount: async () => 3 } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('pr-open')
  expect(s.prUrl).toBe('https://github.com/o/r/pull/1')
  expect(fx.callsOf('git.fetchMain')[0]).toEqual([wt, 'main'])
  expect(fx.callsOf('git.isAncestor')[0]).toEqual([wt, 'origin/main', 'HEAD'])
  expect(fx.callsOf('git.rebaseOnto')).toEqual([])
  expect(fx.callsOf('git.push')).toEqual([[wt, 'feature/T-1-export-csv']])
  const bodyFile = join(missionDir('T-1'), 'pr-body.md')
  expect(fx.callsOf('forge.createPr')).toEqual([[wt, { base: 'main', title: 'feat(export-csv): Export CSV of the records', bodyFile }]])
  const body = await readFile(bodyFile, 'utf8')
  expect(body).toContain('https://github.com/o/r/issues/12')
  expect(body).toContain('Allow the CSV export\nof the records for the month.')
  expect(body).not.toContain('Second paragraph')
  expect(body).toContain('## Context')
  expect(body).toContain('## Changes')
  expect(body).toContain('- Task 1: Model')
  expect(body).toContain('- Task 2: Export')
  expect(body).toContain('`pnpm test a`')
  expect(body).toContain('`pnpm test b`')
  expect(body).toMatch(/lint ✓ \(4 s\)/)
  expect(body).toMatch(/test ✗ \(2 min 05 s\)/)
  expect(body).toContain('already red on main, accepted')
  expect(body).toContain(specPath(s))
  expect(body).toContain('docs/superpowers/plans/2026-10-29-T-1-export-csv.md')
  expect(notes(fx).some((n) => n.includes('https://github.com/o/r/pull/1'))).toBe(true)
  expect(prompts(fx).some((p) => p.includes('https://github.com/o/r/pull/1'))).toBe(true)
  // The opening message names the branch the PR tracks.
  expect(prompts(fx).find((p) => p.includes('The PR is open'))).toContain('feature/T-1-export-csv')
  expect(await eng.tick()).toBe('stop')
})

test("opening the PR stops every remaining agent on the agents tab", async () => {
  const { fx, eng } = await setup({ over: { git: { unpushedCount: async () => 3 } } })
  const { ws, tab, pane: gr } = fx.herdr.seedWorkspace('T-1', 'agents')
  await fx.herdr.paneRename(gr, 'GR · claude-opus-5-5')
  fx.herdr.pane(gr).busy = true
  const master = await fx.herdr.tabCreate({ workspace: ws, cwd: wt, label: 'master' })
  await fx.herdr.paneRename(master.rootPaneId, 'orchestrator')
  fx.herdr.pane(master.rootPaneId).busy = true
  const s0 = await loadState('T-1')
  s0.herdr = { workspace: ws, tabs: { ...s0.herdr.tabs, agents: tab, master: master.tabId }, panes: { orchestrator: master.rootPaneId } }
  await saveState(s0)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('pr-open')
  expect(fx.herdr.pane(gr).busy).toBe(false)
  expect(s.log.map((l) => l.msg).join('\n')).toContain('PR open: agent(s) stopped in GR · claude-opus-5-5')
  expect(fx.callsOf('herdr.paneSendKeys').some((c) => c[0] === master.rootPaneId)).toBe(false)
  expect(fx.herdr.pane(master.rootPaneId).busy).toBe(true)
})

test('stepPr: a written request is quoted as is in the body', async () => {
  const { fx, eng } = await setup({ patch: { source: { kind: 'text', ref: 'ajoute un export' } } })
  await eng.tick()
  const body = await readFile(join(missionDir('T-1'), 'pr-body.md'), 'utf8')
  expect(body).toContain('written request')
  expect(fx.callsOf('forge.createPr')).toHaveLength(1)
})

test('stepPr with no task writes (no task) under Changes', async () => {
  const { eng } = await setup({ patch: { tasks: [] }, over: { git: { unpushedCount: async () => 3 } } })
  await eng.tick()
  const body = await readFile(join(missionDir('T-1'), 'pr-body.md'), 'utf8')
  expect(body).toContain('## Changes')
  expect(body).toContain('(no task)')
})

test('stepPr blocks the mission on a rebase conflict and aborts it', async () => {
  const { fx, eng } = await setup({ over: { git: { isAncestor: async () => false, rebaseOnto: async () => ({ ok: false }) } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedFrom).toBe('pr')
  expect(s.blockedReason).toMatch(/conflict/)
  expect(fx.callsOf('git.rebaseOnto')).toEqual([[wt, 'origin/main']])
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr returns to preflight when the rebase changed code', async () => {
  let head = 'sha-head'
  const rebaseOnto = async () => {
    head = 'sha-rebasee'
    return { ok: true as const, changedCode: true }
  }
  const { fx, eng } = await setup({ over: { git: { isAncestor: async () => false, rebaseOnto, headSha: async () => head } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.results).toEqual([])
  expect(s.loops.preflight.acceptedRed).toEqual([])
  expect(s.prUrl).toBeUndefined()
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr is idempotent: an already pushed branch and an existing PR are reused', async () => {
  const { fx, eng } = await setup({
    over: { git: { unpushedCount: async () => 0 }, forge: { findPr: async () => 'https://github.com/o/r/pull/7' } },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('pr-open')
  expect(s.prUrl).toBe('https://github.com/o/r/pull/7')
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.findPr')).toEqual([[wt, 'feature/T-1-export-csv']])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr with a recorded prUrl goes straight to pr-open', async () => {
  const { fx, eng } = await setup({ patch: { prUrl: 'https://github.com/o/r/pull/9' } })
  await eng.tick()
  expect((await loadState('T-1')).step).toBe('pr-open')
  expect(fx.callsOf('git.fetchMain')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr returns to preflight when HEAD is not the head validated by preflight', async () => {
  const { fx, eng } = await setup({ over: { git: { headSha: async () => 'sha-other' } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.results).toEqual([])
  expect(s.loops.preflight.acceptedRed).toEqual([])
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr refuses to push the main branch or a branch other than the mission branch', async () => {
  let r = await setup({ patch: { branch: 'main' }, over: { git: { currentBranch: async () => 'main' } } })
  await r.eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toMatch(/main branch/)
  expect(r.fx.callsOf('git.push')).toEqual([])

  r = await setup({ over: { git: { currentBranch: async () => 'feature/other' } } })
  await r.eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toMatch(/feature\/other/)
  expect(r.fx.callsOf('git.push')).toEqual([])
  expect(r.fx.callsOf('git.rebaseOnto')).toEqual([])
})

test('a conflict resolved by hand then a resume approved: back to preflight, no push', async () => {
  let head = 'sha-head'
  let ancestor = false
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => head, isAncestor: async () => ancestor, rebaseOnto: async () => ({ ok: false }) } },
  })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  // The user rebases and resolves the conflict: the head changes, main is now an ancestor.
  head = 'sha-resolue'
  ancestor = true
  const g = openGate(s, 'resume-blocked', s.blockedReason!)
  await saveState(s)
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.validatedSha).toBeUndefined()
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

// ---------- resume of a blocked mission (R12/R13) ----------

async function blocked(blockedFrom: MissionState['step'], patch: Partial<MissionState> = {}) {
  // Paused: the engine handles the decision without running the resumed step.
  const r = await setup({ patch: { step: 'blocked', blockedFrom, blockedReason: '3 correction rounds exhausted', paused: true, ...patch } })
  const s = await loadState('T-1')
  const g = openGate(s, 'resume-blocked', s.blockedReason!)
  await saveState(s)
  return { ...r, gate: g.id }
}

test('resume-blocked approved: back to the blocked step, rounds of the current task reset', async () => {
  const tasks = [task({ n: 1, round: 2 }), task({ n: 2, title: 'Export', phase: 'test', round: 4 })]
  const { eng, gate } = await blocked('tasks', { tasks })
  await mkdir(join(missionDir('T-1'), 'tasks', '2'), { recursive: true })
  await writeFile(join(missionDir('T-1'), 'tasks', '2', 'correctifs-1.md'), 'old')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.blockedReason).toBeUndefined()
  expect(s.blockedFrom).toBeUndefined()
  expect(s.tasks.map((t) => t.round)).toEqual([2, 0])
  expect(s.step).toBe('tasks')
  expect(s.log.some((l) => /resume approved/.test(l.msg))).toBe(true)
  // The old fix file is never resent on the new round 1: it is archived.
  const dir = join(missionDir('T-1'), 'tasks', '2')
  expect(await readdir(dir)).toEqual([`correctifs-1.avant-${gate}.md`])
})

test("resume-blocked approved on a task blocked at control with no commit: the implementer is restarted with its brief", async () => {
  const pa = { agent: 'ct-1-t2', file: '/x/brief.md', fromSha: 'sha-head' }
  const tasks = [task({ n: 1 }), task({ n: 2, title: 'Export', phase: 'control', round: 1, baseSha: 'sha-head', pendingAsk: pa })]
  const { eng, gate } = await blocked('tasks', { tasks })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks[1]).toMatchObject({ phase: 'implement', round: 0 })
  expect(s.tasks[1]!.pendingAsk).toBeUndefined()
})

test('resume-blocked approved on a task at control with commits: control is replayed', async () => {
  const tasks = [task({ n: 1 }), task({ n: 2, title: 'Export', phase: 'control', round: 1, baseSha: 'b-avant' })]
  const { eng, gate } = await blocked('tasks', { tasks })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  expect((await loadState('T-1')).tasks[1]).toMatchObject({ phase: 'control', round: 0 })
})

test('resume-blocked approved from the global review or preflight: loop rounds are reset', async () => {
  const loops = freshLoops()
  loops.globalReview.round = 4
  loops.preflight.round = 4
  const { eng, gate } = await blocked('global-review', { loops })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.loops.globalReview.round).toBe(0)
  expect(s.loops.preflight.round).toBe(4)
  expect(s.blockedReason).toBeUndefined()

  const r2 = await blocked('preflight', { loops })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: r2.gate, decision: 'approved' })
  await r2.eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.round).toBe(0)
  expect(s.loops.globalReview.round).toBe(4)
})

test('resume-blocked refused: the mission stays blocked', async () => {
  const { eng, gate } = await blocked('tasks', { tasks: [task({ phase: 'test', round: 4 })] })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'refused', note: 'not yet' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedFrom).toBe('tasks')
  expect(s.blockedReason).toBe('3 correction rounds exhausted')
  expect(s.tasks[0]!.round).toBe(4)
})

test('a resume-blocked gate request is ignored when the mission is not blocked', async () => {
  const { fx, eng } = await setup({ patch: { step: 'pr-open' } })
  await postInbox('T-1', { type: 'request-gate', kind: 'resume-blocked', summary: 'x' })
  await eng.tick()
  expect((await loadState('T-1')).gates).toEqual([])
  expect(fx.callsOf('herdr.notify')).toEqual([])
  expect(await drainInbox('T-1')).toEqual([])
})

test('main moves again after an automatic rebase and its preflight: mission blocked, resume resets the counter', async () => {
  let head = 'sha-head'
  let n = 0
  const rebaseOnto = async () => {
    head = `sha-rebasee-${++n}`
    return { ok: true as const, changedCode: true }
  }
  const { fx, eng } = await setup({ over: { git: { isAncestor: async () => false, rebaseOnto, headSha: async () => head } } })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.prRebases).toBe(1)
  // The replayed preflight validates the rebased head; main has moved again in the meantime.
  s.step = 'pr'
  s.loops.preflight.validatedSha = head
  await saveState(s)
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedFrom).toBe('pr')
  expect(s.blockedReason).toContain('main moved again during preflight; resume the mission to retry')
  expect(fx.callsOf('git.rebaseOnto')).toHaveLength(1)
  expect(fx.callsOf('git.push')).toEqual([])

  await postInbox('T-1', { type: 'request-gate', kind: 'resume-blocked', summary: 'r' })
  await eng.tick()
  const g = (await loadState('T-1')).gates.at(-1)!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  // Counter reset by the resume: another automatic rebase is allowed.
  expect(s.step).toBe('preflight')
  expect(s.loops.prRebases).toBe(1)
  expect(fx.callsOf('git.rebaseOnto')).toHaveLength(2)
})
