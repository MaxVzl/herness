import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { Engine } from '../../src/engine/engine.ts'
import { postInbox } from '../../src/mission/inbox.ts'
import { loadState, newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir, planPath, specPath } from '../../src/paths.ts'
import { fakeEffects, type FakeOverrides } from '../fakes.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-engine-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

async function mission(patch: Partial<MissionState> = {}): Promise<MissionState> {
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: wt }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'herness/T-1',
    herdr: { workspace: 'w1', tabs: { process: 'w1:t4', checks: 'w1:t3', agents: 'w1:t2' }, panes: {} },
    orchestrator: { agent: 'o-T-1' },
    ...patch,
  }
  await saveState(s)
  return s
}

function engine(over: FakeOverrides = {}) {
  const fx = fakeEffects(over)
  return { fx, eng: new Engine('T-1', fx, demo) }
}

const notCursor = async (cmd: string, args: string[]) =>
  cmd === 'cursor-agent' ? { stdout: 'Not logged in', stderr: '', exitCode: 1 } : { stdout: `${cmd} ${args.join(' ')}`, stderr: '', exitCode: 0 }

test('env with a KO blocks the mission and includes the command to run', async () => {
  await mission()
  const { fx, eng } = engine({ run: notCursor })
  expect(await eng.tick()).toBe('continue')
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toContain('cursor')
  expect(s.blockedReason).toContain('! cursor-agent login')
  expect(s.blockedReason).toContain('environment incomplete')
  const prompts = fx.callsOf('herdr.agentPrompt')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]![0]).toBe('o-T-1')
  expect(String(prompts[0]![1])).toMatch(/^\[herness\] .*cursor-agent login/s)
  expect(String(prompts[0]![1])).toMatch(/^\[herness\] Mission blocked:/)
  expect(prompts[0]![2]).toEqual({ wait: false })
  expect(await eng.tick()).toBe('wait')
})

test('env all OK moves on to prepare', async () => {
  await mission()
  const { eng } = engine()
  await eng.tick()
  expect((await loadState('T-1')).step).toBe('prepare')
})

test('prepare without a worktree blocks and does not run the setup', async () => {
  await mission({ step: 'prepare', worktree: undefined })
  const { fx, eng } = engine()
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedFrom).toBe('prepare')
  expect(s.blockedReason).toBe('cannot prepare: worktree or process tab unknown')
  expect(fx.callsOf('runInPane')).toEqual([])
})

test('prepare runs project setup in the process tab, then classify; a failure blocks', async () => {
  await mission({ step: 'prepare' })
  const { fx, eng } = engine()
  await eng.tick()
  const [h, tab, cwd, label, cmd, logDir] = fx.callsOf('runInPane')[0]!
  expect(h).toBe(fx.herdr)
  expect([tab, cwd, label, logDir]).toEqual(['w1:t4', wt, 'prepare', join(missionDir('T-1'), 'logs')])
  expect(cmd).toEqual([demo.prepare[0], wt])
  expect((await loadState('T-1')).step).toBe('classify')

  await mission({ step: 'prepare' })
  const ko = engine({ runInPane: async () => ({ exitCode: 2, logPath: '/l.log', tail: 'error', durationMs: 1 }) })
  await ko.eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toContain('/l.log')
  expect(s.blockedReason).toContain('worktree prepare failed')
})

test('classify renames the branch to feature/<id>-<slug> for type feat on the demo project', async () => {
  await mission({ step: 'classify' })
  const { fx, eng } = engine()
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('git.renameBranch')).toEqual([])

  await postInbox('T-1', { type: 'classified', workType: 'feat', slug: 'export-csv' })
  expect(await eng.tick()).toBe('continue')
  expect(fx.callsOf('git.renameBranch')).toEqual([[wt, 'herness/T-1', 'feature/T-1-export-csv']])
  const s = await loadState('T-1')
  expect(s).toMatchObject({ step: 'brainstorm', type: 'feat', slug: 'export-csv', branch: 'feature/T-1-export-csv' })
  // The orchestrator learns the new name: its prompt does not know it.
  expect(fx.callsOf('herdr.agentPrompt').map((c) => c[1])).toContainEqual(expect.stringContaining('feature/T-1-export-csv'))
  expect(fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).some((p) => p.startsWith('[herness] Mission branch renamed to feature/T-1-export-csv'))).toBe(true)
})

