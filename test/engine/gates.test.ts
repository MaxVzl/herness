import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyDecision, decide, openGate, pendingGate } from '../../src/engine/gates.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { LegacyMissionError, newState, saveState } from '../../src/mission/state.ts'
import { missionDir } from '../../src/paths.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const fresh = () => newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/r' })

test('applyDecision approves a pending gate', () => {
  const s = fresh()
  const g = openGate(s, 'spec', 'Spec to approve', 'docs/spec.md')
  expect(g.id).toBe('g1')
  const r = applyDecision(s, { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'ok' })
  expect(r.ok).toBe(true)
  expect(s.gates[0]).toMatchObject({ status: 'approved', note: 'ok' })
  expect(s.gates[0]!.decidedAt).toBeTruthy()
})

test('applyDecision rejects a decision on a gate already decided', () => {
  const s = fresh()
  openGate(s, 'spec', 'x')
  const d = { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' } as const
  applyDecision(s, d)
  const r = applyDecision(s, { ...d, decision: 'refused' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('gate g1 already decided (approved)')
  expect(s.gates[0]!.status).toBe('approved')
  const missing = applyDecision(s, { ...d, gateId: 'g9' })
  expect(missing.ok).toBe(false)
  if (!missing.ok) expect(missing.reason).toBe('gate g9 not found')
})

test('pendingGate returns the oldest, filterable by kind', () => {
  const s = fresh()
  openGate(s, 'spec', 'a')
  openGate(s, 'plan', 'b')
  expect(pendingGate(s)?.id).toBe('g1')
  expect(pendingGate(s, 'plan')?.id).toBe('g2')
})

async function withGates() {
  const s = fresh()
  openGate(s, 'spec', 'First')
  openGate(s, 'plan', 'Second')
  await saveState(s)
}

test('decide without a TTY throws and posts nothing', async () => {
  await withGates()
  await expect(decide('T-1', 'approved', { isTTY: false, confirm: async () => true }))
    .rejects.toThrow('approval requires an interactive terminal')
  expect(await drainInbox('T-1')).toEqual([])
})

test('decide without gateId targets the oldest pending gate', async () => {
  await withGates()
  await decide('T-1', 'approved', { isTTY: true, confirm: async () => true, note: 'good' })
  expect(await drainInbox('T-1')).toEqual([
    { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'good' },
  ])
})

test('decide without confirmation posts nothing', async () => {
  await withGates()
  await decide('T-1', 'refused', { isTTY: true, confirm: async () => false, note: 'no' })
  expect(await drainInbox('T-1')).toEqual([])
})

test('decide with no pending gate throws', async () => {
  await saveState(fresh())
  await expect(decide('T-1', 'approved', { isTTY: true, confirm: async () => true }))
    .rejects.toThrow('no gate pending')
})

test('an obsolete gate is no longer pending: pendingGate ignores it, a decision is rejected with a clear reason', async () => {
  const s = fresh()
  openGate(s, 'agent-stopped', 'stop')
  openGate(s, 'spec', 'spec')
  s.gates[0]!.status = 'obsolete'
  expect(pendingGate(s)?.id).toBe('g2')
  const r = applyDecision(s, { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(r).toEqual({ ok: false, reason: 'gate g1 obsolete: nothing is waiting for it, decision ignored' })
  await saveState(s)
  await expect(decide('T-1', 'approved', { gateId: 'g1', isTTY: true, confirm: async () => true })).rejects.toThrow('gate g1 obsolete: nothing is waiting for it')
})

test('decide writes the gate summary through out', async () => {
  await withGates()
  const lines: string[] = []
  await decide('T-1', 'approved', { isTTY: true, confirm: async () => false, out: (l) => lines.push(l) })
  expect(lines[0]).toBe('Gate g1 (spec): First')
})

test('decide refuses a legacy running mission', async () => {
  const s = fresh()
  openGate(s, 'spec', 'Spec to approve')
  s.step = 'tasks'
  await saveState(s)
  const file = join(missionDir('T-1'), 'state.json')
  const raw = JSON.parse(await readFile(file, 'utf8')) as { format?: number }
  delete raw.format
  await writeFile(file, JSON.stringify(raw))
  await expect(decide('T-1', 'approved', { isTTY: true, confirm: async () => true })).rejects.toThrow(LegacyMissionError)
  expect(await drainInbox('T-1')).toEqual([])
})

test('decide without out keeps the console display', async () => {
  await withGates()
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  await decide('T-1', 'approved', { isTTY: true, confirm: async () => false })
  expect(spy).toHaveBeenCalledWith('Gate g1 (spec): First')
  spy.mockRestore()
})
