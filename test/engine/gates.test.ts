import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyDecision, decide, openGate, pendingGate } from '../../src/engine/gates.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { newState, saveState } from '../../src/mission/state.ts'

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

test('applyDecision approuve une porte en attente', () => {
  const s = fresh()
  const g = openGate(s, 'spec', 'Spec à valider', 'docs/spec.md')
  expect(g.id).toBe('g1')
  const r = applyDecision(s, { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'ok' })
  expect(r.ok).toBe(true)
  expect(s.gates[0]).toMatchObject({ status: 'approved', note: 'ok' })
  expect(s.gates[0]!.decidedAt).toBeTruthy()
})

test('applyDecision refuse une décision sur une porte déjà décidée', () => {
  const s = fresh()
  openGate(s, 'spec', 'x')
  const d = { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' } as const
  applyDecision(s, d)
  const r = applyDecision(s, { ...d, decision: 'refused' })
  expect(r.ok).toBe(false)
  expect(s.gates[0]!.status).toBe('approved')
  expect(applyDecision(s, { ...d, gateId: 'g9' }).ok).toBe(false)
})

test('pendingGate rend la plus ancienne, filtrable par type', () => {
  const s = fresh()
  openGate(s, 'spec', 'a')
  openGate(s, 'plan', 'b')
  expect(pendingGate(s)?.id).toBe('g1')
  expect(pendingGate(s, 'plan')?.id).toBe('g2')
})

async function withGates() {
  const s = fresh()
  openGate(s, 'spec', 'Première')
  openGate(s, 'plan', 'Seconde')
  await saveState(s)
}

test('decide sans TTY lève et ne poste rien', async () => {
  await withGates()
  await expect(decide('T-1', 'approved', { isTTY: false, confirm: async () => true }))
    .rejects.toThrow('validation réservée à un terminal interactif')
  expect(await drainInbox('T-1')).toEqual([])
})

test('decide sans gateId vise la plus ancienne porte en attente', async () => {
  await withGates()
  await decide('T-1', 'approved', { isTTY: true, confirm: async () => true, note: 'bien' })
  expect(await drainInbox('T-1')).toEqual([
    { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'bien' },
  ])
})

test('decide sans confirmation ne poste rien', async () => {
  await withGates()
  await decide('T-1', 'refused', { isTTY: true, confirm: async () => false, note: 'non' })
  expect(await drainInbox('T-1')).toEqual([])
})

test('decide sans porte en attente lève', async () => {
  await saveState(fresh())
  await expect(decide('T-1', 'approved', { isTTY: true, confirm: async () => true }))
    .rejects.toThrow('aucune porte en attente')
})

test('une porte caduque n’est plus en attente : pendingGate l’ignore, une décision est refusée avec un motif clair', async () => {
  const s = fresh()
  openGate(s, 'agent-arret', 'arrêt')
  openGate(s, 'spec', 'spec')
  s.gates[0]!.status = 'caduque'
  expect(pendingGate(s)?.id).toBe('g2')
  const r = applyDecision(s, { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(r).toEqual({ ok: false, reason: "porte g1 caduque : plus rien ne l'attend, décision ignorée" })
  await saveState(s)
  await expect(decide('T-1', 'approved', { gateId: 'g1', isTTY: true, confirm: async () => true })).rejects.toThrow("porte g1 caduque : plus rien ne l'attend")
})

test('decide écrit le résumé de la porte via out', async () => {
  await withGates()
  const lines: string[] = []
  await decide('T-1', 'approved', { isTTY: true, confirm: async () => false, out: (l) => lines.push(l) })
  expect(lines[0]).toMatch(/^Porte g1 \(/)
})

test('decide sans out garde l\'affichage console', async () => {
  await withGates()
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  await decide('T-1', 'approved', { isTTY: true, confirm: async () => false })
  expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^Porte g1 \(/))
  spy.mockRestore()
})
