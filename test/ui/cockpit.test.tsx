import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openGate } from '../../src/engine/gates.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir } from '../../src/paths.ts'
import type { ActionResult } from '../../src/ui/actions.ts'
import { Cockpit, rowColor, type CockpitActions } from '../../src/ui/cockpit.tsx'
import type { PrInfo } from '../../src/ui/model.ts'
import demo from '../fixtures/demo/config.ts'
import { until, waitFor, waitGone } from './wait.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

function mission(id: string, slug: string, createdAt: string, repoPath = '/r'): MissionState {
  const s = newState({ id, source: { kind: 'text', ref: slug }, project: 'p', repoPath })
  s.slug = slug
  s.createdAt = createdAt
  s.branch = `feat/${id}-${slug}`
  s.step = 'tasks'
  return s
}

function fakeActions(over: Partial<CockpitActions> = {}) {
  const calls: unknown[][] = []
  const done = async (): Promise<ActionResult> => ({ ok: true, lines: [] })
  const a: CockpitActions = {
    validate: async (id, gateId, note) => { calls.push(['validate', id, gateId, note]); return done() },
    refuse: async (id, gateId, note) => { calls.push(['refuse', id, gateId, note]); return done() },
    resume: async (id) => { calls.push(['resume', id]); return done() },
    restart: async (id, o) => { calls.push(['restart', id, o?.detached === true]); return done() },
    close: async (id) => { calls.push(['close', id]); return done() },
    remove: async (id) => { calls.push(['remove', id]); return done() },
    open: async (s) => { calls.push(['open', s.id]); return done() },
    startNew: async (input, note) => { calls.push(note === undefined ? ['startNew', input] : ['startNew', input, note]); return done() },
    ...over,
  }
  return { a, calls }
}

function fakePrCache(entries: Record<string, PrInfo> = {}) {
  const refreshed: string[][] = []
  return {
    refreshed,
    cache: {
      get: (url: string) => entries[url],
      refresh: async (urls: string[]) => { refreshed.push(urls) },
    },
  }
}

test('the mission with a gate is first and amber', async () => {
  const active = mission('26110201-1', 'active', '2026-11-02T10:00:00.000Z')
  const gated = mission('26110201-2', 'with-gate', '2026-11-01T10:00:00.000Z')
  openGate(gated, 'spec', 'Spec to approve')
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [active, gated]} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, '2 active missions')
  const f = lastFrame()!
  expect(f).toContain('herness · demo · 2 active missions')
  expect(f).toContain('1 pending gate')
  const lines = f.split('\n')
  const iGated = lines.findIndex((l) => l.includes('01-2') && l.includes('with-gate'))
  const iActive = lines.findIndex((l) => l.includes('01-1') && l.includes('active'))
  expect(iGated).toBeGreaterThan(-1)
  expect(iActive).toBeGreaterThan(iGated)
  expect(lines[iGated]).toContain('gate g1')
  // amber (ink emits no colors under test: check the chosen color)
  expect(rowColor(gated)).toBe('yellow')
  expect(rowColor(active)).toBeUndefined()
  // the initial selection is the first row: its detail is shown
  expect(f).toContain('Spec to approve')
})

test('a merged PR is hidden, visible after f', async () => {
  const done = mission('26110201-3', 'shipped', '2026-11-01T10:00:00.000Z')
  done.step = 'pr-open'
  done.prUrl = 'https://example.test/o/r/pull/7'
  const active = mission('26110201-4', 'ongoing', '2026-11-02T10:00:00.000Z')
  const pr = fakePrCache({ [done.prUrl]: { state: 'MERGED', checkedAt: '2026-11-02T10:00:00.000Z' } })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [done, active]} actions={fakeActions().a} prCache={pr.cache} columns={140} />,
  )
  await waitFor(lastFrame, 'ongoing')
  expect(lastFrame()).toContain('ongoing')
  expect(lastFrame()).not.toContain('shipped')
  // the merged PR (hidden and already known merged) is not refreshed
  expect(pr.refreshed).toEqual([])
  stdin.write('f')
  await waitFor(lastFrame, 'shipped')
  expect(lastFrame()).toContain('shipped')
  expect(lastFrame()).toContain('PR #7')
  stdin.write('f')
  await waitGone(lastFrame, 'shipped')
  expect(lastFrame()).not.toContain('shipped')
})

