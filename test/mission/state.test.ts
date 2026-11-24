import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import {
  assertResumable,
  isLegacy,
  LegacyMissionError,
  loadState,
  migrateLegacy,
  newState,
  saveState,
} from '../../src/mission/state.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const init = {
  id: 'T-1',
  source: { kind: 'text' as const, ref: 'faire un truc' },
  project: 'demo',
  repoPath: '/tmp/repo',
}

test('saveState puis loadState rend un état identique', async () => {
  const s = newState(init)
  s.tasks.push({ n: 1, title: 'a', testCommand: 'pnpm test', phase: 'pending', round: 0 })
  await saveState(s)
  expect(await loadState('T-1')).toEqual(s)
  expect(s.step).toBe('env')
  expect(typeof s.createdAt).toBe('string')
})

test("saveState n'abîme pas l'état existant si l'écriture échoue", async () => {
  const s = newState(init)
  await saveState(s)
  const tmp = join(missionDir('T-1'), 'state.json.tmp')
  await writeFile(tmp, '')
  await chmod(tmp, 0o444)
  await expect(saveState({ ...s, step: 'spec' })).rejects.toThrow()
  expect((await loadState('T-1')).step).toBe('env')
})

test('loadState rejette un état qui ne respecte pas le schéma', async () => {
  await mkdir(missionDir('T-2'), { recursive: true })
  await writeFile(join(missionDir('T-2'), 'state.json'), JSON.stringify({ id: 'T-2', step: 'nope' }))
  await expect(loadState('T-2')).rejects.toThrow()
})

test('migrateLegacy translates French steps, blockedFrom, gate kinds and statuses', () => {
  const raw = {
    step: 'bloquée',
    blockedFrom: 'pr-ouverte',
    gates: [
      { kind: 'agent-arret', status: 'caduque' },
      { kind: 'reprise-bloquee', status: 'pending' },
    ],
  }
  expect(migrateLegacy(raw)).toEqual({
    step: 'blocked',
    blockedFrom: 'pr-open',
    gates: [
      { kind: 'agent-stopped', status: 'obsolete' },
      { kind: 'resume-blocked', status: 'pending' },
    ],
  })
  expect(raw.step).toBe('bloquée')

  expect(migrateLegacy({ step: 'fermée' })).toEqual({ step: 'closed' })
  expect(migrateLegacy({ step: 'pr-ouverte' })).toEqual({ step: 'pr-open' })
  expect(migrateLegacy({ blockedFrom: 'fermée' })).toEqual({ blockedFrom: 'closed' })
  expect(migrateLegacy({ blockedFrom: 'bloquée' })).toEqual({ blockedFrom: 'blocked' })
  expect(migrateLegacy({ blockedFrom: 'pr-ouverte' })).toEqual({ blockedFrom: 'pr-open' })
  expect(migrateLegacy({
    step: 'tasks',
    blockedFrom: 'prepare',
    gates: [
      { kind: 'amendement', status: 'approved' },
      { kind: 'arbitrage', status: 'refused' },
      { kind: 'pr-malgre-main', status: 'pending' },
      { kind: 'agent-bloque', status: 'pending' },
      { kind: 'spec', status: 'pending' },
      { kind: 'plan', status: 'pending' },
      { kind: 'abandon', status: 'caduque' },
      { kind: 'not-a-kind', status: 'nope' },
    ],
  })).toEqual({
    step: 'tasks',
    blockedFrom: 'prepare',
    gates: [
      { kind: 'amendment', status: 'approved' },
      { kind: 'arbitration', status: 'refused' },
      { kind: 'pr-despite-main', status: 'pending' },
      { kind: 'agent-blocked', status: 'pending' },
      { kind: 'spec', status: 'pending' },
      { kind: 'plan', status: 'pending' },
      { kind: 'abandon', status: 'obsolete' },
      { kind: 'not-a-kind', status: 'nope' },
    ],
  })
  expect(migrateLegacy({ step: 'blocked', blockedFrom: 'pr-open', gates: [{ kind: 'amendment', status: 'obsolete' }] })).toEqual({
    step: 'blocked',
    blockedFrom: 'pr-open',
    gates: [{ kind: 'amendment', status: 'obsolete' }],
  })
})

test('migrateLegacy leaves a format 2 state untouched', () => {
  const raw = { format: 2, step: 'bloquée', gates: [{ kind: 'agent-arret', status: 'caduque' }] }
  expect(migrateLegacy(raw)).toBe(raw)
})

test('loadState reads a legacy state.json', async () => {
  const s = newState(init)
  await saveState(s)
  const file = join(missionDir('T-1'), 'state.json')
  const raw = JSON.parse(await readFile(file, 'utf8')) as { format?: number; step: string }
  delete raw.format
  raw.step = 'fermée'
  await writeFile(file, JSON.stringify(raw))
  const loaded = await loadState('T-1')
  expect(loaded.step).toBe('closed')
  expect(isLegacy(loaded)).toBe(true)
})

test('saveState writes format 2', async () => {
  const s = newState(init)
  delete s.format
  await saveState(s)
  const raw = JSON.parse(await readFile(join(missionDir('T-1'), 'state.json'), 'utf8')) as { format?: number }
  expect(raw.format).toBe(2)
  expect(isLegacy(await loadState('T-1'))).toBe(false)
})

test('assertResumable rejects a running legacy mission and accepts a finished one or format 2', () => {
  const message = (id: string) =>
    `mission ${id} was created by herness 0.8 or earlier and is still running: finish it with that version (herness update --version 0.8.1) or close it (herness close ${id})`

  for (const step of ['tasks', 'blocked'] as const) {
    const s = newState({ ...init, id: 'LEG-1' })
    s.step = step
    delete s.format
    expect(isLegacy(s)).toBe(true)
    expect(() => assertResumable(s)).toThrow(LegacyMissionError)
    try {
      assertResumable(s)
      expect.unreachable('expected LegacyMissionError')
    } catch (e) {
      expect(e).toBeInstanceOf(LegacyMissionError)
      expect((e as Error).message).toBe(message('LEG-1'))
    }
  }

  for (const step of ['pr-open', 'closed'] as const) {
    const s = newState({ ...init, id: 'LEG-1' })
    s.step = step
    delete s.format
    expect(() => assertResumable(s)).not.toThrow()
  }

  const current = newState({ ...init, id: 'CUR-1' })
  current.step = 'tasks'
  expect(isLegacy(current)).toBe(false)
  expect(() => assertResumable(current)).not.toThrow()
})
