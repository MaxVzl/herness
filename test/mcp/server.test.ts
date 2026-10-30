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
  state = { ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/repo' }), worktree: join(home, 'wt'), slug: 'ma-mission' }
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
const PLAN = '### Tâche 1 : a\n\n**Test :** `pnpm t`\n\ncorps\n'

test('la liste des outils ne contient aucun outil de décision (valider, refuser, approuver)', async () => {
  const c = await connect()
  const names = (await c.listTools()).tools.map((t) => t.name).sort()
  expect(names).toEqual(
    ['abandonner', 'demander_arbitrage', 'demander_validation', 'fin_de_pause', 'mission_identifiee', 'pause', 'proposer_amendement', 'statut'],
  )
  expect(names.join(' ')).not.toMatch(/valider\b|refuser|approuver/)
})

test('demander_validation(plan) avec un plan invalide rend les erreurs et ne poste rien', async () => {
  await writeDoc(planPath(state), '# plan sans tâche\n')
  const r = await call('demander_validation', { kind: 'plan', summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('Plan sans tâche')
  expect(await drainInbox('T-1')).toEqual([])
})

test('demander_validation(plan) valide poste un request-gate avec le chemin du plan', async () => {
  await writeDoc(planPath(state), PLAN)
  const r = await call('demander_validation', { kind: 'plan', summary: 's' })
  expect(r.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'plan', summary: 's', path: planPath(state) }])
})

test('demander_validation(spec) poste un request-gate spec', async () => {
  await writeDoc(specPath(state), '# spec\n')
  const r = await call('demander_validation', { kind: 'spec', summary: 's' })
  expect(r.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'spec', summary: 's', path: specPath(state) }])
})

test('demander_validation sans fichier dans le worktree rend une erreur avec le chemin exact attendu', async () => {
  const spec = await call('demander_validation', { kind: 'spec', summary: 's' })
  expect(spec.isError).toBe(true)
  expect(spec.content[0]!.text).toContain(join(state.worktree!, specPath(state)))
  const plan = await call('demander_validation', { kind: 'plan', summary: 's' })
  expect(plan.isError).toBe(true)
  expect(plan.content[0]!.text).toContain(join(state.worktree!, planPath(state)))
  expect(await drainInbox('T-1')).toEqual([])
})

test('mission_identifiee rend les chemins exacts de la spec et du plan', async () => {
  const r = await call('mission_identifiee', { type: 'feat', slug: 'un-slug' })
  const named = { ...state, slug: 'un-slug' }
  expect(r.content[0]!.text).toContain(join(state.worktree!, specPath(named)))
  expect(r.content[0]!.text).toContain(join(state.worktree!, planPath(named)))
})

test('demander_arbitrage poste un request-gate arbitrage', async () => {
  await call('demander_arbitrage', { summary: 'trancher' })
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'arbitrage', summary: 'trancher' }])
})

test('mission_identifiee refuse un type absent des préfixes du projet', async () => {
  const bad = await call('mission_identifiee', { type: 'inconnu', slug: 'un-slug' })
  expect(bad.isError).toBe(true)
  const badSlug = await call('mission_identifiee', { type: 'feat', slug: 'Slug_Mauvais' })
  expect(badSlug.isError).toBe(true)
  expect(await drainInbox('T-1')).toEqual([])
  const ok = await call('mission_identifiee', { type: 'feat', slug: 'un-slug' })
  expect(ok.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'classified', workType: 'feat', slug: 'un-slug' }])
})

test('proposer_amendement lit plan.proposed.md du dossier de mission, refuse une tâche done modifiée, et ne touche pas au worktree', async () => {
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), PLAN)
  await saveState({ ...state, tasks: [{ n: 1, title: 'a', testCommand: 'pnpm t', phase: 'done', round: 0 }] })
  await writeDoc(planPath(state), PLAN)
  const proposed = join(missionDir('T-1'), 'plan.proposed.md')
  const missing = await call('proposer_amendement', { summary: 's' })
  expect(missing.isError).toBe(true)
  expect(missing.content[0]!.text).toContain(proposed)
  await writeFile(proposed, PLAN.replace('corps', 'autre corps'))
  const r = await call('proposer_amendement', { summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('ajoute une tâche de reprise')
  expect(await drainInbox('T-1')).toEqual([])
  const next = PLAN + '\n### Tâche 2 : b\n\n**Test :** `pnpm u`\n'
  await writeFile(proposed, next)
  const ok = await call('proposer_amendement', { summary: 's' })
  expect(ok.isError).toBeFalsy()
  expect(await drainInbox('T-1')).toEqual([{ type: 'request-gate', kind: 'amendement', summary: 's', path: proposed, hash: proposalHash(next) }])
  // Le worktree n'est jamais modifié pendant la proposition.
  expect(await readFile(join(state.worktree!, planPath(state)), 'utf8')).toBe(PLAN)
})

test('proposer_amendement avec une spec proposée lie aussi la spec au hachage et la cite', async () => {
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), PLAN)
  const next = PLAN + '\n### Tâche 2 : b\n\n**Test :** `pnpm u`\n'
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), next)
  await writeFile(join(missionDir('T-1'), 'spec.proposed.md'), '# spec v2\n')
  const ok = await call('proposer_amendement', { summary: 's' })
  expect(ok.isError).toBeFalsy()
  const [m] = (await drainInbox('T-1')) as { hash?: string; summary: string }[]
  expect(m!.hash).toBe(proposalHash(next, '# spec v2\n'))
  expect(m!.summary).toContain(join(missionDir('T-1'), 'spec.proposed.md'))
})

test('pause, fin_de_pause, abandonner postent leur message ; statut résume', async () => {
  await call('pause')
  await call('fin_de_pause')
  await call('abandonner', { reason: 'r' })
  expect(await drainInbox('T-1')).toEqual([{ type: 'pause' }, { type: 'resume' }, { type: 'abandon', reason: 'r' }])
  const r = await call('statut')
  expect(r.content[0]!.text).toContain('env')
})

test('specPath et planPath utilisent la date locale de création et exigent un slug', () => {
  const s = { ...state, createdAt: new Date(2026, 9, 5, 12).toISOString() }
  expect(specPath(s)).toBe('docs/superpowers/specs/2026-10-05-T-1-ma-mission.md')
  expect(planPath(s)).toBe('docs/superpowers/plans/2026-10-05-T-1-ma-mission.md')
  expect(() => specPath({ ...s, slug: undefined })).toThrow()
})

test('missionMcpConfig écrit mcp.json', async () => {
  const p = await missionMcpConfig('T-1')
  const j = JSON.parse(await readFile(p, 'utf8'))
  expect(p).toBe(join(missionDir('T-1'), 'mcp.json'))
  expect(j.mcpServers.herness.args).toEqual(['mcp', 'T-1'])
  expect(j.mcpServers.herness.command).toMatch(/^\/.*bin\/herness\.js$/)
  expect(await readdir(missionDir('T-1'))).toContain('mcp.json')
})

test('proposer_amendement refuse si le plan approuvé est illisible pour parsePlan et ne poste rien', async () => {
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), '# pas de tâche\n')
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), PLAN)
  const r = await call('proposer_amendement', { summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('Plan approuvé invalide')
  expect(await drainInbox('T-1')).toEqual([])
})

test('demander_validation(spec) sans slug rend une erreur en français', async () => {
  await saveState({ ...state, slug: undefined })
  const r = await call('demander_validation', { kind: 'spec', summary: 's' })
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toMatch(/^Erreur : .*slug/)
  expect(await drainInbox('T-1')).toEqual([])
})
