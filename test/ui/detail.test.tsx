import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { Box, Text } from 'ink'
import React from 'react'
import { expect, test, vi } from 'vitest'
import { openGate } from '../../src/engine/gates.ts'
import { newState, type MissionState } from '../../src/mission/state.ts'
import { MissionDetail, missionActions, useMissionKeys, type MissionActions, type Timer } from '../../src/ui/detail.tsx'
import { until, waitFor, waitGone, waitMatch } from './wait.ts'
import type { ActionDeps, ActionResult, Spawner } from '../../src/ui/actions.ts'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
const ESC = '\u001b'

function base(): MissionState {
  const s = newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/r' })
  s.branch = 'feat/T-1-x'
  s.step = 'tasks'
  s.tasks.push({ n: 1, title: 'First', testCommand: 't', phase: 'review', round: 1 })
  return s
}

const ok = (lines: string[] = []): ActionResult => ({ ok: true, lines })

function fakeActions(over: Partial<MissionActions> = {}) {
  const calls: unknown[][] = []
  const a: MissionActions = {
    validate: async (id, gateId, note) => { calls.push(['validate', id, gateId, note]); return ok() },
    refuse: async (id, gateId, note) => { calls.push(['refuse', id, gateId, note]); return ok() },
    resume: async (id) => { calls.push(['resume', id]); return ok(['resume requested']) },
    restart: async (id, o) => { calls.push(o?.detached ? ['restart', id, 'detached'] : ['restart', id]); return ok() },
    close: async (id, confirm) => { calls.push(['close', id]); return { ok: await confirm('Close anyway?'), lines: [] } },
    open: async (s) => { calls.push(['open', s.id]); return ok() },
    remove: async (id) => { calls.push(['remove', id]); return ok(['Mission T-1 deleted.']) },
    ...over,
  }
  return { a, calls }
}

function Harness(props: { state: MissionState; actions: MissionActions; onBack?: () => Promise<void> | void; timer?: Timer; onMessage?: (m: string) => void; ownPanel?: boolean }): React.ReactElement {
  const k = useMissionKeys(props)
  return (
    <Box flexDirection="column">
      <MissionDetail state={props.state} sentGates={k.sentGates} {...(k.selectedGate ? { selectedGate: k.selectedGate } : {})} />
      {k.overlay}
      {k.message ? <Text>{`MSG ${k.message}`}</Text> : null}
      <Text>{`HELP ${k.help}`}</Text>
    </Box>
  )
}

test('MissionDetail highlights the selected gate', () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const f = render(<MissionDetail state={s} selectedGate="g2" />).lastFrame()!
  expect(f).toMatch(/▸.*g2/)
  expect(f).not.toMatch(/▸.*g1/)
  const d = render(<MissionDetail state={s} sentGates={['g1']} />).lastFrame()!
  expect(d).not.toContain('▸')
  expect(d).toMatch(/g1.*decision sent/)
  expect(d).not.toMatch(/g2.*decision sent/)
})

test('while sending, the gate is no longer marked and shows decision sent', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a } = fakeActions({ validate: () => new Promise(() => {}) })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await waitFor(lastFrame, 'decision sent')
  expect(lastFrame()).not.toContain('▸')
  expect(lastFrame()).toMatch(/g1.*decision sent/)
})

test('an action that throws shows its error', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a } = fakeActions({
    validate: async () => { throw new Error('boum v') },
    resume: async () => { throw new Error('boum p') },
  })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await waitFor(lastFrame, 'boum v')
  expect(lastFrame()).toContain('boum v')
  stdin.write('u')
  await waitFor(lastFrame, 'boum p')
  expect(lastFrame()).toContain('boum p')
})

test('the selected gate resets when the mission changes', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const other = { ...s, id: 'T-2', gates: s.gates.map((g) => ({ ...g })) }
  const { a } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'HELP')
  r.stdin.write('\t')
  await waitMatch(r.lastFrame, /▸.*g2/)
  expect(r.lastFrame()).toMatch(/▸.*g2/)
  r.rerender(<Harness state={other} actions={a} />)
  await waitMatch(r.lastFrame, /▸.*g1/)
  expect(r.lastFrame()).toMatch(/▸.*g1/)
})

