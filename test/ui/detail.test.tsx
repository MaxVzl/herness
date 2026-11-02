import { render } from 'ink-testing-library'
import { Box, Text } from 'ink'
import React from 'react'
import { expect, test, vi } from 'vitest'
import { openGate } from '../../src/engine/gates.ts'
import { newState, type MissionState } from '../../src/mission/state.ts'
import { MissionDetail, missionActions, useMissionKeys, type MissionActions, type Timer } from '../../src/ui/detail.tsx'
import type { ActionDeps, ActionResult } from '../../src/ui/actions.ts'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
const ESC = '\u001b'

function base(): MissionState {
  const s = newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/r' })
  s.branch = 'feat/T-1-x'
  s.step = 'tasks'
  s.tasks.push({ n: 1, title: 'Premier', testCommand: 't', phase: 'review', round: 1 })
  return s
}

const ok = (lines: string[] = []): ActionResult => ({ ok: true, lines })

function fakeActions(over: Partial<MissionActions> = {}) {
  const calls: unknown[][] = []
  const a: MissionActions = {
    validate: async (id, gateId, note) => { calls.push(['validate', id, gateId, note]); return ok() },
    refuse: async (id, gateId, note) => { calls.push(['refuse', id, gateId, note]); return ok() },
    resume: async (id) => { calls.push(['resume', id]); return ok(['reprise demandée']) },
    restart: async (id) => { calls.push(['restart', id]); return ok() },
    close: async (id, confirm) => { calls.push(['close', id]); return { ok: await confirm('Fermer quand même ?'), lines: [] } },
    open: async (s) => { calls.push(['open', s.id]); return ok() },
    ...over,
  }
  return { a, calls }
}

function Harness(props: { state: MissionState; actions: MissionActions; onBack?: () => Promise<void> | void; timer?: Timer; onMessage?: (m: string) => void }): React.ReactElement {
  const k = useMissionKeys(props)
  return (
    <Box flexDirection="column">
      <MissionDetail state={props.state} {...(k.selectedGate ? { selectedGate: k.selectedGate } : {})} />
      {k.overlay}
      {k.message ? <Text>{`MSG ${k.message}`}</Text> : null}
      <Text>{`AIDE ${k.help}`}</Text>
    </Box>
  )
}

test('MissionDetail met en évidence la porte sélectionnée', () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const f = render(<MissionDetail state={s} selectedGate="g2" />).lastFrame()!
  expect(f).toMatch(/▸.*g2/)
  expect(f).not.toMatch(/▸.*g1/)
  const d = render(<MissionDetail state={s} />).lastFrame()!
  expect(d).toMatch(/▸.*g1/)
})

test('v affiche la question puis Entrée valide ; Échap n envoie rien', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('v')
  await tick()
  expect(lastFrame()).toContain('Valider g1 (spec) de T-1 ?')
  stdin.write(ESC)
  await tick(100)
  expect(calls).toEqual([])
  expect(lastFrame()).not.toContain('Valider g1')
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', 'T-1', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 validée')
})

test('r : note vide refusée, puis note, confirmation et refus', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('r')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(lastFrame()).toContain('une note est obligatoire pour refuser')
  expect(calls).toEqual([])
  stdin.write('trop long')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(lastFrame()).toContain('Refuser g1 (spec) de T-1 ?')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'trop long']])
  expect(lastFrame()).toContain('g1 refusée')
})

test('n : note, choix v, confirmation, validation avec note', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('n')
  await tick()
  stdin.write('ok pour moi')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(lastFrame()).toContain('v valider · r refuser · échap annuler')
  stdin.write('v')
  await tick()
  expect(lastFrame()).toContain('Valider g1 (spec) de T-1 ?')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', 'T-1', 'g1', 'ok pour moi']])
})

test('n : note vide puis r reste sur le choix', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('n')
  await tick()
  stdin.write('\x13')
  await tick()
  stdin.write('r')
  await tick()
  expect(lastFrame()).toContain('une note est obligatoire pour refuser')
  expect(lastFrame()).toContain('v valider · r refuser · échap annuler')
  expect(calls).toEqual([])
})

