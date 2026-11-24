import { execa } from 'execa'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertResumable, isFinished, isLegacy, loadState, type MissionState } from './mission/state.ts'
import { missionsRoot } from './paths.ts'

export const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/MaxVzl/herness/main/install.sh'

/** Racine du paquet en cours d'exécution. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Dossier d'installation : HERNESS_INSTALL_DIR, sinon $XDG_DATA_HOME/herness, sinon ~/.local/share/herness. */
export function installDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERNESS_INSTALL_DIR || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'herness')
}

/** Lanceur de la version active, posé par install.sh : c'est lui qui exécute le nouveau code. */
export function installedBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(installDir(env), 'current', 'bin', 'herness')
}

type InstalledExec = (file: string, args: string[], opts: { stdio: 'inherit' }) => Promise<unknown>

/** `herness resume <id> --restart` avec le binaire fraîchement installé. */
export async function restartInstalled(
  id: string,
  exec: InstalledExec = (file, args, opts) => execa(file, args, opts),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await exec(installedBin(env), ['resume', id, '--restart'], { stdio: 'inherit' })
}

/** Vrai si la racine réelle du processus est strictement sous le dossier versions/ de l'installation. */
export function runsInstalled(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): boolean {
  try {
    const versions = realpathSync(join(installDir(env), 'versions'))
    return realpathSync(root).startsWith(versions + sep)
  } catch {
    // versions/ ou la racine absents : ce n'est pas une installation
    return false
  }
}

/** Commande pour lancer herness : binaire direct, ou node et un script. */
export interface HernessCommand {
  cmd: string
  args: string[]
}

/** Lanceur installé si ce processus tourne depuis versions/ et que current/bin/herness existe, sinon node et bin/herness.js. */
export function hernessCommand(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): HernessCommand {
  const bin = installedBin(env)
  if (runsInstalled(env, root) && existsSync(bin)) return { cmd: bin, args: [] }
  return { cmd: 'node', args: [join(root, 'bin', 'herness.js')] }
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Ligne à taper dans un panneau herdr : node reste nu, les autres chemins sont cités pour le shell. */
export function shellLine(c: HernessCommand, words: string): string {
  const cmd = c.cmd === 'node' ? c.cmd : shq(c.cmd)
  const args = c.args.map(shq).join(' ')
  return `${args ? `${cmd} ${args}` : cmd} ${words}`
}

/** Version déclarée par current/package.json, ou null si elle est absente, illisible ou vide. */
export function installedVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(installDir(env), 'current', 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    // fichier absent ou JSON invalide : pas de version connue
    return null
  }
}

/** Bandeau si ce processus tourne depuis une installation dont la version active diffère, sinon null. */
export function staleNotice(own: string, env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): string | null {
  if (!runsInstalled(env, root)) return null
  const installed = installedVersion(env)
  if (installed === null || installed === own) return null
  return `herness ${installed} installé, ce cockpit tourne en ${own} : quitte-le et relance herness`
}

export interface UpdateDeps {
  /** Lance install.sh avec ces arguments ; lève s'il échoue. */
  install: (args: string[]) => Promise<void>
  /** `herness resume <id> --restart` avec la version fraîchement installée. */
  restart: (id: string) => Promise<void>
  isTTY: boolean
  confirm: (question: string) => Promise<boolean>
  out: (line: string) => void
}

/** Vrai pour une version `0.y.z` avec `y < 9` (préfixe `v` toléré) : herness d'avant le passage à l'anglais. */
export function isPreEnglish(version: string): boolean {
  const match = /^(?:v)?0\.(\d+)\.\d+$/.exec(version)
  return match !== null && Number(match[1]) < 9
}

export interface ListedMissions {
  /** Missions non terminées, non bloquées, au format courant. */
  running: MissionState[]
  /** Missions héritées non terminées, étape `blocked` comprise. */
  legacy: MissionState[]
}

/** Missions dont le moteur, le tableau et les visionneuses tournent encore sur l'ancien code. */
export async function runningMissions(): Promise<ListedMissions> {
  const ids = (await readdir(missionsRoot()).catch(() => [] as string[])).sort()
  const running: MissionState[] = []
  const legacy: MissionState[] = []
  for (const id of ids) {
    try {
      const s = await loadState(id)
      if (isFinished(s)) continue
      if (isLegacy(s)) {
        legacy.push(s)
        continue
      }
      // Bloquée : rien ne tourne, et `resume` y ouvrirait une porte de reprise.
      if (s.step !== 'blocked') running.push(s)
    } catch {
      // état illisible ou dossier étranger : ignoré
    }
  }
  return { running, legacy }
}

/**
 * `herness update [--version x.y.z]` : installe la version par install.sh, puis
 * propose de redémarrer les missions en cours pour qu'elles passent au nouveau code.
 * Une version antérieure à l'anglais ne sait pas lire les missions créées après : on ne propose rien.
 */
export async function update(opts: { version?: string }, deps: UpdateDeps, list: () => Promise<ListedMissions> = runningMissions): Promise<void> {
  await deps.install(opts.version ? ['--version', opts.version] : [])
  if (opts.version && isPreEnglish(opts.version)) {
    deps.out(`herness ${opts.version} cannot read missions created by newer versions.`)
    deps.out('Missions it started can be restarted with: herness reprendre <id> --redemarrer')
    return
  }
  const { running: missions, legacy } = await list()
  for (const s of legacy) {
    try {
      assertResumable(s)
    } catch (e) {
      deps.out(e instanceof Error ? e.message : String(e))
    }
  }
  if (missions.length === 0) return
  deps.out(`Missions still running on the old code: ${missions.map((s) => s.id).join(', ')}`)
  if (!deps.isTTY) {
    for (const s of missions) deps.out(`  herness resume ${s.id} --restart`)
    return
  }
  if (!(await deps.confirm('Restart them on the new version?'))) {
    deps.out('Later: herness resume <id> --restart')
    return
  }
  const failed: string[] = []
  for (const s of missions) {
    try {
      await deps.restart(s.id)
    } catch (e) {
      failed.push(s.id)
      deps.out(`${s.id} : redémarrage échoué : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failed.length) throw new Error(`redémarrage à relancer à la main : ${failed.map((id) => `herness resume ${id} --restart`).join(' ; ')}`)
}
