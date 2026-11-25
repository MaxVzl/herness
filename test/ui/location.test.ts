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

test("openCockpit creates the herness tab and starts the cockpit", async () => {
  const h = new FakeHerdr()
  const s = h.seedWorkspace('demo')
  expect(await openCockpit('/repo/demo', h, file, load)).toBe('created')
  const tab = h.tabs.find((t) => t.label === 'herness')
  expect(tab?.workspaceId).toBe(s.ws)
  expect(h.calls).toContain('tabCreate herness /repo/demo')
  expect(h.runs).toHaveLength(1)
  expect(h.runs[0]?.cmd).toMatch(/^node '.*herness\.js' cockpit$/)
  expect(h.calls).toContain(`tabFocus ${tab?.tabId}`)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved['/repo/demo']).toEqual({ workspace: s.ws, tab: tab?.tabId })
})

test("openCockpit focuses the existing tab without creating one", async () => {
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  await openCockpit('/repo/demo', h, file, load)
  h.calls.length = 0
  h.runs.length = 0
  expect(await openCockpit('/repo/demo', h, file, load)).toBe('opened')
  expect(h.calls.some((c) => c.startsWith('tabCreate'))).toBe(false)
  expect(h.runs).toHaveLength(0)
  expect(h.calls.some((c) => c.startsWith('tabFocus'))).toBe(true)
})

test("focusCockpit recreates a missing tab", async () => {
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

test("focusCockpit focuses the recorded tab", async () => {
  const h = new FakeHerdr()
  const s = h.seedWorkspace('demo')
  await openCockpit('/repo/demo', h, file, load)
  h.calls.length = 0
  await focusCockpit('/repo/demo', h, file)
  expect(h.calls).toContain(`workspaceFocus ${s.ws}`)
  expect(h.calls.some((c) => c.startsWith('tabCreate'))).toBe(false)
})

test('focusCockpit without a record returns the message', async () => {
  await expect(focusCockpit('/repo/demo', new FakeHerdr(), file)).rejects.toThrow(
    'no cockpit for this project: run herness in the project workspace',
  )
})

test('invalid cockpit.json file: treated as empty', async () => {
  await writeFile(file, '{not json')
  await expect(focusCockpit('/repo/demo', new FakeHerdr(), file)).rejects.toThrow('no cockpit')
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  expect(await openCockpit('/repo/demo', h, file, load)).toBe('created')
})

test('focusCockpit: recorded workspace gone -> clear message', async () => {
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  await openCockpit('/repo/demo', h, file, load)
  h.tabList = async () => { throw new Error('workspace not found') }
  h.workspaceFocus = async () => { throw new Error('workspace not found') }
  await expect(focusCockpit('/repo/demo', h, file)).rejects.toThrow(
    "cockpit not found: run herness again in the project workspace",
  )
})

test('createTab: paneRun failure closes the new tab', async () => {
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  h.paneRun = async () => { throw new Error('boom') }
  await expect(openCockpit('/repo/demo', h, file, load)).rejects.toThrow('boom')
  expect(h.tabs.some((t) => t.label === 'herness')).toBe(false)
  expect(h.calls.some((c) => c.startsWith('tabClose'))).toBe(true)
})
