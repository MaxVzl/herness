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
    restart: async (id, o) => { calls.push(o?.detached ? ['restart', id, 'détaché'] : ['restart', id]); return ok() },
    close: async (id, confirm) => { calls.push(['close', id]); return { ok: await confirm('Fermer quand même ?'), lines: [] } },
    open: async (s) => { calls.push(['open', s.id]); return ok() },
    remove: async (id) => { calls.push(['remove', id]); return ok(['Mission T-1 supprimée.']) },
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
  const d = render(<MissionDetail state={s} sentGates={['g1']} />).lastFrame()!
  expect(d).not.toContain('▸')
  expect(d).toMatch(/g1.*décision envoyée/)
  expect(d).not.toMatch(/g2.*décision envoyée/)
})

test('pendant l envoi, la porte n est plus marquée ▸ et affiche décision envoyée', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a } = fakeActions({ validate: () => new Promise(() => {}) })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g1')
  stdin.write('\r')
  await waitFor(lastFrame, 'décision envoyée')
  expect(lastFrame()).not.toContain('▸')
  expect(lastFrame()).toMatch(/g1.*décision envoyée/)
})

test('une action qui lève affiche son erreur', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a } = fakeActions({
    validate: async () => { throw new Error('boum v') },
    resume: async () => { throw new Error('boum p') },
  })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g1')
  stdin.write('\r')
  await waitFor(lastFrame, 'boum v')
  expect(lastFrame()).toContain('boum v')
  stdin.write('p')
  await waitFor(lastFrame, 'boum p')
  expect(lastFrame()).toContain('boum p')
})

test('la porte sélectionnée est réinitialisée quand la mission change', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  const other = { ...s, id: 'T-2', gates: s.gates.map((g) => ({ ...g })) }
  const { a } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'AIDE')
  r.stdin.write('\t')
  await waitMatch(r.lastFrame, /▸.*g2/)
  expect(r.lastFrame()).toMatch(/▸.*g2/)
  r.rerender(<Harness state={other} actions={a} />)
  await waitMatch(r.lastFrame, /▸.*g1/)
  expect(r.lastFrame()).toMatch(/▸.*g1/)
})

test('la libération d une porte n efface que son propre message', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'AIDE')
  r.stdin.write('v')
  await waitFor(r.lastFrame, 'Valider g1')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'g1 validée')
  r.stdin.write('R')
  await waitFor(r.lastFrame, 'redémarrage demandé')
  expect(r.lastFrame()).toContain('redémarrage demandé')
  const done = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  r.rerender(<Harness state={done} actions={a} />)
  await tick()
  expect(r.lastFrame()).toContain('redémarrage demandé')
})

test('démontage pendant la confirmation interne de close : elle rend false', async () => {
  let answer: boolean | undefined
  const { a } = fakeActions({ close: async (_id, confirm) => { answer = await confirm('Fermer quand même ?'); return ok() } })
  const r = render(<Harness state={base()} actions={a} />)
  await waitFor(r.lastFrame, 'AIDE')
  r.stdin.write('f')
  await waitFor(r.lastFrame, 'Fermer T-1 ?')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'Fermer quand même ?')
  expect(r.lastFrame()).toContain('Fermer quand même ?')
  r.unmount()
  await until(() => answer === false)
  expect(answer).toBe(false)
})

test('v affiche la question puis Entrée valide ; Échap n envoie rien', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g1 (spec) de T-1 ?')
  expect(lastFrame()).toContain('Valider g1 (spec) de T-1 ?')
  stdin.write(ESC)
  await waitGone(lastFrame, 'Valider g1')
  expect(calls).toEqual([])
  expect(lastFrame()).not.toContain('Valider g1')
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g1')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 validée')
  expect(calls).toEqual([['validate', 'T-1', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 validée')
})

test('r : note vide refusée, puis note, confirmation et refus', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('r')
  await waitFor(lastFrame, 'ctrl+s valider')
  stdin.write('\x13')
  await waitFor(lastFrame, 'une note est obligatoire pour refuser')
  expect(lastFrame()).toContain('une note est obligatoire pour refuser')
  expect(calls).toEqual([])
  stdin.write('trop long')
  await waitFor(lastFrame, 'trop long▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'Refuser g1 (spec) de T-1 ?')
  expect(lastFrame()).toContain('Refuser g1 (spec) de T-1 ?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitFor(lastFrame, 'g1 refusée')
  expect(calls).toEqual([['refuse', 'T-1', 'g1', 'trop long']])
  expect(lastFrame()).toContain('g1 refusée')
})

test('n : note, choix v, confirmation, validation avec note', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('n')
  await waitFor(lastFrame, 'ctrl+s valider · ctrl+e')
  stdin.write('ok pour moi')
  await waitFor(lastFrame, 'ok pour moi▏')
  stdin.write('\x13')
  await waitFor(lastFrame, 'v valider · r refuser · échap annuler')
  expect(lastFrame()).toContain('v valider · r refuser · échap annuler')
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g1 (spec) de T-1 ?')
  expect(lastFrame()).toContain('Valider g1 (spec) de T-1 ?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', 'T-1', 'g1', 'ok pour moi']])
})

