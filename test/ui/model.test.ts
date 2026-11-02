import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import {
  bucketOf, isHidden, projectMissions, shortId, sortMissions, statusLabel, type PrInfo,
} from '../../src/ui/model.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

function mk(over: Partial<MissionState> = {}): MissionState {
  return { ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: '/r' }), ...over }
}
const gate = (id: string, status: 'pending' | 'approved' = 'pending'): MissionState['gates'][number] =>
  ({ id, kind: 'plan', status, summary: 's', createdAt: '2026-11-01T00:00:00Z' })
const now = new Date('2026-11-10T12:00:00Z')

test('bucketOf : porte en attente -> decision, même bloquée', () => {
  expect(bucketOf(mk({ step: 'plan', gates: [gate('g1')] }))).toBe('decision')
  expect(bucketOf(mk({ step: 'bloquée', gates: [gate('g1')] }))).toBe('decision')
})
test('bucketOf : bloquée', () => expect(bucketOf(mk({ step: 'bloquée' }))).toBe('bloquee'))
test('bucketOf : pr-ouverte et fermée -> terminee', () => {
  expect(bucketOf(mk({ step: 'pr-ouverte' }))).toBe('terminee')
  expect(bucketOf(mk({ step: 'fermée' }))).toBe('terminee')
})
test('bucketOf : active sinon', () => {
  expect(bucketOf(mk({ step: 'tasks', gates: [gate('g1', 'approved')] }))).toBe('active')
})

test('shortId', () => {
  expect(shortId('20261102-4')).toBe('02-4')
  expect(shortId('T-1')).toBe('T-1')
})

test('statusLabel', () => {
  expect(statusLabel(mk({ step: 'plan', gates: [gate('g3')] }))).toBe('porte g3')
  expect(statusLabel(mk({ step: 'bloquée' }))).toBe('bloquée')
  const t = (n: number, phase: 'done' | 'pending'): MissionState['tasks'][number] => ({ n, title: 't', testCommand: 'x', phase, round: 0 })
  expect(statusLabel(mk({ step: 'tasks', tasks: [t(1, 'done'), t(2, 'pending'), t(3, 'pending')] }))).toBe('tâche 2/3')
  expect(statusLabel(mk({ step: 'preflight' }))).toBe('preflight')
  expect(statusLabel(mk({ step: 'pr-ouverte', prUrl: 'https://github.com/o/r/pull/1513' }))).toBe('PR #1513')
  expect(statusLabel(mk({ step: 'fermée' }))).toBe('fermée')
})

const merged: PrInfo = { state: 'MERGED', checkedAt: now.toISOString() }
const open: PrInfo = { state: 'OPEN', checkedAt: now.toISOString() }
const url = 'https://github.com/o/r/pull/1'

test('isHidden : pr-ouverte mergée cachée, ouverte visible', () => {
  expect(isHidden(mk({ step: 'pr-ouverte', prUrl: url }), merged, now)).toBe(true)
  expect(isHidden(mk({ step: 'pr-ouverte', prUrl: url }), open, now)).toBe(false)
  expect(isHidden(mk({ step: 'pr-ouverte', prUrl: url }), undefined, now)).toBe(false)
})
test('isHidden : fermée sans PR depuis 8 jours cachée, 2 jours visible', () => {
  const closed = (at: string): MissionState => mk({ step: 'fermée', createdAt: '2026-10-01T00:00:00Z', log: [{ at, msg: 'mission fermée (herness fermer)' }] })
  expect(isHidden(closed('2026-11-02T12:00:00Z'), undefined, now)).toBe(true)
  expect(isHidden(closed('2026-11-08T12:00:00Z'), undefined, now)).toBe(false)
})
test('isHidden : fermée sans log de fermeture utilise createdAt', () => {
  expect(isHidden(mk({ step: 'fermée', createdAt: '2026-10-01T00:00:00Z' }), undefined, now)).toBe(true)
})
test('isHidden : un log « PR fermée » ne compte pas comme fermeture de la mission', () => {
  const s = mk({ step: 'fermée', createdAt: '2026-10-01T00:00:00Z', log: [{ at: '2026-11-09T00:00:00Z', msg: 'PR fermée' }] })
  expect(isHidden(s, undefined, now)).toBe(true)
})
test('isHidden : fermée avec PR mergée cachée, sinon visible', () => {
  const s = mk({ step: 'fermée', prUrl: url, createdAt: '2026-10-01T00:00:00Z' })
  expect(isHidden(s, merged, now)).toBe(true)
  expect(isHidden(s, open, now)).toBe(false)
  expect(isHidden(s, undefined, now)).toBe(false)
})
test('isHidden : mission active jamais cachée', () => {
  expect(isHidden(mk({ step: 'tasks' }), merged, now)).toBe(false)
})

test('sortMissions : décision, bloquée, active, terminée, puis createdAt décroissant', () => {
  const list = [
    mk({ id: 'a', step: 'fermée', createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'b', step: 'tasks', createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'c', step: 'bloquée', createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'd', step: 'plan', gates: [gate('g1')], createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'e', step: 'tasks', createdAt: '2026-11-03T00:00:00Z' }),
  ]
  expect(sortMissions(list).map((s) => s.id)).toEqual(['d', 'c', 'e', 'b', 'a'])
})

test('projectMissions ignore les autres dépôts et les états illisibles', async () => {
  await saveState(mk({ id: 'm1', repoPath: '/r' }))
  await saveState(mk({ id: 'm2', repoPath: '/autre' }))
  await mkdir(missionDir('m3'), { recursive: true })
  await writeFile(join(missionDir('m3'), 'state.json'), '{pas du json')
  await mkdir(missionDir('m4'), { recursive: true })
  expect((await projectMissions('/r')).map((s) => s.id)).toEqual(['m1'])
})
test('projectMissions : aucun dossier -> liste vide', async () => {
  expect(await projectMissions('/r')).toEqual([])
})
