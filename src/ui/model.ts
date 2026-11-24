import { readdir } from 'node:fs/promises'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionsRoot } from '../paths.ts'

export type Bucket = 'decision' | 'blocked' | 'active' | 'finished'
export type PrInfo = { state: 'OPEN' | 'MERGED' | 'CLOSED'; checkedAt: string }

const BUCKET_ORDER: Bucket[] = ['decision', 'blocked', 'active', 'finished']
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000

export function bucketOf(s: MissionState): Bucket {
  if (s.gates.some((g) => g.status === 'pending')) return 'decision'
  if (s.step === 'blocked') return 'blocked'
  if (s.step === 'pr-open' || s.step === 'closed') return 'finished'
  return 'active'
}

export function statusLabel(s: MissionState): string {
  const gate = s.gates.find((g) => g.status === 'pending')
  if (gate) return `gate ${gate.id}`
  if (s.step === 'blocked') return 'blocked'
  if (s.step === 'tasks' && s.tasks.length > 0) {
    const done = s.tasks.filter((t) => t.phase === 'done').length
    return `task ${Math.min(done + 1, s.tasks.length)}/${s.tasks.length}`
  }
  if (s.step === 'pr-open') {
    const n = s.prUrl?.match(/\/pull\/(\d+)/)?.[1]
    return n ? `PR #${n}` : 'PR open'
  }
  return s.step
}

export function shortId(id: string): string {
  const m = /^\d{6}(\d{2})-(\d+)$/.exec(id)
  return m ? `${m[1]}-${m[2]}` : id
}

function closedAt(s: MissionState): number {
  // "mission closed" is the English log line. "(herness close)" is what lifecycle still writes.
  // "mission fermée" matches logs from herness 0.8.
  const entry = [...s.log].reverse().find((l) => /mission closed|\(herness close\)|mission fermée/.test(l.msg))
  return new Date(entry?.at ?? s.createdAt).getTime()
}

/**
 * Hidden finished mission: merged PR, or a mission closed for more than 7 days with no PR or with a CLOSED PR.
 * A `pr-open` whose PR is CLOSED stays visible: it needs an action.
 */
export function isHidden(s: MissionState, pr: PrInfo | undefined, now: Date): boolean {
  if (s.step === 'pr-open') return pr?.state === 'MERGED'
  if (s.step === 'closed') {
    if (pr?.state === 'MERGED') return true
    if (s.prUrl && pr?.state !== 'CLOSED') return false
    return now.getTime() - closedAt(s) > SEVEN_DAYS_MS
  }
  return false
}

/** PR state to refresh: neither merged, nor CLOSED on a mission hidden by the 7-day rule. */
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
      // unreadable state or foreign directory: ignored
    }
  }
  return out
}

export function sortMissions(list: MissionState[]): MissionState[] {
  return [...list].sort((a, b) =>
    BUCKET_ORDER.indexOf(bucketOf(a)) - BUCKET_ORDER.indexOf(bucketOf(b))
    || b.createdAt.localeCompare(a.createdAt))
}
