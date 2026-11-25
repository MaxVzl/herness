import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { RunResult } from '../../src/exec.ts'
import { PrCache } from '../../src/ui/pr-cache.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'herness-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const url = 'https://github.com/o/r/pull/7'
const ok = (state: string): RunResult => ({ stdout: JSON.stringify({ state }), stderr: '', exitCode: 0 })

test('PrCache does not call gh again before 5 min', async () => {
  let t = new Date('2026-11-02T10:00:00Z')
  const calls: string[][] = []
  const c = new PrCache(join(dir, 'c.json'), async (_cmd, args) => { calls.push(args); return ok('OPEN') }, () => t)
  await c.refresh([url])
  expect(c.get(url)?.state).toBe('OPEN')
  t = new Date('2026-11-02T10:04:00Z')
  await c.refresh([url])
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual(['pr', 'view', url, '--json', 'state'])
  t = new Date('2026-11-02T10:06:00Z')
  await c.refresh([url])
  expect(calls).toHaveLength(2)
})

test('PrCache keeps the previous value when gh fails', async () => {
  let t = new Date('2026-11-02T10:00:00Z')
  let fail = false
  const c = new PrCache(join(dir, 'c.json'), async () => { if (fail) throw new Error('gh missing'); return ok('MERGED') }, () => t)
  await c.refresh([url])
  fail = true
  t = new Date('2026-11-02T11:00:00Z')
  await expect(c.refresh([url])).resolves.toBeUndefined()
  expect(c.get(url)?.state).toBe('MERGED')
})

test('PrCache persists to the file and ignores invalid output', async () => {
  const file = join(dir, 'c.json')
  const t = new Date('2026-11-02T10:00:00Z')
  await new PrCache(file, async () => ok('CLOSED'), () => t).refresh([url])
  const again = new PrCache(file, async () => ({ stdout: 'garbage', stderr: '', exitCode: 0 }), () => new Date('2026-11-02T12:00:00Z'))
  expect(again.get(url)?.state).toBe('CLOSED')
  await again.refresh([url])
  expect(again.get(url)?.state).toBe('CLOSED')
})

test('PrCache: two instances keep each other entries', async () => {
  const file = join(dir, 'c.json')
  const t = () => new Date('2026-11-02T10:00:00Z')
  const u2 = 'https://github.com/o/r/pull/8'
  const a = new PrCache(file, async () => ok('OPEN'), t)
  const b = new PrCache(file, async () => ok('MERGED'), t)
  await a.refresh([url])
  await b.refresh([u2])
  const c = new PrCache(file, async () => ok('OPEN'), t)
  expect(c.get(url)?.state).toBe('OPEN')
  expect(c.get(u2)?.state).toBe('MERGED')
})

test('PrCache does not call gh again before 5 min after a failure', async () => {
  let t = new Date('2026-11-02T10:00:00Z')
  let calls = 0
  const c = new PrCache(join(dir, 'c.json'), async () => { calls++; throw new Error('gh missing') }, () => t)
  await c.refresh([url])
  t = new Date('2026-11-02T10:00:01Z')
  await c.refresh([url])
  t = new Date('2026-11-02T10:04:00Z')
  await c.refresh([url])
  expect(calls).toBe(1)
  t = new Date('2026-11-02T10:05:01Z')
  await c.refresh([url])
  expect(calls).toBe(2)
  expect(c.get(url)).toBeUndefined()
})

test('PrCache: invalid output also counts as an attempt', async () => {
  let t = new Date('2026-11-02T10:00:00Z')
  let calls = 0
  const c = new PrCache(join(dir, 'c.json'), async () => { calls++; return { stdout: '', stderr: 'auth', exitCode: 1 } }, () => t)
  await c.refresh([url])
  t = new Date('2026-11-02T10:01:00Z')
  await c.refresh([url])
  expect(calls).toBe(1)
})