test('n : note vide puis r reste sur le choix', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('n')
  await waitFor(lastFrame, 'ctrl+s valider · ctrl+e')
  stdin.write('\x13')
  await waitFor(lastFrame, 'v valider · r refuser · échap annuler')
  stdin.write('r')
  await waitFor(lastFrame, 'une note est obligatoire pour refuser')
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
  await waitFor(lastFrame, 'AIDE')
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g1')
  stdin.write('\r')
  await until(() => calls.length === 1)
  stdin.write('v')
  await waitFor(lastFrame, 'aucune porte en attente')
  // l'erreur reste affichée jusqu'à la touche suivante
  expect(lastFrame()).toContain('aucune porte en attente')
  stdin.write('\r')
  await tick()
  expect(calls).toHaveLength(1)
  release()
  await waitFor(lastFrame, 'g1 validée')
  stdin.write('v')
  await waitFor(lastFrame, 'aucune porte en attente')
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
  await waitFor(lastFrame, 'AIDE')
  stdin.write('\t')
  await waitMatch(lastFrame, /▸.*g2/)
  expect(lastFrame()).toMatch(/▸.*g2/)
  stdin.write('\u001b[C')
  await waitMatch(lastFrame, /▸.*g1/)
  expect(lastFrame()).toMatch(/▸.*g1/)
  stdin.write('\u001b[D')
  await waitMatch(lastFrame, /▸.*g2/)
  expect(lastFrame()).toMatch(/▸.*g2/)
  stdin.write('v')
  await waitFor(lastFrame, 'Valider g2 (plan)')
  expect(lastFrame()).toContain('Valider g2 (plan)')
  stdin.write('\r')
  await until(() => calls.length === 1)
  expect(calls).toEqual([['validate', 'T-1', 'g2', undefined]])
})

test('f demande confirmation avant close et relaie la confirmation interne', async () => {
  const s = base()
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('f')
  await waitFor(lastFrame, 'Fermer T-1 ?')
  expect(lastFrame()).toContain('Fermer T-1 ?')
  expect(calls).toEqual([])
  stdin.write(ESC)
  await waitFor(lastFrame, 'fermeture annulée')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('fermeture annulée')
  stdin.write('f')
  await waitFor(lastFrame, 'Fermer T-1 ?')
  stdin.write('\r')
  await waitFor(lastFrame, 'Fermer quand même ?')
  expect(calls).toEqual([['close', 'T-1']])
  expect(lastFrame()).toContain('Fermer quand même ?')
  stdin.write(ESC)
  await waitGone(lastFrame, 'Fermer quand même ?')
  await waitFor(lastFrame, 'fermeture annulée')
  expect(lastFrame()).not.toContain('Fermer quand même ?')
  expect(lastFrame()).toContain('fermeture annulée')
})

test('pendant une fermeture, aucun autre geste n ouvre de saisie ni ne lance d action', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  let go: () => void = () => {}
  let answer: boolean | undefined
  const { a, calls } = fakeActions({
    close: async (id, confirm) => {
      calls.push(['close', id])
      await new Promise<void>((r) => { go = r })
      answer = await confirm('Fermer quand même ?')
      return ok(['fermée'])
    },
  })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('f')
  await waitFor(lastFrame, 'Fermer T-1 ?')
  stdin.write('\r')
  await until(() => calls.length === 1)
  await waitGone(lastFrame, 'Fermer T-1 ?')
  for (const k of ['v', 'r', 'n', 'f', 'p', 'R', 'o']) {
    stdin.write(k)
    await waitFor(lastFrame, 'action en cours')
    await tick() // absence : le geste refusé ne doit rien ouvrir
    expect(lastFrame()).toContain('action en cours')
    expect(lastFrame()).not.toContain('Valider g1')
    expect(lastFrame()).not.toContain('Note')
    expect(lastFrame()).not.toContain('Fermer T-1 ?')
  }
  expect(calls).toEqual([['close', 'T-1']])
  go()
  await waitFor(lastFrame, 'Fermer quand même ?')
  expect(lastFrame()).toContain('Fermer quand même ?')
  stdin.write('\r')
  await until(() => answer === true)
  await waitFor(lastFrame, 'fermée')
  expect(lastFrame()).toContain('fermée')
  stdin.write('p')
  await until(() => calls.length === 2)
  expect(calls).toEqual([['close', 'T-1'], ['resume', 'T-1']])
})

