import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'

export type DocKind = 'spec' | 'plan'
export type DocState = Pick<MissionState, 'id' | 'slug' | 'worktree' | 'createdAt'>
export type ResolvedDoc = { path: string; proposed: boolean } | { missing: true; expected?: string }

export const PROPOSED_HEADER = "proposition d'amendement en attente"

/** Quel fichier montrer : la proposition d'amendement gagne, puis le fichier du worktree, sinon rien (encore). */
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
  /** Termine l'afficheur (et tout ce qu'il a lancé) ; résolu quand il est vraiment sorti. */
  kill(): Promise<void>
  /** Appelé quand le processus se termine (y compris après `kill`). */
  onExit(cb: () => void): void
}

export interface ViewerDeps {
  readState(): Promise<DocState>
  exists(path: string): boolean
  /** Date de modification en ms, ou `null` si illisible. */
  mtime(path: string): number | null
  /** Lance l'afficheur ; peut lever (fichier disparu entre-temps). */
  spawn(path: string, proposed: boolean): ViewerChild
  print(line: string): void
  /** Écoute la touche Entrée (seulement quand l'afficheur est sorti) ; `pressed` la consomme. */
  input: { start(): void; stop(): void; pressed(): boolean }
}

/** Boucle d'observation : `tick` est appelé chaque seconde, ne lit ni n'écrit jamais state.json autrement qu'en lecture. */
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
    // Un enfant tué puis remplacé ne doit pas marquer le nouveau comme sorti.
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
      this.say(`état illisible, nouvel essai : ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if ('missing' in resolved) {
      await this.stopChild()
      this.shown = undefined
      this.pending = undefined
      this.exited = false
      this.say(`${this.kind} pas encore écrite${resolved.expected ? `\n${resolved.expected}` : ''}`)
      return
    }
    const mtime = this.d.mtime(resolved.path)
    if (mtime === null) {
      this.say(`${resolved.path} illisible, nouvel essai`)
      return
    }
    const key = `${resolved.path}\0${mtime}`
    if (key !== this.shown) {
      // Remplacer un affichage demande que le fichier soit stable depuis un tick (écriture en cours sinon).
      if (this.shown !== undefined && this.pending !== key) {
        this.pending = key
        return
      }
      await this.stopChild()
      try {
        this.open(resolved.path, resolved.proposed)
      } catch (e) {
        // Non marqué affiché : le prochain tick réessaie.
        this.say(`${resolved.path} illisible, nouvel essai : ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      this.shown = key
      this.pending = undefined
      return
    }
    this.pending = undefined
    if (this.exited) {
      this.say('appuie sur Entrée pour rouvrir')
      this.d.input.start()
      if (this.d.input.pressed()) {
        try {
          this.open(resolved.path, resolved.proposed)
        } catch (e) {
          this.say(`${resolved.path} illisible, nouvel essai : ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.stopChild()
  }
}

// ---------- effets réels ----------

function onPath(cmd: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch {
      // suivant
    }
  }
  return false
}

const KILL_GRACE_MS = 2000

/**
 * Seul enfant durable : `less -R`, dont l'entrée reçoit l'en-tête éventuel puis la sortie de `bat` (sans pager) ;
 * sans `bat`, le contenu brut. Aucun pager imbriqué : tuer `less` suffit, `bat` est tué avec lui.
 */
function realSpawn(file: string, proposed: boolean): ViewerChild {
  const useBat = onPath('bat')
  const raw = useBat ? undefined : readFileSync(file) // lève avant de lancer quoi que ce soit
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

/** `herness voir <spec|plan> <id>` : tourne jusqu'à ctrl+c. */
export async function runViewer(kind: DocKind, id: string): Promise<void> {
  const viewer = new DocViewer(kind, missionDir(id), realViewerDeps(id))
  const stop = (): void => void viewer.close().finally(() => process.exit(0))
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop)
  for (;;) {
    await viewer.tick()
    await new Promise((r) => setTimeout(r, 1000))
  }
}