test('deux v rapides n envoient qu une décision', async () => {
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
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toHaveLength(1)
  expect(lastFrame()).toContain('aucune porte en attente')
  release()
  await tick()
  stdin.write('v')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toHaveLength(1)
})

test('tab et flèches changent la porte sélectionnée et v la vise', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('\t')
  await tick()
  expect(lastFrame()).toMatch(/▸.*g2/)
  stdin.write('\u001b[C')
  await tick()
  expect(lastFrame()).toMatch(/▸.*g1/)
  stdin.write('\u001b[D')
  await tick()
  expect(lastFrame()).toMatch(/▸.*g2/)
  stdin.write('v')
  await tick()
  expect(lastFrame()).toContain('Valider g2 (plan)')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', 'T-1', 'g2', undefined]])
})

test('f demande confirmation avant close et relaie la confirmation interne', async () => {
  const s = base()
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('f')
  await tick()
  expect(lastFrame()).toContain('Fermer T-1 ?')
  expect(calls).toEqual([])
  stdin.write(ESC)
  await tick(100)
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('fermeture annulée')
  stdin.write('f')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['close', 'T-1']])
  expect(lastFrame()).toContain('Fermer quand même ?')
  stdin.write(ESC)
  await tick(100)
  expect(lastFrame()).not.toContain('Fermer quand même ?')
  expect(lastFrame()).toContain('fermeture annulée')
})

test('p désactivé sur une mission fermée ; actif sinon', async () => {
  const s = base()
  s.step = 'fermée'
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await tick()
  stdin.write('p')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('mission terminée')
  expect(lastFrame()).toContain('(p reprendre)')
  const live = render(<Harness state={base()} actions={a} />)
  await tick()
  live.stdin.write('p')
  await tick()
  expect(calls).toEqual([['resume', 'T-1']])
  expect(live.lastFrame()).toContain('reprise demandée')
})

test('R redémarre, o ouvre, c appelle onBack', async () => {
  const s = base()
  const { a, calls } = fakeActions()
  const onBack = vi.fn(async () => {})
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} onBack={onBack} />)
  await tick()
  expect(lastFrame()).toContain('c cockpit')
  stdin.write('R')
  await tick()
  stdin.write('o')
  await tick()
  stdin.write('c')
  await tick()
  expect(calls).toEqual([['restart', 'T-1'], ['open', 'T-1']])
  expect(onBack).toHaveBeenCalledTimes(1)
})

test('une erreur de onBack s affiche', async () => {
  const { a } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} onBack={async () => { throw new Error('aucun cockpit') }} />)
  await tick()
  stdin.write('c')
  await tick()
  expect(lastFrame()).toContain('aucun cockpit')
})

test('le message montre les 5 dernières lignes, est relayé et disparaît à l expiration', async () => {
  const pending: { fn: () => void; ms: number }[] = []
  const timer: Timer = (fn, ms) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const { a } = fakeActions({ resume: async () => ok(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) })
  const seen: string[] = []
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} timer={timer} onMessage={(m) => seen.push(m)} />)
  await tick()
  stdin.write('p')
  await tick()
  expect(lastFrame()).toContain('l6')
  expect(lastFrame()).not.toContain('l1')
  expect(seen.at(-1)).toContain('l6')
  expect(pending.at(-1)?.ms).toBe(5000)
  pending.at(-1)!.fn()
  await tick()
  expect(lastFrame()).not.toContain('l6')
})

test('une porte décidée redevient sélectionnable quand l état ne la montre plus en attente puis rouverte', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await tick()
  r.stdin.write('v')
  await tick()
  r.stdin.write('\r')
  await tick()
  r.stdin.write('v')
  await tick()
  expect(r.lastFrame()).toContain('aucune porte en attente')
  const done = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  r.rerender(<Harness state={done} actions={a} />)
  await tick()
  r.rerender(<Harness state={s} actions={a} />)
  await tick()
  r.stdin.write('v')
  await tick()
  r.stdin.write('\r')
  await tick()
  expect(calls).toHaveLength(2)
})

test('missionActions relie les actions aux dépendances', async () => {
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
})
