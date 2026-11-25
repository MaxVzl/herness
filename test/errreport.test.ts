import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { errorLogPath, logHernessError } from '../src/errlog.ts'
import {
  commentBody,
  entryHash,
  errorSignature,
  groupEntries,
  issueBody,
  issueTitle,
  maskHome,
  parseErrorLog,
} from '../src/errreport.ts'
import { VERSION } from '../src/version.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

async function readLog(): Promise<string> {
  return readFile(errorLogPath(), 'utf8')
}

function item<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`item ${index} missing`)
  return value
}

test('parseErrorLog reads both a legacy step header and a (step X) header', () => {
  const text = [
    '=== 2026-01-01T00:00:00.000Z · mission m1 · herness 1.0.0 · moteur (étape tasks)',
    'ancien',
    '',
    '=== 2026-01-02T00:00:00.000Z · mission m1 · herness 1.0.0 · engine (step preflight)',
    'new',
    '',
  ].join('\n')
  const entries = parseErrorLog(text)
  expect(entries.map((e) => ({ origin: e.origin, step: e.step, body: e.body }))).toEqual([
    { origin: 'moteur', step: 'tasks', body: 'ancien' },
    { origin: 'engine', step: 'preflight', body: 'new' },
  ])
})

test('splits two entries and reads their header', async () => {
  await logHernessError({ mission: 'm1', origin: 'engine', step: 'tasks' }, new Error('boom'))
  await logHernessError({ origin: 'engine startup' }, 'text')
  const entries = parseErrorLog(await readLog())
  expect(entries).toHaveLength(2)
  const first = item(entries, 0)
  const second = item(entries, 1)
  expect(first).toMatchObject({ mission: 'm1', origin: 'engine', step: 'tasks', version: VERSION })
  expect(first.body.startsWith('Error: boom')).toBe(true)
  expect(second.mission).toBeUndefined()
  expect(second.step).toBeUndefined()
  expect(second.body).toBe('text')
})

test('a body with blank lines and a cause stays a single entry', async () => {
  await logHernessError({ origin: 'engine' }, new Error('top', { cause: new Error('bottom') }))
  await logHernessError({ mission: 'm1', origin: 'orchestrator anomaly report' }, 'line 1\n\nline 3')
  const entries = parseErrorLog(await readLog())
  expect(entries).toHaveLength(2)
  expect(item(entries, 0).body).toContain('cause:')
  expect(item(entries, 0).body).toContain('Error: bottom')
  expect(item(entries, 1).body).toBe('line 1\n\nline 3')
})

test("an unreadable === line does not create an entry", () => {
  expect(parseErrorLog('=== not a header\n')).toEqual([])
})

test('entryHash differs for two identical entries at different times', async () => {
  await logHernessError({ origin: 'engine' }, 'same')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await logHernessError({ origin: 'engine' }, 'same')
  const entries = parseErrorLog(await readLog())
  expect(entries).toHaveLength(2)
  const first = item(entries, 0)
  const second = item(entries, 1)
  expect(first.raw).not.toBe(second.raw)
  expect(entryHash(first)).toBe(createHash('sha256').update(first.raw).digest('hex'))
  expect(entryHash(first)).not.toBe(entryHash(second))
})

test('the signature ignores step, version and stack, not the first line', async () => {
  await logHernessError({ origin: 'engine', step: 'tasks' }, new Error('same'))
  await logHernessError({ origin: 'engine', step: 'preflight' }, new Error('same'))
  await logHernessError({ origin: 'engine', step: 'tasks' }, new Error('other'))
  const entries = parseErrorLog(await readLog())
  const same = item(entries, 0)
  const sameAgain = item(entries, 1)
  const other = item(entries, 2)
  expect(errorSignature(same)).toBe(errorSignature(sameAgain))
  expect(errorSignature(same)).toMatch(/^herness-sig-[0-9a-f]{12}$/)
  expect(errorSignature(same)).not.toBe(errorSignature(other))
})

test('maskHome replaces the home directory', () => {
  expect(maskHome('/home/x/a and /home/x/b', '/home/x')).toBe('~/a and ~/b')
})

test("groupEntries groups repeats in order", async () => {
  await logHernessError({ origin: 'engine', step: 'one' }, new Error('A'))
  await logHernessError({ origin: 'engine', step: 'two' }, new Error('B'))
  await logHernessError({ origin: 'engine', step: 'three' }, new Error('A'))
  const groups = groupEntries(parseErrorLog(await readLog()))
  expect(groups).toHaveLength(2)
  expect(item(groups, 0).entries.map((e) => e.step)).toEqual(['one', 'three'])
  expect(item(groups, 1).entries.map((e) => e.step)).toEqual(['two'])
})

test('title truncated to 120 characters', async () => {
  await logHernessError({ origin: 'engine' }, 'm'.repeat(300))
  const title = issueTitle(item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(title).toHaveLength(120)
  expect(title.endsWith('…')).toBe(true)
  expect(title.startsWith('[herness error] engine: ')).toBe(true)
})

test("issue body", async () => {
  const perso = '/home/alice'
  await logHernessError({ mission: 'm1', origin: 'engine', step: 'tasks' }, `boom ${perso}/file`)
  await logHernessError({ mission: 'm1', origin: 'engine', step: 'preflight' }, `boom ${perso}/file`)
  const group = item(groupEntries(parseErrorLog(await readLog()), perso), 0)
  const body = issueBody('m1', group, perso)
  expect(body).toContain('Filed automatically by `herness report` (mission m1).')
  expect(body).toContain('- Origin: engine (step tasks, preflight)')
  expect(body).toContain('- Seen 2 times in the mission: ')
  expect(body).toContain('- Signature: herness-sig-')
  expect(body).toContain('```\nboom ~/file\n```')
  expect(body).not.toContain(perso)
})

test('fence longer than the backticks in the body', async () => {
  await logHernessError({ mission: 'm1', origin: 'engine' }, 'before\n```\nafter')
  const body = issueBody('m1', item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(body).toContain('````\nbefore\n```\nafter\n````')
})

test('body truncated past 60 000 characters', async () => {
  await logHernessError({ mission: 'm1', origin: 'engine' }, 'y'.repeat(70_000))
  const body = issueBody('m1', item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(body).toContain('(truncated)')
  expect(body.length).toBeLessThan(61_000)
})

test('comment body', async () => {
  await logHernessError({ mission: 'm2', origin: 'engine' }, 'detail')
  const body = commentBody('m2', item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(body.startsWith('Seen again in mission m2.')).toBe(true)
  expect(body).not.toContain('Signature')
})
