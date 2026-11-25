import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { Engine } from '../../src/engine/engine.ts'
import { findingsOf, forbidden, stopAgent } from '../../src/engine/tasks.ts'
import { postInbox } from '../../src/mission/inbox.ts'
import { loadState, newState, saveState, type Gate, type MissionState, type TaskState } from '../../src/mission/state.ts'
import { missionDir, planPath, specPath } from '../../src/paths.ts'
import { proposalHash } from '../../src/mission/amendment.ts'
import { fakeEffects, seq, type FakeEffects, type FakeOverrides } from '../fakes.ts'
import type { ControlResult } from '../../src/git/git.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-tasks-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

test('forbidden names the generated files from the project config', () => {
  const text = forbidden(demo)
  expect(text).toContain('editing generated project files')
  for (const p of demo.forbiddenPaths) expect(text).toContain(`\`${p}\``)
})

test('findingsOf without a review body says (none)', async () => {
  expect(await findingsOf(undefined)).toBe('(none)')
})

const T1 = '### Task 1: Model\n\n**Test:** `pnpm test a`\n\ndo a\n'
const T2 = '### Task 2: Export\n\n**Test:** `pnpm test b`\n\ndo b\n'
const PLAN1 = `# Plan\n\n${T1}`
const PLAN2 = `# Plan\n\n${T1}\n${T2}`

const task = (patch: Partial<TaskState> = {}): TaskState => ({ n: 1, title: 'Model', testCommand: 'pnpm test a', phase: 'pending', round: 0, ...patch })
const gate = (patch: Partial<Gate>): Gate => ({ id: 'g1', kind: 'amendment', status: 'approved', summary: 's', createdAt: '2026-10-29T10:00:00.000Z', ...patch })
const taskDir = (n = 1) => join(missionDir('T-1'), 'tasks', String(n))

/** The fake reviewer writes its report next to its brief: `review-brief.md` → `review.md`. */
function scriptedAsk(verdicts: string[], impl: () => 'done' | 'blocked' | 'timeout' = () => 'done') {
  let i = 0
  return async (name: string, file: string) => {
    if (!name.startsWith('r')) return impl()
    const fileName = basename(file)
    const out = join(dirname(file), fileName === 'review-brief.md' ? 'review.md' : fileName.replace(/^consigne-/, ''))
    const v = verdicts[Math.min(i++, verdicts.length - 1)]!
    await writeFile(out, `${v}\n\n## Notes\n- src/a.ts:3 note ${i}\n`)
    return 'done' as const
  }
}

async function setup(opts: { over?: FakeOverrides; patch?: Partial<MissionState>; plan?: string; approved?: string; proposed?: string; config?: typeof demo } = {}) {
  const fx: FakeEffects = fakeEffects(opts.over)
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: wt }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'feature/T-1-export-csv',
    type: 'feat',
    slug: 'export-csv',
    step: 'tasks',
    tasks: [task()],
    herdr: { workspace: ws, tabs: { agents: tab, checks: `${ws}:tc`, process: `${ws}:tp` }, panes: {} },
    orchestrator: { agent: 'o-T-1' },
    ...opts.patch,
  }
  await saveState(s)
  const file = join(wt, planPath(s))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, opts.plan ?? PLAN1)
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), opts.approved ?? opts.plan ?? PLAN1)
  if (opts.proposed !== undefined) await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), opts.proposed)
  return { fx, eng: new Engine('T-1', fx, opts.config ?? demo) }
}

async function until(eng: Engine, pred: (s: MissionState) => boolean, max = 40): Promise<MissionState> {
  for (let i = 0; i < max; i++) {
    await eng.tick()
    const s = await loadState('T-1')
    if (pred(s)) return s
  }
  throw new Error('condition never reached')
}

const red = { exitCode: 1, logPath: '/l/t.log', tail: 'AssertionError: expected 2', durationMs: 1 }
const green = { exitCode: 0, logPath: '/l/t.log', tail: 'ok', durationMs: 1 }

test("a task brief is written at tasks/1/brief.md and the expected report is tasks/1/report.md", async () => {
  const { eng } = await setup({ over: { agents: { ask: async () => 'blocked' as const } } })
  const dir = join(missionDir('T-1'), 'tasks', '1')
  let brief = ''
  for (let i = 0; i < 6; i++) {
    await eng.tick()
    try {
      brief = await readFile(join(dir, 'brief.md'), 'utf8')
      break
    } catch {
      brief = ''
    }
  }
  expect(brief).toContain(join(dir, 'report.md'))
})

test('brief rendered for language fr names that language and the commit rule', async () => {
  const { eng } = await setup({
    config: { ...demo, language: 'fr' },
    over: { agents: { ask: async () => 'blocked' as const } },
  })
  const dir = join(missionDir('T-1'), 'tasks', '1')
  let brief = ''
  for (let i = 0; i < 6; i++) {
    await eng.tick()
    try {
      brief = await readFile(join(dir, 'brief.md'), 'utf8')
      break
    } catch {
      brief = ''
    }
  }
  expect(brief).toMatch(/\bfr\b/)
  expect(brief).toMatch(/commit messages/i)
})