test('no key triggers two actions with the detail open in the cockpit', async () => {
  const visible = mission('26110201-50', 'open-one', '2026-11-02T10:00:00.000Z')
  openGate(visible, 'spec', 'A')
  const hidden = mission('26110201-51', 'done-one', '2026-11-01T10:00:00.000Z')
  hidden.step = 'pr-open'
  hidden.prUrl = 'https://example.test/o/r/pull/51'
  const pr = fakePrCache({ [hidden.prUrl]: { state: 'MERGED', checkedAt: '2026-11-02T10:00:00.000Z' } })
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [visible, hidden]} actions={a} prCache={pr.cache} columns={140} />,
  )
  await waitFor(lastFrame, 'a approve')
  expect(lastFrame()).toContain('a approve')
  expect(lastFrame()).toContain('r reject')
  expect(lastFrame()).toContain('f show finished')
  expect(lastFrame()).toContain('+ new mission')
  expect(lastFrame()).toContain('q quit')
  expect(lastFrame()).not.toContain('done-one')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1')
  stdin.write('\r')
  await until(() => calls.filter((c) => c[0] === 'validate').length === 1)
  expect(calls.filter((c) => c[0] === 'validate')).toEqual([['validate', '26110201-50', 'g1', undefined]])
  expect(lastFrame()).not.toContain('done-one')
  stdin.write('c')
  await waitFor(lastFrame, 'Close 26110201-50?')
  stdin.write('\r')
  await until(() => calls.filter((c) => c[0] === 'close').length === 1)
  expect(calls.map((c) => c[0])).toEqual(['validate', 'close'])
})

test('PR CLOSED: closed for more than 7 days is hidden and never refreshed; pr-open CLOSED is visible and refreshed', async () => {
  const old = mission('26110201-31', 'abandoned', '2026-10-01T10:00:00.000Z')
  old.step = 'closed'
  old.prUrl = 'https://example.test/o/r/pull/31'
  old.log = [{ at: '2026-10-20T10:00:00.000Z', msg: 'mission fermée (herness fermer)' }]
  const open = mission('26110201-32', 'needs-action', '2026-10-01T10:00:00.000Z')
  open.step = 'pr-open'
  open.prUrl = 'https://example.test/o/r/pull/32'
  const closed = (at: string): PrInfo => ({ state: 'CLOSED', checkedAt: at })
  const pr = fakePrCache({ [old.prUrl]: closed('2026-10-21T10:00:00.000Z'), [open.prUrl]: closed('2026-10-21T10:00:00.000Z') })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [old, open]} actions={fakeActions().a} prCache={pr.cache} columns={140}
      now={() => new Date('2026-11-02T10:00:00.000Z')} intervalMs={20} />,
  )
  await waitFor(lastFrame, 'needs-action')
  expect(lastFrame()).toContain('needs-action')
  expect(lastFrame()).not.toContain('abandoned')
  stdin.write('f')
  await waitFor(lastFrame, 'abandoned')
  await until(() => pr.refreshed.length > 0)
  expect(lastFrame()).toContain('abandoned')
  expect(pr.refreshed.length).toBeGreaterThan(0)
  expect(pr.refreshed.flat()).not.toContain(old.prUrl)
  expect(pr.refreshed.flat()).toContain(open.prUrl)
})

