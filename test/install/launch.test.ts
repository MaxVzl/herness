import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { FakeHerdr } from '../herdr/fake.ts'
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

test('missionMcpConfig écrit le lanceur installé', async () => {
  const p = await missionMcpConfig('T-1')
  const j = JSON.parse(await readFile(p, 'utf8'))
  expect(j.mcpServers.herness).toEqual({ command: '/inst/current/bin/herness', args: ['mcp', 'T-1'] })
})

test('restartDetached lance le lanceur installé', async () => {
  const seen: unknown[] = []
  const spawn: Spawner = (cmd, args) => {
    seen.push([cmd, args])
    return { unref: () => {}, once: (ev: string, fn: (e?: Error) => void) => { if (ev === 'spawn') fn() } }
  }
  await restartDetached('m1', spawn, () => new Date('2026-11-02T10:11:12.000Z'))
  const [cmd, args] = seen[0] as [string, string[]]
  expect(cmd).toBe('/inst/current/bin/herness')
  expect(args).toEqual(['reprendre', 'm1', '--redemarrer'])
})

test('openCockpit lance le cockpit par le lanceur installé', async () => {
  const h = new FakeHerdr()
  h.seedWorkspace('demo')
  const cfg = { ...demo, repoPath: '/repo/demo' }
  await openCockpit('/repo/demo', h, join(home, 'cockpit.json'), async () => cfg)
  expect(h.runs[0]?.cmd).toBe(`'/inst/current/bin/herness' cockpit`)
})