test('a green approved task goes through implement, control, test, review, then done', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } } })
  const s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.step).toBe('global-review')
  expect(s.tasks[0]).toMatchObject({ phase: 'done', round: 0, baseSha: 'sha-head', reviewedSha: 'sha-head', implementer: 'ct-1-t1', reviewer: 'rt-1-t1' })

  const order = fx.calls.map((c) => c.fn).filter((f) => ['agents.start', 'agents.ask', 'git.controlCommits', 'runInPane', 'git.diffPackage'].includes(f))
  expect(order).toEqual(['agents.start', 'agents.ask', 'git.controlCommits', 'runInPane', 'git.diffPackage', 'agents.start', 'agents.ask'])

  const [name, role, , launch] = fx.callsOf('agents.start')[0]!
  expect([name, role]).toEqual(['ct-1-t1', 'implementer'])
  expect((launch as { args: string[] }).args).toContain('grok-4.7-medium')
  expect(fx.callsOf('agents.ask')[0]!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'brief.md')])
  const brief = await readFile(join(taskDir(), 'brief.md'), 'utf8')
  expect(brief).toContain('do a')
  expect(brief).toContain('pnpm test a')
  expect(brief).toContain('[T-1]')
  expect(brief).toContain('git push')
  expect(brief).toContain('git stash')
  expect(brief).toContain(join(taskDir(), 'report.md'))

  expect(fx.callsOf('git.controlCommits')[0]).toEqual([wt, 'sha-head', demo.forbiddenPaths, 'origin/main'])
  const [, tab, cwd, label, cmd] = fx.callsOf('runInPane')[0]!
  expect([tab, cwd, label]).toEqual([s.herdr.tabs['checks'], wt, 'T1 · tests'])
  expect(cmd).toEqual(['bash', '-c', 'pnpm test a'])
  expect(fx.callsOf('git.diffPackage')[0]).toEqual([wt, 'sha-head', join(taskDir(), 'task.diff')])
  expect(fx.callsOf('agents.start')[1]!.slice(0, 2)).toEqual(['rt-1-t1', 'reviewer'])

  const labels = fx.herdr.panes.map((p) => p.label)
  expect(labels).toContain('T1 · grok-4.7-medium ✓')
  expect(labels).toContain('T1 · claude-opus-5-5 ✓')
  expect(s.herdr.panes['ct-1-t1']).toBeDefined()
  expect(s.herdr.panes['rt-1-t1']).toBeDefined()
})

test('red tests send the same implementer back without starting a reviewer', async () => {
  const { fx, eng } = await setup({ over: { runInPane: seq(red, green) as never, agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } } })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  expect(s.tasks[0]).toMatchObject({ round: 1, fixer: 'same' })
  expect(s.tasks[0]!.lastFailure).toContain('AssertionError: expected 2')
  expect(fx.callsOf('git.diffPackage')).toEqual([])

  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  const asks = fx.callsOf('agents.ask')
  expect(asks.at(-1)!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'fixes-1.md')])
  const fix = await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')
  expect(fix).toContain('AssertionError: expected 2')
  expect(fix).toContain('/l/t.log')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['ct-1-t1'])
})

test('on round 3 a new grok-4.7-high implementer is started', async () => {
  const { fx, eng } = await setup({ over: { runInPane: seq(red, red, red, green) as never, agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } } })
  const s = await until(eng, (x) => x.tasks[0]!.round === 3 && x.tasks[0]!.phase === 'control')
  const starts = fx.callsOf('agents.start')
  expect(starts.map((c) => c[0])).toEqual(['ct-1-t1', 'ct-1-t1b'])
  expect((starts[1]![3] as { args: string[] }).args).toContain('grok-4.7-high')
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['ct-1-t1b', join(taskDir(), 'fixes-3.md')])
  const fix3 = await readFile(join(taskDir(), 'fixes-3.md'), 'utf8')
  expect(fix3).toContain(join(taskDir(), 'brief.md'))
  expect(s.tasks[0]!.implementer).toBe('ct-1-t1b')
  // rounds 1 and 2 went to the same implementer
  expect(fx.callsOf('agents.ask').map((c) => c[0])).toEqual(['ct-1-t1', 'ct-1-t1', 'ct-1-t1', 'ct-1-t1b'])
})

test('on round 4 the mission is blocked and a notification is sent', async () => {
  const { fx, eng } = await setup({ over: { runInPane: async () => red } })
  const s = await until(eng, (x) => x.step === 'blocked')
  expect(s.blockedFrom).toBe('tasks')
  expect(s.blockedReason).toContain('3 correction rounds exhausted')
  expect(s.tasks[0]!.round).toBe(4)
  expect(String(fx.callsOf('herdr.notify').at(-1)![1])).toContain('3 correction rounds exhausted')
  expect(fx.callsOf('agents.ask')).toHaveLength(4)
})

test('a re-review uses the same reviewer and the diff since reviewedSha', async () => {
  const heads = seq('h1', 'h2')
  const { fx, eng } = await setup({
    over: {
      agents: { ask: scriptedAsk(['VERDICT: CORRECTIONS', 'VERDICT: APPROVED']) },
      git: { diffPackage: async (_wt: string, base: string) => ({ base, head: heads(), commits: 1 }) },
    },
  })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  expect(s.tasks[0]).toMatchObject({ round: 1, fixer: 'same', reviewedSha: 'h1' })
  s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.tasks[0]).toMatchObject({ phase: 'done', reviewedSha: 'h2' })

  const fix = await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')
  expect(fix).toContain('src/a.ts:3 note 1')
  const diffs = fx.callsOf('git.diffPackage')
  expect(diffs[1]![1]).toBe('h1')
  expect(diffs[1]![2]).not.toBe(join(taskDir(), 'task.diff'))
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['ct-1-t1', 'rt-1-t1'])
  const reviewerAsks = fx.callsOf('agents.ask').filter((c) => c[0] === 'rt-1-t1')
  expect(reviewerAsks.map((c) => basename(String(c[1])))).toEqual(['review-brief.md', 'consigne-rerevue-1.md'])
  const prompt = await readFile(String(reviewerAsks[1]![1]), 'utf8')
  expect(prompt).toContain('h1')
  expect(prompt).toContain('h2')
  expect(prompt).toContain('src/a.ts:3 note 1')
  expect(prompt).toContain(join(taskDir(), 'rerevue-1.md'))
})

test('an unreadable verdict blocks the mission', async () => {
  const { eng } = await setup({ over: { agents: { ask: scriptedAsk(['I think this is fine']) } } })
  const s = await until(eng, (x) => x.step === 'blocked')
  expect(s.blockedReason).toContain('unreadable review verdict')
})

