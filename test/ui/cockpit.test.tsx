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
    open: async (s) => { calls.push(['open', s.id]); return done() },
    startNew: async (input) => { calls.push(['startNew', input]); return done() },
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

test('la mission avec une porte est en tête et en ambre', async () => {
  const active = mission('26110201-1', 'actif', '2026-11-02T10:00:00.000Z')
  const gated = mission('26110201-2', 'avec-porte', '2026-11-01T10:00:00.000Z')
  openGate(gated, 'spec', 'Spec à valider')
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [active, gated]} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick()
  const f = lastFrame()!
  expect(f).toContain('herness · demo · 2 missions actives')
  expect(f).toContain('1 porte en attente')
  const lines = f.split('\n')
  const iGated = lines.findIndex((l) => l.includes('01-2') && l.includes('avec-porte'))
  const iActive = lines.findIndex((l) => l.includes('01-1') && l.includes('actif'))
  expect(iGated).toBeGreaterThan(-1)
  expect(iActive).toBeGreaterThan(iGated)
  expect(lines[iGated]).toContain('porte g1')
  // ambre (ink n'émet pas de couleurs sous test : on vérifie la couleur choisie)
  expect(rowColor(gated)).toBe('yellow')
  expect(rowColor(active)).toBeUndefined()
  // la sélection initiale est la première ligne : son détail est affiché
  expect(f).toContain('Spec à valider')
})

test('une PR mergée est masquée, visible après a', async () => {
  const done = mission('26110201-3', 'livree', '2026-11-01T10:00:00.000Z')
  done.step = 'pr-ouverte'
  done.prUrl = 'https://example.test/o/r/pull/7'
  const active = mission('26110201-4', 'encours', '2026-11-02T10:00:00.000Z')
  const pr = fakePrCache({ [done.prUrl]: { state: 'MERGED', checkedAt: '2026-11-02T10:00:00.000Z' } })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [done, active]} actions={fakeActions().a} prCache={pr.cache} columns={140} />,
  )
  await tick()
  expect(lastFrame()).toContain('encours')
  expect(lastFrame()).not.toContain('livree')
  // la PR mergée (masquée et déjà connue comme mergée) n'est pas revérifiée
  expect(pr.refreshed).toEqual([])
  stdin.write('a')
  await tick()
  expect(lastFrame()).toContain('livree')
  expect(lastFrame()).toContain('PR #7')
  stdin.write('a')
  await tick()
  expect(lastFrame()).not.toContain('livree')
})

test('PR CLOSED : fermée depuis plus de 7 jours masquée et jamais revérifiée ; pr-ouverte CLOSED visible et revérifiée', async () => {
  const old = mission('26110201-31', 'abandonnee', '2026-10-01T10:00:00.000Z')
  old.step = 'fermée'
  old.prUrl = 'https://example.test/o/r/pull/31'
  old.log = [{ at: '2026-10-20T10:00:00.000Z', msg: 'mission fermée (herness fermer)' }]
  const open = mission('26110201-32', 'a-traiter', '2026-10-01T10:00:00.000Z')
  open.step = 'pr-ouverte'
  open.prUrl = 'https://example.test/o/r/pull/32'
  const closed = (at: string): PrInfo => ({ state: 'CLOSED', checkedAt: at })
  const pr = fakePrCache({ [old.prUrl]: closed('2026-10-21T10:00:00.000Z'), [open.prUrl]: closed('2026-10-21T10:00:00.000Z') })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [old, open]} actions={fakeActions().a} prCache={pr.cache} columns={140}
      now={() => new Date('2026-11-02T10:00:00.000Z')} intervalMs={20} />,
  )
  await tick()
  expect(lastFrame()).toContain('a-traiter')
  expect(lastFrame()).not.toContain('abandonnee')
  stdin.write('a')
  await tick()
  expect(lastFrame()).toContain('abandonnee')
  expect(pr.refreshed.length).toBeGreaterThan(0)
  expect(pr.refreshed.flat()).not.toContain(old.prUrl)
  expect(pr.refreshed.flat()).toContain(open.prUrl)
})

