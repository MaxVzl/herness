import { existsSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { require as tsxRequire } from 'tsx/cjs/api'
import { z } from 'zod'
import { PERMISSION_MODES } from '../agents/adapters.ts'

export const ProjectConfigSchema = z.object({
  name: z.string(),
  repoPath: z.string(),
  mainBranch: z.string(),
  branchPrefixes: z.record(z.string(), z.string()),
  commitFormat: z.string(),
  forbiddenPaths: z.array(z.string()),
  forbiddenCommands: z.array(z.string()),
  prepare: z.array(z.string()),
  testDb: z.object({ up: z.array(z.string()), down: z.array(z.string()) }).optional(),
  preflight: z.array(z.object({ label: z.string(), command: z.array(z.string()) })),
  falsePositives: z.array(z.object({
    label: z.string().optional(),
    pattern: z.string(),
    action: z.enum(['retry', 'ignore', 'cleanup']),
    cleanup: z.array(z.string()).optional(),
    explanation: z.string(),
  })),
  orchestratorPermissionMode: z.enum(PERMISSION_MODES).default('auto'),
  models: z.object({
    orchestrator: z.string(),
    reviewer: z.string(),
    implementer: z.string(),
    implementerStrong: z.string(),
  }),
})
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

// Racine du paquet herness : herness est lancé depuis le dépôt cible, pas depuis ici.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Dossier de config ignoré : il documente le format, il ne vise aucun vrai dépôt. */
const EXAMPLE = 'exemple'

/**
 * Dossiers où chercher les configs de projet, dans l'ordre :
 * `$HERNESS_PROJECTS_DIR`, sinon `$XDG_CONFIG_HOME/herness/projects`, sinon
 * `~/.config/herness/projects` ; puis le dossier `projects/` du paquet.
 */
export function projectDirs(): string[] {
  const env = process.env
  const user = env.HERNESS_PROJECTS_DIR
    || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'herness', 'projects')
  return [user, join(packageRoot, 'projects')]
}

/** Aucune config ne couvre le dossier (les autres erreurs : config invalide, import cassé…). */
export class NoProjectError extends Error {}

/** Le fichier `config.ts` est là, mais son contenu n'est pas une config de projet valide. */
export class InvalidConfigError extends Error {}

export interface FoundConfig {
  config: ProjectConfig
  file: string
}

// Fichier → date déjà chargée. Une query sur `import()` ne marche pas : tsx recompile
// un `.ts` hors paquet `"type": "module"` en CommonJS, et `require` garde cette query
// dans le nom du fichier (`config.ts?v=…`), qui n'existe pas.
const loadedMtime = new Map<string, number>()

function dropTsxCache(file: string): void {
  for (const key of Object.keys(tsxRequire.cache)) {
    if (key === file || key.startsWith(`${file}?`)) delete tsxRequire.cache[key]
  }
}

/**
 * Importe un `config.ts` via `tsx.require`, qui compile aussi un fichier placé hors
 * paquet `"type": "module"`. Le cache de ce require est vidé quand la date de
 * modification change, donc un fichier déjà lu est rechargé. `undefined` si le fichier
 * est absent.
 */
async function importProjectConfig(file: string): Promise<ProjectConfig | undefined> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(file)).mtimeMs
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      loadedMtime.delete(file)
      dropTsxCache(file)
      return undefined
    }
    throw e
  }
  let mod: { default?: unknown }
  try {
    if (loadedMtime.get(file) !== mtimeMs) dropTsxCache(file)
    mod = tsxRequire(file, import.meta.url)
    loadedMtime.set(file, mtimeMs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ENOENT') && !existsSync(file)) {
      loadedMtime.delete(file)
      dropTsxCache(file)
      return undefined
    }
    throw e
  }
  const parsed = ProjectConfigSchema.safeParse(mod.default)
  if (!parsed.success) throw new InvalidConfigError(`config de projet invalide (${file}) : ${parsed.error.message}`)
  return parsed.data
}

/**
 * Config du projet dont `repoPath` contient `cwd`, avec son fichier.
 * Un fichier modifié est réimporté : sa date de modification invalide le cache du require.
 */
export async function findProjectConfig(cwd: string): Promise<FoundConfig> {
  const real = await realpath(cwd)
  const dirs = [...new Set(projectDirs())]
  for (const projectsDir of dirs) {
    const names = await readdir(projectsDir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (name === EXAMPLE) continue
      const file = join(projectsDir, name, 'config.ts')
      const config = await importProjectConfig(file)
      if (!config) continue
      if (real === config.repoPath || real.startsWith(config.repoPath + sep)) return { config, file }
    }
  }
  throw new NoProjectError(`aucun projet herness pour ${cwd} (dossiers cherchés : ${dirs.join(', ')})`)
}

/** Toutes les configs valides, une par `name` (la première trouvée gagne), triées par `name`. */
export async function listProjects(): Promise<FoundConfig[]> {
  const dirs = [...new Set(projectDirs())]
  const byName = new Map<string, FoundConfig>()
  for (const projectsDir of dirs) {
    const names = await readdir(projectsDir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (name === EXAMPLE) continue
      const file = join(projectsDir, name, 'config.ts')
      let config: ProjectConfig | undefined
      try {
        config = await importProjectConfig(file)
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        console.error(`${file} : ${detail}`)
        continue
      }
      if (!config || byName.has(config.name)) continue
      byName.set(config.name, { config, file })
    }
  }
  return [...byName.values()].sort((a, b) => a.config.name.localeCompare(b.config.name))
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  return (await findProjectConfig(cwd)).config
}

export function fill(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) => part.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m))
}