test('une confirmation interne remplacée par une autre rend false', async () => {
  const answers: boolean[] = []
  const { a } = fakeActions({
    close: async (_id, confirm) => {
      const first = confirm('Première ?')
      const second = confirm('Seconde ?')
      answers.push(await first)
      answers.push(await second)
      return ok()
    },
  })
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('f')
  await waitFor(lastFrame, 'Fermer T-1 ?')
  stdin.write('\r')
  await waitFor(lastFrame, 'Seconde ?')
  expect(lastFrame()).toContain('Seconde ?')
  expect(lastFrame()).not.toContain('Première ?')
  stdin.write('\r')
  await until(() => answers.length === 2)
  expect(answers).toEqual([false, true])
})

test('p désactivé sur une mission fermée ; actif sinon', async () => {
  const s = base()
  s.step = 'fermée'
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('p')
  await waitFor(lastFrame, 'mission terminée')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('mission terminée')
  expect(lastFrame()).toContain('(p reprendre)')
  const live = render(<Harness state={base()} actions={a} />)
  await waitFor(live.lastFrame, 'AIDE')
  live.stdin.write('p')
  await until(() => calls.length === 1)
  await waitFor(live.lastFrame, 'reprise demandée')
  expect(calls).toEqual([['resume', 'T-1']])
  expect(live.lastFrame()).toContain('reprise demandée')
})

test('R redémarre, o ouvre, c appelle onBack', async () => {
  const s = base()
  const { a, calls } = fakeActions()
  const onBack = vi.fn(async () => {})
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} onBack={onBack} />)
  await waitFor(lastFrame, 'c cockpit')
  expect(lastFrame()).toContain('c cockpit')
  stdin.write('R')
  await until(() => calls.length === 1)
  stdin.write('o')
  await until(() => calls.length === 2)
  stdin.write('c')
  await until(() => onBack.mock.calls.length === 1)
  expect(calls).toEqual([['restart', 'T-1'], ['open', 'T-1']])
  const own = render(<Harness state={s} actions={a} ownPanel />)
  await waitFor(own.lastFrame, 'AIDE')
  own.stdin.write('R')
  await until(() => calls.length === 3)
  expect(calls.at(-1)).toEqual(['restart', 'T-1', 'détaché'])
  expect(onBack).toHaveBeenCalledTimes(1)
})

test('une erreur de onBack s affiche', async () => {
  const { a } = fakeActions()
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} onBack={async () => { throw new Error('aucun cockpit') }} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('c')
  await waitFor(lastFrame, 'aucun cockpit')
  expect(lastFrame()).toContain('aucun cockpit')
})

test('le message montre les 5 dernières lignes, est relayé et disparaît à l expiration', async () => {
  const pending: { fn: () => void; ms: number }[] = []
  const timer: Timer = (fn, ms) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const { a } = fakeActions({ resume: async () => ok(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) })
  const seen: string[] = []
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} timer={timer} onMessage={(m) => seen.push(m)} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('p')
  await waitFor(lastFrame, 'l6')
  expect(lastFrame()).toContain('l6')
  expect(lastFrame()).not.toContain('l1')
  expect(seen.at(-1)).toContain('l6')
  expect(pending.at(-1)?.ms).toBe(5000)
  pending.at(-1)!.fn()
  await waitGone(lastFrame, 'l6')
  expect(lastFrame()).not.toContain('l6')
})

test('un échec garde les lignes KO et l erreur finale (8 lignes au plus), ne s efface pas seul mais à la touche suivante', async () => {
  const pending: { fn: () => void; ms: number }[] = []
  const timer: Timer = (fn, ms) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const lines = [
    'OK git : présent', 'KO gh : absent', 'OK node : 24', 'KO herdr : hors session', 'OK a', 'OK b', 'OK c', 'OK d', 'OK e', 'OK f',
    'environnement incomplet : corrige les KO ci-dessus',
  ]
  const { a } = fakeActions({ resume: async () => ({ ok: false, lines }) })
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} timer={timer} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('p')
  await waitFor(lastFrame, 'environnement incomplet')
  const f = lastFrame()!
  expect(f).toContain('KO gh : absent')
  expect(f).toContain('KO herdr : hors session')
  expect(f).toContain('environnement incomplet')
  expect(f).not.toContain('OK f')
  expect(pending).toEqual([])
  stdin.write('x')
  await waitGone(lastFrame, 'environnement incomplet')
  expect(lastFrame()).not.toContain('environnement incomplet')
})