test('releasing a gate clears only its own message', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'HELP')
  r.stdin.write('a')
  await waitFor(r.lastFrame, 'Approve g1')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'g1 approved')
  r.stdin.write('R')
  await waitFor(r.lastFrame, 'restart requested')
  expect(r.lastFrame()).toContain('restart requested')
  const done = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  r.rerender(<Harness state={done} actions={a} />)
  await tick()
  expect(r.lastFrame()).toContain('restart requested')
})

test('unmount during close internal confirmation: it resolves false', async () => {
  let answer: boolean | undefined
  const { a } = fakeActions({ close: async (_id, confirm) => { answer = await confirm('Close anyway?'); return ok() } })
  const r = render(<Harness state={base()} actions={a} />)
  await waitFor(r.lastFrame, 'HELP')
  r.stdin.write('c')
  await waitFor(r.lastFrame, 'Close T-1 ?')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'Close anyway?')
  expect(r.lastFrame()).toContain('Close anyway?')
  r.unmount()
  await until(() => answer === false)
  expect(answer).toBe(false)
})

test('a shows the question then Enter approves; Esc sends nothing', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1 (spec) of T-1 ?')
  expect(lastFrame()).toContain('Approve g1 (spec) of T-1 ?')
  stdin.write(ESC)
  await waitGone(lastFrame, 'Approve g1')
  expect(calls).toEqual([])
  expect(lastFrame()).not.toContain('Approve g1')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 approved')
  expect(calls).toEqual([['validate', 'T-1', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 approved')
})

test('r: empty note rejected, then note, confirmation and reject', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('r')
  await waitFor(lastFrame, 'ctrl+s submit')
  stdin.write('\x13')
  await waitFor(lastFrame, 'a note is required to reject')
  expect(lastFrame()).toContain('a note is required to reject')
  expect(calls).toEqual([])
  stdin.write('too long')
  await waitFor(lastFrame, 'too long▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'Reject g1 (spec) of T-1 ?')
  expect(lastFrame()).toContain('Reject g1 (spec) of T-1 ?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 rejected')
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'too long']])
  expect(lastFrame()).toContain('g1 rejected')
})

test('n: note, choose a, confirmation, approve with the note', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('n')
  await waitFor(lastFrame, 'ctrl+s submit · ctrl+e')
  stdin.write('ok for me')
  await waitFor(lastFrame, 'ok for me▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'a approve · r reject · esc cancel')
  expect(lastFrame()).toContain('a approve · r reject · esc cancel')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1 (spec) of T-1 ?')
  expect(lastFrame()).toContain('Approve g1 (spec) of T-1 ?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', 'T-1', 'g1', 'ok for me']])
})

test('n: empty note then r stays on the choice', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('n')
  await waitFor(lastFrame, 'ctrl+s submit · ctrl+e')
  stdin.write('\x13')
  await waitFor(lastFrame, 'a approve · r reject · esc cancel')
  stdin.write('r')
  await waitFor(lastFrame, 'a note is required to reject')
  expect(lastFrame()).toContain('a note is required to reject')
  expect(lastFrame()).toContain('a approve · r reject · esc cancel')
  expect(calls).toEqual([])
})

test('two quick a keys send only one decision', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  let release: () => void = () => {}
  const { a, calls } = fakeActions({
    validate: (id, gateId) => {
      calls.push(['validate', id, gateId])
      return new Promise((r) => { release = () => r(ok()) })
    },
  })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await until(() => calls.length === 1)
  stdin.write('a')
  await waitFor(lastFrame, 'no pending gate')
  // the error stays visible until the next key
  expect(lastFrame()).toContain('no pending gate')
  stdin.write('\r')
  await tick()
  expect(calls).toHaveLength(1)
  release()
  await waitFor(lastFrame, 'g1 approved')
  stdin.write('a')
  await waitFor(lastFrame, 'no pending gate')
  stdin.write('\r')
  await tick()
  expect(calls).toHaveLength(1)
})

