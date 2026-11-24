import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'

export type DocKind = 'spec' | 'plan'
export type DocState = Pick<MissionState, 'id' | 'slug' | 'worktree' | 'createdAt'>
export type ResolvedDoc = { path: string; proposed: boolean } | { missing: true; expected?: string }

export const PROPOSED_HEADER = "pending amendment proposal"

/** Which file to show: the amendment proposal wins, then the worktree file, otherwise nothing yet. */
export function resolveDoc(kind: DocKind, s: DocState, dir: string, exists: (path: string) => boolean): ResolvedDoc {
  const proposed = join(dir, `${kind}.proposed.md`)
  if (exists(proposed)) return { path: proposed, proposed: true }
  if (s.slug && s.worktree) {
    const expected = join(s.worktree, (kind === 'spec' ? specPath : planPath)({ id: s.id, slug: s.slug, createdAt: s.createdAt }))
    if (exists(expected)) return { path: expected, proposed: false }
    return { missing: true, expected }
  }
  return { missing: true }
}

export interface ViewerChild {
  /** Stops the viewer (and everything it started); resolves when it has really exited. */
  kill(): Promise<void>
  /** Called when the process exits (including after `kill`). */
  onExit(cb: () => void): void
}

export interface ViewerDeps {
  readState(): Promise<DocState>
  exists(path: string): boolean
  /** Modification time in ms, or `null` if unreadable. */
  mtime(path: string): number | null
  /** Starts the viewer; may throw (file gone in the meantime). */
  spawn(path: string, proposed: boolean): ViewerChild
  print(line: string): void
  /** Listens for Enter (only once the viewer has exited); `pressed` consumes it. */
  input: { start(): void; stop(): void; pressed(): boolean }
}

/** Observation loop: `tick` is called every second and only ever reads state.json. */
export class DocViewer {
  private child: ViewerChild | undefined
  private shown: string | undefined
  private exited = false
  private lastMessage: string | undefined
  private pending: string | undefined

  constructor(private readonly kind: DocKind, private readonly dir: string, private readonly d: ViewerDeps) {}

  private say(message: string): void {
    if (message === this.lastMessage) return
    this.lastMessage = message
    this.d.print(message)
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.d.input.stop()
    await child?.kill()
  }

  private open(path: string, proposed: boolean): void {
    this.d.input.stop()
    this.exited = false
    this.lastMessage = undefined
    const child = this.d.spawn(path, proposed)
    this.child = child
    // A child that was killed then replaced must not mark the new one as exited.
    child.onExit(() => {
      if (this.child !== child) return
      this.child = undefined
      this.exited = true
    })
  }

  async tick(): Promise<void> {
    let resolved: ResolvedDoc
    try {
      resolved = resolveDoc(this.kind, await this.d.readState(), this.dir, this.d.exists)
    } catch (e) {
      this.say(`unreadable state, retrying: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if ('missing' in resolved) {
      await this.stopChild()
      this.shown = undefined
      this.pending = undefined
      this.exited = false
      this.say(`${this.kind} not written yet${resolved.expected ? `\n${resolved.expected}` : ''}`)
      return
    }
    const mtime = this.d.mtime(resolved.path)
    if (mtime === null) {
      this.say(`${resolved.path} unreadable, retrying`)
      return
    }
    const key = `${resolved.path}\0${mtime}`
    if (key !== this.shown) {
      // Replacing a view requires the file to have been stable for one tick (otherwise a write is in progress).
      if (this.shown !== undefined && this.pending !== key) {
        this.pending = key
        return
      }
      await this.stopChild()
      try {
        this.open(resolved.path, resolved.proposed)
      } catch (e) {
        // Not marked shown: the next tick retries.
        this.say(`${resolved.path} unreadable, retrying: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      this.shown = key
      this.pending = undefined
      return
    }
    this.pending = undefined
    if (this.exited) {
      this.say('press Enter to reopen')
      this.d.input.start()
      if (this.d.input.pressed()) {
        try {
          this.open(resolved.path, resolved.proposed)
        } catch (e) {
          this.say(`${resolved.path} unreadable, retrying: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.stopChild()
  }
}

// ---------- real effects ----------

function onPath(cmd: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch {
      // next
    }
  }
  return false
}

const KILL_GRACE_MS = 2000

/**
 * The only long-lived child is `less -R`, whose input receives the optional header then the `bat` output (no pager);
 * without `bat`, the raw content. No nested pager: killing `less` is enough, `bat` is killed with it.
 */
function realSpawn(file: string, proposed: boolean): ViewerChild {
  const useBat = onPath('bat')
  const raw = useBat ? undefined : readFileSync(file) // throws before launching anything
  const less = nodeSpawn('less', ['-R'], { stdio: ['pipe', 'inherit', 'inherit'] })
  less.stdin.on('error', () => {})
  if (proposed) less.stdin.write(`${PROPOSED_HEADER}\n\n`)
  let bat: ReturnType<typeof nodeSpawn> | undefined
  if (useBat) {
    bat = nodeSpawn('bat', ['--paging=never', '--color=always', '--style=header,grid', '--language=markdown', file], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    bat.on('error', () => less.stdin.end())
    bat.stdout?.pipe(less.stdin)
  } else {
    less.stdin.end(raw)
  }
  const cbs: (() => void)[] = []
  let done = false
  const exit = new Promise<void>((resolve) => {
    const fire = (): void => {
      if (done) return
      done = true
      bat?.kill('SIGTERM')
      for (const cb of cbs) cb()
      resolve()
    }
    less.on('exit', fire)
    less.on('error', fire)
  })
  return {
    async kill() {
      if (done) return
      bat?.kill('SIGTERM')
      less.kill('SIGTERM')
      const timer = setTimeout(() => less.kill('SIGKILL'), KILL_GRACE_MS)
      await exit
      clearTimeout(timer)
    },
    onExit: (cb) => (done ? cb() : void cbs.push(cb)),
  }
}

function realInput(): ViewerDeps['input'] {
  let rl: ReturnType<typeof createInterface> | undefined
  let flag = false
  return {
    start() {
      if (rl) return
      rl = createInterface({ input: process.stdin })
      rl.on('line', () => void (flag = true))
    },
    stop() {
      rl?.close()
      rl = undefined
      flag = false
    },
    pressed() {
      const was = flag
      flag = false
      return was
    },
  }
}

export function realViewerDeps(id: string): ViewerDeps {
  return {
    readState: () => loadState(id),
    exists: existsSync,
    mtime: (p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return null
      }
    },
    spawn: realSpawn,
    print: (l) => console.log(l),
    input: realInput(),
  }
}

/** `herness show <spec|plan> <id>`: runs until ctrl+c. */
export async function runViewer(kind: DocKind, id: string): Promise<void> {
  const viewer = new DocViewer(kind, missionDir(id), realViewerDeps(id))
  const stop = (): void => void viewer.close().finally(() => process.exit(0))
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop)
  for (;;) {
    await viewer.tick()
    await new Promise((r) => setTimeout(r, 1000))
  }
}