test('a blocked agent opens an agent-blocked gate and nothing is sent to it', async () => {
  const outcomes = seq<'blocked' | 'done'>('blocked', 'done')
  const { fx, eng } = await setup({
    over: { agents: { ask: async () => outcomes() }, herdr: { agentRead: async () => 'Allow the rm command? (y/n)' } },
  })
  let s = await until(eng, (x) => x.gates.length > 0)
  expect(s.gates[0]).toMatchObject({ kind: 'agent-blocked', status: 'pending' })
  expect(s.gates[0]!.summary).toContain('Allow the rm command')
  expect(fx.callsOf('herdr.agentRead')[0]).toEqual(['ct-1-t1', 40])
  expect(fx.callsOf('herdr.notify')).toHaveLength(1)
  expect(fx.callsOf('herdr.agentPrompt').map((c) => c[0])).toEqual(['o-T-1'])
  expect(fx.callsOf('herdr.paneSendKeys')).toEqual([])

  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.ask')).toHaveLength(1)

  expect(s.tasks[0]!.pendingAsk).toMatchObject({ agent: 'ct-1-t1', file: join(taskDir(), 'brief.md') })

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  // unblocked in its pane: wait for the agent, without resending the brief
  expect(fx.callsOf('agents.ask')).toHaveLength(1)
  expect(fx.callsOf('agents.wait').map((c) => c[0])).toEqual(['ct-1-t1'])
  expect(fx.callsOf('herdr.agentPrompt').every((c) => c[0] === 'o-T-1')).toBe(true)
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
})

test('a second blocked while waiting after unblock opens a new gate', async () => {
  const waits = seq<'blocked' | 'done'>('blocked', 'done')
  const { fx, eng } = await setup({
    over: { agents: { ask: async () => 'blocked' as const, wait: async () => waits() } },
  })
  await until(eng, (x) => x.gates.length === 1)
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  let s = await until(eng, (x) => x.gates.length === 2)
  expect(s.gates[1]).toMatchObject({ id: 'g2', kind: 'agent-blocked', status: 'pending' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g2', decision: 'approved' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  expect(fx.callsOf('agents.ask')).toHaveLength(1)
  expect(fx.callsOf('agents.wait')).toHaveLength(2)
})

test("an agent with no reply blocks the mission", async () => {
  const { eng } = await setup({ over: { agents: { ask: async () => 'timeout' as const } } })
  const s = await until(eng, (x) => x.step === 'blocked')
  expect(s.blockedReason).toContain('agent ct-1-t1 timed out')
})

// herdr sees a cursor-agent idle during a long command (vitest…): only the report proves it is finished.
test("an implementer seen idle without a report is not checked before it has written its report", async () => {
  let sleeps = 0
  const states = seq('working', 'idle', 'idle')
  const { fx, eng } = await setup({
    over: {
      agents: { ask: scriptedAsk(['VERDICT: APPROVED']) },
      herdr: { agentGet: async (name: string) => (name.startsWith('c') ? { state: states() } : { state: 'idle' }) },
      sleep: async () => {
        // The agent finishes during the 3rd wait: it writes its report.
        if (++sleeps === 3) await writeFile(join(taskDir(), 'report.md'), 'fichiers : a.ts\ncommit sha-head\n')
      },
      git: {
        controlCommits: async () => {
          expect(await readFile(join(taskDir(), 'report.md'), 'utf8')).toContain('commit sha-head')
          return { ok: true, commits: 1 }
        },
      },
    },
  })
  const s = await until(eng, () => fx.callsOf('git.controlCommits').length > 0)
  expect(sleeps).toBe(3)
  expect(fx.callsOf('sleep')[0]).toEqual([15_000])
  expect(fx.callsOf('git.controlCommits')).toHaveLength(1)
  expect(s.log.map((l) => l.msg)).toContain('task 1: ct-1-t1 seen idle without a report, waiting for the real end')
})

test('idle without a report for 10 min: check as before', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } } })
  const s = await until(eng, () => fx.callsOf('git.controlCommits').length > 0)
  // The idle count restarts when the agent is working: here it stays idle, 40 × 15 s.
  expect(fx.callsOf('sleep')).toHaveLength(40)
  expect(fx.callsOf('git.controlCommits')).toHaveLength(1)
  expect(s.log.map((l) => l.msg)).toContain('task 1: ct-1-t1 idle for 10 min without a report, checking the work')
})

test("a report already completed when the brief ends: no wait", async () => {
  const { fx, eng } = await setup({
    over: {
      agents: {
        ask: async (name: string, file: string) => {
          if (name.startsWith('c')) await writeFile(join(taskDir(), 'report.md'), 'fait\n')
          return scriptedAsk(['VERDICT: APPROVED'])(name, file)
        },
      },
    },
  })
  await until(eng, (x) => x.tasks[0]!.phase === 'done')
  expect(fx.callsOf('sleep')).toEqual([])
})

test("an agent that becomes blocked while waiting for the report opens an agent-blocked gate", async () => {
  const { eng } = await setup({
    over: { herdr: { agentGet: async () => ({ state: 'blocked' }), agentRead: async () => 'Allow? (y/n)' } },
  })
  const s = await until(eng, (x) => x.gates.length > 0)
  expect(s.gates[0]).toMatchObject({ kind: 'agent-blocked', status: 'pending' })
  expect(s.tasks[0]!.pendingAsk).toMatchObject({ agent: 'ct-1-t1' })
})

test('a pending arbitration gate suspends the correction and its note goes into the fix file', async () => {
  const { fx, eng } = await setup({
    patch: {
      tasks: [task({ phase: 'fix', round: 1, fixer: 'same', baseSha: 'b0', reviewedSha: 'h1', implementer: 'ct-1-t1', lastReview: join(taskDir(), 'review.md') })],
      gates: [gate({ id: 'g1', kind: 'arbitration', status: 'pending', summary: 'keep this column?' })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'review.md'), 'VERDICT: CORRECTIONS\n\n- src/b.ts:9 extra column\n')
  fx.herdr.started.add('ct-1-t1')

  expect(await eng.tick()).toBe('wait')
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.ask')).toEqual([])

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'keep the column' })
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  expect(fx.callsOf('agents.ask')[0]!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'fixes-1.md')])
  const fix = await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')
  expect(fix).toContain('src/b.ts:9 extra column')
  expect(fix).toContain('User decision')
  expect(fix).toContain('keep the column')
  expect(s.consumedArbitrages).toEqual(['g1'])
})

