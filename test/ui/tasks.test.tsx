import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { openGate } from '../../src/engine/gates.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { TasksDashboard, TasksView } from '../../src/ui/tasks.tsx'
import { settle, until, waitFor, waitGone, waitMatch } from './wait.ts'
import type { MissionActions } from '../../src/ui/detail.tsx'
import type { ActionResult } from '../../src/ui/actions.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

function base(): MissionState {
  const s = newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/r' })
  s.branch = 'feat/T-1-x'
  s.step = 'tasks'
  s.tasks.push(
    { n: 1, title: 'First', testCommand: 't', phase: 'done', round: 0 },
    { n: 2, title: 'Second', testCommand: 't', phase: 'review', round: 2, implementer: 'i2', reviewer: 'r2' },
    { n: 3, title: 'Third', testCommand: 't', phase: 'pending', round: 0 },
  )
  return s
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

test('shows tasks with their phase and round', () => {
  const { lastFrame } = render(<TasksView state={base()} />)
  const f = lastFrame()!
  expect(f).toContain('T-1 · feat/T-1-x · tasks')
  expect(f).toMatch(/✓.*First/)
  expect(f).toMatch(/▶.*Second.*review.*round 2\/3/)
  expect(f).toMatch(/·.*Third/)
  expect(f).toContain('i2')
  expect(f).toContain('r2')
})

test('highlights a pending gate with its summary', () => {
  const s = base()
  openGate(s, 'spec', 'Spec to approve', '/x/spec.md')
  s.paused = true
  const f = render(<TasksView state={s} />).lastFrame()!
  expect(f).toContain('g1')
  expect(f).toContain('spec: Spec to approve')
  expect(f).toContain('a approve · r reject')
  expect(f).toContain('PAUSED')
})

test('shows global review, preflight, log and PR', () => {
  const s = base()
  s.step = 'preflight'
  s.loops.globalReview.round = 1
  s.loops.preflight.round = 2
  s.loops.preflight.results.push(
    { label: 'lint', exitCode: 0, durationMs: 1500, logPath: '/l' },
    { label: 'test', exitCode: 1, durationMs: 62000, logPath: '/l' },
  )
  for (let i = 0; i < 7; i++) s.log.push({ at: 'x', msg: `line${i}` })
  s.prUrl = 'https://gh/pr/1'
  const f = render(<TasksView state={s} />).lastFrame()!
  expect(f).toMatch(/lint ✓/)
  expect(f).toMatch(/test ✗/)
  expect(f).not.toContain('line1')
  expect(f).toContain('line6')
  expect(f).toContain('PR: https://gh/pr/1')
})

test('shows the blocked reason', () => {
  const s = base()
  s.step = 'blocked'
  s.blockedReason = '3 rounds exhausted'
  expect(render(<TasksView state={s} />).lastFrame()!).toContain('3 rounds exhausted')
})


function fakeActions() {
  const calls: unknown[][] = []
  const done = async (): Promise<ActionResult> => ({ ok: true, lines: [] })
  const a: MissionActions = {
    validate: async (id, gateId, note) => { calls.push(['validate', id, gateId, note]); return done() },
    refuse: async (id, gateId, note) => { calls.push(['refuse', id, gateId, note]); return done() },
    resume: async (id) => { calls.push(['resume', id]); return done() },
    restart: async (id, o) => { calls.push(['restart', id, o?.detached === true]); return done() },
    close: async (id) => { calls.push(['close', id]); return done() },
    remove: async (id) => { calls.push(['remove', id]); return done() },
    open: async (s) => { calls.push(['open', s.id]); return done() },
  }
  return { a, calls }
}

test('a then Enter approves the oldest gate', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1 (spec) of T-1?')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('Approve g1 (spec) of T-1?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 approved')
  expect(calls).toEqual([['validate', 'T-1', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 approved')
})

test('a then Esc sends nothing', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\u001b')
  await waitGone(lastFrame, 'Approve g1')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).not.toContain('Approve g1')
})

test('r without a note then Enter rejects nothing; with a note, confirm then reject', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('r')
  await waitFor(lastFrame, 'ctrl+s submit')
  stdin.write('\r') // empty new line: nothing observable to wait for
  await settle()
  stdin.write('\x13')
  await waitFor(lastFrame, 'a note is required to reject')
  expect(calls).toEqual([])
  stdin.write('too long')
  await waitFor(lastFrame, 'too long▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'Reject g1')
  expect(calls).toEqual([])
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 rejected')
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'too long']])
  expect(lastFrame()).toContain('g1 rejected')
})