test('un échec sans ligne KO montre ses 8 dernières lignes', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `ligne ${i + 1}`)
  const { a } = fakeActions({ resume: async () => ({ ok: false, lines }) })
  const { stdin, lastFrame } = render(<Harness state={base()} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('p')
  await waitFor(lastFrame, 'ligne 10')
  expect(lastFrame()).toContain('ligne 3')
  expect(lastFrame()).toContain('ligne 10')
  expect(lastFrame()).not.toContain('ligne 2\n')
  expect(lastFrame()).not.toMatch(/ligne 2$/m)
})

test('une erreur reste jusqu à l action suivante, qui la remplace', async () => {
  const s = base()
  const { a } = fakeActions({ resume: async () => ({ ok: false, lines: ['reprise impossible'] }) })
  const { stdin, lastFrame } = render(<Harness state={s} actions={a} />)
  await waitFor(lastFrame, 'AIDE')
  stdin.write('p')
  await waitFor(lastFrame, 'reprise impossible')
  expect(lastFrame()).toContain('reprise impossible')
  await tick(100)
  expect(lastFrame()).toContain('reprise impossible')
  stdin.write('R')
  await waitFor(lastFrame, 'redémarrage demandé')
  expect(lastFrame()).not.toContain('reprise impossible')
  expect(lastFrame()).toContain('redémarrage demandé')
})

test('une porte décidée redevient sélectionnable quand l état ne la montre plus en attente puis rouverte', async () => {
  const s = base()
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'AIDE')
  r.stdin.write('v')
  await waitFor(r.lastFrame, 'Valider g1')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'g1 validée')
  r.stdin.write('v')
  await waitFor(r.lastFrame, 'aucune porte en attente')
  expect(r.lastFrame()).toContain('aucune porte en attente')
  const done = { ...s, gates: s.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  r.rerender(<Harness state={done} actions={a} />)
  await waitGone(r.lastFrame, 'g1')
  r.rerender(<Harness state={s} actions={a} />)
  await waitMatch(r.lastFrame, /▸.*g1/)
  r.stdin.write('v')
  await waitFor(r.lastFrame, 'Valider g1')
  r.stdin.write('\r')
  await until(() => calls.length === 2)
  expect(calls).toHaveLength(2)
})

test('missionActions avec focus:false transmet focus:false à resumeMission (p et R)', async () => {
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
  expect(spawned).toEqual([[process.execPath, ['reprendre', 'T-1', '--redemarrer'], expect.objectContaining({ detached: true })], 'unref'])
  expect(r.lines[0]).toMatch(/^redémarrage lancé \(ce panneau va se relancer\) ; journal : .*redemarrage-.*\.log$/)
})

test('x supprime une mission fermée après confirmation ; Échap annule', async () => {
  const s = { ...base(), step: 'fermée' as const }
  const { a, calls } = fakeActions()
  const r = render(<Harness state={s} actions={a} />)
  await waitFor(r.lastFrame, 'AIDE')
  expect(r.lastFrame()).toContain('x supprimer')
  r.stdin.write('x')
  await waitFor(r.lastFrame, 'Supprimer définitivement T-1 (état, spec, plan, journaux) ?')
  r.stdin.write(ESC)
  await waitFor(r.lastFrame, 'suppression annulée')
  expect(calls).toEqual([])
  r.stdin.write('x')
  await waitFor(r.lastFrame, 'Supprimer définitivement T-1')
  r.stdin.write('\r')
  await waitFor(r.lastFrame, 'Mission T-1 supprimée.')
  expect(calls).toEqual([['remove', 'T-1']])
})

test('x refuse une mission pas fermée', async () => {
  const { a, calls } = fakeActions()
  const r = render(<Harness state={base()} actions={a} />)
  await waitFor(r.lastFrame, 'AIDE')
  expect(r.lastFrame()).toContain('(x supprimer)')
  r.stdin.write('x')
  await waitFor(r.lastFrame, "supprimer indisponible : ferme d'abord la mission (f)")
  expect(calls).toEqual([])
})

test('x absent du panneau tasks de la mission', async () => {
  const { a, calls } = fakeActions()
  const r = render(<Harness state={{ ...base(), step: 'fermée' }} actions={a} ownPanel />)
  await waitFor(r.lastFrame, 'AIDE')
  expect(r.lastFrame()).not.toContain('supprimer')
  r.stdin.write('x')
  await tick()
  expect(r.lastFrame()).not.toContain('Supprimer')
  expect(calls).toEqual([])
})
