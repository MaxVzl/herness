import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { decide } from '../engine/gates.ts'
import { realEffects } from '../engine/effects.ts'
import { closeMission, deleteMission, resumeMission, startMission, type LifecycleDeps } from '../lifecycle.ts'
import type { MissionState } from '../mission/state.ts'
import { missionDir } from '../paths.ts'
import { hernessCommand } from '../update.ts'

export type ActionResult = { ok: boolean; lines: string[] }

/** Subset of `child_process.spawn` used for the detached restart; injectable for tests. */
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
 * Real dependencies, built at call time (no effect is created at import). `log` receives herdr logs:
 * inside an ink interface, nothing must write directly to the terminal.
 */
export function realActionDeps(cwd: string, log?: (message: string) => void): ActionDeps {
  return { lifecycle: { e: realEffects(log ? { log } : {}) }, decide, resume: resumeMission, close: closeMission, remove: deleteMission, start: startMission, cwd }
}

/** Runs an action, accumulating its output; any exception becomes `ok: false`. */
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
  if (note.trim() === '') return { ok: false, lines: ['a note is required to reject'] }
  return decideWith(id, 'refused', gateId, note, d)
}

/** `focus: false`: resume does not focus the master tab (the cockpit stays on screen, `o` opens it). */
export type ResumeOpts = { focus?: boolean }

export function resume(id: string, d: ActionDeps, o: ResumeOpts = {}): Promise<ActionResult> {
  return run((out) => d.resume(id, { ...d.lifecycle, out }, { restart: false, ...(o.focus === false ? { focus: false } : {}) }))
}

export function restart(id: string, d: ActionDeps, o: ResumeOpts = {}): Promise<ActionResult> {
  return run((out) => d.resume(id, { ...d.lifecycle, out }, { restart: true, ...(o.focus === false ? { focus: false } : {}) }))
}

/**
 * Restart launched outside this process: from the mission's `tasks` panel, `resumeMission` would interrupt this
 * panel itself mid-restart. `herness resume <id> --restart` survives that interruption; its
 * output goes to `<mission>/logs/restart-<timestamp>.log` (nothing is written to the ink terminal).
 */
export function restartDetached(
  id: string,
  spawn: Spawner = nodeSpawn as unknown as Spawner,
  now: () => Date = () => new Date(),
): Promise<ActionResult> {
  return run(async (out) => {
    const dir = join(missionDir(id), 'logs')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, `restart-${now().toISOString().replace(/[:.]/g, '-')}.log`)
    const fd = openSync(log, 'a')
    try {
      const c = hernessCommand()
      const child = spawn(c.cmd, [...c.args, 'resume', id, '--restart'], { detached: true, stdio: ['ignore', fd, fd] })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (err) => reject(err ?? new Error('cannot start')))
      })
      child.unref()
    } finally {
      // The child keeps its own copy of the descriptor.
      closeSync(fd)
    }
    out(`restart started (this panel will relaunch); log: ${log}`)
  })
}

export function close(id: string, d: ActionDeps, confirm: (q: string) => Promise<boolean>): Promise<ActionResult> {
  return run((out) => d.close(id, { ...d.lifecycle, out, isTTY: true, confirm }))
}

/** Confirmation already happened in the interface (`D` then Enter). */
export function remove(id: string, d: ActionDeps): Promise<ActionResult> {
  return run((out) => d.remove(id, { ...d.lifecycle, out }, { force: true }))
}

export function open(s: MissionState, d: ActionDeps): Promise<ActionResult> {
  const ws = s.herdr.workspace
  if (!ws) return Promise.resolve({ ok: false, lines: ['unknown herdr workspace'] })
  return run(async () => { await d.lifecycle.e.herdr.workspaceFocus(ws) })
}

export function startNew(input: string, d: ActionDeps, note?: string): Promise<ActionResult> {
  // startMission itself announces "Mission <id> started …".
  return run(async (out) => { await d.start(input, d.cwd, { ...d.lifecycle, out }, note !== undefined ? { note } : {}) })
}