test('tab and arrows change the selected gate and a targets it', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('\t')
  await waitMatch(lastFrame, /▸.*g2/)
  expect(lastFrame()).toMatch(/▸.*g2/)
  stdin.write('\u001b[C')
  await waitMatch(lastFrame, /▸.*g1/)
  expect(lastFrame()).toMatch(/▸.*g1/)
  stdin.write('\u001b[D')
  await waitMatch(lastFrame, /▸.*g2/)
  expect(lastFrame()).toMatch(/▸.*g2/)
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g2 (plan)')
  expect(lastFrame()).toContain('Approve g2 (plan)')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', 'T-1', 'g2', undefined]])
})

test('c asks for confirmation before close and forwards the internal confirmation', async () => {
  const s = base()
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('c')
  await waitFor(lastFrame, 'Close T-1 ?')
  expect(lastFrame()).toContain('Close T-1 ?')
  expect(calls).toEqual([])
  stdin.write(ESC)
  await waitFor(lastFrame, 'close cancelled')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('close cancelled')
  stdin.write('c')
  await waitFor(lastFrame, 'Close T-1 ?')
  stdin.write('\r')
  await waitFor(lastFrame, 'Close anyway?')
  expect(calls).toEqual([['close', 'T-1']])
  expect(lastFrame()).toContain('Close anyway?')
  stdin.write(ESC)
  await waitGone(lastFrame, 'Close anyway?')
  await waitFor(lastFrame, 'close cancelled')
  expect(lastFrame()).not.toContain('Close anyway?')
  expect(lastFrame()).toContain('close cancelled')
})

test('during a close, no other gesture opens an input or starts an action', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  let go: () => void = () => {}
  let answer: boolean | undefined
  const { a, calls } = fakeActions({
    close: async (id, confirm) => {
      calls.push(['close', id])
      await new Promise<void>((r) => { go = r })
      answer = await confirm('Close anyway?')
      return ok(['closed'])
    },
  })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('c')
  await waitFor(lastFrame, 'Close T-1 ?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitGone(lastFrame, 'Close T-1 ?')
  for (const k of ['a', 'r', 'n', 'c', 'u', 'R', 'o']) {
    stdin.write(k)
    await waitFor(lastFrame, 'action in progress')
    await tick() // absence: the refused gesture must open nothing
    expect(lastFrame()).toContain('action in progress')
    expect(lastFrame()).not.toContain('Approve g1')
    expect(lastFrame()).not.toContain('Note')
    expect(lastFrame()).not.toContain('Close T-1 ?')
  }
  expect(calls).toEqual([['close', 'T-1']])
  go()
  await waitFor(lastFrame, 'Close anyway?')
  expect(lastFrame()).toContain('Close anyway?')
  stdin.write('\r')
  await until(() => answer === true)
  await waitFor(lastFrame, 'closed')
  expect(lastFrame()).toContain('closed')
  stdin.write('u')
  await until(() => calls.length === 2)
  expect(calls).toEqual([['close', 'T-1'], ['resume', 'T-1']])
})

test('an internal confirmation replaced by another resolves false', async () => {
  const answers: boolean[] = []
  const { a } = fakeActions({
    close: async (_id, confirm) => {
      const first = confirm('First?')
      const second = confirm('Second?')
      answers.push(await first)
      answers.push(await second)
      return ok()
    },
  })
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('c')
  await waitFor(lastFrame, 'Close T-1 ?')
  stdin.write('\r')
  await waitFor(lastFrame, 'Second?')
  expect(lastFrame()).toContain('Second?')
  expect(lastFrame()).not.toContain('First?')
  stdin.write('\r')
  await until(() => answers.length === 2)
  expect(answers).toEqual([false, true])
})

test('u is disabled on a closed mission; enabled otherwise', async () => {
  const s = base()
  s.step = 'closed'
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('u')
  await waitFor(lastFrame, 'mission finished')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('mission finished')
  expect(lastFrame()).toContain('(u resume)')
  const live = render(<Harness state={base()} actions={a} />)
  await waitFor(live.lastFrame, 'HELP')
  live.stdin.write('u')
  await until(() => calls.length === 1)
  await waitFor(live.lastFrame, 'resume requested')
  expect(calls).toEqual([['resume', 'T-1']])
  expect(live.lastFrame()).toContain('resume requested')
})