test("an approved amendment during an in-progress task, with no brief at an agent, applies at once; the unchanged task continues", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2,
    over: { agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } },
    patch: {
      tasks: [task({ phase: 'review', baseSha: 'b0', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN2) })],
    },
  })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks.map((t) => [t.n, t.phase])).toEqual([[1, 'review'], [2, 'pending']])
  expect(await readFile(join(missionDir('T-1'), 'plan.approved.md'), 'utf8')).toBe(PLAN2)
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s)], 'docs(T-1): amend the plan']])
  s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  // Task 1 unchanged: no new brief, nothing new sent to the implementer.
  expect(fx.callsOf('agents.ask').map((c) => c[0])).toEqual(['rt-1-t1'])
})

test("an amendment waits until no brief is in progress with an agent", async () => {
  const { eng } = await setup({
    proposed: PLAN2,
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1', pendingAsk: { agent: 'ct-1-t1', file: '/x/brief.md', fromSha: 'b0' } })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN2) })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual([])
  expect(s.tasks).toHaveLength(1)
})

test('an amendment waits for the decision on an agent-blocked gate', async () => {
  const { eng } = await setup({
    proposed: PLAN2,
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1', blockedGate: 'g2' })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN2) }), gate({ id: 'g2', kind: 'agent-blocked', status: 'pending' })],
    },
  })
  expect(await eng.tick()).toBe('wait')
  expect((await loadState('T-1')).appliedAmendments).toEqual([])
})

test('an approved amendment in global-review adds the task and returns to tasks', async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks.map((t) => [t.n, t.phase])).toEqual([[1, 'done'], [2, 'pending']])
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s)], 'docs(T-1): amend the plan']])
})

test("an amendment applied after the tasks stops the previous generation's closing agents", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  const tab = (await loadState('T-1')).herdr.tabs['agents']!
  const pane = fx.herdr.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, 'GR · claude-opus-5-5')
  fx.herdr.pane(pane).busy = true
  fx.herdr.pane(pane).agent = 'rgt-1'
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.herdr.pane(pane).busy).toBe(false)
  expect(s.loopGeneration).toBe(2)
  expect(s.log.map((l) => l.msg)).toContain('new generation of the closing loops: agent(s) stopped in GR · claude-opus-5-5')
})

test("an amendment that changes an already-validated task is rejected and the orchestrator is told", async () => {
  const changed = PLAN2.replace('do a', 'do something else')
  const { fx, eng } = await setup({
    proposed: changed,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(changed) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.tasks).toHaveLength(1)
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] .*already-validated task 1 has changed/s)
})

test('resume: implement with no agent but with commits goes straight to control', async () => {
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => 'h1' } },
    patch: { tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.tasks[0]!.phase).toBe('control')
  expect(fx.callsOf('herdr.agentGet')).toEqual([['ct-1-t1']])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('agents.ask')).toEqual([])
})

test("resume: implement with no agent and no commit restarts the agent with the same brief", async () => {
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => 'b0' } },
    patch: { tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })] },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), 'BRIEF ORIGINAL')
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['ct-1-t1'])
  expect(fx.callsOf('agents.ask').map((c) => c.slice(0, 2))).toEqual([['ct-1-t1', join(taskDir(), 'brief.md')]])
  expect(await readFile(join(taskDir(), 'brief.md'), 'utf8')).toBe('BRIEF ORIGINAL')
  expect(s.tasks[0]!.phase).toBe('control')
  expect(s.tasks[0]!.baseSha).toBe('b0')
})

test("the in-progress brief is saved in state before it is sent, then cleared", async () => {
  let seen: unknown
  const { eng } = await setup({
    patch: { tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })] },
    over: {
      herdr: { agentGet: async () => ({ state: 'idle' }) },
      agents: {
        ask: async () => {
          seen = (await loadState('T-1')).tasks[0]!.pendingAsk
          return 'done' as const
        },
      },
    },
  })
  await eng.tick()
  expect(seen).toMatchObject({ agent: 'ct-1-t1', file: join(taskDir(), 'brief.md') })
  const s = await loadState('T-1')
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
  expect(s.tasks[0]!.phase).toBe('control')
})

