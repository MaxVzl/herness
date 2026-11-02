import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../engine/gates.ts'
import { realEffects } from '../engine/effects.ts'
import { closeMission, deleteMission, resumeMission, startMission, type LifecycleDeps } from '../lifecycle.ts'
import type { MissionState } from '../mission/state.ts'
import { missionDir } from '../paths.ts'

export type ActionResult = { ok: boolean; lines: string[] }

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'herness.js')

/** Sous-ensemble de `child_process.spawn` utilisé pour le redémarrage détaché ; injectable pour les tests. */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { detached: true; stdio: ['ignore', number, number] },
) => { unref(): void; once(event: 'spawn' | 'error', fn: (err?: Error) => void): unknown }

export interface ActionDeps {
  lifecycle: LifecycleDeps
  decide: typeof decide
  resume: typeof resumeMission
  close: typeof closeMission
  remove: typeof deleteMission
  start: typeof startMission
  cwd: string
}

/**
 * Dépendances réelles, construites à l'appel (aucun effet créé à l'import). `log` reçoit les journaux de herdr :
 * dans une interface ink, rien ne doit écrire directement dans le terminal.
 */
export function realActionDeps(cwd: string, log?: (message: string) => void): ActionDeps {
  return { lifecycle: { e: realEffects(log ? { log } : {}) }, decide, resume: resumeMission, close: closeMission, remove: deleteMission, start: startMission, cwd }
}

/** Exécute une action en accumulant sa sortie ; toute exception devient `ok: false`. */
async function run(fn: (out: (line: string) => void) => Promise<boolean | void>): Promise<ActionResult> {
  const lines: string[] = []
  try {
    const r = await fn((l) => lines.push(l))
    return { ok: r !== false, lines }
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err))
    return { ok: false, lines }
  }
}

const decideWith = (
  id: string,
  decision: 'approved' | 'refused',
  gateId: string,
  note: string | undefined,
  d: ActionDeps,
): Promise<ActionResult> =>
  run((out) => d.decide(id, decision, { gateId, ...(note !== undefined ? { note } : {}), isTTY: true, confirm: async () => true, out }))

export function validate(id: string, gateId: string, note: string | undefined, d: ActionDeps): Promise<ActionResult> {
  return decideWith(id, 'approved', gateId, note, d)
}

export async function refuse(id: string, gateId: string, note: string, d: ActionDeps): Promise<ActionResult> {
  if (note.trim() === '') return { ok: false, lines: ['une note est obligatoire pour refuser'] }
  return decideWith(id, 'refused', gateId, note, d)
}

/** `focus: false` : la reprise ne focalise pas l'onglet master (le cockpit reste à l'écran, `o` l'ouvre). */
export type ResumeOpts = { focus?: boolean }

export function resume(id: string, d: ActionDeps, o: ResumeOpts = {}): Promise<ActionResult> {
  return run((out) => d.resume(id, { ...d.lifecycle, out }, { restart: false, ...(o.focus === false ? { focus: false } : {}) }))
}

export function restart(id: string, d: ActionDeps, o: ResumeOpts = {}): Promise<ActionResult> {
  return run((out) => d.resume(id, { ...d.lifecycle, out }, { restart: true, ...(o.focus === false ? { focus: false } : {}) }))
}

/**
 * Redémarrage lancé hors de ce processus : depuis le panneau `tasks` de la mission, `resumeMission` interromprait ce
 * panneau lui-même au milieu du redémarrage. `herness reprendre <id> --redemarrer` survit à cette interruption ; sa
 * sortie va dans `<mission>/logs/redemarrage-<horodatage>.log` (rien n'est écrit dans le terminal d'ink).
 */
export function restartDetached(
  id: string,
  spawn: Spawner = nodeSpawn as unknown as Spawner,
  now: () => Date = () => new Date(),
): Promise<ActionResult> {
  return run(async (out) => {
    const dir = join(missionDir(id), 'logs')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, `redemarrage-${now().toISOString().replace(/[:.]/g, '-')}.log`)
    const fd = openSync(log, 'a')
    try {
      const child = spawn(process.execPath, [BIN, 'reprendre', id, '--redemarrer'], { detached: true, stdio: ['ignore', fd, fd] })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (err) => reject(err ?? new Error('lancement impossible')))
      })
      child.unref()
    } finally {
      // L'enfant garde sa propre copie du descripteur.
      closeSync(fd)
    }
    out(`redémarrage lancé (ce panneau va se relancer) ; journal : ${log}`)
  })
}

export function close(id: string, d: ActionDeps, confirm: (q: string) => Promise<boolean>): Promise<ActionResult> {
  return run((out) => d.close(id, { ...d.lifecycle, out, isTTY: true, confirm }))
}

/** La confirmation a déjà eu lieu dans l'interface (`x` puis Entrée). */
export function remove(id: string, d: ActionDeps): Promise<ActionResult> {
  return run((out) => d.remove(id, { ...d.lifecycle, out }, { force: true }))
}

export function open(s: MissionState, d: ActionDeps): Promise<ActionResult> {
  const ws = s.herdr.workspace
  if (!ws) return Promise.resolve({ ok: false, lines: ['espace herdr inconnu'] })
  return run(async () => { await d.lifecycle.e.herdr.workspaceFocus(ws) })
}

export function startNew(input: string, d: ActionDeps): Promise<ActionResult> {
  // startMission annonce elle-même « Mission <id> lancée … ».
  return run(async (out) => { await d.start(input, d.cwd, { ...d.lifecycle, out }) })
}
