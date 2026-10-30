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
    { n: 1, title: 'Premier', testCommand: 't', phase: 'done', round: 0 },
    { n: 2, title: 'Deuxième', testCommand: 't', phase: 'review', round: 2, implementer: 'i2', reviewer: 'r2' },
    { n: 3, title: 'Troisième', testCommand: 't', phase: 'pending', round: 0 },
  )
  return s
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

test('affiche les tâches avec leur phase et leur tour', () => {
  const { lastFrame } = render(<TasksView state={base()} />)
  const f = lastFrame()!
  expect(f).toContain('T-1 · feat/T-1-x · tasks')
  expect(f).toMatch(/✓.*Premier/)
  expect(f).toMatch(/▶.*Deuxième.*review.*tour 2\/3/)
  expect(f).toMatch(/·.*Troisième/)
  expect(f).toContain('i2')
  expect(f).toContain('r2')
})

test('met en évidence une porte en attente avec son résumé', () => {
  const s = base()
  openGate(s, 'spec', 'Spec à valider', '/x/spec.md')
  s.paused = true
  const f = render(<TasksView state={s} />).lastFrame()!
  expect(f).toContain('g1')
  expect(f).toContain('spec')
  expect(f).toContain('Spec à valider')
  expect(f).toContain('v valider · r refuser')
  expect(f).toContain('EN PAUSE')
})

test('affiche revue globale, preflight, journal et PR', () => {
  const s = base()
  s.step = 'preflight'
  s.loops.globalReview.round = 1
  s.loops.preflight.round = 2
  s.loops.preflight.results.push(
    { label: 'lint', exitCode: 0, durationMs: 1500, logPath: '/l' },
    { label: 'test', exitCode: 1, durationMs: 62000, logPath: '/l' },
  )
  for (let i = 0; i < 7; i++) s.log.push({ at: 'x', msg: `ligne${i}` })
  s.prUrl = 'https://gh/pr/1'
  const f = render(<TasksView state={s} />).lastFrame()!
  expect(f).toMatch(/lint ✓/)
  expect(f).toMatch(/test ✗/)
  expect(f).not.toContain('ligne1')
  expect(f).toContain('ligne6')
  expect(f).toContain('https://gh/pr/1')
})

test('affiche la raison de blocage', () => {
  const s = base()
  s.step = 'bloquée'
  s.blockedReason = '3 tours épuisés'
  expect(render(<TasksView state={s} />).lastFrame()!).toContain('3 tours épuisés')
})

test('la touche v poste une décision approved pour la plus ancienne porte', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const decide = vi.fn(async () => {})
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" decide={decide} load={async () => s} />)
  await tick()
  stdin.write('v')
  await tick()
  expect(decide).toHaveBeenCalledTimes(1)
  const call = decide.mock.calls[0] as unknown as [string, string, { gateId: string; isTTY: boolean; confirm: () => Promise<boolean> }]
  expect(call[0]).toBe('T-1')
  expect(call[1]).toBe('approved')
  expect(call[2].gateId).toBe('g1')
  expect(call[2].isTTY).toBe(true)
  expect(await call[2].confirm()).toBe(true)
  expect(lastFrame()).toContain('décision envoyée : g1 validée')
})

test('la touche r saisit une note puis refuse ; note vide rejetée ; Échap annule', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const decide = vi.fn(async () => {})
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" decide={decide} load={async () => s} />)
  await tick()
  stdin.write('r')
  await tick()
  stdin.write('\r')
  await tick()
  expect(decide).not.toHaveBeenCalled()
  expect(lastFrame()).toContain('note obligatoire')
  stdin.write('trop long')
  await tick()
  stdin.write('\r')
  await tick()
  expect(decide).toHaveBeenCalledWith('T-1', 'refused', expect.objectContaining({ gateId: 'g1', note: 'trop long', isTTY: true }))
  expect(lastFrame()).toContain('décision envoyée : g1 refusée')
  stdin.write('r')
  await tick()
  stdin.write('\u001b')
  await tick(100)
  stdin.write('x')
  await tick()
  expect(lastFrame()).not.toContain('Note de refus')
})

test('état illisible : garde le dernier état et affiche un message', async () => {
  const s = base()
  let fail = false
  const load = async () => {
    if (fail) throw new Error('boom')
    return s
  }
  const { lastFrame } = render(<TasksDashboard id="T-1" decide={async () => {}} load={load} intervalMs={20} />)
  await tick()
  fail = true
  await tick(80)
  expect(lastFrame()).toContain('état illisible, nouvel essai…')
  expect(lastFrame()).toContain('Premier')
})

test('herness tasks <id> sans TTY imprime la vue une fois', async () => {
  const s = base()
  await saveState(s)
  const r = await execa('node', ['bin/herness.js', 'tasks', 'T-1'], {
    reject: false, stdin: 'ignore', env: { HERNESS_HOME: home },
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('T-1 · feat/T-1-x · tasks')
})

test('un double v ne poste qu une décision', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const decide = vi.fn(() => new Promise<void>((r) => setTimeout(r, 100)))
  const { stdin } = render(<TasksDashboard id="T-1" decide={decide} load={async () => s} />)
  await tick()
  stdin.write('v')
  stdin.write('v')
  await tick(20)
  stdin.write('r')
  await tick(200)
  expect(decide).toHaveBeenCalledTimes(1)
})

test('v puis v avec deux portes cible g1 puis g2', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const decide = vi.fn(async () => {})
  const { stdin } = render(<TasksDashboard id="T-1" decide={decide} load={async () => s} />)
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('v')
  await tick()
  const ids = decide.mock.calls.map((c) => (c as unknown as [string, string, { gateId: string }])[2].gateId)
  expect(ids).toEqual(['g1', 'g2'])
})

test('le message disparaît quand la porte n est plus en attente', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  let cur = s
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" decide={async () => {}} load={async () => cur} intervalMs={20} />)
  await tick()
  stdin.write('v')
  await tick()
  expect(lastFrame()).toContain('décision envoyée')
  cur = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  await tick(80)
  expect(lastFrame()).not.toContain('décision envoyée')
})
