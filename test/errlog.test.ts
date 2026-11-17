import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { errorLogPath, logHernessError } from '../src/errlog.ts'
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

test('errorLogPath vaut <HERNESS_HOME>/erreurs.log', () => {
  expect(errorLogPath()).toBe(join(home, 'erreurs.log'))
})

test('une Error donne un en-tête complet et sa pile', async () => {
  await logHernessError({ mission: 'T-1', origin: 'moteur', step: 'tasks' }, new Error('boum'))
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toMatch(
    new RegExp(
      `^=== \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z · mission T-1 · herness ${version} · moteur \\(étape tasks\\)$`,
      'm',
    ),
  )
  expect(text).toContain('Error: boum')
  expect(text).toMatch(/^ {4}at /m)
})

test('sans mission ni étape, les segments sont omis', async () => {
  await logHernessError({ origin: 'lancement du moteur' }, 'incident')
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toMatch(new RegExp(`· herness ${version} · lancement du moteur$`, 'm'))
  expect(text).not.toContain('mission')
  expect(text).not.toContain('étape')
})

test("une valeur qui n'est pas une Error est écrite telle quelle", async () => {
  await logHernessError({ origin: 'x' }, 'texte libre')
  expect(await readFile(errorLogPath(), 'utf8')).toContain('texte libre')
  await rm(errorLogPath())
  await logHernessError({ origin: 'x' }, 42)
  expect(await readFile(errorLogPath(), 'utf8')).toContain('42')
})

test("la cause d'une Error est ajoutée", async () => {
  await logHernessError({ origin: 'x' }, new Error('haut', { cause: new Error('bas') }))
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text).toContain('cause :')
  expect(text).toContain('Error: bas')
})

test("deux entrées s'ajoutent, séparées par une ligne vide", async () => {
  await logHernessError({ origin: 'a' }, 'un')
  await logHernessError({ origin: 'b' }, 'deux')
  const text = await readFile(errorLogPath(), 'utf8')
  expect(text.match(/^=== /gm)).toHaveLength(2)
  expect(text).toContain('\n\n=== ')
})

test("n'écrit jamais sur stdout", async () => {
  const log = vi.spyOn(console, 'log')
  const write = vi.spyOn(process.stdout, 'write')
  await logHernessError({ origin: 'x' }, new Error('e'))
  expect(log).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  log.mockRestore()
  write.mockRestore()
})

test('ne lève jamais quand le journal est inaccessible', async () => {
  const file = join(home, 'pas-un-dossier')
  await writeFile(file, 'x')
  process.env.HERNESS_HOME = file
  await expect(logHernessError({ origin: 'x' }, new Error('e'))).resolves.toBeUndefined()
})