test('↓ puis v puis Entrée valide la porte de la deuxième mission', async () => {
  const first = mission('26110201-5', 'premiere', '2026-11-02T10:00:00.000Z')
  const second = mission('26110201-6', 'seconde', '2026-11-01T10:00:00.000Z')
  openGate(first, 'spec', 'A')
  openGate(second, 'plan', 'B')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [first, second]} actions={a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick()
  stdin.write('\u001b[B')
  await tick(80)
  stdin.write('v')
  await tick()
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('Valider g1 (plan) de 01-6 ?')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', '26110201-6', 'g1', undefined]])
  expect(lastFrame()).toContain('g1 validée')
})

test('+ puis texte puis Entrée appelle startNew et affiche son erreur', async () => {
  const { a, calls } = fakeActions({
    startNew: async (input) => { calls.push(['startNew', input]); return { ok: false, lines: ['mission déjà existante'] } },
  })
  const s = mission('26110201-7', 'seule', '2026-11-02T10:00:00.000Z')
  openGate(s, 'spec', 'A')
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick()
  stdin.write('+')
  await tick()
  expect(lastFrame()).toContain('Lien Wrike, issue GitHub ou texte :')
  stdin.write('voir q et a')
  await tick()
  expect(lastFrame()).toContain('voir q et a')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['startNew', 'voir q et a']])
  expect(lastFrame()).toContain('mission déjà existante')
  expect(lastFrame()).not.toContain('Lien Wrike, issue GitHub ou texte :')
})

test('un échec de startNew garde les KO et l erreur finale', async () => {
  const lines = ['OK git : présent', 'KO gh : non connecté', 'OK node : 24', 'OK a', 'OK b', 'OK c', 'OK d', 'environnement incomplet : corrige les KO ci-dessus']
  const pending: { fn: () => void; ms: number }[] = []
  const timer = (fn: () => void, ms: number) => { const e = { fn, ms }; pending.push(e); return () => { pending.splice(pending.indexOf(e), 1) } }
  const { a } = fakeActions({ startNew: async () => ({ ok: false, lines }) })
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={a} prCache={fakePrCache().cache} columns={140} timer={timer} />,
  )
  await tick()
  stdin.write('+')
  await tick()
  stdin.write('texte')
  await tick()
  stdin.write('\r')
  await tick()
  expect(lastFrame()).toContain('KO gh : non connecté')
  expect(lastFrame()).toContain('environnement incomplet')
  expect(lastFrame()).not.toContain('OK d')
  // seul le message « démarrage… » (réussi) a une expiration, annulée par l'erreur
  expect(pending).toEqual([])
})

test('+ pendant une fermeture est refusé ; la confirmation interne n est jamais active avec un champ', async () => {
  let go: () => void = () => {}
  let answer: boolean | undefined
  const { a, calls } = fakeActions({
    close: async (id, confirm) => {
      calls.push(['close', id])
      await new Promise<void>((r) => { go = r })
      answer = await confirm('Fermer quand même ?')
      return { ok: true, lines: [] }
    },
  })
  const s = mission('26110201-33', 'fermer', '2026-11-02T10:00:00.000Z')
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick()
  stdin.write('f')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('+')
  await tick()
  expect(lastFrame()).not.toContain('Lien Wrike')
  expect(lastFrame()).toContain('action en cours')
  go()
  await tick()
  expect(lastFrame()).toContain('Fermer quand même ?')
  expect(lastFrame()).not.toContain('Lien Wrike')
  stdin.write('\r')
  await tick()
  expect(answer).toBe(true)
  expect(calls).toEqual([['close', '26110201-33']])
  stdin.write('+')
  await tick()
  expect(lastFrame()).toContain('Lien Wrike')
})

test('+ puis Échap annule sans démarrer', async () => {
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => []} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick()
  stdin.write('+')
  await tick()
  stdin.write('abc')
  await tick()
  stdin.write('\u001b')
  await tick(100)
  expect(lastFrame()).not.toContain('Lien Wrike')
  expect(calls).toEqual([])
  expect(lastFrame()).toContain('aucune mission')
})

