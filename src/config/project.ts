import { existsSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

export interface FoundConfig {
  config: ProjectConfig
  file: string
}

/**
 * Config du projet dont `repoPath` contient `cwd`, avec son fichier. Un fichier déjà
 * importé ne se recharge pas : pour revalider après modification, passer par un autre processus.
 */
export async function findProjectConfig(cwd: string): Promise<FoundConfig> {
  const real = await realpath(cwd)
  const dirs = [...new Set(projectDirs())]
  for (const projectsDir of dirs) {
    const names = await readdir(projectsDir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (name === EXAMPLE) continue
      const file = join(projectsDir, name, 'config.ts')
      let mod: { default?: unknown }
      try {
        mod = await import(pathToFileURL(file).href)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') && !existsSync(file)) continue
        throw e
      }
      const parsed = ProjectConfigSchema.safeParse(mod.default)
      if (!parsed.success) throw new Error(`config de projet invalide (${file}) : ${parsed.error.message}`)
      const config = parsed.data
      if (real === config.repoPath || real.startsWith(config.repoPath + sep)) return { config, file }
    }
  }
  throw new NoProjectError(`aucun projet herness pour ${cwd} (dossiers cherchés : ${dirs.join(', ')})`)
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  return (await findProjectConfig(cwd)).config
}

export function fill(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) => part.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m))
}