test('down then a then Enter approves the second mission gate', async () => {
  const first = mission('26110201-5', 'first', '2026-11-02T10:00:00.000Z')
  const second = mission('26110201-6', 'second', '2026-11-01T10:00:00.000Z')
  openGate(first, 'spec', 'A')
  openGate(second, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [first, second]} actions={a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, 'first')
  stdin.write('\u001b[B')
  await waitFor(lastFrame, '26110201-6 · feat/26110201-6-second')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1 (plan) of 01-6?')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('Approve g1 (plan) of 01-6?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 approved')
  expect(calls).toEqual([['validate', '26110201-6', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 approved')
})

test('+ then text then Enter calls startNew and shows its error', async () => {
  const { a, calls } = fakeActions({
    startNew: async (input) => { calls.push(['startNew', input]); return { ok: false, lines: ['mission already exists'] } },
  })
  const s = mission('26110201-7', 'only', '2026-11-02T10:00:00.000Z')
  openGate(s, 'spec', 'A')
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, 'only')
  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link, GitHub issue, or text:')
  expect(lastFrame()).toContain('Wrike link, GitHub issue, or text:')
  stdin.write('see q and a')
  await waitFor(lastFrame, 'see q and a')
  expect(lastFrame()).toContain('see q and a')
  stdin.write('\r')
  await waitFor(lastFrame, NOTE_LABEL)
  stdin.write('\x13')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'mission already exists')
  await waitGone(lastFrame, 'Wrike link, GitHub issue, or text:')
  expect(calls).toEqual([['startNew', 'see q and a']])
  expect(lastFrame()).toContain('mission already exists')
  expect(lastFrame()).not.toContain('Wrike link, GitHub issue, or text:')
})

test('a startNew failure keeps the KO lines and the final error', async () => {
  const lines = ['OK git: present', 'KO gh: not connected', 'OK node : 24', 'OK a', 'OK b', 'OK c', 'OK d', 'incomplete environment: fix the KO lines above']
  const pending: { fn: () => void; ms: number }[] = []
  const timer = (fn: () => void, ms: number) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const { a } = fakeActions({ startNew: async () => ({ ok: false, lines }) })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={a} prCache={fakePrCache().cache} columns={140} timer={timer} />,
  )
  await waitFor(lastFrame, 'no missions')
  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link')
  stdin.write('text')
  await waitFor(lastFrame, 'text▏')
  stdin.write('\r')
  await waitFor(lastFrame, NOTE_LABEL)
  stdin.write('\x13')
  await waitFor(lastFrame, 'incomplete environment')
  expect(lastFrame()).toContain('KO gh: not connected')
  expect(lastFrame()).toContain('incomplete environment')
  expect(lastFrame()).not.toContain('OK d')
  // only the successful starting message expires, and the error cancels it
  expect(pending).toEqual([])
})

test('+ during a close is refused; the internal confirmation is never active with a field', async () => {
  let go: () => void = () => {}
  let answer: boolean | undefined
  const { a, calls } = fakeActions({
    close: async (id, confirm) => {
      calls.push(['close', id])
      await new Promise<void>((r) => { go = r })
      answer = await confirm('Close anyway?')
      return { ok: true, lines: [] }
    },
  })
  const s = mission('26110201-33', 'closing', '2026-11-02T10:00:00.000Z')
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, 'closing')
  stdin.write('c')
  await waitFor(lastFrame, 'Close 26110201-33?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  stdin.write('+')
  await waitFor(lastFrame, 'action in progress')
  expect(lastFrame()).not.toContain('Wrike link')
  expect(lastFrame()).toContain('action in progress')
  go()
  await waitFor(lastFrame, 'Close anyway?')
  expect(lastFrame()).toContain('Close anyway?')
  expect(lastFrame()).not.toContain('Wrike link')
  stdin.write('\r')
  await until(() => answer === true)
  await waitGone(lastFrame, 'Close anyway?')
  await waitGone(lastFrame, 'action in progress')
  expect(answer).toBe(true)
  expect(calls).toEqual([['close', '26110201-33']])
  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link')
  expect(lastFrame()).toContain('Wrike link')
})

const NOTE_LABEL = 'Note for the mission (optional)'

test('+ then link then note: startNew receives the note; Esc on the note cancels', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, 'no missions')
  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link')
  stdin.write('https://www.wrike.com/open.htm?id=1')
  await waitFor(lastFrame, 'id=1▏')
  stdin.write('\r')
  await waitFor(lastFrame, `${NOTE_LABEL}: https://www.wrike.com/open.htm?id=1`)
  expect(lastFrame()).not.toContain('Wrike link')
  stdin.write('\u001b')
  await waitFor(lastFrame, 'start cancelled')
  expect(calls).toEqual([])

  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link')
  stdin.write('https://www.wrike.com/open.htm?id=1')
  await waitFor(lastFrame, 'id=1▏')
  stdin.write('\r')
  await waitFor(lastFrame, NOTE_LABEL)
  stdin.write('skip the PDF')
  await waitFor(lastFrame, 'skip the PDF▏')
  stdin.write('\r')
  stdin.write('empty base')
  await waitFor(lastFrame, 'empty base▏')
  stdin.write('\x13')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['startNew', 'https://www.wrike.com/open.htm?id=1', 'skip the PDF\nempty base']])
  await waitGone(lastFrame, NOTE_LABEL)
})

