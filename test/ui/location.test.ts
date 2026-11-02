import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { FakeHerdr } from '../herdr/fake.ts'
import { focusCockpit, openCockpit } from '../../src/ui/location.ts'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herness-'))
  file = join(dir, 'cockpit.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const cfg = { ...demo, repoPath: '/repo/demo' }
const load = async () => cfg

test("openCockpit crée l'onglet herness et lance le cockpit", async () => {
  const h = new FakeHerdr()
  const s = h.seedWorkspace('demo')
  expect(await openCockpit('/repo/demo', h, file, load)).toBe('créé')
  const tab = h.tabs.find((t) => t.label === 'herness')
  expect(tab?.workspaceId).toBe(s.ws)
  expect(h.calls).toContain('tabCreate herness /repo/demo')
  expect(h.runs).toHaveLength(1)
  expect(h.runs[0]?.cmd).toMatch(/^node '.*herness\.js' cockpit$/)
  expect(h.calls).toContain(`tabFocus ${tab?.tabId}`)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved['/repo/demo']).toEqual({ workspace: s.ws, tab: tab?.tabId })
})

test("openCockpit donne le focus à l'onglet existant sans en créer", async () => {
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  await openCockpit('/repo/demo', h, file, load)
  h.calls.length = 0
  h.runs.length = 0
  expect(await openCockpit('/repo/demo', h, file, load)).toBe('ouvert')
  expect(h.calls.some((c) => c.startsWith('tabCreate'))).toBe(false)
  expect(h.runs).toHaveLength(0)
  expect(h.calls.some((c) => c.startsWith('tabFocus'))).toBe(true)
})

test("focusCockpit recrée l'onglet disparu", async () => {
  const h = new FakeHerdr()
  const s = h.seedWorkspace('demo')
  await openCockpit('/repo/demo', h, file, load)
  h.tabs = h.tabs.filter((t) => t.label !== 'herness')
  h.runs.length = 0
  await focusCockpit('/repo/demo', h, file)
  const tab = h.tabs.find((t) => t.label === 'herness')
  expect(tab?.workspaceId).toBe(s.ws)
  expect(h.runs).toHaveLength(1)
  expect(JSON.parse(await readFile(file, 'utf8'))['/repo/demo'].tab).toBe(tab?.tabId)
})

test("focusCockpit donne le focus à l'onglet enregistré", async () => {
  const h = new FakeHerdr()
  const s = h.seedWorkspace('demo')
  await openCockpit('/repo/demo', h, file, load)
  h.calls.length = 0
  await focusCockpit('/repo/demo', h, file)
  expect(h.calls).toContain(`workspaceFocus ${s.ws}`)
  expect(h.calls.some((c) => c.startsWith('tabCreate'))).toBe(false)
})

test('focusCockpit sans enregistrement rend le message', async () => {
  await expect(focusCockpit('/repo/demo', new FakeHerdr(), file)).rejects.toThrow(
    'aucun cockpit pour ce projet : lance herness dans l\'espace du projet',
  )
})

test('fichier cockpit.json invalide : traité comme vide', async () => {
  await writeFile(file, '{pas du json')
  await expect(focusCockpit('/repo/demo', new FakeHerdr(), file)).rejects.toThrow('aucun cockpit')
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  expect(await openCockpit('/repo/demo', h, file, load)).toBe('créé')
})