test('état illisible : la liste garde les autres missions', async () => {
  await saveState(mission('26110201-8', 'lisible', '2026-11-02T10:00:00.000Z', '/projet'))
  await saveState(mission('26110201-9', 'autre-projet', '2026-11-02T10:00:00.000Z', '/ailleurs'))
  await mkdir(missionDir('26110201-10'), { recursive: true })
  await writeFile(join(missionDir('26110201-10'), 'state.json'), '{ pas du json')
  const { lastFrame } = render(
    <Cockpit repoPath="/projet" name="demo" actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick(150)
  expect(lastFrame()).toContain('lisible')
  expect(lastFrame()).not.toContain('autre-projet')
  expect(lastFrame()).toContain('1 mission active')
})

test('la sélection suit la mission à travers les relectures', async () => {
  const x = mission('26110201-11', 'xx', '2026-11-02T10:00:00.000Z')
  const y = mission('26110201-12', 'yy', '2026-11-01T10:00:00.000Z')
  let list = [x, y]
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick()
  stdin.write('\u001b[B')
  await tick(80)
  expect(lastFrame()).toContain('26110201-12 · feat/26110201-12-yy')
  // une nouvelle mission plus récente arrive en tête : la sélection reste sur y
  const z = mission('26110201-13', 'zz', '2026-11-03T10:00:00.000Z')
  list = [z, x, y]
  await tick(80)
  expect(lastFrame()).toContain('26110201-12 · feat/26110201-12-yy')
  // y disparaît : retour à la première ligne
  list = [z, x]
  await tick(80)
  expect(lastFrame()).toContain('26110201-13 · feat/26110201-13-zz')
})

test('sans ↓ préalable, la sélection reste sur la mission affichée quand la liste se réordonne', async () => {
  const x = mission('26110201-20', 'xx', '2026-11-02T10:00:00.000Z')
  let list = [x]
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick()
  expect(lastFrame()).toContain('26110201-20 · feat/26110201-20-xx')
  list = [mission('26110201-21', 'zz', '2026-11-03T10:00:00.000Z'), x]
  await tick(80)
  expect(lastFrame()).toContain('26110201-20 · feat/26110201-20-xx')
})

test('une relecture lente ne chevauche pas la suivante et un résultat périmé n est pas appliqué', async () => {
  const stale = mission('26110201-22', 'vieux', '2026-11-02T10:00:00.000Z')
  openGate(stale, 'spec', 'A')
  const fresh = { ...stale, slug: 'neuf', gates: stale.gates.map((g) => ({ ...g, status: 'approved' as const })) }
  let calls = 0
  const load = async (): Promise<MissionState[]> => {
    calls++
    if (calls === 1) {
      await tick(120)
      return [stale]
    }
    return [fresh]
  }
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={load} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick(90)
  expect(calls).toBe(1)
  await tick(150)
  expect(calls).toBeGreaterThan(1)
  expect(lastFrame()).toContain(' neuf ')
  expect(lastFrame()).not.toContain('porte en attente')
})

test('un rafraîchissement des PR lent n est pas relancé à chaque relecture', async () => {
  const s = mission('26110201-23', 'pr', '2026-11-02T10:00:00.000Z')
  s.step = 'pr-ouverte'
  s.prUrl = 'https://example.test/o/r/pull/8'
  let refreshes = 0
  const cache = { get: () => undefined, refresh: async () => { refreshes++; await tick(200) } }
  render(<Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={cache} columns={140} intervalMs={20} />)
  await tick(150)
  expect(refreshes).toBe(1)
  await tick(150)
  expect(refreshes).toBe(2)
})

test('un rafraîchissement des PR qui lève n affiche pas l erreur de lecture', async () => {
  const s = mission('26110201-24', 'pr', '2026-11-02T10:00:00.000Z')
  s.step = 'pr-ouverte'
  s.prUrl = 'https://example.test/o/r/pull/9'
  const cache = { get: () => undefined, refresh: (): Promise<void> => { throw new Error('boom') } }
  const { lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={fakeActions().a} prCache={cache} columns={140} intervalMs={20} />,
  )
  await tick(80)
  expect(lastFrame()).toContain('PR #9')
  expect(lastFrame()).not.toContain('lecture des missions impossible')
})

test('seules les PR visibles et non mergées sont rafraîchies', async () => {
  const open = mission('26110201-25', 'ouverte', '2026-11-02T10:00:00.000Z')
  open.step = 'pr-ouverte'
  open.prUrl = 'https://example.test/o/r/pull/10'
  const merged = mission('26110201-26', 'mergee', '2026-11-01T10:00:00.000Z')
  merged.step = 'pr-ouverte'
  merged.prUrl = 'https://example.test/o/r/pull/11'
  const pr = fakePrCache({ [merged.prUrl]: { state: 'MERGED', checkedAt: '2026-11-02T10:00:00.000Z' } })
  const { stdin } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [open, merged]} actions={fakeActions().a} prCache={pr.cache} columns={140} intervalMs={20} />,
  )
  await tick()
  stdin.write('a')
  await tick(80)
  expect(pr.refreshed.length).toBeGreaterThan(0)
  for (const urls of pr.refreshed) expect(urls).toEqual([open.prUrl])
})

