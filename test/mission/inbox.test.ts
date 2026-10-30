import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import { drainInbox, postInbox } from '../../src/mission/inbox.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

test('drainInbox rend les messages dans l\'ordre de dépôt et vide la boîte', async () => {
  await postInbox('T-1', { type: 'pause' })
  await new Promise((r) => setTimeout(r, 5))
  await postInbox('T-1', { type: 'resume' })
  await new Promise((r) => setTimeout(r, 5))
  await postInbox('T-1', { type: 'abandon', reason: 'x' })
  const msgs = await drainInbox('T-1')
  expect(msgs.map((m) => m.type)).toEqual(['pause', 'resume', 'abandon'])
  expect(await drainInbox('T-1')).toEqual([])
  expect((await readdir(join(missionDir('T-1'), 'inbox'))).filter((f) => f.endsWith('.json'))).toEqual([])
})

test('drainInbox déplace un JSON invalide ou de type inconnu dans inbox/rejected et rend les autres', async () => {
  await postInbox('T-1', { type: 'pause' })
  const dir = join(missionDir('T-1'), 'inbox')
  await writeFile(join(dir, '1-bad.json'), '{pas du json')
  await writeFile(join(dir, '2-unknown.json'), JSON.stringify({ type: 'inconnu' }))
  const msgs = await drainInbox('T-1')
  expect(msgs).toEqual([{ type: 'pause' }])
  expect((await readdir(join(dir, 'rejected'))).sort()).toEqual(['1-bad.json', '2-unknown.json'])
})

test('drainInbox rend dans l\'ordre de dépôt des messages postés dans la même milliseconde', async () => {
  for (let i = 0; i < 50; i++) await postInbox('T-1', { type: 'abandon', reason: String(i) })
  const msgs = await drainInbox('T-1')
  expect(msgs.map((m) => (m.type === 'abandon' ? m.reason : ''))).toEqual(Array.from({ length: 50 }, (_, i) => String(i)))
})
