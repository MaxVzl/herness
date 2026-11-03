import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../exec.ts'
import { render } from '../prompts/render.ts'
import { findProjectConfig, NoProjectError, projectDirs, type FoundConfig } from './project.ts'

export interface InitDeps {
  isTTY: boolean
  confirm: (question: string) => Promise<boolean>
  /** Lance Claude en interactif dans le terminal courant et rend la main à sa sortie. */
  claude: (args: string[], cwd: string) => Promise<void>
  log: (line: string) => void
}

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'herness.js')

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

export interface Detected {
  name: string
  repoPath: string
  mainBranch: string
  packageManager?: PackageManager
  preflight: { label: string; command: string[] }[]
  commitFormat: string
}

/** Scripts de package.json repris dans le preflight, dans cet ordre. */
const PREFLIGHT_SCRIPTS = ['typecheck', 'lint', 'format:check', 'test']

const DEFAULTS = {
  branchPrefixes: { feat: 'feature', fix: 'fix', chore: 'chore', refactor: 'chore', docs: 'chore', test: 'chore' },
  forbiddenPaths: [] as string[],
  forbiddenCommands: ['git stash', '--no-verify'],
  falsePositives: [] as unknown[],
  orchestratorPermissionMode: 'auto',
  models: {
    orchestrator: 'claude-opus-5-5',
    reviewer: 'claude-opus-5-5',
    implementer: 'grok-4.7-medium',
    implementerStrong: 'grok-4.7-high',
  },
}

const INSTALL: Record<PackageManager, string> = {
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install',
  bun: 'bun install --frozen-lockfile',
  npm: 'npm ci',
}

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { reject: false })).stdout.trim()

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projet'

async function detectPackageManager(root: string, pkg: { packageManager?: unknown }): Promise<PackageManager> {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  return 'npm'
}

async function detectMainBranch(root: string): Promise<string> {
  const remote = await git(root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  if (remote.startsWith('origin/')) return remote.slice('origin/'.length)
  for (const b of ['main', 'master']) {
    if ((await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { reject: false })).exitCode === 0) return b
  }
  return (await git(root, 'branch', '--show-current')) || 'main'
}

/** Format des commits d'après les 50 derniers : conventionnel ou non, avec portée, avec suffixe `[id]`. */
async function detectCommitFormat(root: string): Promise<string> {
  const subjects = (await git(root, 'log', '-50', '--no-merges', '--format=%s')).split('\n').filter(Boolean)
  const most = (re: RegExp, among: string[]): boolean => among.length > 0 && among.filter((s) => re.test(s)).length * 2 >= among.length
  const conventional = subjects.filter((s) => /^\w+(\([^)]+\))?!?: /.test(s))
  const scoped = !most(/^\w+!?: /, conventional)
  const base = scoped ? '{type}({scope}): {description}' : '{type}: {description}'
  return most(/\s\[[^\]]+\]$/, subjects) ? `${base} [{id}]` : base
}

export async function detectProject(root: string): Promise<Detected> {
  let pkg: { scripts?: Record<string, string>; packageManager?: unknown } | undefined
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  } catch {
    pkg = undefined
  }
  const packageManager = pkg ? await detectPackageManager(root, pkg) : undefined
  const scripts = pkg?.scripts ?? {}
  return {
    name: slug(basename(root)),
    repoPath: root,
    mainBranch: await detectMainBranch(root),
    ...(packageManager ? { packageManager } : {}),
    preflight: packageManager
      ? PREFLIGHT_SCRIPTS.filter((s) => s in scripts).map((s) => ({ label: s, command: [packageManager, 'run', s] }))
      : [],
    commitFormat: await detectCommitFormat(root),
  }
}

const value = (v: unknown): string => JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')