test('two quick a keys send only one decision', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const calls: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const a = { ...fakeActions().a, validate: async (_id: string, gateId: string) => { calls.push(gateId); await gate; return { ok: true, lines: [] } } }
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await until(() => calls.length === 1)
  stdin.write('a')
  await waitFor(lastFrame, 'no pending gate')
  stdin.write('\r')
  await tick() // absence: no second decision is sent
  release()
  await waitFor(lastFrame, 'g1 approved')
  expect(calls).toEqual(['g1'])
})

test('tab selects the second gate and a targets it', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('\t')
  await waitMatch(lastFrame, /▸.*g2/)
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g2')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', 'T-1', 'g2', undefined]])
})

test('a then a with two gates targets g1 then g2', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  for (let i = 0; i < 2; i++) {
    stdin.write('a')
    await waitFor(lastFrame, `Approve g${i + 1}`)
    stdin.write('\r')
    await until(() => calls.length === i + 1)
    await waitGone(lastFrame, 'Valider g')
  }
  expect(calls.map((c) => c[2])).toEqual(['g1', 'g2'])
})

test('c asks for confirmation before close', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => base()} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('c')
  await waitFor(lastFrame, 'Close T-1?')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('Close T-1?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['close', 'T-1']])
})

test('b calls focusCockpit with repoPath', async () => {
  const focus = vi.fn(async () => {})
  const { a } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} focusCockpit={focus} load={async () => base()} />)
  await waitFor(lastFrame, 'b cockpit')
  expect(lastFrame()).toContain('b cockpit')
  stdin.write('b')
  await until(() => focus.mock.calls.length === 1)
  expect(focus).toHaveBeenCalledWith('/r')
})

test('R from the tasks panel uses the detached restart', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => base()} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('R')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['restart', 'T-1', true]])
})

test('u is disabled on a closed mission', async () => {
  const s = base()
  s.step = 'closed'
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('u')
  await waitFor(lastFrame, 'mission finished')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('mission finished')
})

test('q inside a note does not quit', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('r')
  await waitFor(lastFrame, 'ctrl+s submit')
  stdin.write('why')
  await waitFor(lastFrame, 'why▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'Reject g1')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 rejected')
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'why']])
  expect(lastFrame()).toContain('g1 rejected')
})

test('unreadable state: keeps the last state and shows a message', async () => {
  const s = base()
  let fail = false
  const load = async () => {
    if (fail) throw new Error('boom')
    return s
  }
  const { lastFrame } = render(<TasksDashboard id="T-1" actions={fakeActions().a} load={load} intervalMs={20} />)
  await waitFor(lastFrame, 'First')
  fail = true
  await waitFor(lastFrame, 'unreadable state, retrying…')
  expect(lastFrame()).toContain('unreadable state, retrying…')
  expect(lastFrame()).toContain('First')
})

test('herness tasks <id> without a TTY prints the view once', async () => {
  const s = base()
  await saveState(s)
  const r = await execa('node', ['bin/herness.js', 'tasks', 'T-1'], {
    reject: false, stdin: 'ignore', env: { HERNESS_HOME: home },
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('T-1 · feat/T-1-x · tasks')
})

test('the message disappears when the gate is no longer pending', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  let cur = s
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={fakeActions().a} load={async () => cur} intervalMs={20} />)
  await waitFor(lastFrame, 'T-1 · feat/T-1-x')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await waitFor(lastFrame, 'g1 approved')
  expect(lastFrame()).toContain('g1 approved')
  cur = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  await waitGone(lastFrame, 'g1 approved')
  expect(lastFrame()).not.toContain('g1 approved')
})