test('+ then an empty link: no note field', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, 'no missions')
  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link')
  stdin.write('\r')
  await waitFor(lastFrame, 'empty request: nothing to start')
  expect(lastFrame()).not.toContain(NOTE_LABEL)
  expect(calls).toEqual([])
})

test('+ then Esc cancels without starting', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, 'no missions')
  stdin.write('+')
  await waitFor(lastFrame, 'Wrike link')
  stdin.write('abc')
  await waitFor(lastFrame, 'abc▏')
  stdin.write('\u001b')
  await waitGone(lastFrame, 'Wrike link')
  expect(lastFrame()).not.toContain('Wrike link')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('no missions')
})

test('unreadable state: the list keeps the other missions', async () => {
  await saveState(mission('26110201-8', 'readable', '2026-11-02T10:00:00.000Z', '/project'))
  await saveState(mission('26110201-9', 'other-project', '2026-11-02T10:00:00.000Z', '/elsewhere'))
  await mkdir(missionDir('26110201-10'), { recursive: true })
  await writeFile(join(missionDir('26110201-10'), 'state.json'), '{ not json')
  const { lastFrame } = render(
    <Cockpit repoPath="/project" name="demo" actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, '1 active mission')
  expect(lastFrame()).toContain('readable')
  expect(lastFrame()).not.toContain('other-project')
  expect(lastFrame()).toContain('1 active mission')
})

test('the selection follows the mission across reloads', async () => {
  const x = mission('26110201-11', 'xx', '2026-11-02T10:00:00.000Z')
  const y = mission('26110201-12', 'yy', '2026-11-01T10:00:00.000Z')
  let list = [x, y]
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, '26110201-11 · feat/26110201-11-xx')
  stdin.write('\u001b[B')
  await waitFor(lastFrame, '26110201-12 · feat/26110201-12-yy')
  expect(lastFrame()).toContain('26110201-12 · feat/26110201-12-yy')
  // a newer mission arrives first: the selection stays on y
  const z = mission('26110201-13', 'zz', '2026-11-03T10:00:00.000Z')
  list = [z, x, y]
  await waitFor(lastFrame, 'zz')
  expect(lastFrame()).toContain('26110201-12 · feat/26110201-12-yy')
  // y disappears: back to the first row
  list = [z, x]
  await waitFor(lastFrame, '26110201-13 · feat/26110201-13-zz')
  expect(lastFrame()).toContain('26110201-13 · feat/26110201-13-zz')
})

test('without a prior down key, the selection stays on the shown mission when the list reorders', async () => {
  const x = mission('26110201-20', 'xx', '2026-11-02T10:00:00.000Z')
  let list = [x]
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, '26110201-20 · feat/26110201-20-xx')
  expect(lastFrame()).toContain('26110201-20 · feat/26110201-20-xx')
  list = [mission('26110201-21', 'zz', '2026-11-03T10:00:00.000Z'), x]
  await waitFor(lastFrame, 'zz')
  expect(lastFrame()).toContain('26110201-20 · feat/26110201-20-xx')
})

