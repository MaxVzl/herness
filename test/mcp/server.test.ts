import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { missionDir, planPath, specPath } from '../../src/paths.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { buildServer, missionMcpConfig } from '../../src/mcp/server.ts'
import { proposalHash } from '../../src/mission/amendment.ts'

vi.mock('../../src/config/project.ts', () => ({
  loadProjectConfig: async () => ({ branchPrefixes: { feat: 'feature', fix: 'fix' } }),
}))

let home: string
let state: MissionState
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
  state = { ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/repo' }), worktree: join(home, 'wt'), slug: 'my-mission' }
  await saveState(state)
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await buildServer('T-1').connect(a)
  const client = new Client({ name: 't', version: '1' })
  await client.connect(b)
  return client
}
type Res = { isError?: boolean; content: { type: string; text: string }[] }
async function call(name: string, args: Record<string, unknown> = {}): Promise<Res> {
  const c = await connect()
  return (await c.callTool({ name, arguments: args })) as Res
}
async function writeDoc(rel: string, body: string) {
  const file = join(state.worktree!, rel)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, body)
}
const PLAN = '### Task 1: a\n\n**Test:** `pnpm t`\n\nbody\n'
const LEGACY_PLAN = '### Tâche 1 : a\n\n**Test :** `pnpm t`\n\nbody\n'

test('the tool list contains no legacy decision tool', async () => {
  const c = await connect()
  const names = (await c.listTools()).tools.map((t) => t.name).sort()
  expect(names).toEqual(
    ['abandon', 'end_pause', 'mission_classified', 'pause', 'propose_amendment', 'report_anomaly', 'request_approval', 'request_arbitration', 'status'],
  )
  expect(names.join(' ')).not.toMatch(new RegExp(['vali', 'der\\b|refu', 'ser|approu', 'ver'].join('')))
})

test('request_approval(plan) with an invalid plan returns the errors and posts nothing', async () => {
  await writeDoc(planPath(state), '# plan with no task\n')
  const r = await call('request_approval', { kind: 'plan', summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('Plan has no task')
  expect(await drainInbox('T-1')).toEqual([])
})

test('request_approval(plan) accepts a legacy 0.8 plan', async () => {
  await writeDoc(planPath(state), LEGACY_PLAN)
  const r = await call('request_approval', { kind: 'plan', summary: 's' })
  expect(r.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'plan', summary: 's', path: planPath(state) }])
})

test('request_approval(plan) when valid posts a request-gate with the plan path', async () => {
  await writeDoc(planPath(state), PLAN)
  const r = await call('request_approval', { kind: 'plan', summary: 's' })
  expect(r.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'plan', summary: 's', path: planPath(state) }])
})

test('request_approval(spec) posts a spec request-gate', async () => {
  await writeDoc(specPath(state), '# spec\n')
  const r = await call('request_approval', { kind: 'spec', summary: 's' })
  expect(r.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'spec', summary: 's', path: specPath(state) }])
})

test('request_approval without the file in the worktree returns an error with the exact expected path', async () => {
  const spec = await call('request_approval', { kind: 'spec', summary: 's' })
  expect(spec.isError).toBe(true)
  expect(spec.content[0]!.text).toContain(join(state.worktree!, specPath(state)))
  const plan = await call('request_approval', { kind: 'plan', summary: 's' })
  expect(plan.isError).toBe(true)
  expect(plan.content[0]!.text).toContain(join(state.worktree!, planPath(state)))
  expect(await drainInbox('T-1')).toEqual([])
})

test('mission_classified returns the exact spec and plan paths', async () => {
  const r = await call('mission_classified', { type: 'feat', slug: 'a-slug' })
  const named = { ...state, slug: 'a-slug' }
  expect(r.content[0]!.text).toContain(join(state.worktree!, specPath(named)))
  expect(r.content[0]!.text).toContain(join(state.worktree!, planPath(named)))
})

test('request_arbitration posts an arbitration request-gate', async () => {
  await call('request_arbitration', { summary: 'decide' })
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'arbitration', summary: 'decide' }])
})

test('mission_classified rejects a type absent from the project prefixes', async () => {
  const bad = await call('mission_classified', { type: 'unknown', slug: 'a-slug' })
  expect(bad.isError).toBe(true)
  const badSlug = await call('mission_classified', { type: 'feat', slug: 'Bad_Slug' })
  expect(badSlug.isError).toBe(true)
  expect(await drainInbox('T-1')).toEqual([])
  const ok = await call('mission_classified', { type: 'feat', slug: 'a-slug' })
  expect(ok.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'classified', workType: 'feat', slug: 'a-slug' }])
})

