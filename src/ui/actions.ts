import { spawn as nodeSpawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../engine/gates.ts'
import { realEffects } from '../engine/effects.ts'
import { closeMission, resumeMission, startMission, type LifecycleDeps } from '../lifecycle.ts'
import type { MissionState } from '../mission/state.ts'

export type ActionResult = { ok: boolean; lines: string[] }

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'herness.js')

/** Sous-ensemble de `child_process.spawn` utilisé pour le redémarrage détaché ; injectable pour les tests. */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { detached: true; stdio: 'ignore' },
) => { unref(): void; once(event: 'spawn' | 'error', fn: (err?: Error) => void): unknown }

export interface ActionDeps {
  lifecycle: LifecycleDeps
  decide: typeof decide
  resume: typeof resumeMission
  close: typeof closeMission
  start: typeof startMission
  cwd: string
}

/**
 * Dépendances réelles, construites à l'appel (aucun effet créé à l'import). `log` reçoit les journaux de herdr :
 * dans une interface ink, rien ne doit écrire directement dans le terminal.
 */
export function realActionDeps(cwd: string, log?: (message: string) => void): ActionDeps {
  return { lifecycle: { e: realEffects(log ? { log } : {}) }, decide, resume: resumeMission, close: closeMission, start: startMission, cwd }
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

export function resume(id: string, d: ActionDeps): Promise<ActionResult> {
  return run((out) => d.resume(id, { ...d.lifecycle, out }, { restart: false }))
}

export function restart(id: string, d: ActionDeps): Promise<ActionResult> {
  return run((out) => d.resume(id, { ...d.lifecycle, out }, { restart: true }))
}

/**
 * Redémarrage lancé hors de ce processus : depuis le panneau `tasks` de la mission, `resumeMission` interromprait ce
 * panneau lui-même au milieu du redémarrage. `herness reprendre <id> --redemarrer` survit à cette interruption.
 */
export function restartDetached(id: string, spawn: Spawner = nodeSpawn as unknown as Spawner): Promise<ActionResult> {
  return run(async (out) => {
    const child = spawn('node', [BIN, 'reprendre', id, '--redemarrer'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (err) => reject(err ?? new Error('lancement impossible')))
    })
    child.unref()
    out('redémarrage lancé (ce panneau va se relancer)')
  })
}

export function close(id: string, d: ActionDeps, confirm: (q: string) => Promise<boolean>): Promise<ActionResult> {
  return run((out) => d.close(id, { ...d.lifecycle, out, isTTY: true, confirm }))
}

export function open(s: MissionState, d: ActionDeps): Promise<ActionResult> {
  const ws = s.herdr.workspace
  if (!ws) return Promise.resolve({ ok: false, lines: ['espace herdr inconnu'] })
  return run(async () => { await d.lifecycle.e.herdr.workspaceFocus(ws) })
}

export function startNew(input: string, d: ActionDeps): Promise<ActionResult> {
  return run(async (out) => {
    const id = await d.start(input, d.cwd, { ...d.lifecycle, out })
    out(`mission ${id} lancée`)
  })
}
