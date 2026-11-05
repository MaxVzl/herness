import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadState, type MissionState } from './mission/state.ts'
import { missionsRoot } from './paths.ts'

export const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/MaxVzl/herness/main/install.sh'

/** Lanceur de la version active, posé par install.sh : c'est lui qui exécute le nouveau code. */
export function installedBin(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.HERNESS_INSTALL_DIR || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'herness')
  return join(data, 'current', 'bin', 'herness')
}

export interface UpdateDeps {
  /** Lance install.sh avec ces arguments ; lève s'il échoue. */
  install: (args: string[]) => Promise<void>
  /** `herness reprendre <id> --redemarrer` avec la version fraîchement installée. */
  restart: (id: string) => Promise<void>
  isTTY: boolean
  confirm: (question: string) => Promise<boolean>
  out: (line: string) => void
}

/** Missions dont le moteur, le tableau et les visionneuses tournent encore sur l'ancien code. */
export async function runningMissions(): Promise<MissionState[]> {
  const ids = (await readdir(missionsRoot()).catch(() => [] as string[])).sort()
  const out: MissionState[] = []
  for (const id of ids) {
    try {
      const s = await loadState(id)
      // Bloquée : rien ne tourne, et `reprendre` y ouvrirait une porte de reprise.
      if (s.step !== 'pr-ouverte' && s.step !== 'fermée' && s.step !== 'bloquée') out.push(s)
    } catch {
      // état illisible ou dossier étranger : ignoré
    }
  }
  return out
}

/**
 * `herness mise-a-jour [--version x.y.z]` : installe la version par install.sh, puis
 * propose de redémarrer les missions en cours pour qu'elles passent au nouveau code.
 */
export async function update(opts: { version?: string }, deps: UpdateDeps, list: () => Promise<MissionState[]> = runningMissions): Promise<void> {
  await deps.install(opts.version ? ['--version', opts.version] : [])
  const missions = await list()
  if (missions.length === 0) return
  deps.out(`Missions en cours, encore sur l'ancien code : ${missions.map((s) => s.id).join(', ')}`)
  if (!deps.isTTY) {
    for (const s of missions) deps.out(`  herness reprendre ${s.id} --redemarrer`)
    return
  }
  if (!(await deps.confirm('Les redémarrer sur la nouvelle version ?'))) {
    deps.out(`Plus tard : herness reprendre <id> --redemarrer`)
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
  if (failed.length) throw new Error(`redémarrage à relancer à la main : ${failed.map((id) => `herness reprendre ${id} --redemarrer`).join(' ; ')}`)
}