test("resume: brief in progress and a live working agent, wait without resending, then the outcome is handled", async () => {
  const { fx, eng } = await setup({
    over: { herdr: { agentGet: async () => ({ state: 'working' }) } },
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1', pendingAsk: { agent: 'ct-1-t1', file: join(taskDir(), 'brief.md') } })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([])
  expect(fx.callsOf('agents.wait').map((c) => c[0])).toEqual(['ct-1-t1'])
  expect(s.tasks[0]).toMatchObject({ phase: 'control' })
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
})

test('resume: review in progress, reviewer gone but verdict already written, the verdict is used without resending', async () => {
  const out = join(taskDir(), 'review.md')
  const { fx, eng } = await setup({
    patch: {
      tasks: [task({
        phase: 'review', baseSha: 'b0', implementer: 'ct-1-t1', reviewer: 'rt-1-t1',
        pendingAsk: { agent: 'rt-1-t1', file: join(taskDir(), 'review-brief.md'), out, head: 'h1' },
      })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(out, 'VERDICT: APPROVED\n')
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('git.diffPackage')).toEqual([])
  expect(s.tasks[0]).toMatchObject({ phase: 'done', reviewedSha: 'h1', lastReview: out })
})

test('resume: review in progress, reviewer gone with no verdict, reviewer restarted and the brief resent', async () => {
  const { fx, eng } = await setup({
    over: { agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } },
    patch: {
      tasks: [task({
        phase: 'review', baseSha: 'b0', implementer: 'ct-1-t1', reviewer: 'rt-1-t1',
        pendingAsk: { agent: 'rt-1-t1', file: join(taskDir(), 'review-brief.md'), out: join(taskDir(), 'review.md'), head: 'h1' },
      })],
    },
  })
  await eng.tick()
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rt-1-t1'])
  expect(fx.callsOf('agents.ask').map((c) => basename(String(c[1])))).toEqual(['review-brief.md'])
  expect((await loadState('T-1')).tasks[0]!.phase).toBe('done')
})

test('resume: correction in progress, implementer gone with a commit since the previous head, move to control', async () => {
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => 'h2' } },
    patch: {
      tasks: [task({
        phase: 'fix', round: 1, fixer: 'same', baseSha: 'b0', implementer: 'ct-1-t1',
        pendingAsk: { agent: 'ct-1-t1', file: join(taskDir(), 'fixes-1.md'), fromSha: 'h1' },
      })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(s.tasks[0]).toMatchObject({ phase: 'control', round: 1 })
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
})

test('pending reuses an implementer already started (stop between start and save)', async () => {
  const { fx, eng } = await setup()
  fx.herdr.started.add('ct-1-t1')
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement', implementer: 'ct-1-t1' })
})

test('an amendment with no proposed plan is rejected cleanly', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] Amendment g1 not applied/)
})

// ---------- amendments proposed outside the worktree (C2) ----------

test('approved amendment: the proposal is copied into the worktree, committed (plan and spec), then removed', async () => {
  const SPEC2 = '# Spec v2\n\ncontexte\n'
  const { fx, eng } = await setup({
    proposed: PLAN2,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2, SPEC2) })] },
  })
  await writeFile(join(missionDir('T-1'), 'spec.proposed.md'), SPEC2)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks.map((t) => t.n)).toEqual([1, 2])
  expect(await readFile(join(wt, planPath(s)), 'utf8')).toBe(PLAN2)
  expect(await readFile(join(wt, specPath(s)), 'utf8')).toBe(SPEC2)
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s), specPath(s)], 'docs(T-1): amend the plan']])
  expect(await readFile(join(missionDir('T-1'), 'plan.approved.md'), 'utf8')).toBe(PLAN2)
  await expect(readFile(join(missionDir('T-1'), 'plan.proposed.md'))).rejects.toThrow()
  await expect(readFile(join(missionDir('T-1'), 'spec.proposed.md'))).rejects.toThrow()
})

test('a proposal changed after the request is rejected and the worktree stays intact', async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2.replace('do b', 'do b differently'),
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.tasks).toHaveLength(1)
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(await readFile(join(wt, planPath(s)), 'utf8')).toBe(PLAN1)
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain('the proposal changed after the request; ask for validation again')
})

// ---------- arbitration of findings that contradict the plan (I4) ----------

test('a finding "imposed by the plan" opens an arbitration gate and suspends fixes; each CORRECTIONS is reported', async () => {
  const ask = async (name: string, file: string) => {
    if (name.startsWith('r')) {
      const fileName = basename(file)
      const out = join(dirname(file), fileName === 'review-brief.md' ? 'review.md' : fileName.replace(/^consigne-/, ''))
      await writeFile(out, 'VERDICT: CORRECTIONS\n\n## Notes\n- src/a.ts:3 variable name\n- src/b.ts:9 column removed although it is imposed by the plan (task 1)\n')
    }
    return 'done' as const
  }
  const { fx, eng } = await setup({ over: { agents: { ask } } })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  const g = s.gates.find((x) => x.kind === 'arbitration')!
  expect(g).toMatchObject({ status: 'pending' })
  expect(g.summary).toContain('src/b.ts:9 column removed')
  expect(g.summary).not.toContain('variable name')
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.some((p) => /^\[herness\] task 1: review CORRECTIONS \(round 1\)/.test(p))).toBe(true)
  expect(prompts.some((p) => p.includes(`Gate ${g.id} (arbitration)`))).toBe(true)

  expect(await eng.tick()).toBe('wait')
  await expect(readFile(join(taskDir(), 'fixes-1.md'))).rejects.toThrow()
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved', note: 'the plan wins, keep the column' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  const fix = await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')
  expect(fix).toContain('the plan wins, keep the column')
})

const legacyContradiction = 'impos\u00e9 par le plan'

test('a finding with the 0.8 plan-contradiction wording still opens an arbitration gate', async () => {
  const ask = async (name: string, file: string) => {
    if (name.startsWith('r')) {
      const fileName = basename(file)
      const out = join(dirname(file), fileName === 'review-brief.md' ? 'review.md' : fileName.replace(/^consigne-/, ''))
      await writeFile(out, `VERDICT: CORRECTIONS\n\n- src/b.ts:9 ${legacyContradiction}\n`)
    }
    return 'done' as const
  }
  const { eng } = await setup({ over: { agents: { ask } } })
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  expect(s.gates.find((x) => x.kind === 'arbitration')?.summary).toContain(legacyContradiction)
})

test('a CORRECTIONS verdict with no plan contradiction informs the orchestrator and opens no gate', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: CORRECTIONS', 'VERDICT: APPROVED']) } } })
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  expect(s.gates).toEqual([])
  const msgs = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).filter((p) => p.includes('review CORRECTIONS'))
  expect(msgs).toHaveLength(1)
  expect(msgs[0]!.split('\n')).toHaveLength(1)
})

// ---------- implementer stopped without a commit (agent-stopped) ----------

const noCommit: ControlResult = { ok: false, code: 'no-commit', reason: 'no commit since sha-head' }
/** Control "no commit", then a green control. */
const stopThenOk = () => {
  const next = seq<ControlResult>(noCommit, { ok: true, commits: 1 })
  return async () => next()
}
const REPORT = 'Stop: the plan is impossible.\nThe base component requires placeholder=" ".\nI am not committing.\n'

/** The implementer writes its report on the initial brief, then the reviewer approves. */
function stoppingAsk(report = REPORT) {
  const review = scriptedAsk(['VERDICT: APPROVED'])
  return async (name: string, file: string) => {
    if (basename(file) === 'brief.md' && report) await writeFile(join(dirname(file), 'report.md'), report)
    return review(name, file)
  }
}

