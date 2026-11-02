import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { run, type RunResult } from '../exec.ts'
import { missionsRoot } from '../paths.ts'
import type { PrInfo } from './model.ts'

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>

const TTL_MS = 5 * 60 * 1000
const STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])

export class PrCache {
  private entries: Record<string, PrInfo> = {}

  constructor(
    private file: string = join(missionsRoot(), '..', 'pr-cache.json'),
    private runner: Runner = run,
    private now: () => Date = () => new Date(),
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [url, v] of Object.entries(raw)) {
          const e = v as Partial<PrInfo> | null
          if (e && typeof e.checkedAt === 'string' && STATES.has(e.state as string)) this.entries[url] = e as PrInfo
        }
      }
    } catch {
      // fichier absent ou illisible : cache vide
    }
  }

  get(url: string): PrInfo | undefined {
    return this.entries[url]
  }

  async refresh(urls: string[]): Promise<void> {
    let changed = false
    for (const url of urls) {
      const cur = this.entries[url]
      if (cur && this.now().getTime() - new Date(cur.checkedAt).getTime() < TTL_MS) continue
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
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify(this.entries, null, 2) + '\n')
    } catch {
      // cache non persisté : sans conséquence
    }
  }
}