test('classified with an unknown type is logged and ignored', async () => {
  await mission({ step: 'classify' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'classified', workType: 'bidule', slug: 'export-csv' })
  expect(await eng.tick()).toBe('wait')
  const s = await loadState('T-1')
  expect(s.type).toBeUndefined()
  expect(s.log.map((l) => l.msg).join('\n')).toContain('unknown type "bidule"')
})

async function writeSpec(s0: MissionState): Promise<void> {
  const file = join(wt, specPath(s0))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '# Spec\n')
}

test('an approved spec gate commits the spec and moves on to plan', async () => {
  await writeSpec(await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' }))
  const { fx, eng } = engine()
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec ready', path: 'docs/x.md' })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('spec')
  expect(s.gates).toMatchObject([{ id: 'g1', kind: 'spec', status: 'pending' }])
  expect(fx.callsOf('herdr.notify')[0]![2]).toBe('request')
  expect(String(fx.callsOf('herdr.notify')[0]![1])).toMatch(/^Gate spec to approve: /)
  expect(String(fx.callsOf('herdr.agentPrompt')[0]![1])).toMatch(/^\[herness\] Gate g1 \(spec\) opened, waiting for the user's decision \(herness approve\|reject T-1 --gate g1\)\./)
  expect(await eng.tick()).toBe('wait')

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [specPath(s)], 'docs(T-1): spec export-csv']])
  expect(s.step).toBe('plan')
})

test('a rejected spec gate sends the note back to the orchestrator and returns to brainstorm', async () => {
  await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec ready' })
  await eng.tick()
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'refused', note: 'too vague about permissions' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('brainstorm')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  const last = fx.callsOf('herdr.agentPrompt').at(-1)!
  expect(last[0]).toBe('o-T-1')
  expect(String(last[1])).toMatch(/^\[herness\] The user rejected gate g1 \(spec\)\. Reason: too vague about permissions\. Fix it, then request approval again with request_approval\('spec'\)\./)
  expect(last[2]).toEqual({ wait: false })
  // A rejected gate does not move back to spec; a new request does.
  expect(await eng.tick()).toBe('wait')
  expect((await loadState('T-1')).step).toBe('brainstorm')
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec v2' })
  await eng.tick()
  expect((await loadState('T-1')).step).toBe('spec')
})

const PLAN = '# Plan\n\n### Tâche 1 : Modèle\n\n**Test :** `pnpm test a`\n\nfaire a\n\n### Tâche 2 : Export\n\n**Test :** `pnpm test b`\n\nfaire b\n'

test('an approved plan gate fills state.tasks from the plan', async () => {
  const s0 = await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const file = join(wt, planPath(s0))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, PLAN)
  const { fx, eng } = engine()
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'Plan ready', path: planPath(s0) })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks).toEqual([
    { n: 1, title: 'Modèle', testCommand: 'pnpm test a', phase: 'pending', round: 0 },
    { n: 2, title: 'Export', testCommand: 'pnpm test b', phase: 'pending', round: 0 },
  ])
  expect(await readFile(join(missionDir('T-1'), 'plan.approved.md'), 'utf8')).toBe(PLAN)
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s)], 'docs(T-1): plan export-csv']])
})

test('a rejected plan gate stays on plan and waits for a new plan gate', async () => {
  await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'Plan ready' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'refused', note: 'split too large' })
  expect(await eng.tick()).toBe('wait')
  expect((await loadState('T-1')).step).toBe('plan')
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain('Reason: split too large')
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain("request_approval('plan')")
  expect(fx.callsOf('git.commitFiles')).toEqual([])
})

