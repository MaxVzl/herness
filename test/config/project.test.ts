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

// A config written the way a user would write it outside the repo: no import of herness.
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

test('finds the config in HERNESS_PROJECTS_DIR from a subdirectory of the repo', async () => {
  const { prepare: _p, ...rest } = demo
  await writeConfig('demo', { ...rest, repoPath: repo })
  const c = await loadProjectConfig(join(repo, 'apps', 'api'))
  expect(c.name).toBe('demo')
  // Script paths stay resolved from the config folder.
  expect(c.prepare).toEqual([join(dir, 'demo', 'prepare.sh'), '{worktree}'])
})

test('validates the config with the schema', async () => {
  const { prepare: _p, models: _m, ...rest } = demo
  await writeConfig('broken', { ...rest, repoPath: repo })
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

test('no project: the message lists the folders searched', async () => {
  const err = await loadProjectConfig(repo).catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain('no herness project')
  expect((err as Error).message).toContain(dir)
})

test('projectDirs: HERNESS_PROJECTS_DIR, else XDG_CONFIG_HOME, else ~/.config; plus projects/ from the repo', () => {
  expect(projectDirs()[0]).toBe(dir)
  delete process.env.HERNESS_PROJECTS_DIR
  process.env.XDG_CONFIG_HOME = '/xdg'
  expect(projectDirs()[0]).toBe('/xdg/herness/projects')
  delete process.env.XDG_CONFIG_HOME
  process.env.HOME = '/home'
  expect(projectDirs()[0]).toBe('/home/.config/herness/projects')
  expect(projectDirs()[1]).toMatch(/projects$/)
  expect(projectDirs()).toHaveLength(2)
})

test('the example config is valid and does not point at a real repo', () => {
  expect(exemple).toMatchObject({ name: 'example', repoPath: '/path/to/your-project', language: 'en' })
  const c = ProjectConfigSchema.parse(exemple)
  expect(c.language).toBe('en')
})

test('fill replaces the variables', () => {
  expect(fill(['a', '{id}', '{worktree}/x'], { id: '7', worktree: '/w' })).toEqual(['a', '7', '/w/x'])
})

test("orchestratorPermissionMode is 'auto' by default and rejects 'default'", () => {
  const { orchestratorPermissionMode: _m, ...without } = demo
  expect(ProjectConfigSchema.parse(without).orchestratorPermissionMode).toBe('auto')
  expect(() => ProjectConfigSchema.parse({ ...without, orchestratorPermissionMode: 'default' })).toThrow()
  for (const m of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    expect(ProjectConfigSchema.parse({ ...without, orchestratorPermissionMode: m }).orchestratorPermissionMode).toBe(m)
})