test('a slow reload does not overlap the next one and a stale result is not applied', async () => {
  const stale = mission('26110201-22', 'old', '2026-11-02T10:00:00.000Z')
  openGate(stale, 'spec', 'A')
  const fresh = { ...stale, slug: 'fresh', gates: stale.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const load = async (): Promise<MissionState[]> => {
    calls++
    if (calls === 1) {
      await gate
      return [stale]
    }
    return [fresh]
  }
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={load} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await until(() => calls === 1)
  await tick(90) // absence: while the first reload runs, no other one starts
  expect(calls).toBe(1)
  release()
  await until(() => calls > 1)
  await waitFor(lastFrame, ' fresh ')
  expect(lastFrame()).toContain(' fresh ')
  expect(lastFrame()).not.toContain('pending gate')
})

test('a slow PR refresh is not started again on every reload', async () => {
  const s = mission('26110201-23', 'pr', '2026-11-02T10:00:00.000Z')
  s.step = 'pr-open'
  s.prUrl = 'https://example.test/o/r/pull/8'
  let refreshes = 0
  let release: () => void = () => {}
  const slow = new Promise<void>((r) => { release = r })
  const cache = { get: () => undefined, refresh: async () => { refreshes++; await slow } }
  render(<Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={cache} columns={140} intervalMs={20} />)
  await until(() => refreshes === 1)
  await tick(100) // absence: several reloads pass without starting the refresh again
  expect(refreshes).toBe(1)
  release()
  await until(() => refreshes >= 2)
  expect(refreshes).toBeGreaterThanOrEqual(2)
})

test('a PR refresh that throws does not show the read error', async () => {
  const s = mission('26110201-24', 'pr', '2026-11-02T10:00:00.000Z')
  s.step = 'pr-open'
  s.prUrl = 'https://example.test/o/r/pull/9'
  const cache = { get: () => undefined, refresh: (): Promise<void> => { throw new Error('boom') } }
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, 'PR #9')
  await tick(60) // absence: let one reload pass
  expect(lastFrame()).toContain('PR #9')
  expect(lastFrame()).not.toContain('cannot read missions')
})

test('only visible non-merged PRs are refreshed', async () => {
  const open = mission('26110201-25', 'open-pr', '2026-11-02T10:00:00.000Z')
  open.step = 'pr-open'
  open.prUrl = 'https://example.test/o/r/pull/10'
  const merged = mission('26110201-26', 'merged-pr', '2026-11-01T10:00:00.000Z')
  merged.step = 'pr-open'
  merged.prUrl = 'https://example.test/o/r/pull/11'
  const pr = fakePrCache({ [merged.prUrl]: { state: 'MERGED', checkedAt: '2026-11-02T10:00:00.000Z' } })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [open, merged]} actions={fakeActions().a} prCache={pr.cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, 'open-pr')
  stdin.write('f')
  await waitFor(lastFrame, 'merged-pr')
  await until(() => pr.refreshed.length > 0)
  expect(pr.refreshed.length).toBeGreaterThan(0)
  for (const urls of pr.refreshed) expect(urls).toEqual([open.prUrl])
})

test('q quits when nothing is open: reloading stops', async () => {
  let calls = 0
  const { stdin } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => { calls++; return [] }} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await until(() => calls > 0)
  stdin.write('q')
  // reloading stops: the counter stays stable for more than one period
  let last = -1
  await until(() => { const stable = calls === last; last = calls; return stable }, 3000, 60)
  const n = calls
  await tick(100)
  expect(calls).toBe(n)
})

test('unmount stops reloading', async () => {
  let calls = 0
  const { unmount } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => { calls++; return [] }} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await until(() => calls > 0)
  unmount()
  const n = calls
  await tick(100)
  expect(calls).toBe(n)
})

test('a list reordered during confirmation keeps the targeted mission and gate', async () => {
  const x = mission('26110201-27', 'xx', '2026-11-02T10:00:00.000Z')
  openGate(x, 'spec', 'A')
  let list = [x]
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, '26110201-27 · feat/26110201-27-xx')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1 (spec) of 01-27?')
  expect(lastFrame()).toContain('Approve g1 (spec) of 01-27?')
  const y = mission('26110201-28', 'yy', '2026-11-03T10:00:00.000Z')
  openGate(y, 'plan', 'B')
  list = [y, x]
  await waitFor(lastFrame, 'yy')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', '26110201-27', 'g1', undefined]])
})

test('the a/r choice of a note targets the mission from when it opened, even if it left the list', async () => {
  const x = mission('26110201-34', 'xx', '2026-11-02T10:00:00.000Z')
  openGate(x, 'spec', 'A')
  const y = mission('26110201-35', 'yy', '2026-11-01T10:00:00.000Z')
  openGate(y, 'spec', 'B')
  let list = [x, y]
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await waitFor(lastFrame, '26110201-34 · feat/26110201-34-xx')
  stdin.write('n')
  await waitFor(lastFrame, 'ctrl+s submit · ctrl+e editor')
  stdin.write('voir')
  await waitFor(lastFrame, 'voir▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'a approve · r reject · esc cancel')
  expect(lastFrame()).toContain('a approve · r reject · esc cancel')
  list = [y]
  await waitGone(lastFrame, '01-34')
  stdin.write('a')
  await waitFor(lastFrame, 'Approve g1 (spec) of 01-34?')
  expect(lastFrame()).toContain('Approve g1 (spec) of 01-34?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', '26110201-34', 'g1', 'voir']])
})