test('R restarts, o opens, b calls onBack', async () => {
  const s = base()
  const { a, calls } = fakeActions()
  const onBack = vi.fn(async () => {})
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} onBack={onBack} />)
  await waitFor(lastFrame, 'b back')
  expect(lastFrame()).toContain('b back')
  stdin.write('R')
  await until(() => calls.length === 1)
  stdin.write('o')
  await until(() => calls.length === 2)
  stdin.write('b')
  await until(() => onBack.mock.calls.length === 1)
  expect(calls).toEqual([['restart', 'T-1'], ['open', 'T-1']])
  const own = render(<Harness state={s} actions={a} ownPanel />)
  await waitFor(own.lastFrame, 'HELP')
  own.stdin.write('R')
  await until(() => calls.length === 3)
  expect(calls.at(-1)).toEqual(['restart', 'T-1', 'detached'])
  expect(onBack).toHaveBeenCalledTimes(1)
})

test('an onBack error is shown', async () => {
  const { a } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} onBack={async () => { throw new Error('no cockpit') }} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('b')
  await waitFor(lastFrame, 'no cockpit')
  expect(lastFrame()).toContain('no cockpit')
})

test('the message shows the last 5 lines, is forwarded and disappears when it expires', async () => {
  const pending: { fn: () => void; ms: number }[] = []
  const timer: Timer = (fn, ms) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const { a } = fakeActions({ resume: async () => ok(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) })
  const seen: string[] = []
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} timer={timer} onMessage={(m) => seen.push(m)} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('u')
  await waitFor(lastFrame, 'l6')
  expect(lastFrame()).toContain('l6')
  expect(lastFrame()).not.toContain('l1')
  expect(seen.at(-1)).toContain('l6')
  expect(pending.at(-1)?.ms).toBe(5000)
  pending.at(-1)!.fn()
  await waitGone(lastFrame, 'l6')
  expect(lastFrame()).not.toContain('l6')
})

test('a failure keeps KO lines and the final error (8 lines at most), does not clear alone but on the next key', async () => {
  const pending: { fn: () => void; ms: number }[] = []
  const timer: Timer = (fn, ms) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const lines = [
    'OK git: present', 'KO gh: missing', 'OK node : 24', 'KO herdr: outside session', 'OK a', 'OK b', 'OK c', 'OK d', 'OK e', 'OK f',
    'incomplete environment: fix the KO lines above',
  ]
  const { a } = fakeActions({ resume: async () => ({ ok: false, lines }) })
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} timer={timer} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('u')
  await waitFor(lastFrame, 'incomplete environment')
  const f = lastFrame()!
  expect(f).toContain('KO gh: missing')
  expect(f).toContain('KO herdr: outside session')
  expect(f).toContain('incomplete environment')
  expect(f).not.toContain('OK f')
  expect(pending).toEqual([])
  stdin.write('D')
  await waitGone(lastFrame, 'incomplete environment')
  expect(lastFrame()).not.toContain('incomplete environment')
})

test('a failure without KO lines shows its last 8 lines', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  const { a } = fakeActions({ resume: async () => ({ ok: false, lines }) })
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('u')
  await waitFor(lastFrame, 'line 10')
  expect(lastFrame()).toContain('line 3')
  expect(lastFrame()).toContain('line 10')
  expect(lastFrame()).not.toContain('line 2\n')
  expect(lastFrame()).not.toMatch(/line 2$/m)
})

test('an error stays until the next action, which replaces it', async () => {
  const s = base()
  const { a } = fakeActions({ resume: async () => ({ ok: false, lines: ['cannot resume'] }) })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'HELP')
  stdin.write('u')
  await waitFor(lastFrame, 'cannot resume')
  expect(lastFrame()).toContain('cannot resume')
  await tick(100)
  expect(lastFrame()).toContain('cannot resume')
  stdin.write('R')
  await waitFor(lastFrame, 'restart requested')
  expect(lastFrame()).not.toContain('cannot resume')
  expect(lastFrame()).toContain('restart requested')
})

test('a decided gate becomes selectable again when the state no longer shows it pending, then reopened', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'HELP')
  r.stdin.write('a')
  await waitFor(r.lastFrame, 'Approve g1')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'g1 approved')
  r.stdin.write('a')
  await waitFor(r.lastFrame, 'no pending gate')
  expect(r.lastFrame()).toContain('no pending gate')
  const done = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  r.rerender(<Harness state={done} actions={a} />)
  await waitGone(r.lastFrame, 'g1')
  r.rerender(<Harness state={s} actions={a} />)
  await waitMatch(r.lastFrame, /▸.*g1/)
  r.stdin.write('a')
  await waitFor(r.lastFrame, 'Approve g1')
  r.stdin.write('\r')
  await until(() => calls.length === 2)
  expect(calls).toHaveLength(2)
})