test('a decision from a message without source user is rejected', async () => {
  await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec ready' })
  await eng.tick()
  const inbox = join(missionDir('T-1'), 'inbox')
  await writeFile(join(inbox, '999999999999999-000001-1-forge.json'), JSON.stringify({ type: 'decision', gateId: 'g1', decision: 'approved' }))
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.gates[0]!.status).toBe('pending')
  expect(s.step).toBe('spec')
  expect(await readdir(join(inbox, 'rejected'))).toEqual(['999999999999999-000001-1-forge.json'])
})

test('abandon opens an abandon gate without closing anything; the user approves it, databases are removed and the mission is closed', async () => {
  await mission({ step: 'brainstorm', testDbUp: true })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  expect(await eng.tick()).toBe('wait')
  let s = await loadState('T-1')
  expect(s.step).toBe('brainstorm')
  expect(s.testDbUp).toBe(true)
  expect(s.gates).toMatchObject([{ id: 'g1', kind: 'abandon', status: 'pending', summary: 'spike' }])
  expect(fx.callsOf('run')).toEqual([])
  expect(fx.callsOf('herdr.notify')).toHaveLength(1)
  expect(String(fx.callsOf('herdr.notify')[0]![1])).toBe('Abandon to approve: spike')
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] Gate g1 \(abandon\) opened, waiting for the user's decision \(herness approve\|reject T-1 --gate g1\)\./)
  // A second request does not open another gate.
  await postInbox('T-1', { type: 'abandon', reason: 'spike again' })
  await eng.tick()
  expect((await loadState('T-1')).gates).toHaveLength(1)
  expect((await loadState('T-1')).log.map((l) => l.msg).join('\n')).toContain('abandon request: gate g1 is already pending')

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(await eng.tick()).toBe('stop')
  s = await loadState('T-1')
  expect(s.step).toBe('closed')
  expect(s.testDbUp).toBe(false)
  expect(fx.callsOf('run')).toEqual([[demo.testDb!.down[0], ['down', 'T-1', wt], { cwd: wt, reject: false }]])
  expect(s.log.map((l) => l.msg).join('\n')).toContain('abandon approved (g1): mission closed')
})

