import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import { loadState, newState, saveState } from '../../src/mission/state.ts'

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
