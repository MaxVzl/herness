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
  if (value === undefined) throw new Error(`élément ${index} absent`)
  return value
}

test('découpe deux entrées et lit leur en-tête', async () => {
  await logHernessError({ mission: 'm1', origin: 'moteur', step: 'tasks' }, new Error('boum'))
  await logHernessError({ origin: 'lancement du moteur' }, 'texte')
  const entries = parseErrorLog(await readLog())
  expect(entries).toHaveLength(2)
  const first = item(entries, 0)
  const second = item(entries, 1)
  expect(first).toMatchObject({ mission: 'm1', origin: 'moteur', step: 'tasks', version: VERSION })
  expect(first.body.startsWith('Error: boum')).toBe(true)
  expect(second.mission).toBeUndefined()
  expect(second.step).toBeUndefined()
  expect(second.body).toBe('texte')
})

test('un corps avec lignes vides et cause reste une seule entrée', async () => {
  await logHernessError({ origin: 'moteur' }, new Error('haut', { cause: new Error('bas') }))
  await logHernessError({ mission: 'm1', origin: "signalement de l'orchestrateur" }, 'ligne 1\n\nligne 3')
  const entries = parseErrorLog(await readLog())
  expect(entries).toHaveLength(2)
  expect(item(entries, 0).body).toContain('cause :')
  expect(item(entries, 0).body).toContain('Error: bas')
  expect(item(entries, 1).body).toBe('ligne 1\n\nligne 3')
})

test("une ligne === illisible ne crée pas d'entrée", () => {
  expect(parseErrorLog("=== n'importe quoi\n")).toEqual([])
})

test('entryHash diffère pour deux entrées identiques à des instants différents', async () => {
  await logHernessError({ origin: 'moteur' }, 'même')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await logHernessError({ origin: 'moteur' }, 'même')
  const entries = parseErrorLog(await readLog())
  expect(entries).toHaveLength(2)
  const first = item(entries, 0)
  const second = item(entries, 1)
  expect(first.raw).not.toBe(second.raw)
  expect(entryHash(first)).toBe(createHash('sha256').update(first.raw).digest('hex'))
  expect(entryHash(first)).not.toBe(entryHash(second))
})

test('la signature ignore étape, version et pile, pas la première ligne', async () => {
  await logHernessError({ origin: 'moteur', step: 'tasks' }, new Error('même'))
  await logHernessError({ origin: 'moteur', step: 'preflight' }, new Error('même'))
  await logHernessError({ origin: 'moteur', step: 'tasks' }, new Error('autre'))
  const entries = parseErrorLog(await readLog())
  const same = item(entries, 0)
  const sameAgain = item(entries, 1)
  const other = item(entries, 2)
  expect(errorSignature(same)).toBe(errorSignature(sameAgain))
  expect(errorSignature(same)).toMatch(/^herness-sig-[0-9a-f]{12}$/)
  expect(errorSignature(same)).not.toBe(errorSignature(other))
})

test('maskHome remplace le dossier personnel', () => {
  expect(maskHome('/home/x/a et /home/x/b', '/home/x')).toBe('~/a et ~/b')
})

test("groupEntries regroupe les répétitions dans l'ordre", async () => {
  await logHernessError({ origin: 'moteur', step: 'un' }, new Error('A'))
  await logHernessError({ origin: 'moteur', step: 'deux' }, new Error('B'))
  await logHernessError({ origin: 'moteur', step: 'trois' }, new Error('A'))
  const groups = groupEntries(parseErrorLog(await readLog()))
  expect(groups).toHaveLength(2)
  expect(item(groups, 0).entries.map((e) => e.step)).toEqual(['un', 'trois'])
  expect(item(groups, 1).entries.map((e) => e.step)).toEqual(['deux'])
})

test('titre tronqué à 120 caractères', async () => {
  await logHernessError({ origin: 'moteur' }, 'm'.repeat(300))
  const title = issueTitle(item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(title).toHaveLength(120)
  expect(title.endsWith('…')).toBe(true)
  expect(title.startsWith('[erreur herness] moteur : ')).toBe(true)
})

test("corps d'issue", async () => {
  const perso = '/home/alice'
  await logHernessError({ mission: 'm1', origin: 'moteur', step: 'tasks' }, `boom ${perso}/fichier`)
  await logHernessError({ mission: 'm1', origin: 'moteur', step: 'preflight' }, `boom ${perso}/fichier`)
  const group = item(groupEntries(parseErrorLog(await readLog()), perso), 0)
  const body = issueBody('m1', group, perso)
  expect(body).toContain('Remontée automatiquement par `herness report` (mission m1).')
  expect(body).toContain('- Origine : moteur (étape tasks, preflight)')
  expect(body).toContain('- Vue 2 fois dans la mission : ')
  expect(body).toContain('- Signature : herness-sig-')
  expect(body).toContain('```\nboom ~/fichier\n```')
  expect(body).not.toContain(perso)
})

test('clôture plus longue que les accents graves du corps', async () => {
  await logHernessError({ mission: 'm1', origin: 'moteur' }, 'avant\n```\naprès')
  const body = issueBody('m1', item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(body).toContain('````\navant\n```\naprès\n````')
})

test('corps tronqué au-delà de 60 000 caractères', async () => {
  await logHernessError({ mission: 'm1', origin: 'moteur' }, 'y'.repeat(70_000))
  const body = issueBody('m1', item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(body).toContain('(tronqué)')
  expect(body.length).toBeLessThan(61_000)
})

test('corps de commentaire', async () => {
  await logHernessError({ mission: 'm2', origin: 'moteur' }, 'détail')
  const body = commentBody('m2', item(groupEntries(parseErrorLog(await readLog())), 0))
  expect(body.startsWith('Revue dans la mission m2.')).toBe(true)
  expect(body).not.toContain('Signature')
})