test('rejected abandon: the mission continues', async () => {
  await mission({ step: 'brainstorm' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'refused', note: 'keep going' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('brainstorm')
  expect(s.gates[0]!.status).toBe('refused')
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toBe('[herness] The user rejected the abandon (gate g1), with the note: keep going. The mission continues.')
})

test('approved abandon when a database cannot be removed: mission blocked, not closed', async () => {
  await mission({ step: 'brainstorm', testDbUp: true })
  const { eng } = engine({ run: async () => ({ stdout: '', stderr: 'docker missing', exitCode: 1 }) })
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toContain('test database T-1 not removed')
  expect(s.testDbUp).toBe(true)
})

test('pause blocks all progress until resume', async () => {
  await mission()
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'pause' })
  expect(await eng.tick()).toBe('wait')
  expect(await eng.tick()).toBe('wait')
  let s = await loadState('T-1')
  expect(s).toMatchObject({ step: 'env', paused: true })
  expect(fx.callsOf('run')).toEqual([])
  await postInbox('T-1', { type: 'resume' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s).toMatchObject({ step: 'prepare', paused: false })
  expect(s.log.map((l) => l.msg)).toContain('resume')
})

test('run: an exception blocks the mission without stopping the engine, which continues until stop', async () => {
  await mission({ step: 'classify', type: 'feat', slug: 'export-csv', testDbUp: true })
  let sleeps = 0
  const { fx, eng } = engine({
    git: { renameBranch: async () => { throw new Error('branch locked') } },
    sleep: async () => {
      if (++sleeps === 2) {
        await postInbox('T-1', { type: 'abandon', reason: 'end of test' })
        await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
      }
    },
  })
  await eng.run()
  const s = await loadState('T-1')
  expect(s.step).toBe('closed')
  expect(s.blockedReason).toContain('branch locked')
  expect(s.blockedReason?.split('\n')[0]?.startsWith('engine error: ')).toBe(true)
  expect(s.blockedReason?.endsWith(`\ndetail: ${join(home, 'errors.log')}`)).toBe(true)
  const journal = await readFile(join(home, 'errors.log'), 'utf8')
  expect(journal).toContain('· mission T-1 · herness ')
  expect(journal).toContain('· engine (step classify)')
  expect(journal).toContain('branch locked')
  expect(journal).toMatch(/^    at /m)
  expect(s.log.map((l) => l.msg).join('\n')).toContain('branch locked')
  // Test database stopped as soon as the exception happens.
  expect(fx.callsOf('run')[0]).toEqual([demo.testDb!.down[0], ['down', 'T-1', wt], { cwd: wt, reject: false }])
})

test('unreadable state: startup and block-recording errors are logged without a step', async () => {
  const { eng } = engine({ sleep: async () => { throw new Error('end of test') } })
  await expect(eng.run()).rejects.toThrow('end of test')
  const journal = await readFile(join(home, 'errors.log'), 'utf8')
  expect(journal).toContain('engine: startup (pane cleanup)')
  expect(journal).toContain('engine: startup (stopping finished agents)')
  expect(journal).toContain('engine: recording the block')
  expect(journal).toMatch(/· engine$/m)
  expect(journal).not.toContain('(étape')
})

test('unreachable journal: the block reason does not point at the file', async () => {
  await mission({ step: 'classify', type: 'feat', slug: 'export-csv' })
  await mkdir(join(home, 'errors.log'))
  const { eng } = engine({
    git: { renameBranch: async () => { throw new Error('branch locked') } },
    sleep: async () => { throw new Error('end of test') },
  })
  await expect(eng.run()).rejects.toThrow('end of test')
  const s = await loadState('T-1')
  expect(s.blockedReason?.split('\n')[0]).toBe('engine error: branch locked')
  expect(s.blockedReason).not.toContain('detail:')
})

test('persistent unreadable state: a single pair of entries across several turns', async () => {
  let sleeps = 0
  const { eng } = engine({
    sleep: async () => {
      if (++sleeps === 3) throw new Error('end of test')
    },
  })
  await expect(eng.run()).rejects.toThrow('end of test')
  expect(sleeps).toBe(3)
  const journal = await readFile(join(home, 'errors.log'), 'utf8')
  expect(journal.match(/· engine$/gm)).toHaveLength(1)
  expect(journal.match(/engine: recording the block/g)).toHaveLength(1)
})

test('pr-open stops the loop', async () => {
  await mission({ step: 'pr-open' })
  expect(await engine().eng.tick()).toBe('stop')
})

test('resume: branch already renamed, no new rename, branch recorded', async () => {
  await mission({ step: 'classify', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine({ git: { currentBranch: async () => 'feature/T-1-export-csv' } })
  await eng.tick()
  expect(fx.callsOf('git.renameBranch')).toEqual([])
  expect(await loadState('T-1')).toMatchObject({ step: 'brainstorm', branch: 'feature/T-1-export-csv' })
  expect(fx.callsOf('herdr.agentPrompt').map((c) => c[1])).toContainEqual(expect.stringContaining('feature/T-1-export-csv'))
  expect((await loadState('T-1')).log.map((l) => l.msg).join('\n')).toContain('branch already named feature/T-1-export-csv')
})

test('resume: spec already committed, no commit, move on to plan', async () => {
  await writeSpec(await mission({ step: 'spec', type: 'feat', slug: 'export-csv' }))
  const { fx, eng } = engine({ git: { isClean: async () => true } })
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 's' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(fx.callsOf('git.isClean')).toEqual([[wt, specPath(s)]])
  expect(s.step).toBe('plan')
  expect(s.log.map((l) => l.msg).join('\n')).toContain('already committed')
})

test('resume: plan already committed, no commit, tasks filled and move on to tasks', async () => {
  const s0 = await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const file = join(wt, planPath(s0))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, PLAN)
  const { fx, eng } = engine({ git: { isClean: async () => true } })
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'p' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(s.step).toBe('tasks')
  expect(s.tasks).toHaveLength(2)
})

test('two spec request-gate messages leave a single pending gate, updated', async () => {
  await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'v1', path: 'a.md' })
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'v2', path: 'b.md' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.gates).toHaveLength(1)
  expect(s.gates[0]).toMatchObject({ id: 'g1', status: 'pending', summary: 'v2', path: 'b.md' })
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] Gate g1 \(spec\) is already pending the user's decision/)
  expect(fx.callsOf('herdr.notify')).toHaveLength(1)
})