test('q quitte quand rien n est ouvert : la relecture s arrête', async () => {
  let calls = 0
  const { stdin } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => { calls++; return [] }} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick()
  stdin.write('q')
  await tick()
  const n = calls
  await tick(100)
  expect(calls).toBe(n)
})

test('le démontage arrête la relecture', async () => {
  let calls = 0
  const { unmount } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => { calls++; return [] }} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick(60)
  unmount()
  const n = calls
  await tick(100)
  expect(calls).toBe(n)
})

test('une liste réordonnée pendant la confirmation garde la mission et la porte visées', async () => {
  const x = mission('26110201-27', 'xx', '2026-11-02T10:00:00.000Z')
  openGate(x, 'spec', 'A')
  let list = [x]
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick()
  stdin.write('v')
  await tick()
  expect(lastFrame()).toContain('Valider g1 (spec) de 01-27 ?')
  const y = mission('26110201-28', 'yy', '2026-11-03T10:00:00.000Z')
  openGate(y, 'plan', 'B')
  list = [y, x]
  await tick(80)
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', '26110201-27', 'g1', undefined]])
})

test('le choix v/r d une note vise la mission de son ouverture, même disparue de la liste', async () => {
  const x = mission('26110201-34', 'xx', '2026-11-02T10:00:00.000Z')
  openGate(x, 'spec', 'A')
  const y = mission('26110201-35', 'yy', '2026-11-01T10:00:00.000Z')
  openGate(y, 'spec', 'B')
  let list = [x, y]
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => list} actions={a} prCache={fakePrCache().cache} columns={140} intervalMs={20} />,
  )
  await tick()
  stdin.write('n')
  await tick()
  stdin.write('voir')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(lastFrame()).toContain('v valider · r refuser · échap annuler')
  list = [y]
  await tick(80)
  stdin.write('v')
  await tick()
  expect(lastFrame()).toContain('Valider g1 (spec) de 01-34 ?')
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['validate', '26110201-34', 'g1', 'voir']])
})

test('q quitte seulement hors saisie', async () => {
  const s = mission('26110201-14', 'q', '2026-11-02T10:00:00.000Z')
  openGate(s, 'spec', 'A')
  const { a, calls } = fakeActions()
  const { stdin, lastFrame } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick()
  stdin.write('r')
  await tick()
  stdin.write('quoi')
  await tick()
  stdin.write('\x13')
  await tick()
  stdin.write('\r')
  await tick()
  expect(calls).toEqual([['refuse', '26110201-14', 'g1', 'quoi']])
  expect(lastFrame()).toContain('q quitter')
})

test('R depuis le cockpit redémarre directement', async () => {
  const s = mission('26110201-15', 'r', '2026-11-02T10:00:00.000Z')
  const { a, calls } = fakeActions()
  const { stdin } = render(
    <Cockpit repoPath="/r" name="demo" load={async () => [s]} actions={a} prCache={fakePrCache().cache} columns={140} />,
  )
  await tick()
  stdin.write('R')
  await tick()
  expect(calls).toEqual([['restart', '26110201-15', false]])
})

test('herness cockpit hors TTY affiche une image et sort', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'herness-projects-'))
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'herness-repo-')))
  try {
    await mkdir(join(projects, 'demo'), { recursive: true })
    await writeFile(join(projects, 'demo', 'config.ts'), `export default ${JSON.stringify({ ...demo, repoPath: repo })}\n`)
    const s = mission('26110201-16', 'image', '2026-11-02T10:00:00.000Z', repo)
    openGate(s, 'spec', 'Spec de test')
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
    expect(r.stdout).toContain('herness · demo · 1 mission active')
    expect(r.stdout).toContain('image')
    expect(r.stdout).toContain('Spec de test')
  } finally {
    await rm(projects, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})
