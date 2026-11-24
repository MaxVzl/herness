import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import exemple from '../../projects/example/config.ts'
import demo from '../fixtures/demo/config.ts'
import { fill, loadProjectConfig, projectDirs, ProjectConfigSchema } from '../../src/config/project.ts'

let dir: string
let repo: string
const saved = { ...process.env }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herness-projects-'))
  repo = await realpath(await mkdtemp(join(tmpdir(), 'herness-repo-')))
  await mkdir(join(repo, 'apps', 'api'), { recursive: true })
  process.env.HERNESS_PROJECTS_DIR = dir
})
afterEach(async () => {
  process.env = { ...saved }
  await rm(dir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

// Une config écrite comme un utilisateur l'écrirait hors du dépôt : aucun import vers herness.
async function writeConfig(name: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(
    join(dir, name, 'config.ts'),
    `import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
export default { ...${JSON.stringify(body)}, prepare: [join(here, 'prepare.sh'), '{worktree}'] }
`,
  )
}

test('trouve la config du dossier HERNESS_PROJECTS_DIR depuis un sous-dossier du dépôt', async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('demo', { ...rest, repoPath: repo })
  const c = await loadProjectConfig(join(repo, 'apps', 'api'))
  expect(c.name).toBe('demo')
  // Les chemins de scripts restent résolus depuis le dossier de la config.
  expect(c.prepare).toEqual([join(dir, 'demo', 'prepare.sh'), '{worktree}'])
})

test('valide la config avec le schéma', async () => {
  const { prepare: _p, models: _m, ...rest } = demo
  await writeConfig('cassee', { ...rest, repoPath: repo })
  await expect(loadProjectConfig(repo)).rejects.toThrow(/models/)
})

test("ignores a config named 'example' even when its repoPath matches", async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('example', { ...rest, name: 'example', repoPath: repo })
  await expect(loadProjectConfig(repo)).rejects.toThrow('no herness project')
})

test("loads a config named 'exemple'", async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('exemple', { ...rest, name: 'exemple', repoPath: repo })
  expect((await loadProjectConfig(repo)).name).toBe('exemple')
})

test('language defaults to en', () => {
  const { language: _l, ...without } = demo as typeof demo & { language?: string }
  expect(ProjectConfigSchema.parse(without).language).toBe('en')
})

test("language keeps a given value ('fr')", () => {
  expect(ProjectConfigSchema.parse({ ...demo, language: 'fr' }).language).toBe('fr')
})

test('aucun projet : le message liste les dossiers cherchés', async () => {
  const err = await loadProjectConfig(repo).catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain('no herness project')
  expect((err as Error).message).toContain(dir)
})

test('projectDirs : HERNESS_PROJECTS_DIR, sinon XDG_CONFIG_HOME, sinon ~/.config ; plus projects/ du dépôt', () => {
  expect(projectDirs()[0]).toBe(dir)
  delete process.env.HERNESS_PROJECTS_DIR
  process.env.XDG_CONFIG_HOME = '/xdg'
  expect(projectDirs()[0]).toBe('/xdg/herness/projects')
  delete process.env.XDG_CONFIG_HOME
  process.env.HOME = '/maison'
  expect(projectDirs()[0]).toBe('/maison/.config/herness/projects')
  expect(projectDirs()[1]).toMatch(/projects$/)
  expect(projectDirs()).toHaveLength(2)
})

test("la config d'exemple est valide et ne vise pas un vrai dépôt", () => {
  expect(exemple).toMatchObject({ name: 'example', repoPath: '/path/to/your-project', language: 'en' })
  const c = ProjectConfigSchema.parse(exemple)
  expect(c.language).toBe('en')
})

test('fill remplace les variables', () => {
  expect(fill(['a', '{id}', '{worktree}/x'], { id: '7', worktree: '/w' })).toEqual(['a', '7', '/w/x'])
})

test("orchestratorPermissionMode vaut 'auto' par défaut et refuse 'default'", () => {
  const { orchestratorPermissionMode: _m, ...sans } = demo
  expect(ProjectConfigSchema.parse(sans).orchestratorPermissionMode).toBe('auto')
  expect(() => ProjectConfigSchema.parse({ ...sans, orchestratorPermissionMode: 'default' })).toThrow()
  for (const m of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    expect(ProjectConfigSchema.parse({ ...sans, orchestratorPermissionMode: m }).orchestratorPermissionMode).toBe(m)
})
