import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { fakeEffects } from '../fakes.ts'
import { FakeHerdr } from '../herdr/fake.ts'
import { resumeMission, startMission, type LifecycleDeps } from '../../src/lifecycle.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { loadState, saveState } from '../../src/mission/state.ts'
import { missionMcpConfig } from '../../src/mcp/server.ts'
import { restartDetached, type Spawner } from '../../src/ui/actions.ts'
import { openCockpit } from '../../src/ui/location.ts'

vi.mock('../../src/update.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/update.ts')>()),
  hernessCommand: () => ({ cmd: '/inst/current/bin/herness', args: [] }),
}))

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

test('missionMcpConfig writes the installed launcher', async () => {
  const p = await missionMcpConfig('T-1')
  const j = JSON.parse(await readFile(p, 'utf8'))
  expect(j.mcpServers.herness).toEqual({ command: '/inst/current/bin/herness', args: ['mcp', 'T-1'] })
})

test('restartDetached launches the installed launcher', async () => {
  const seen: unknown[] = []
  const spawn: Spawner = (cmd, args) => {
    seen.push([cmd, args])
    return { unref: () => {}, once: (ev: string, fn: (e?: Error) => void) => { if (ev === 'spawn') fn() } }
  }
  await restartDetached('m1', spawn, () => new Date('2026-11-02T10:11:12.000Z'))
  const [cmd, args] = seen[0] as [string, string[]]
  expect(cmd).toBe('/inst/current/bin/herness')
  expect(args).toEqual(['resume', 'm1', '--restart'])
})

const LAUNCHER = "'/inst/current/bin/herness'"

async function lifecycle() {
  const repo = join(home, 'demo-project')
  await mkdir(repo, { recursive: true })
  const fx = fakeEffects({ git: { isClean: async () => true } })
  const d: LifecycleDeps = { e: fx, loadConfig: async () => ({ ...demo, repoPath: repo }), out: () => {} }
  return { fx, d, repo, h: fx.herdr }
}

test('startMission launches the engine, dashboard and viewers through the installed launcher', async () => {
  const { d, repo, h } = await lifecycle()
  const id = await startMission('https://github.com/o/r/issues/12', repo, d)
  expect(h.runs.map((r) => r.cmd)).toEqual(expect.arrayContaining([
    `${LAUNCHER} engine ${id}`,
    `${LAUNCHER} tasks ${id}`,
    `${LAUNCHER} show spec ${id}`,
    `${LAUNCHER} show plan ${id}`,
  ]))
})

test('resumeMission restarts a stopped engine, dashboard and viewers through the installed launcher', async () => {
  const { d, repo, h } = await lifecycle()
  const id = await startMission('https://github.com/o/r/issues/12', repo, d)
  await drainInbox(id)
  const s = await loadState(id)
  await saveState({ ...s, orchestrator: { ...s.orchestrator, started: true } })
  for (const kind of ['engine', 'tasks', 'spec', 'plan'] as const) h.pane(s.herdr.panes[kind]!).busy = false
  h.runs.length = 0
  await resumeMission(id, d)
  expect(h.runs.map((r) => r.cmd)).toEqual(expect.arrayContaining([
    `${LAUNCHER} engine ${id}`,
    `${LAUNCHER} tasks ${id}`,
    `${LAUNCHER} show spec ${id}`,
    `${LAUNCHER} show plan ${id}`,
  ]))
})

test('openCockpit launches the cockpit through the installed launcher', async () => {
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  const cfg = { ...demo, repoPath: '/repo/demo' }
  await openCockpit('/repo/demo', h, join(home, 'cockpit.json'), async () => cfg)
  expect(h.runs[0]?.cmd).toBe(`'/inst/current/bin/herness' cockpit`)
})