test("stop without a commit with a report: agent-stopped gate, the orchestrator explains; once approved, a correction round carries the decision", async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: stopThenOk() } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-stopped'))
  expect(s.step).toBe('tasks')
  const g = s.gates.find((x) => x.kind === 'agent-stopped')!
  expect(g).toMatchObject({ status: 'pending', path: join(taskDir(), 'report.md') })
  expect(g.summary).toMatch(/^task 1: the implementer stopped without a commit\n/)
  expect(g.summary).toContain('placeholder=" "')
  expect(s.tasks[0]).toMatchObject({ phase: 'control', round: 0, stopGate: g.id })
  expect(String(fx.callsOf('herdr.notify').at(-1)![1])).toContain("stopped without a commit")
  const msg = String(fx.callsOf('herdr.agentPrompt').at(-1)![1])
  expect(msg).toContain(`Gate ${g.id} (agent-stopped)`)
  expect(msg).toContain('propose_amendment')

  expect(await eng.tick()).toBe('wait')
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.ask')).toHaveLength(1)

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved', note: 'keep the placeholder, document it' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control' && x.tasks[0]!.round === 1)
  expect(s.tasks[0]!.stopGate).toBeUndefined()
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'fixes-1.md')])
  const fix = await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')
  expect(fix).toContain('User decision: keep the placeholder, document it')
  expect(fix).not.toContain('Amended task')
  s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.step).toBe('global-review')
})

test("stop without a commit approved with no note: the decision passed on is \"continue\"", async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: stopThenOk() } } })
  const s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-stopped'))
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: s.gates[0]!.id, decision: 'approved' })
  await until(eng, (x) => x.tasks[0]!.round === 1 && x.tasks[0]!.phase === 'control')
  expect(await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')).toContain('User decision: continue')
})

test('stop without a commit, agent-stopped gate refused: the mission is blocked', async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: async () => noCommit } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-stopped'))
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: s.gates[0]!.id, decision: 'refused', note: 'we stop' })
  s = await until(eng, (x) => x.step === 'blocked')
  expect(s.blockedFrom).toBe('tasks')
  expect(s.blockedReason).toContain("stopped without a commit")
  expect(s.blockedReason).toContain('we stop')
  expect(s.tasks[0]!.stopGate).toBeUndefined()
})

test('no commit and no report: the mission is blocked as before, with no gate', async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk('') }, git: { controlCommits: async () => noCommit } } })
  const s = await until(eng, (x) => x.step === 'blocked')
  expect(s.blockedReason).toContain('commit check failed')
  expect(s.gates).toEqual([])
})

test('another control failure (dirty tree) blocks even with a report', async () => {
  const dirty = { ok: false as const, code: 'dirty' as const, reason: 'dirty tree:\n?? x' }
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: async () => dirty } } })
  const s = await until(eng, (x) => x.step === 'blocked')
  expect(s.blockedReason).toContain('dirty tree')
  expect(s.gates).toEqual([])
})

test("stop without a commit approved after a task amendment: the fix file carries the new task text", async () => {
  const AMENDED = PLAN1.replace('do a', 'do a, keeping the placeholder')
  const { fx, eng } = await setup({
    approved: AMENDED,
    patch: {
      tasks: [task({ phase: 'control', baseSha: 'b0', implementer: 'ct-1-t1', stopGate: 'g1' })],
      gates: [gate({ id: 'g1', kind: 'agent-stopped', status: 'pending', summary: "task 1: the implementer stopped without a commit" })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), '# Brief\n\n### Task 1: Model\n\n**Test:** `pnpm test a`\n\ndo a\n')
  fx.herdr.started.add('ct-1-t1')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'ok' })
  await until(eng, (x) => x.tasks[0]!.round === 1 && x.tasks[0]!.phase === 'control')
  const fix = await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')
  expect(fix).toContain('User decision: ok')
  expect(fix).toContain('## Amended task instructions')
  expect(fix).toContain('do a, keeping the placeholder')
})

// ---------- amendment of the in-progress task (scenario 20261030-5) ----------

const T1_FIXED = '### Task 1: Model\n\n**Test:** `pnpm test a`\n\ndo a, keeping the placeholder required by the base component\n'
const PLAN1_FIXED = `# Plan\n\n${T1_FIXED}`

test("20261030-5: stop without a commit, task amendment approved, brief rewritten with a resume, implementer restarted, no block", async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: stopThenOk() } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-stopped'))
  const stop = s.gates.find((g) => g.kind === 'agent-stopped')!
  expect(await eng.tick()).toBe('wait')

  // The orchestrator proposes the amendment (outside the worktree), the user approves it.
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), PLAN1_FIXED)
  await postInbox('T-1', { type: 'request-gate', kind: 'amendment', summary: 'keep the placeholder', path: join(missionDir('T-1'), 'plan.proposed.md'), hash: proposalHash(PLAN1_FIXED) })
  await eng.tick()
  s = await loadState('T-1')
  const amend = s.gates.find((g) => g.kind === 'amendment')!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: amend.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.appliedAmendments).toEqual([amend.id])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement', round: 0 })
  expect(s.tasks[0]!.stopGate).toBeUndefined()
  expect(s.gates.find((g) => g.id === stop.id)!.status).toBe('obsolete')
  expect(fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).some((p) => p.includes(`Gate ${stop.id} (agent-stopped) is obsolete`))).toBe(true)
  const brief = await readFile(join(taskDir(), 'brief.md'), 'utf8')
  expect(brief).toContain('## Resume')
  expect(brief).toContain('Work is already present in the tree: keep it, adapt it to the new instructions, then run the tests and commit')
  expect(brief).toContain('keeping the placeholder required')
  expect(await readFile(join(wt, planPath(s)), 'utf8')).toBe(PLAN1_FIXED)

  s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.step).toBe('global-review')
  const implAsks = fx.callsOf('agents.ask').filter((c) => c[0] === 'ct-1-t1').map((c) => c[1])
  expect(implAsks).toEqual([join(taskDir(), 'brief.md'), join(taskDir(), 'brief.md')])
  expect(s.log.some((l) => l.msg.startsWith('mission blocked'))).toBe(false)

  // The agent-stopped gate, decided later (message already posted), is ignored.
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: stop.id, decision: 'refused', note: 'too late' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).not.toBe('blocked')
  expect(s.gates.find((g) => g.id === stop.id)!.status).toBe('obsolete')
  expect(s.log.some((l) => l.msg === `decision ignored: gate ${stop.id} obsolete: nothing is waiting for it, decision ignored`)).toBe(true)
})