test('block records the step the mission was blocked from', async () => {
  await mission({ step: 'prepare' })
  const { eng } = engine({ runInPane: async () => ({ exitCode: 1, logPath: '/l', tail: '', durationMs: 1 }) })
  await eng.tick()
  expect(await loadState('T-1')).toMatchObject({ step: 'blocked', blockedFrom: 'prepare' })
  expect((await loadState('T-1')).log.map((l) => l.msg).join('\n')).toContain('mission blocked:')
})

test('amendment request-gate: the proposal hash is stored on the gate (updated on a duplicate)', async () => {
  await mission({ step: 'blocked', slug: 'x' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'amendment', summary: 'a', path: '/m/plan.proposed.md', hash: 'h1' })
  await eng.tick()
  expect((await loadState('T-1')).gates[0]).toMatchObject({ kind: 'amendment', hash: 'h1', path: '/m/plan.proposed.md' })
  await postInbox('T-1', { type: 'request-gate', kind: 'amendment', summary: 'b', path: '/m/plan.proposed.md', hash: 'h2' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.gates).toHaveLength(1)
  // Blocked mission: the summary says what approving will change.
  expect(s.gates[0]).toMatchObject({ summary: 'b (mission blocked: approving does not clear the block)', hash: 'h2' })
})

test('classified: the orchestrator receives the exact spec and plan paths', async () => {
  await mission({ step: 'classify' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'classified', workType: 'feat', slug: 'export-csv' })
  await eng.tick()
  const s = await loadState('T-1')
  const msg = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).find((p) => p.includes('export-csv'))!
  expect(msg).toContain(join(wt, specPath(s)))
  expect(msg).toContain(join(wt, planPath(s)))
  expect(msg).toMatch(/^\[herness\] Mission classified feat \/ export-csv\. Write the spec at /)
})

