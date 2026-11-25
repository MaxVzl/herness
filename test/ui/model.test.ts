import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import {
  bucketOf, isHidden, needsPrRefresh, projectMissions, shortId, sortMissions, statusLabel, type PrInfo,
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

test('bucketOf: pending gate -> decision, even when blocked', () => {
  expect(bucketOf(mk({ step: 'plan', gates: [gate('g1')] }))).toBe('decision')
  expect(bucketOf(mk({ step: 'blocked', gates: [gate('g1')] }))).toBe('decision')
})
test('bucketOf: blocked', () => expect(bucketOf(mk({ step: 'blocked' }))).toBe('blocked'))
test('bucketOf: pr-open and closed -> finished', () => {
  expect(bucketOf(mk({ step: 'pr-open' }))).toBe('finished')
  expect(bucketOf(mk({ step: 'closed' }))).toBe('finished')
})
test('bucketOf: active otherwise', () => {
  expect(bucketOf(mk({ step: 'tasks', gates: [gate('g1', 'approved')] }))).toBe('active')
})

test('shortId', () => {
  expect(shortId('20261102-4')).toBe('02-4')
  expect(shortId('T-1')).toBe('T-1')
})

test('statusLabel', () => {
  expect(statusLabel(mk({ step: 'plan', gates: [gate('g3')] }))).toBe('gate g3')
  expect(statusLabel(mk({ step: 'blocked' }))).toBe('blocked')
  const t = (n: number, phase: 'done' | 'pending'): MissionState['tasks'][number] => ({ n, title: 't', testCommand: 'x', phase, round: 0 })
  expect(statusLabel(mk({ step: 'tasks', tasks: [t(1, 'done'), t(2, 'pending'), t(3, 'pending')] }))).toBe('task 2/3')
  expect(statusLabel(mk({ step: 'preflight' }))).toBe('preflight')
  expect(statusLabel(mk({ step: 'pr-open', prUrl: 'https://github.com/o/r/pull/1513' }))).toBe('PR #1513')
  expect(statusLabel(mk({ step: 'closed' }))).toBe('closed')
})

const merged: PrInfo = { state: 'MERGED', checkedAt: now.toISOString() }
const open: PrInfo = { state: 'OPEN', checkedAt: now.toISOString() }
const url = 'https://github.com/o/r/pull/1'

test('isHidden: merged pr-open is hidden, open pr-open is visible', () => {
  expect(isHidden(mk({ step: 'pr-open', prUrl: url }), merged, now)).toBe(true)
  expect(isHidden(mk({ step: 'pr-open', prUrl: url }), open, now)).toBe(false)
  expect(isHidden(mk({ step: 'pr-open', prUrl: url }), undefined, now)).toBe(false)
})
test('isHidden: closed without a PR for 8 days is hidden, for 2 days is visible', () => {
  const closed = (at: string): MissionState => mk({ step: 'closed', createdAt: '2026-10-01T00:00:00Z', log: [{ at, msg: 'mission closed' }] })
  expect(isHidden(closed('2026-11-02T12:00:00Z'), undefined, now)).toBe(true)
  expect(isHidden(closed('2026-11-08T12:00:00Z'), undefined, now)).toBe(false)
})
test('isHidden: closed without a close log uses createdAt', () => {
  expect(isHidden(mk({ step: 'closed', createdAt: '2026-10-01T00:00:00Z' }), undefined, now)).toBe(true)
})
test('isHidden: a PR closed log does not count as closing the mission', () => {
  const s = mk({ step: 'closed', createdAt: '2026-10-01T00:00:00Z', log: [{ at: '2026-11-09T00:00:00Z', msg: 'PR closed' }] })
  expect(isHidden(s, undefined, now)).toBe(true)
})
test('isHidden: closed with a merged PR is hidden, otherwise visible', () => {
  const s = mk({ step: 'closed', prUrl: url, createdAt: '2026-10-01T00:00:00Z' })
  expect(isHidden(s, merged, now)).toBe(true)
  expect(isHidden(s, open, now)).toBe(false)
  expect(isHidden(s, undefined, now)).toBe(false)
})
const closedPr: PrInfo = { state: 'CLOSED', checkedAt: now.toISOString() }
test('isHidden: closed with a CLOSED PR follows the 7-day rule from close time', () => {
  const closed = (at: string): MissionState =>
    mk({ step: 'closed', prUrl: url, createdAt: '2026-10-01T00:00:00Z', log: [{ at, msg: 'mission fermée (herness fermer)' }] })
  expect(isHidden(closed('2026-11-02T12:00:00Z'), closedPr, now)).toBe(true)
  expect(isHidden(closed('2026-11-08T12:00:00Z'), closedPr, now)).toBe(false)
})
test('isHidden: pr-open with a CLOSED PR stays visible (needs attention)', () => {
  expect(isHidden(mk({ step: 'pr-open', prUrl: url, createdAt: '2026-10-01T00:00:00Z' }), closedPr, now)).toBe(false)
})
test('needsPrRefresh: not a merged PR, nor a CLOSED PR of a mission closed for more than 7 days', () => {
  const closed = (at: string): MissionState =>
    mk({ step: 'closed', prUrl: url, createdAt: '2026-10-01T00:00:00Z', log: [{ at, msg: 'mission closed' }] })
  expect(needsPrRefresh(mk({ step: 'tasks' }), undefined, now)).toBe(false)
  expect(needsPrRefresh(mk({ step: 'pr-open', prUrl: url }), undefined, now)).toBe(true)
  expect(needsPrRefresh(mk({ step: 'pr-open', prUrl: url }), open, now)).toBe(true)
  expect(needsPrRefresh(mk({ step: 'pr-open', prUrl: url }), merged, now)).toBe(false)
  expect(needsPrRefresh(mk({ step: 'pr-open', prUrl: url, createdAt: '2026-10-01T00:00:00Z' }), closedPr, now)).toBe(true)
  expect(needsPrRefresh(closed('2026-11-08T12:00:00Z'), closedPr, now)).toBe(true)
  expect(needsPrRefresh(closed('2026-11-02T12:00:00Z'), closedPr, now)).toBe(false)
})
test('isHidden: an active mission is never hidden', () => {
  expect(isHidden(mk({ step: 'tasks' }), merged, now)).toBe(false)
})

test('sortMissions: decision, blocked, active, finished, then createdAt descending', () => {
  const list = [
    mk({ id: 'a', step: 'closed', createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'b', step: 'tasks', createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'c', step: 'blocked', createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'd', step: 'plan', gates: [gate('g1')], createdAt: '2026-11-01T00:00:00Z' }),
    mk({ id: 'e', step: 'tasks', createdAt: '2026-11-03T00:00:00Z' }),
  ]
  expect(sortMissions(list).map((s) => s.id)).toEqual(['d', 'c', 'e', 'b', 'a'])
})

test('projectMissions ignores other repos and unreadable states', async () => {
  await saveState(mk({ id: 'm1', repoPath: '/r' }))
  await saveState(mk({ id: 'm2', repoPath: '/other' }))
  await mkdir(missionDir('m3'), { recursive: true })
  await writeFile(join(missionDir('m3'), 'state.json'), '{not json')
  await mkdir(missionDir('m4'), { recursive: true })
  expect((await projectMissions('/r')).map((s) => s.id)).toEqual(['m1'])
})
test('projectMissions: no directory -> empty list', async () => {
  expect(await projectMissions('/r')).toEqual([])
})