export function configSource(d: Detected, date: string): string {
  const field = (k: string, v: unknown): string => `  ${k}: ${value(v)},\n`
  return `// Config herness du projet ${d.name}, générée par « herness init » le ${date}.
// Champs : section « Ajouter un projet » du README de herness. Vérifier avec « herness projet ».
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Les scripts du projet sont rangés à côté de cette config.
const here = dirname(fileURLToPath(import.meta.url))

export default {
${field('name', d.name)}${field('repoPath', d.repoPath)}${field('mainBranch', d.mainBranch)}${field('branchPrefixes', DEFAULTS.branchPrefixes)}${field('commitFormat', d.commitFormat)}${field('forbiddenPaths', DEFAULTS.forbiddenPaths)}${field('forbiddenCommands', DEFAULTS.forbiddenCommands)}  prepare: [join(here, 'prepare-worktree.sh'), '{worktree}'],
${field('preflight', d.preflight)}${field('falsePositives', DEFAULTS.falsePositives)}${field('orchestratorPermissionMode', DEFAULTS.orchestratorPermissionMode)}${field('models', DEFAULTS.models)}}
`
}

export function prepareSource(d: Detected): string {
  const install = d.packageManager
    ? `\n# Dépendances.\n(cd "$wt" && ${INSTALL[d.packageManager]})\n`
    : ''
  return `#!/usr/bin/env bash
# Préparation d'un worktree neuf du projet ${d.name}, générée par « herness init ».
# Usage : prepare-worktree.sh <worktree>
set -euo pipefail

wt=\${1:?worktree manquant}
[ -d "$wt" ] || { echo "worktree introuvable : $wt" >&2; exit 1; }
# Le checkout principal est la première entrée de \`git worktree list\`.
main=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')

# Fichiers d'environnement (gitignorés) du checkout principal, s'ils manquent.
for f in .env .env.local; do
  if [ -f "$main/$f" ] && [ ! -f "$wt/$f" ]; then
    cp "$main/$f" "$wt/$f"
  fi
done
${install}echo "worktree prêt : $wt"
`
}

async function generate(root: string, deps: InitDeps): Promise<FoundConfig> {
  const d = await detectProject(root)
  const dir = join(projectDirs()[0] as string, d.name)
  if (existsSync(dir)) throw new Error(`le dossier ${dir} existe déjà et ne couvre pas ${root} : vérifie son repoPath`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.ts'), configSource(d, new Date().toISOString().slice(0, 10)))
  const prepare = join(dir, 'prepare-worktree.sh')
  await writeFile(prepare, prepareSource(d))
  await chmod(prepare, 0o755)
  const found = await findProjectConfig(root)
  deps.log(`config créée : ${found.file}`)
  deps.log(`  projet ${d.name}, branche principale ${d.mainBranch}, commits « ${d.commitFormat} »`)
  deps.log(d.preflight.length
    ? `  preflight : ${d.preflight.map((p) => p.label).join(', ')}`
    : '  preflight : vide (aucun script typecheck, lint, format:check ou test trouvé)')
  return found
}

/**
 * Crée la config herness du dépôt courant (ou reprend celle qui existe), puis
 * propose de l'affiner avec Claude.
 */
export async function initProject(cwd: string, deps: InitDeps): Promise<FoundConfig> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel')
  if (!top) throw new Error(`pas un dépôt git : ${cwd}`)
  const root = await realpath(top)
  let found: FoundConfig
  try {
    found = await findProjectConfig(root)
    deps.log(`projet « ${found.config.name} » déjà configuré : ${found.file}`)
  } catch (e) {
    if (!(e instanceof NoProjectError)) throw e
    found = await generate(root, deps)
  }
  if (!deps.isTTY) {
    deps.log('affinage avec Claude : relance « herness init » dans un terminal interactif')
    return found
  }
  if (!(await deps.confirm('Affiner la config avec Claude ?'))) return found
  const dir = dirname(found.file)
  const prompt = await render('init', { repoPath: root, configFile: found.file, configDir: dir })
  deps.log('Claude démarre : quitte-le (/exit) quand la config te convient.')
  // `--add-dir` prend plusieurs dossiers : sans `--`, la consigne serait lue comme un dossier de plus.
  await deps.claude(['--model', found.config.models.orchestrator, '--add-dir', dir, '--', prompt], root)
  // La config vient d'être réécrite : ce processus l'a déjà importée, on la revalide ailleurs.
  const check = await run('node', [BIN, 'projet'], { cwd: root, reject: false })
  if (check.exitCode !== 0) throw new Error(`config à corriger après Claude : ${(check.stderr || check.stdout).replace(/^herness : /, '').trim()}`)
  deps.log(`config valide : ${found.file}`)
  return found
}
