import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  diagnosticName,
  globalFixerName,
  globalReviewerName,
  implName,
  preflightFixerName,
  reviewerName,
  strongName,
} from '../agents/names.ts'
import type { MissionState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { awaitingReply, type ChatItem } from './transcript.ts'
import { bucketOf, isHidden, statusLabel, type PrInfo } from '../ui/model.ts'
import type { Badge, CheckView, DocView, MissionSummary } from './protocol.ts'

const FIXED_PANES = new Set(['orchestrator', 'tasks', 'lazygit', 'engine', 'spec', 'plan'])
const BUCKETS: MissionSummary['bucket'][] = ['decision', 'bloquee', 'active', 'terminee']

export function badgeOf(s: MissionState, orchestratorState: string | null, items: ChatItem[]): Badge | undefined {
  if (s.step === 'pr-ouverte' || s.step === 'fermée') return undefined
  if (orchestratorState === 'blocked') return 'attend-herdr'
  if (orchestratorState && orchestratorState !== 'working' && awaitingReply(items)) return 'attend-reponse'
  return undefined
}

export function summarize(s: MissionState, pr: PrInfo | undefined, badge: Badge | undefined, now: Date): MissionSummary {
  const title = s.slug ?? Array.from(s.source.ref).slice(0, 60).join('')
  let bucket = bucketOf(s)
  if (bucket === 'active' && badge) bucket = 'decision'
  return {
    id: s.id,
    project: s.project,
    title,
    status: statusLabel(s),
    bucket,
    ...(badge ? { badge } : {}),
    hidden: isHidden(s, pr, now),
    createdAt: s.createdAt,
    step: s.step,
  }
}

export function sortSummaries(list: MissionSummary[]): MissionSummary[] {
  return [...list].sort((a, b) =>
    BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) || b.createdAt.localeCompare(a.createdAt))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileNames(dir: string): Promise<string[] | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  } catch {
    return undefined
  }
}

/** Fichiers présents dans `taches/<n>/`, `global/` et `preflight/`. */
export async function missionFiles(id: string): Promise<Record<string, string[]>> {
  const root = missionDir(id)
  const out: Record<string, string[]> = {}
  const tasks = await readdir(join(root, 'taches'), { withFileTypes: true }).catch(() => [])
  for (const entry of tasks) {
    if (!entry.isDirectory()) continue
    const names = await fileNames(join(root, 'taches', entry.name))
    if (names) out[`taches/${entry.name}`] = names
  }
  for (const dir of ['global', 'preflight'] as const) {
    const names = await fileNames(join(root, dir))
    if (names) out[dir] = names
  }
  return out
}

export async function readDoc(s: MissionState, kind: 'spec' | 'plan'): Promise<DocView> {
  const dir = missionDir(s.id)
  const proposed = join(dir, `${kind}.proposed.md`)
  const worktreeFile = s.slug && s.worktree
    ? join(s.worktree, (kind === 'spec' ? specPath : planPath)(s))
    : undefined
  if (await isFile(proposed)) {
    const text = await readText(proposed)
    if (text !== undefined) {
      const current = worktreeFile && await isFile(worktreeFile) ? await readText(worktreeFile) ?? null : null
      return { source: 'proposition', text, current }
    }
  }
  const worktreeGone = Boolean(s.worktree) && !(await isDir(s.worktree as string))
  if (worktreeFile && !worktreeGone && await isFile(worktreeFile)) {
    const text = await readText(worktreeFile)
    if (text !== undefined) return { source: 'worktree', text }
  }
  if (worktreeGone && kind === 'plan') {
    const approved = join(dir, 'plan.approved.md')
    if (await isFile(approved)) {
      const text = await readText(approved)
      if (text !== undefined) return { source: 'approuve', text }
    }
  }
  if (worktreeGone && kind === 'spec') {
    return { source: 'absent', reason: 'worktree supprimé : spec plus disponible ici' }
  }
  return { source: 'absent', reason: 'pas encore écrit' }
}

/** Journaux `<horodatage>-<libellé>.log` de la mission, du plus récent au plus ancien. */
export async function checksOf(id: string, now: Date): Promise<CheckView[]> {
  const dir = join(missionDir(id), 'logs')
  const names = await readdir(dir).catch(() => [] as string[])
  const checks: CheckView[] = []
  for (const file of names) {
    if (!file.endsWith('.log') || file.startsWith('redemarrage-')) continue
    const match = /^(\d+)-(.+)\.log$/.exec(file)
    const slug = match?.[2]
    const stampRaw = match?.[1]
    if (!slug || !stampRaw) continue
    const stamp = Number(stampRaw)
    const logPath = join(dir, file)
    try {
      const logStat = await stat(logPath)
      const exitPath = join(dir, `${file.slice(0, -4)}.exit`)
      let status: CheckView['status'] = 'en-cours'
      let end = now.getTime()
      let errorTail: string | undefined
      if (await isFile(exitPath)) {
        const code = (await readFile(exitPath, 'utf8')).trim()
        end = Math.round((await stat(exitPath)).mtimeMs)
        if (code === '0') status = 'vert'
        else {
          status = 'rouge'
          const lines = (await readFile(logPath, 'utf8')).split('\n').filter((line) => line.trim() !== '')
          errorTail = lines.slice(-8).join('\n')
        }
      }
      checks.push({
        file,
        label: slug.replace(/-/g, ' '),
        status,
        startedAt: new Date(stamp).toISOString(),
        durationMs: Math.max(0, Math.round(end) - stamp),
        lastOutputAt: new Date(Math.round(logStat.mtimeMs)).toISOString(),
        ...(errorTail !== undefined ? { errorTail } : {}),
      })
    } catch {
      // journal disparu entre la liste et la lecture
    }
  }
  checks.sort((a, b) => Number(/^(\d+)/.exec(b.file)?.[1] ?? 0) - Number(/^(\d+)/.exec(a.file)?.[1] ?? 0))
  return checks
}

type AgentRef = { name: string; role: string; tool: 'Claude' | 'Cursor'; task?: number }

function classifyAgent(s: MissionState, name: string): AgentRef {
  const id = s.id
  for (let n = 1; n <= 64; n++) {
    if (name === strongName(id, n)) return { name, role: 'Implémenteur fort', tool: 'Cursor', task: n }
    if (name === implName(id, n)) return { name, role: 'Implémenteur', tool: 'Cursor', task: n }
    if (name === reviewerName(id, n)) return { name, role: 'Relecteur', tool: 'Claude', task: n }
  }
  const generations = Math.max(s.loopGeneration, 8)
  for (let generation = 1; generation <= generations; generation++) {
    if (name === globalReviewerName(id, generation)) return { name, role: 'Relecteur global', tool: 'Claude' }
    for (let round = 0; round <= 16; round++) {
      if (name === globalFixerName(id, generation, round)) return { name, role: 'Correcteur global', tool: 'Cursor' }
      if (name === preflightFixerName(id, generation, round)) return { name, role: 'Correcteur preflight', tool: 'Cursor' }
    }
    for (let n = 1; n <= 32; n++) {
      if (name === diagnosticName(id, generation, n)) return { name, role: 'Diagnostic', tool: 'Claude' }
    }
  }
  return { name, role: name, tool: 'Claude' }
}

/** Panneaux d'agents hors panneaux fixes, du plus récemment ajouté au plus ancien. */
export function agentRefs(s: MissionState): AgentRef[] {
  return Object.keys(s.herdr.panes).filter((name) => !FIXED_PANES.has(name)).reverse().map((name) => classifyAgent(s, name))
}