test("an amendment approved while the mission is blocked in the task loop unblocks it and applies", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN1_FIXED,
    patch: {
      step: 'blocked',
      blockedFrom: 'tasks',
      blockedReason: 'task 1: commit check failed',
      tasks: [task({ phase: 'control', round: 2, baseSha: 'sha-head', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'pending', hash: proposalHash(PLAN1_FIXED) })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), '# Task brief\n\ndo a\n')
  fx.herdr.started.add('ct-1-t1')
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.step).toBe('tasks')
  expect(s.blockedReason).toBeUndefined()
  expect(s.blockedFrom).toBeUndefined()
  expect(await readFile(join(taskDir(), 'brief.md'), 'utf8')).toContain('## Resume')
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'brief.md')])
})

// ---------- arbitration with no correction waiting ----------

test("an arbitration decided while no correction is waiting has no effect and the orchestrator is told", async () => {
  const { fx, eng } = await setup({
    patch: {
      step: 'blocked',
      blockedFrom: 'tasks',
      blockedReason: 'task 1: commit check failed',
      tasks: [task({ phase: 'control', baseSha: 'b0' })],
      gates: [gate({ id: 'g1', kind: 'arbitration', status: 'pending', summary: 'continue?' })],
    },
  })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'continue' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.consumedArbitrages).toEqual(['g1'])
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.at(-1)).toContain('arbitration g1 with no effect: no correction was waiting for a decision')
})

test("an arbitration decided while a correction is waiting is not reported as having no effect", async () => {
  const { fx, eng } = await setup({
    patch: {
      tasks: [task({ phase: 'fix', round: 1, fixer: 'same', baseSha: 'b0', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'arbitration', status: 'pending', summary: 'column?' })],
    },
  })
  fx.herdr.started.add('ct-1-t1')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'keep it' })
  await eng.tick()
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.some((p) => p.includes('with no effect'))).toBe(false)
  expect(await readFile(join(taskDir(), 'fixes-1.md'), 'utf8')).toContain('keep it')
})

// ---------- review, round 1 ----------

test("I1: the amendment commit moves the in-progress task base, control does not count the documents", async () => {
  let head = 'sha-head'
  const controls: string[] = []
  const control = stopThenOk()
  const { fx, eng } = await setup({
    over: {
      agents: { ask: stoppingAsk() },
      git: {
        headSha: async () => head,
        commitFiles: async () => {
          head = 'sha-docs'
          return head
        },
        controlCommits: async (_wt: string, base: string) => {
          controls.push(base)
          return control()
        },
      },
    },
  })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-stopped'))
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), PLAN1_FIXED)
  await postInbox('T-1', { type: 'request-gate', kind: 'amendment', summary: 's', hash: proposalHash(PLAN1_FIXED) })
  await eng.tick()
  s = await loadState('T-1')
  const amend = s.gates.find((g) => g.kind === 'amendment')!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: amend.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toHaveLength(1)
  expect(s.tasks[0]!.baseSha).toBe('sha-docs')
  await until(eng, (x) => x.step !== 'tasks')
  expect(controls).toEqual(['sha-head', 'sha-docs'])
})

test("I2: an obsolete agent-stopped gate does not hold back a later amendment", async () => {
  const { eng } = await setup({
    proposed: PLAN2,
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'agent-stopped', status: 'obsolete' }), gate({ id: 'g2', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN2) })],
    },
  })
  await eng.tick()
  expect((await loadState('T-1')).appliedAmendments).toEqual(['g2'])
})

// Like `writeBrief`: title, then the body as `parsePlan` cuts it (it starts with the title's trailing newline).
const BRIEF1 = '# Task brief\n\n### Task 1: Model\n\n\n\n**Test:** `pnpm test a`\n\ndo a\n'
const blockedOn = (reason: string): Partial<MissionState> => ({
  step: 'blocked',
  blockedFrom: 'tasks',
  blockedReason: reason,
  tasks: [task({ phase: 'control', round: 2, baseSha: 'sha-head', implementer: 'ct-1-t1' })],
})

/** The orchestrator proposes the amendment (gate opened by the engine), the user approves it. */
async function proposeAndApprove(eng: Engine, plan: string): Promise<MissionState> {
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), plan)
  await postInbox('T-1', { type: 'request-gate', kind: 'amendment', summary: 'amendment', hash: proposalHash(plan) })
  await eng.tick()
  const g = (await loadState('T-1')).gates.find((x) => x.kind === 'amendment')!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  await eng.tick()
  return loadState('T-1')
}

test("I3: mission blocked by task 1, amendment that changes it: the gate says so, approval unblocks", async () => {
  const { eng } = await setup({ patch: blockedOn('task 1: 3 correction rounds exhausted') })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  const s = await proposeAndApprove(eng, PLAN1_FIXED)
  expect(s.gates.find((g) => g.kind === 'amendment')!.summary).toBe('amendment (mission blocked: approving this amendment will restart task 1)')
  expect(s.step).toBe('tasks')
  expect(s.tasks[0]!.round).toBe(0)
})

test("I3: amendment that does not change the blocking task: applied, the mission stays blocked and the orchestrator knows", async () => {
  const { fx, eng } = await setup({ patch: blockedOn('task 1: commit check failed') })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  const s = await proposeAndApprove(eng, PLAN2)
  expect(s.gates.find((g) => g.kind === 'amendment')!.summary).toBe('amendment (mission blocked: approving does not clear the block)')
  expect(s.appliedAmendments).toHaveLength(1)
  expect(s.tasks.map((t) => t.n)).toEqual([1, 2])
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toBe('task 1: commit check failed')
  expect(s.tasks[0]).toMatchObject({ phase: 'control', round: 2 })
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.some((p) => p.includes('mission still blocked: herness resume T-1 to restart it'))).toBe(true)
})

