import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import { nextFreeTextId, parseRequest } from '../../src/mission/ids.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

test('Wrike link with an id', () => {
  const ref = 'https://www.wrike.com/open.htm?id=1234567890'
  expect(parseRequest(ref)).toEqual({ kind: 'wrike', id: '1234567890', ref })
})

test('Wrike link without an id throws', () => {
  expect(() => parseRequest('https://www.wrike.com/open.htm')).toThrow('Wrike link without an id')
})

test('issue GitHub', () => {
  const ref = 'https://github.com/demo/projet/issues/42'
  expect(parseRequest(ref)).toEqual({ kind: 'github', id: 'gh42', number: 42, ref })
})

test('free text', () => {
  expect(parseRequest('corrige le bouton export')).toEqual({ kind: 'text', ref: 'corrige le bouton export' })
})

test('nextFreeTextId increments from existing directories', async () => {
  const d = new Date('2026-10-29')
  expect(await nextFreeTextId(d)).toBe('20261029-1')
  await mkdir(missionDir('20261029-1'), { recursive: true })
  expect(await nextFreeTextId(d)).toBe('20261029-2')
})