test('propose_amendment reads plan.proposed.md from the mission folder, rejects a modified done task, and does not touch the worktree', async () => {
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), PLAN)
  await saveState({ ...state, tasks: [{ n: 1, title: 'a', testCommand: 'pnpm t', phase: 'done', round: 0 }] })
  await writeDoc(planPath(state), PLAN)
  const proposed = join(missionDir('T-1'), 'plan.proposed.md')
  const missing = await call('propose_amendment', { summary: 's' })
  expect(missing.isError).toBe(true)
  expect(missing.content[0]!.text).toContain(proposed)
  await writeFile(proposed, PLAN.replace('body', 'other body'))
  const r = await call('propose_amendment', { summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('add a follow-up task')
  expect(await drainInbox('T-1')).toEqual([])
  const next = PLAN + '\n### Task 2: b\n\n**Test:** `pnpm u`\n'
  await writeFile(proposed, next)
  const ok = await call('propose_amendment', { summary: 's' })
  expect(ok.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'amendment', summary: 's', path: proposed, hash: proposalHash(next) }])
  // The worktree is never modified during the proposal.
  expect(await readFile(join(state.worktree!, planPath(state)), 'utf8')).toBe(PLAN)
})

test('propose_amendment with a proposed spec also binds the spec into the hash and cites it', async () => {
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), PLAN)
  const next = PLAN + '\n### Task 2: b\n\n**Test:** `pnpm u`\n'
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), next)
  await writeFile(join(missionDir('T-1'), 'spec.proposed.md'), '# spec v2\n')
  const ok = await call('propose_amendment', { summary: 's' })
  expect(ok.isError).toBeFalsy()
  const [m] = (await drainInbox('T-1')) as { hash?: string; summary: string }[]
  expect(m!.hash).toBe(proposalHash(next, '# spec v2\n'))
  expect(m!.summary).toContain(join(missionDir('T-1'), 'spec.proposed.md'))
})

test('pause, end_pause, abandon post their message; status summarizes', async () => {
  await call('pause')
  await call('end_pause')
  await call('abandon', { reason: 'r' })
  expect(await drainInbox('T-1')).toEqual([{ type: 'pause' }, { type: 'resume' }, { type: 'abandon', reason: 'r' }])
  const r = await call('status')
  expect(r.content[0]!.text).toContain('env')
})

test('specPath and planPath use the local creation date and require a slug', () => {
  const s = { ...state, createdAt: new Date(2026, 9, 5, 12).toISOString() }
  expect(specPath(s)).toBe('docs/superpowers/specs/2026-10-05-T-1-my-mission.md')
  expect(planPath(s)).toBe('docs/superpowers/plans/2026-10-05-T-1-my-mission.md')
  expect(() => specPath({ ...s, slug: undefined })).toThrow()
})

test('missionMcpConfig writes mcp.json', async () => {
  const p = await missionMcpConfig('T-1')
  const j = JSON.parse(await readFile(p, 'utf8'))
  expect(p).toBe(join(missionDir('T-1'), 'mcp.json'))
  expect(j.mcpServers.herness).toEqual({ command: 'node', args: [expect.stringMatching(/\/bin\/herness\.js$/), 'mcp', 'T-1'] })
  expect(await readdir(missionDir('T-1'))).toContain('mcp.json')
})

test('propose_amendment rejects when the approved plan is unreadable by parsePlan and posts nothing', async () => {
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), '# no task\n')
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), PLAN)
  const r = await call('propose_amendment', { summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('Approved plan is invalid')
  expect(await drainInbox('T-1')).toEqual([])
})

test("a tool exception is logged with the tool name", async () => {
  await rm(join(missionDir('T-1'), 'state.json'))
  const r = await call('status')
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text.startsWith('Error: ')).toBe(true)
  const text = await readFile(join(home, 'errors.log'), 'utf8')
  expect(text).toContain('· mission T-1 · herness ')
  expect(text).toContain('· MCP tool status')
})

test("report_anomaly writes the description with the step and posts nothing", async () => {
  const r = await call('report_anomaly', { description: '  the engine announces g3 but status does not show it  ' })
  expect(r.isError).toBeFalsy()
  expect(r.content[0]!.text).toContain(join(home, 'errors.log'))
  const text = await readFile(join(home, 'errors.log'), 'utf8')
  expect(text).toContain(`· orchestrator anomaly report (step ${state.step})`)
  expect(text).toContain('the engine announces g3 but status does not show it')
  expect(await drainInbox('T-1')).toEqual([])
})

test('report_anomaly rejects an empty description', async () => {
  const r = await call('report_anomaly', { description: '   ' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('Empty description')
  await expect(readFile(join(home, 'errors.log'), 'utf8')).rejects.toThrow()
})

test('request_approval(spec) without a slug returns an error', async () => {
  await saveState({ ...state, slug: undefined })
  const r = await call('request_approval', { kind: 'spec', summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toMatch(/^Error: .*slug/)
  expect(await drainInbox('T-1')).toEqual([])
})
