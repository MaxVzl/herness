import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { errorLogPath, installProcessErrorLog, logHernessError, withErrorLog, type ErrorProcess } from '../src/errlog.ts'
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

const version = VERSION.replaceAll('.', '\\.')

test('errorLogPath is <HERNESS_HOME>/errors.log', () => {
  expect(errorLogPath()).toBe(join(home, 'errors.log'))
})

test('logHernessError writes to errors.log with a (step X) header', async () => {
  await logHernessError({ mission: 'T-1', origin: 'moteur', step: 'tasks' }, new Error('boum'))
  const text = await readFile(join(home, 'errors.log'), 'utf8')
  expect(text).toMatch(/· moteur \(step tasks\)$/m)
  expect(text).toContain('Error: boum')
})

test('an Error gets a full header and its stack', async () => {
  await logHernessError({ mission: 'T-1', origin: 'moteur', step: 'tasks' }, new Error('boum'))
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toMatch(
    new RegExp(
      `^=== \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z · mission T-1 · herness ${version} · moteur \\(step tasks\\)$`,
      'm',
    ),
  )
  expect(text).toContain('Error: boum')
  expect(text).toMatch(/^ {4}at /m)
})

test('without a mission or a step, those segments are omitted', async () => {
  await logHernessError({ origin: 'lancement du moteur' }, 'incident')
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toMatch(new RegExp(`· herness ${version} · lancement du moteur$`, 'm'))
  expect(text).not.toContain('mission')
  expect(text).not.toContain('step')
})

test("a value that is not an Error is written as-is", async () => {
  await logHernessError({ origin: 'x' }, 'texte libre')
  expect(await readFile(errorLogPath(), 'utf8')).toContain('texte libre')
  await rm(errorLogPath())
  await logHernessError({ origin: 'x' }, 42)
  expect(await readFile(errorLogPath(), 'utf8')).toContain('42')
})

test("an Error cause is appended", async () => {
  await logHernessError({ origin: 'x' }, new Error('haut', { cause: new Error('bas') }))
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toContain('cause:')
  expect(text).toContain('Error: bas')
})

test('a cyclic cause chain is written only once', async () => {
  const haut = new Error('haut')
  const bas = new Error('bas')
  haut.cause = bas
  bas.cause = haut
  await expect(logHernessError({ origin: 'x' }, haut)).resolves.toBe(true)
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text.match(/Error: haut/g)).toHaveLength(1)
  expect(text.match(/Error: bas/g)).toHaveLength(1)
})

test("two entries are appended, separated by a blank line", async () => {
  await logHernessError({ origin: 'a' }, 'un')
  await logHernessError({ origin: 'b' }, 'deux')
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text.match(/^=== /gm)).toHaveLength(2)
  expect(text).toContain('\n\n=== ')
})

test("never writes to stdout", async () => {
  const log = vi.spyOn(console, 'log')
  const write = vi.spyOn(process.stdout, 'write')
  await logHernessError({ origin: 'x' }, new Error('e'))
  expect(log).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  log.mockRestore()
  write.mockRestore()
})

test('never throws when the log is unavailable', async () => {
  const file = join(home, 'pas-un-dossier')
  await writeFile(file, 'x')
  process.env.HERNESS_HOME = file
  await expect(logHernessError({ origin: 'x' }, new Error('e'))).resolves.toBe(false)
})

test("reports that the entry was written", async () => {
  await expect(logHernessError({ origin: 'x' }, 'ok')).resolves.toBe(true)
  expect(await readFile(errorLogPath(), 'utf8')).toContain('ok')
})

test('withErrorLog returns the result without writing anything', async () => {
  await expect(withErrorLog({ origin: 'x' }, async () => 7)).resolves.toBe(7)
  expect(existsSync(errorLogPath())).toBe(false)
})

test('withErrorLog logs then rethrows the same error', async () => {
  const boom = new Error('unreadable state')
  await expect(
    withErrorLog({ mission: 'T-1', origin: 'lancement du moteur' }, async () => {
      throw boom
    }),
  ).rejects.toBe(boom)
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toContain('· mission T-1 · herness ')
  expect(text).toContain('· lancement du moteur')
  expect(text).toContain('unreadable state')
})

test("the process listener does not write an error already logged by withErrorLog", async () => {
  const listeners = new Map<'uncaughtException' | 'unhandledRejection', (err: unknown) => Promise<void>>()
  const exit = vi.fn()
  const proc: ErrorProcess = {
    on(event, listener) {
      listeners.set(event, listener)
    },
    exit,
  }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const boom = new Error('unreadable state')
  installProcessErrorLog({ mission: 'T-1', origin: 'engine: uncaught error' }, proc)
  await expect(
    withErrorLog({ mission: 'T-1', origin: 'lancement du moteur' }, async () => {
      throw boom
    }),
  ).rejects.toBe(boom)
  await listeners.get('uncaughtException')!(boom)
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text.match(/^=== /gm)).toHaveLength(1)
  expect(text).toContain('lancement du moteur')
  expect(text).not.toContain('uncaught error')
  expect(exit).toHaveBeenCalledWith(1)
  expect(error).toHaveBeenCalled()
  error.mockRestore()
})

test('installProcessErrorLog logs then exits with code 1', async () => {
  const listeners = new Map<'uncaughtException' | 'unhandledRejection', (err: unknown) => Promise<void>>()
  let wrote = false
  const exit = vi.fn(() => {
    wrote = existsSync(errorLogPath())
  })
  const proc: ErrorProcess = {
    on(event, listener) {
      listeners.set(event, listener)
    },
    exit,
  }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  installProcessErrorLog({ mission: 'T-1', origin: 'MCP server: uncaught error' }, proc)
  expect(listeners.has('uncaughtException')).toBe(true)
  expect(listeners.has('unhandledRejection')).toBe(true)
  await listeners.get('unhandledRejection')!(new Error('promesse perdue'))
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toContain('· MCP server: uncaught error')
  expect(text).toContain('promesse perdue')
  expect(exit).toHaveBeenCalledWith(1)
  expect(wrote).toBe(true)
  error.mockRestore()
})
