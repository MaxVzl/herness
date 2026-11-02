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


function fakeActions() {
  const calls: unknown[][] = []
  const done = async (): Promise<ActionResult> => ({ ok: true, lines: [] })
  const a: MissionActions = {
    validate: async (id, gateId, note) => { calls.push(['validate', id, gateId, note]); return done() },
    refuse: async (id, gateId, note) => { calls.push(['refuse', id, gateId, note]); return done() },
    resume: async (id) => { calls.push(['resume', id]); return done() },
    restart: async (id, o) => { calls.push(['restart', id, o?.detached === true]); return done() },
    close: async (id) => { calls.push(['close', id]); return done() },
    open: async (s) => { calls.push(['open', s.id]); return done() },
  }
  return { a, calls }
}

test('v puis Entrée valide la plus ancienne porte', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('v')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('Valider g1 (spec) de T-1 ?')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', 'T-1', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 validée')
})

test('v puis Échap n envoie rien', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\u001b')
  await tick(100)
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).not.toContain('Valider g1')
})

test('r sans note puis Entrée ne valide rien ; avec note, confirmation puis refus', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('r')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('une note est obligatoire pour refuser')
  stdin.write('trop long')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(calls).toEqual([])
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'trop long']])
  expect(lastFrame()).toContain('g1 refusée')
})

test('deux v rapides n envoient qu une décision', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const calls: string[] = []
  const a = { ...fakeActions().a, validate: async (_id: string, gateId: string) => { calls.push(gateId); await tick(150); return { ok: true, lines: [] } } }
  const { stdin } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick(20)
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick(200)
  expect(calls).toEqual(['g1'])
})

test('tab sélectionne la deuxième porte et v la vise', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('\t')
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', 'T-1', 'g2', undefined]])
})

test('v puis v avec deux portes cible g1 puis g2', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  for (let i = 0; i < 2; i++) {
    stdin.write('v')
    await tick()
    stdin.write('\r')
    await tick()
  }
  expect(calls.map((c) => c[2])).toEqual(['g1', 'g2'])
})

test('f demande confirmation avant close', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => base()} />)
  await tick()
  stdin.write('f')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('Fermer T-1 ?')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['close', 'T-1']])
})

test('c appelle focusCockpit avec repoPath', async () => {
  const focus = vi.fn(async () => {})
  const { a } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} focusCockpit={focus} load={async () => base()} />)
  await tick()
  expect(lastFrame()).toContain('c cockpit')
  stdin.write('c')
  await tick()
  expect(focus).toHaveBeenCalledWith('/r')
})

test('R depuis le panneau tasks passe par le redémarrage détaché', async () => {
  const { a, calls } = fakeActions()
  const { stdin } = render(<TasksDashboard id="T-1" actions={a} load={async () => base()} />)
  await tick()
  stdin.write('R')
  await tick()
  expect(calls).toEqual([['restart', 'T-1', true]])
})

test('p désactivé sur une mission fermée', async () => {
  const s = base()
  s.step = 'fermée'
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('p')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('mission terminée')
})

test('q dans une note ne quitte pas', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={a} load={async () => s} />)
  await tick()
  stdin.write('r')
  await tick()
  stdin.write('quoi')
  await tick()
  stdin.write('\x13')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'quoi']])
  expect(lastFrame()).toContain('g1 refusée')
})

test('état illisible : garde le dernier état et affiche un message', async () => {
  const s = base()
  let fail = false
  const load = async () => {
    if (fail) throw new Error('boom')
    return s
  }
  const { lastFrame } = render(<TasksDashboard id="T-1" actions={fakeActions().a} load={load} intervalMs={20} />)
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

test('le message disparaît quand la porte n est plus en attente', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  let cur = s
  const { stdin, lastFrame } = render(<TasksDashboard id="T-1" actions={fakeActions().a} load={async () => cur} intervalMs={20} />)
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick()
  expect(lastFrame()).toContain('g1 validée')
  cur = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  await tick(80)
  expect(lastFrame()).not.toContain('g1 validée')
})