test("I3: block from something other than the task (agent timed out), task amendment: applied, the mission stays blocked", async () => {
  const { eng } = await setup({ patch: blockedOn('agent ct-1-t1 timed out (task 1)') })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  const s = await proposeAndApprove(eng, PLAN1_FIXED)
  expect(s.gates.find((g) => g.kind === 'amendment')!.summary).toContain('approving does not clear the block')
  expect(s.step).toBe('blocked')
  expect(s.appliedAmendments).toHaveLength(1)
})

test("M1: a report that has not grown since the brief was sent does not open an agent-stopped gate", async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk('') }, git: { controlCommits: async () => noCommit } } })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'report.md'), 'old report\n')
  const s = await until(eng, (x) => x.step === 'blocked')
  expect(s.tasks[0]!.reportSize).toBe(Buffer.byteLength('old report\n'))
  expect(s.blockedReason).toContain('commit check failed')
  expect(s.gates).toEqual([])
})

test("M1: the agent-stopped gate shows only what the implementer added to the report", async () => {
  const ask = async (name: string, file: string) => {
    if (basename(file) === 'brief.md') await writeFile(join(dirname(file), 'report.md'), 'old\nNEW: stop\n')
    return 'done' as const
  }
  const { eng } = await setup({ over: { agents: { ask }, git: { controlCommits: async () => noCommit } } })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'report.md'), 'old\n')
  const s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-stopped'))
  expect(s.gates[0]!.summary).toBe("task 1: the implementer stopped without a commit\nNEW: stop")
})

test("M2: engine stop after the proposal was removed (old order): the amendment is resumed as applied", async () => {
  const { eng } = await setup({
    approved: PLAN1_FIXED,
    patch: {
      tasks: [task({ phase: 'control', baseSha: 'sha-head', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN1_FIXED) })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement' })
  expect(await readFile(join(taskDir(), 'brief.md'), 'utf8')).toContain('## Resume')
  expect(s.log.some((l) => l.msg.includes('not applied'))).toBe(false)
})

test("M2: engine stop before state was saved (brief already rewritten): resume reapplies it", async () => {
  const { eng } = await setup({
    proposed: PLAN1_FIXED,
    approved: PLAN1_FIXED,
    patch: {
      tasks: [task({ phase: 'control', baseSha: 'sha-head', implementer: 'ct-1-t1', stopGate: 'g2' })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN1_FIXED) }), gate({ id: 'g2', kind: 'agent-stopped', status: 'pending' })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  // Brief rewritten by the interrupted attempt.
  await writeFile(join(taskDir(), 'brief.md'), `# Task brief\n\n## Resume\n\n<!-- amendment g1 -->\n\n### Task 1: Model\n\n\n\n**Test:** \`pnpm test a\`\n\ndo a, keeping the placeholder required by the base component\n`)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement' })
  expect(s.gates[1]!.status).toBe('obsolete')
  await expect(readFile(join(missionDir('T-1'), 'plan.proposed.md'))).rejects.toThrow()
})

test("M4: an amendment that removes the in-progress task is rejected and the orchestrator is told", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN1,
    plan: PLAN2,
    patch: {
      tasks: [task({ phase: 'done' }), task({ n: 2, title: 'Export', testCommand: 'pnpm test b', phase: 'control', baseSha: 'b0' })],
      gates: [gate({ id: 'g1', kind: 'amendment', status: 'approved', hash: proposalHash(PLAN1) })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks).toHaveLength(2)
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain('in-progress task 2 has disappeared')
})

const msgs = (s: MissionState) => s.log.map((l) => l.msg)

test('a validated task stops its implementer and its reviewer, panes kept with ✓', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } } })
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  const impl = fx.herdr.pane(s.herdr.panes['ct-1-t1']!)
  const rev = fx.herdr.pane(s.herdr.panes['rt-1-t1']!)
  expect(impl.busy).toBe(false)
  expect(rev.busy).toBe(false)
  expect(impl.label).toBe('T1 · grok-4.7-medium ✓')
  expect(rev.label).toBe('T1 · claude-opus-5-5 ✓')
  expect(await fx.herdr.agentGet('ct-1-t1')).toBeNull()
  expect(msgs(s)).toEqual(expect.arrayContaining(['task 1: agent ct-1-t1 stopped', 'task 1: agent rt-1-t1 stopped']))
})

test("during a correction round the implementer and the reviewer stay alive", async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: CORRECTIONS', 'VERDICT: APPROVED']) } } })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  expect(fx.herdr.pane(s.herdr.panes['ct-1-t1']!).busy).toBe(true)
  expect(fx.herdr.pane(s.herdr.panes['rt-1-t1']!).busy).toBe(true)
  expect(msgs(s).filter((m) => /agent .+ stopped/.test(m))).toEqual([])
  s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  expect(fx.herdr.pane(s.herdr.panes['ct-1-t1']!).busy).toBe(false)
  expect(fx.herdr.pane(s.herdr.panes['rt-1-t1']!).busy).toBe(false)
  expect(msgs(s)).toEqual(expect.arrayContaining(['task 1: agent ct-1-t1 stopped', 'task 1: agent rt-1-t1 stopped']))
})

test('a stop that fails is logged and the task still moves to done', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: APPROVED']) } } })
  const born = await until(eng, (x) => x.herdr.panes['ct-1-t1'] !== undefined)
  fx.herdr.pane(born.herdr.panes['ct-1-t1']!).deaf = true
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  expect(s.step).not.toBe('blocked')
  expect(msgs(s).some((m) => m.startsWith('task 1: agent ct-1-t1 not stopped ('))).toBe(true)
})

test('stopAgent on an agent with no recorded pane does nothing', async () => {
  const { fx } = await setup()
  const s = await loadState('T-1')
  const logLen = s.log.length
  await stopAgent(s, fx, 'task 9', 'unknown')
  expect(fx.callsOf('herdr.paneSendKeys')).toEqual([])
  expect(s.log).toHaveLength(logLen)
})