test('q quits only outside an input', async () => {
  const s = mission('26110201-14', 'q', '2026-11-02T10:00:00.000Z')
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, '26110201-14 · feat')
  stdin.write('r')
  await waitFor(lastFrame, 'ctrl+s submit · ctrl+e editor')
  stdin.write('why')
  await waitFor(lastFrame, 'why▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'Reject g1 (spec) of 01-14?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['refuse', '26110201-14', 'g1', 'why']])
  expect(lastFrame()).toContain('q quit')
})

test('R from the cockpit restarts directly', async () => {
  const s = mission('26110201-15', 'r', '2026-11-02T10:00:00.000Z')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await waitFor(lastFrame, '26110201-15 · feat')
  stdin.write('R')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['restart', '26110201-15', false]])
})

test('the cockpit shows the version banner under the title', async () => {
  const s = mission('26110201-40', 'banner', '2026-11-02T10:00:00.000Z')
  const message = 'herness 0.8.0 is installed, this cockpit is running 0.6.0: quit and start herness again'
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140}
      notice={() => message} />,
  )
  await waitFor(lastFrame, 'is installed, this cockpit is running')
  const lines = lastFrame()!.split('\n')
  const iTitle = lines.findIndex((l) => l.includes('herness · demo'))
  const iNotice = lines.findIndex((l) => l.includes(message))
  expect(iTitle).toBeGreaterThan(-1)
  expect(iNotice).toBeGreaterThan(iTitle)
})

test('no banner when notice returns null', async () => {
  const s = mission('26110201-41', 'no-banner', '2026-11-02T10:00:00.000Z')
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140}
      notice={() => null} />,
  )
  await waitFor(lastFrame, 'no-banner')
  expect(lastFrame()).not.toContain('is installed, this cockpit is running')
})

test('the banner follows refreshes', async () => {
  let text: string | null = null
  const message = 'herness 0.8.0 is installed, this cockpit is running 0.6.0: quit and start herness again'
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140}
      intervalMs={20} notice={() => text} />,
  )
  await waitFor(lastFrame, 'no missions')
  expect(lastFrame()).not.toContain('is installed, this cockpit is running')
  text = message
  await waitFor(lastFrame, message)
  expect(lastFrame()).toContain(message)
})

test("a notice that throws does not prevent showing missions", async () => {
  const s = mission('26110201-42', 'despite-notice', '2026-11-02T10:00:00.000Z')
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140}
      notice={() => { throw new Error('x') }} />,
  )
  await waitFor(lastFrame, 'despite-notice')
  expect(lastFrame()).toContain('despite-notice')
  expect(lastFrame()).not.toContain('is installed, this cockpit is running')
})

test("the banner shows even when reading missions fails", async () => {
  const message = 'herness 0.8.0 is installed, this cockpit is running 0.6.0: quit and start herness again'
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => { throw new Error('unreadable') }} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140}
      notice={() => message} />,
  )
  await waitFor(lastFrame, message)
  expect(lastFrame()).toContain('cannot read missions')
})

test('herness cockpit outside a TTY shows a snapshot and exits', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'herness-projects-'))
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'herness-repo-')))
  try {
    await mkdir(join(projects, 'demo'), { recursive: true })
    await writeFile(join(projects, 'demo', 'config.ts'), `export default ${JSON.stringify({ ...demo, repoPath: repo })}\n`)
    const s = mission('26110201-16', 'image', '2026-11-02T10:00:00.000Z', repo)
    openGate(s, 'spec', 'Test spec')
    await saveState(s)
    const r = await execa('node', [resolve('bin/herness.js'), 'cockpit'], {
      reject: false,
      stdin: 'ignore',
      cwd: repo,
      env: { HERNESS_HOME: home, HERNESS_PROJECTS_DIR: projects, PATH: process.env.PATH ?? '' },
      extendEnv: false,
      timeout: 20000,
    })
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('herness · demo · 1 active mission')
    expect(r.stdout).toContain('image')
    expect(r.stdout).toContain('Test spec')
  } finally {
    await rm(projects, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})
