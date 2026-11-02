import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { run, type RunResult } from '../exec.ts'
import { missionsRoot } from '../paths.ts'
import type { PrInfo } from './model.ts'

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>

const TTL_MS = 5 * 60 * 1000
const STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])

export class PrCache {
  private readFile(): Record<string, PrInfo> {
    const out: Record<string, PrInfo> = {}
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [url, v] of Object.entries(raw)) {
          const e = v as Partial<PrInfo> | null
          if (e && typeof e.checkedAt === 'string' && STATES.has(e.state as string)) out[url] = e as PrInfo
        }
      }
    } catch {
      // fichier absent ou illisible : cache vide
    }
    return out
  }

  private entries: Record<string, PrInfo> = {}
  /** Dernier appel à gh par URL, réussi ou non : un gh en échec n'est pas rappelé à chaque rafraîchissement. */
  private lastAttempt: Record<string, number> = {}

  constructor(
    private file: string = join(missionsRoot(), '..', 'pr-cache.json'),
    private runner: Runner = run,
    private now: () => Date = () => new Date(),
  ) {
    this.entries = this.readFile()
  }

  get(url: string): PrInfo | undefined {
    return this.entries[url]
  }

  async refresh(urls: string[]): Promise<void> {
    let changed = false
    for (const url of urls) {
      const t = this.now().getTime()
      const cur = this.entries[url]
      if (cur && t - new Date(cur.checkedAt).getTime() < TTL_MS) continue
      const last = this.lastAttempt[url]
      if (last !== undefined && t - last < TTL_MS) continue
      this.lastAttempt[url] = t
      try {
        const r = await this.runner('gh', ['pr', 'view', url, '--json', 'state'])
        const state = (JSON.parse(r.stdout) as { state?: unknown }).state
        if (r.exitCode !== 0 || typeof state !== 'string' || !STATES.has(state)) continue
        this.entries[url] = { state: state as PrInfo['state'], checkedAt: this.now().toISOString() }
        changed = true
      } catch {
        // gh absent, réseau coupé, sortie invalide : on garde l'entrée existante
      }
    }
    if (!changed) return
    try {
      // Relit juste avant d'écrire : on garde l'entrée la plus récente de chaque URL (autre instance possible).
      const merged = this.readFile()
      for (const [url, e] of Object.entries(this.entries)) {
        const o = merged[url]
        if (!o || e.checkedAt >= o.checkedAt) merged[url] = e
      }
      this.entries = merged
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n')
      await rename(tmp, this.file)
    } catch {
      // cache non persisté : sans conséquence
    }
  }
}
