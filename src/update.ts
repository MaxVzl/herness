import { execa } from 'execa'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertResumable, isFinished, isLegacy, loadState, type MissionState } from './mission/state.ts'
import { missionsRoot } from './paths.ts'

export const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/MaxVzl/herness/main/install.sh'

/** Root of the package currently running. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Install directory: HERNESS_INSTALL_DIR, otherwise $XDG_DATA_HOME/herness, otherwise ~/.local/share/herness. */
export function installDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERNESS_INSTALL_DIR || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'herness')
}

/** Launcher of the active version, placed by install.sh: it is what executes the new code. */
export function installedBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(installDir(env), 'current', 'bin', 'herness')
}

type InstalledExec = (file: string, args: string[], opts: { stdio: 'inherit' }) => Promise<unknown>

/** `herness resume <id> --restart` with the freshly installed binary. */
export async function restartInstalled(
  id: string,
  exec: InstalledExec = (file, args, opts) => execa(file, args, opts),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await exec(installedBin(env), ['resume', id, '--restart'], { stdio: 'inherit' })
}

/** True when the process's real root is strictly under the installation's versions/ directory. */
export function runsInstalled(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): boolean {
  try {
    const versions = realpathSync(join(installDir(env), 'versions'))
    return realpathSync(root).startsWith(versions + sep)
  } catch {
    // versions/ or the root is missing: this is not an installation
    return false
  }
}

/** Command used to launch herness: a direct binary, or node and a script. */
export interface HernessCommand {
  cmd: string
  args: string[]
}

/** Installed launcher when this process runs from versions/ and current/bin/herness exists, otherwise node and bin/herness.js. */
export function hernessCommand(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): HernessCommand {
  const bin = installedBin(env)
  if (runsInstalled(env, root) && existsSync(bin)) return { cmd: bin, args: [] }
  return { cmd: 'node', args: [join(root, 'bin', 'herness.js')] }
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Line to type in a herdr pane: node stays bare, other paths are quoted for the shell. */
export function shellLine(c: HernessCommand, words: string): string {
  const cmd = c.cmd === 'node' ? c.cmd : shq(c.cmd)
  const args = c.args.map(shq).join(' ')
  return `${args ? `${cmd} ${args}` : cmd} ${words}`
}

/** Version declared by current/package.json, or null when it is missing, unreadable or empty. */
export function installedVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(installDir(env), 'current', 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    // missing file or invalid JSON: no known version
    return null
  }
}

/** Banner when this process runs from an installation whose active version differs, otherwise null. */
export function staleNotice(own: string, env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): string | null {
  if (!runsInstalled(env, root)) return null
  const installed = installedVersion(env)
  if (installed === null || installed === own) return null
  return `herness ${installed} is installed, this cockpit is running ${own}: quit it and start herness again`
}

export interface UpdateDeps {
  /** Runs install.sh with these arguments; throws when it fails. */
  install: (args: string[]) => Promise<void>
  /** `herness resume <id> --restart` with the freshly installed version. */
  restart: (id: string) => Promise<void>
  isTTY: boolean
  confirm: (question: string) => Promise<boolean>
  out: (line: string) => void
}

/** True for a `0.y.z` version with `y < 9` (`v` prefix tolerated): herness from before the switch to English. */
export function isPreEnglish(version: string): boolean {
  const match = /^(?:v)?0\.(\d+)\.\d+$/.exec(version)
  return match !== null && Number(match[1]) < 9
}

export interface ListedMissions {
  /** Unfinished, unblocked missions, in the current format. */
  running: MissionState[]
  /** Unfinished legacy missions, including step `blocked`. */
  legacy: MissionState[]
}

/** Missions whose engine, dashboard and viewers are still running the old code. */
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
      // Blocked: nothing is running, and `resume` would open a resume gate.
      if (s.step !== 'blocked') running.push(s)
    } catch {
      // unreadable state or foreign directory: ignored
    }
  }
  return { running, legacy }
}

/**
 * `herness update [--version x.y.z]`: installs the version through install.sh, then
 * offers to restart running missions so they pick up the new code.
 * A version from before the switch to English cannot read missions created afterwards: nothing is offered.
 */
export async function update(opts: { version?: string }, deps: UpdateDeps, list: () => Promise<ListedMissions> = runningMissions): Promise<void> {
  await deps.install(opts.version ? ['--version', opts.version] : [])
  if (opts.version && isPreEnglish(opts.version)) {
    deps.out(`herness ${opts.version} cannot read missions created by newer versions.`)
    // Compatibility: 0.8 still uses this command line.
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
      deps.out(`${s.id}: restart failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failed.length) throw new Error(`restart these by hand: ${failed.map((id) => `herness resume ${id} --restart`).join('; ')}`)
}