test('approved spec missing from the worktree: mission blocked with the path, never "already committed"', async () => {
  const s0 = await mission({ step: 'spec', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine({ git: { isClean: async () => true } })
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 's' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedReason).toContain(join(wt, specPath(s0)))
  expect(s.blockedReason).toContain('approved spec missing from the worktree')
  expect(s.log.map((l) => l.msg).join('\n')).not.toContain('already committed')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
})

test('approved plan missing from the worktree: mission blocked with the path', async () => {
  const s0 = await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'p' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('blocked')
  expect(s.blockedFrom).toBe('plan')
  expect(s.blockedReason).toContain(join(wt, planPath(s0)))
  expect(s.blockedReason).toContain('approved plan missing from the worktree')
  expect(s.blockedReason).not.toContain('engine error')
})

test('at engine startup, commands still running in checks and process are interrupted and marked ✗', async () => {
  const { fx, eng } = engine()
  const { ws, tab: checks, pane: c1 } = fx.herdr.seedWorkspace('T-1', 'checks')
  const proc = await fx.herdr.tabCreate({ workspace: ws, cwd: wt, label: 'process' })
  const agents = await fx.herdr.tabCreate({ workspace: ws, cwd: wt, label: 'agents' })
  await fx.herdr.paneRename(c1, 'preflight · lint …')
  const c2 = fx.herdr.addPane(checks, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · tests ✓')
  await fx.herdr.paneRename(proc.rootPaneId, 'engine')
  const p2 = fx.herdr.addPane(proc.tabId, { x: 0, y: 30, width: 200, height: 30 }, 'test database …')
  const a1 = fx.herdr.addPane(agents.tabId, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · grok …')
  for (const p of [c1, p2, a1]) fx.herdr.pane(p).busy = true
  await mission({ step: 'pr-open', herdr: { workspace: ws, tabs: { checks, process: proc.tabId, agents: agents.tabId }, panes: {} } })
  fx.calls.length = 0
  await eng.run()
  const keys = fx.callsOf('herdr.paneSendKeys')
  expect(keys).toEqual([[c1, 'ctrl+c'], [c1, 'ctrl+c'], [p2, 'ctrl+c'], [p2, 'ctrl+c'], [a1, 'ctrl+c'], [a1, 'ctrl+c']])
  expect(fx.herdr.pane(c1).label).toBe('preflight · lint ✗')
  expect(fx.herdr.pane(p2).label).toBe('test database ✗')
  expect(fx.herdr.pane(c2).label).toBe('T1 · tests ✓')
  expect(fx.herdr.pane(proc.rootPaneId).label).toBe('engine')
  expect(fx.herdr.pane(a1).label).toBe('T1 · grok …')
  expect(fx.herdr.pane(a1).busy).toBe(false)
  // Once per engine startup.
  await eng.tick()
  expect(fx.callsOf('herdr.paneSendKeys')).toHaveLength(6)
})

test('at engine startup, a blocked mission stops agents in ✓ panes and keeps the others', async () => {
  const { fx, eng } = engine({
    sleep: async () => {
      throw new Error('end of test')
    },
  })
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const done = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · grok ✓')
  const live = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T2 · grok')
  for (const p of [done, live]) fx.herdr.pane(p).busy = true
  await mission({
    step: 'blocked',
    blockedFrom: 'tasks',
    blockedReason: 'check failed',
    herdr: { workspace: ws, tabs: { agents: tab }, panes: {} },
  })
  await expect(eng.run()).rejects.toThrow('end of test')
  expect(fx.herdr.pane(done).busy).toBe(false)
  expect(fx.herdr.pane(live).busy).toBe(true)
  const s = await loadState('T-1')
  expect(s.log.map((l) => l.msg).join('\n')).toContain('engine startup : agent(s) arrêté(s) dans T1 · grok ✓')
})

test('an approved abandon stops every agent in the agents tab', async () => {
  const { fx, eng } = engine()
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const done = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · grok ✓')
  const live = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T2 · grok')
  for (const p of [done, live]) fx.herdr.pane(p).busy = true
  await mission({
    step: 'brainstorm',
    testDbUp: true,
    herdr: { workspace: ws, tabs: { process: 'w1:t4', checks: 'w1:t3', agents: tab }, panes: {} },
  })
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(await eng.tick()).toBe('stop')
  const s = await loadState('T-1')
  expect(s.step).toBe('closed')
  expect(fx.herdr.pane(done).busy).toBe(false)
  expect(fx.herdr.pane(live).busy).toBe(false)
  expect(s.log.some((l) => l.msg.startsWith('abandon approved : agent(s) arrêté(s) dans'))).toBe(true)
})

test('orchestrator-started: the engine records that the opening prompt was sent', async () => {
  await mission({ step: 'blocked' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'orchestrator-started' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.orchestrator.started).toBe(true)
  expect(s.log.map((l) => l.msg)).toContain('opening prompt sent to the orchestrator')
})
