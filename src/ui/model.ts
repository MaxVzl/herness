import { readdir } from 'node:fs/promises'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionsRoot } from '../paths.ts'

export type Bucket = 'decision' | 'bloquee' | 'active' | 'terminee'
export type PrInfo = { state: 'OPEN' | 'MERGED' | 'CLOSED'; checkedAt: string }

const BUCKET_ORDER: Bucket[] = ['decision', 'bloquee', 'active', 'terminee']
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000

export function bucketOf(s: MissionState): Bucket {
  if (s.gates.some((g) => g.status === 'pending')) return 'decision'
  if (s.step === 'bloquée') return 'bloquee'
  if (s.step === 'pr-ouverte' || s.step === 'fermée') return 'terminee'
  return 'active'
}

export function statusLabel(s: MissionState): string {
  const gate = s.gates.find((g) => g.status === 'pending')
  if (gate) return `porte ${gate.id}`
  if (s.step === 'bloquée') return 'bloquée'
  if (s.step === 'tasks' && s.tasks.length > 0) {
    const done = s.tasks.filter((t) => t.phase === 'done').length
    return `tâche ${Math.min(done + 1, s.tasks.length)}/${s.tasks.length}`
  }
  if (s.step === 'pr-ouverte') {
    const n = s.prUrl?.match(/\/pull\/(\d+)/)?.[1]
    return n ? `PR #${n}` : 'PR ouverte'
  }
  return s.step
}

export function shortId(id: string): string {
  const m = /^\d{6}(\d{2})-(\d+)$/.exec(id)
  return m ? `${m[1]}-${m[2]}` : id
}

function closedAt(s: MissionState): number {
  const entry = [...s.log].reverse().find((l) => /mission fermée/.test(l.msg))
  return new Date(entry?.at ?? s.createdAt).getTime()
}

/**
 * Mission terminée masquée : PR mergée, ou mission fermée depuis plus de 7 jours sans PR ou avec une PR CLOSED.
 * Une `pr-ouverte` dont la PR est CLOSED reste visible : elle demande une action.
 */
export function isHidden(s: MissionState, pr: PrInfo | undefined, now: Date): boolean {
  if (s.step === 'pr-ouverte') return pr?.state === 'MERGED'
  if (s.step === 'fermée') {
    if (pr?.state === 'MERGED') return true
    if (s.prUrl && pr?.state !== 'CLOSED') return false
    return now.getTime() - closedAt(s) > SEVEN_DAYS_MS
  }
  return false
}

/** État de PR à revérifier : ni mergée, ni CLOSED d'une mission masquée par la règle des 7 jours. */
export function needsPrRefresh(s: MissionState, pr: PrInfo | undefined, now: Date): boolean {
  if (!s.prUrl || pr?.state === 'MERGED') return false
  return !(pr?.state === 'CLOSED' && isHidden(s, pr, now))
}

export async function projectMissions(repoPath: string): Promise<MissionState[]> {
  let ids: string[]
  try {
    ids = await readdir(missionsRoot())
  } catch {
    return []
  }
  const out: MissionState[] = []
  for (const id of ids) {
    try {
      const s = await loadState(id)
      if (s.repoPath === repoPath) out.push(s)
    } catch {
      // état illisible ou dossier étranger : ignoré
    }
  }
  return out
}

export function sortMissions(list: MissionState[]): MissionState[] {
  return [...list].sort((a, b) =>
    BUCKET_ORDER.indexOf(bucketOf(a)) - BUCKET_ORDER.indexOf(bucketOf(b))
    || b.createdAt.localeCompare(a.createdAt))
}
