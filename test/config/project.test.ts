import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import exemple from '../../projects/exemple/config.ts'
import demo from '../fixtures/demo/config.ts'
import { fill, listProjects, loadProjectConfig, projectDirs, ProjectConfigSchema } from '../../src/config/project.ts'

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

test("ignore une config nommée 'exemple', même si son repoPath correspond", async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('exemple', { ...rest, name: 'exemple', repoPath: repo })
  await expect(loadProjectConfig(repo)).rejects.toThrow('aucun projet herness')
})

test('aucun projet : le message liste les dossiers cherchés', async () => {
  const err = await loadProjectConfig(repo).catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain('aucun projet herness')
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
  const c = ProjectConfigSchema.parse(exemple)
  expect(c.name).toBe('exemple')
  expect(c.repoPath).toBe('/chemin/vers/ton-projet')
})

test('listProjects rend toutes les configs triées par nom, sans exemple', async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('b', { ...rest, name: 'b', repoPath: repo })
  await writeConfig('a', { ...rest, name: 'a', repoPath: repo })
  await writeConfig('exemple', { ...rest, name: 'exemple', repoPath: repo })
  expect((await listProjects()).map((f) => f.config.name)).toEqual(['a', 'b'])
})

test('une config modifiée est relue sans redémarrer', async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('a', { ...rest, name: 'a', repoPath: repo, mainBranch: 'main' })
  expect((await loadProjectConfig(repo)).mainBranch).toBe('main')
  await writeConfig('a', { ...rest, name: 'a', repoPath: repo, mainBranch: 'dev' })
  const file = join(dir, 'a', 'config.ts')
  const later = new Date(Date.now() + 2000)
  await utimes(file, later, later)
  expect((await loadProjectConfig(repo)).mainBranch).toBe('dev')
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