test('missionActions with focus:false passes focus:false to resumeMission (u and R)', async () => {
  const seen: unknown[] = []
  const d = {
    lifecycle: { e: {} },
    resume: async (id: string, _d: unknown, o: unknown) => { seen.push([id, o]) },
  } as unknown as ActionDeps
  const m = missionActions(d, undefined, { focus: false })
  await m.resume('T-1')
  await m.restart('T-1')
  expect(seen).toEqual([['T-1', { restart: false, focus: false }], ['T-1', { restart: true, focus: false }]])
})

test('missionActions wires actions to dependencies', async () => {
  const seen: unknown[] = []
  const d = {
    lifecycle: { e: { herdr: { workspaceFocus: async () => {} } } },
    decide: async (id: string, decision: string, o: { gateId?: string; note?: string }) => { seen.push([id, decision, o.gateId, o.note]) },
    resume: async (id: string, _d: unknown, o: { restart: boolean }) => { seen.push(['resume', id, o.restart]) },
    close: async () => true,
    start: async () => 'x',
    cwd: '/x',
  } as unknown as ActionDeps
  const m = missionActions(d)
  await m.validate('T-1', 'g1', undefined)
  await m.refuse('T-1', 'g1', 'non')
  await m.restart('T-1')
  expect(seen).toEqual([['T-1', 'approved', 'g1', undefined], ['T-1', 'refused', 'g1', 'non'], ['resume', 'T-1', true]])
  const spawned: unknown[] = []
  const spawn: Spawner = (cmd, args, opts) => {
    spawned.push([cmd, args.slice(1), opts])
    return { unref: () => spawned.push('unref'), once: (ev: string, fn: (e?: Error) => void) => { if (ev === 'spawn') fn() } }
  }
  const home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
  const r = await missionActions(d, spawn).restart('T-1', { detached: true }).finally(async () => {
    delete process.env.HERNESS_HOME
    await rm(home, { recursive: true, force: true })
  })
  expect(seen).toHaveLength(3)
  expect(spawned).toEqual([['node', ['resume', 'T-1', '--restart'], expect.objectContaining({ detached: true })], 'unref'])
  expect(r.lines[0]).toMatch(/^restart started \(this panel will relaunch\); log: .*restart-.*\.log$/)
})

test('D deletes a closed mission after confirmation; Esc cancels', async () => {
  const s = { ...base(), step: 'closed' as const }
  const { a, calls } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'HELP')
  expect(r.lastFrame()!.replace(/\s+/g, ' ')).toContain('D delete')
  r.stdin.write('D')
  await waitFor(r.lastFrame, 'Permanently delete T-1 (state, spec, plan, logs)?')
  r.stdin.write(ESC)
  await waitFor(r.lastFrame, 'delete cancelled')
  expect(calls).toEqual([])
  r.stdin.write('D')
  await waitFor(r.lastFrame, 'Permanently delete T-1')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'Mission T-1 deleted.')
  expect(calls).toEqual([['remove', 'T-1']])
})

test('D refuses a mission that is not closed', async () => {
  const { a, calls } = fakeActions()
  const r = render(<Harness state={base()} actions={a} />)
  await waitFor(r.lastFrame, 'HELP')
  expect(r.lastFrame()!.replace(/\s+/g, ' ')).toContain('(D delete)')
  r.stdin.write('D')
  await waitFor(r.lastFrame, "delete unavailable: close the mission first (c)")
  expect(calls).toEqual([])
})

test('D is absent from the mission tasks panel', async () => {
  const { a, calls } = fakeActions()
  const r = render(<Harness state={{ ...base(), step: 'closed' }} actions={a} ownPanel />)
  await waitFor(r.lastFrame, 'HELP')
  expect(r.lastFrame()).not.toContain('delete')
  r.stdin.write('D')
  await tick()
  expect(r.lastFrame()).not.toContain('Supprimer')
  expect(calls).toEqual([])
})
