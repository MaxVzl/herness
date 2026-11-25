import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { detectProject, initProject, type InitDeps } from '../../src/config/init.ts'
import { findProjectConfig } from '../../src/config/project.ts'

let dir: string
let repo: string
const saved = { ...process.env }

const git = (...args: string[]) => execa('git', ['-C', repo, ...args])

async function commit(subject: string): Promise<void> {
  await git('commit', '--allow-empty', '-q', '-m', subject)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herness-projects-'))
  repo = await realpath(await mkdtemp(join(tmpdir(), 'My App-')))
  process.env.HERNESS_PROJECTS_DIR = dir
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 't@t')
  await git('config', 'user.name', 't')
})
afterEach(async () => {
  process.env = { ...saved }
  await rm(dir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function deps(answer = false): InitDeps & { lines: string[]; asked: string[]; launches: { args: string[]; cwd: string }[] } {
  const lines: string[] = []
  const asked: string[] = []
  const launches: { args: string[]; cwd: string }[] = []
  return {
    lines,
    asked,
    launches,
    isTTY: true,
    confirm: async (q) => {
      asked.push(q)
      return answer
    },
    claude: async (args, cwd) => {
      launches.push({ args, cwd })
    },
    log: (l) => lines.push(l),
  }
}

async function nodeRepo(): Promise<void> {
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
  }))
  await writeFile(join(repo, 'pnpm-lock.yaml'), '')
  for (const s of ['feat(api): add [123]', 'fix(ui): button [124]', 'chore: deps [125]']) await commit(s)
}

test('detects name, branch, package manager, preflight and commit format', async () => {
  await nodeRepo()
  const d = await detectProject(repo)
  expect(d.name).toMatch(/^my-app-/)
  expect(d.mainBranch).toBe('main')
  expect(d.packageManager).toBe('pnpm')
  expect(d.preflight).toEqual([
    { label: 'typecheck', command: ['pnpm', 'run', 'typecheck'] },
    { label: 'lint', command: ['pnpm', 'run', 'lint'] },
    { label: 'test', command: ['pnpm', 'run', 'test'] },
  ])
  expect(d.commitFormat).toBe('{type}({scope}): {description} [{id}]')
})

test('commits with neither scope nor id', async () => {
  for (const s of ['feat: a', 'fix: b', 'docs: c']) await commit(s)
  expect((await detectProject(repo)).commitFormat).toBe('{type}: {description}')
})

test('creates a valid config and an executable prepare script, and does not launch Claude when refused', async () => {
  await nodeRepo()
  const d = deps(false)
  const found = await initProject(join(repo), d)
  expect(found.config.repoPath).toBe(repo)
  expect(found.file.startsWith(dir)).toBe(true)
  expect((await findProjectConfig(repo)).config.name).toBe(found.config.name)
  const prepare = join(dir, found.config.name, 'prepare-worktree.sh')
  expect(found.config.prepare).toEqual([prepare, '{worktree}'])
  expect((await stat(prepare)).mode & 0o111).toBeTruthy()
  expect(await readFile(prepare, 'utf8')).toContain('pnpm install --frozen-lockfile')
  await execa('bash', ['-n', prepare])
  expect(d.asked).toEqual(['Refine the config with Claude?'])
  expect(d.launches).toEqual([])
  expect(d.lines[0]).toContain('config created')
  const src = await readFile(found.file, 'utf8')
  expect(src).toMatch(/commitFormat: .+\n {2}language: "en",/)
})

test('repo without package.json: empty preflight, prepare script without install', async () => {
  await commit('init')
  const found = await initProject(repo, deps())
  expect(found.config.preflight).toEqual([])
  expect(await readFile(join(dir, found.config.name, 'prepare-worktree.sh'), 'utf8')).not.toContain('install')
})

test('accepted: launches Claude at the repo root with the config folder and the instruction', async () => {
  await nodeRepo()
  await mkdir(join(repo, 'src'))
  const d = deps(true)
  const found = await initProject(join(repo, 'src'), d)
  expect(d.launches).toHaveLength(1)
  const { args, cwd } = d.launches[0]!
  expect(cwd).toBe(repo)
  // The instruction comes after `--`: otherwise `--add-dir`, which takes several folders, would swallow it.
  expect(args.slice(0, 5)).toEqual(['--model', 'claude-opus-5-5', '--add-dir', join(dir, found.config.name), '--'])
  expect(args).toHaveLength(6)
  expect(args[5]).toContain(found.file)
  expect(args[5]).toContain('herness project')
  expect(d.lines.at(-1)).toBe(`valid config: ${found.file}`)
})

test('config broken by Claude: error', async () => {
  await nodeRepo()
  const d = deps(true)
  d.claude = async () => {
    const { file } = await findProjectConfig(repo)
    await writeFile(file, (await readFile(file, 'utf8')).replace(/ {2}models: [\s\S]*\},\n\}/, '}'))
  }
  await expect(initProject(repo, d)).rejects.toThrow(/config to fix after Claude.*models/s)
})

test('project already configured: nothing rewritten, still offers Claude', async () => {
  await nodeRepo()
  const first = await initProject(repo, deps())
  const before = await readFile(first.file, 'utf8')
  const d = deps(false)
  const again = await initProject(repo, d)
  expect(again.file).toBe(first.file)
  expect(await readFile(first.file, 'utf8')).toBe(before)
  expect(d.lines[0]).toBe(`project "${first.config.name}" already configured: ${first.file}`)
  expect(d.asked).toHaveLength(1)
})

test('outside an interactive terminal: does not ask', async () => {
  await nodeRepo()
  const d = { ...deps(true), isTTY: false }
  await initProject(repo, d)
  expect(d.asked).toEqual([])
  expect(d.launches).toEqual([])
  expect(d.lines.at(-1)).toMatch(/interactive terminal/)
})

test('a folder of the same name for another repo: refuses to overwrite', async () => {
  await nodeRepo()
  const name = (await detectProject(repo)).name
  await mkdir(join(dir, name))
  await expect(initProject(repo, deps())).rejects.toThrow(/already exists/)
})

test('outside a git repo: error', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'herness-plain-'))
  try {
    await expect(initProject(plain, deps())).rejects.toThrow(/not a git repository/)
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})
