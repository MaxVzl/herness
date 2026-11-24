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
  language: z.string().default('en'),
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

/** Main ref, always taken from origin. */
export const mainRef = (cfg: ProjectConfig): string => `origin/${cfg.mainBranch}`

// herness package root: herness is launched from the target repository, not from here.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Ignored config directory: it documents the format and does not point at a real repository. */
const EXAMPLE = 'example'

/**
 * Directories where project configs are looked up, in order:
 * `$HERNESS_PROJECTS_DIR`, otherwise `$XDG_CONFIG_HOME/herness/projects`, otherwise
 * `~/.config/herness/projects`; then the package's `projects/` directory.
 */
export function projectDirs(): string[] {
  const env = process.env
  const user = env.HERNESS_PROJECTS_DIR
    || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'herness', 'projects')
  return [user, join(packageRoot, 'projects')]
}

/** No config covers the directory (other errors: invalid config, broken import…). */
export class NoProjectError extends Error {}

export interface FoundConfig {
  config: ProjectConfig
  file: string
}

/**
 * Config of the project whose `repoPath` contains `cwd`, together with its file. An already
 * imported file is not reloaded: to revalidate after a change, use another process.
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
      if (!parsed.success) throw new Error(`invalid project config (${file}): ${parsed.error.message}`)
      const config = parsed.data
      if (real === config.repoPath || real.startsWith(config.repoPath + sep)) return { config, file }
    }
  }
  throw new NoProjectError(`no herness project for ${cwd} (searched directories: ${dirs.join(', ')})`)
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  return (await findProjectConfig(cwd)).config
}

export function fill(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) => part.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m))
}
