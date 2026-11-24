import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorLogPath } from './errlog.ts'
import type { Runner } from './forge/github.ts'
import { missionDir } from './paths.ts'

export const ISSUES_REPO = 'MaxVzl/herness'

export type LogEntry = {
  raw: string
  at: string
  mission?: string
  version: string
  origin: string
  step?: string
  body: string
}

export type ReportGroup = { signature: string; entries: LogEntry[] }

const HEADER = /^=== (\S+) · (?:mission (\S+) · )?herness (\S+) · (.+)$/
const STEP = /^(.*) \(étape ([^)]+)\)$/

function stripTrailingBlank(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  return lines.slice(0, end)
}

function firstNonEmpty(body: string): string {
  for (const line of body.split('\n')) {
    if (line !== '') return line
  }
  return ''
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function longestBackticks(text: string): number {
  let max = 0
  let run = 0
  for (const char of text) {
    if (char === '`') {
      run++
      if (run > max) max = run
    } else {
      run = 0
    }
  }
  return max
}

function codeBlock(body: string): string {
  const content = body.length > 60_000 ? `${body.slice(0, 60_000)}\n(tronqué)` : body
  const fence = '`'.repeat(Math.max(3, longestBackticks(content) + 1))
  return `${fence}\n${content}\n${fence}`
}

/** Découpe le journal. Ne lève jamais. */
export function parseErrorLog(text: string): LogEntry[] {
  try {
    const lines = text.split('\n')
    const entries: LogEntry[] = []
    let current: { header: string; at: string; mission?: string; version: string; origin: string; step?: string; bodyLines: string[] } | null = null

    const flush = () => {
      if (!current) return
      const bodyLines = stripTrailingBlank(current.bodyLines)
      const raw = stripTrailingBlank([current.header, ...current.bodyLines]).join('\n')
      const entry: LogEntry = {
        raw,
        at: current.at,
        version: current.version,
        origin: current.origin,
        body: bodyLines.join('\n'),
      }
      if (current.mission !== undefined) entry.mission = current.mission
      if (current.step !== undefined) entry.step = current.step
      entries.push(entry)
      current = null
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const startsEntry = line.startsWith('=== ') && (i === 0 || lines[i - 1] === '')
      if (startsEntry) {
        const match = HEADER.exec(line)
        if (match) {
          flush()
          const originRaw = match[4] ?? ''
          const stepMatch = STEP.exec(originRaw)
          current = {
            header: line,
            at: match[1] ?? '',
            version: match[3] ?? '',
            origin: stepMatch?.[1] ?? originRaw,
            bodyLines: [],
          }
          if (match[2] !== undefined) current.mission = match[2]
          if (stepMatch?.[2] !== undefined) current.step = stepMatch[2]
          continue
        }
      }
      if (current) current.bodyLines.push(line)
    }
    flush()
    return entries
  } catch {
    return []
  }
}

export function entryHash(e: LogEntry): string {
  return createHash('sha256').update(e.raw).digest('hex')
}

export function maskHome(text: string, home: string = homedir()): string {
  if (!home) return text
  return text.replaceAll(home, '~')
}

export function errorSignature(e: LogEntry, home?: string): string {
  const line = maskHome(firstNonEmpty(e.body), home)
  const hex = createHash('sha256').update(`${e.origin}\n${line}`).digest('hex').slice(0, 12)
  return `herness-sig-${hex}`
}

export function groupEntries(entries: LogEntry[], home?: string): ReportGroup[] {
  const groups: ReportGroup[] = []
  const bySignature = new Map<string, ReportGroup>()
  for (const entry of entries) {
    const signature = errorSignature(entry, home)
    let group = bySignature.get(signature)
    if (!group) {
      group = { signature, entries: [] }
      bySignature.set(signature, group)
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}

export function issueTitle(g: ReportGroup, home?: string): string {
  const entry = g.entries[0]
  const title = maskHome(`[erreur herness] ${entry?.origin ?? ''} : ${entry ? firstNonEmpty(entry.body) : ''}`, home)
  if (title.length <= 120) return title
  return `${title.slice(0, 119)}…`
}

function reportText(missionId: string, g: ReportGroup, home: string | undefined, kind: 'issue' | 'comment'): string {
  const first = g.entries[0]
  const versions = unique(g.entries.map((entry) => entry.version))
  const steps = unique(g.entries.flatMap((entry) => (entry.step ? [entry.step] : [])))
  const dates = g.entries.map((entry) => entry.at).join(', ')
  const origin = first?.origin ?? ''
  const originLine = steps.length > 0 ? `- Origine : ${origin} (étape ${steps.join(', ')})` : `- Origine : ${origin}`
  const lines = [
    kind === 'issue'
      ? `Remontée automatiquement par \`herness report\` (mission ${missionId}).`
      : `Revue dans la mission ${missionId}.`,
    '',
    `- Version : herness ${versions.join(', ')}`,
    originLine,
    `- Vue ${g.entries.length} fois dans la mission : ${dates}`,
  ]
  if (kind === 'issue') lines.push(`- Signature : ${g.signature}`)
  lines.push('', codeBlock(first?.body ?? ''))
  return maskHome(lines.join('\n'), home)
}

export function issueBody(missionId: string, g: ReportGroup, home?: string): string {
  return reportText(missionId, g, home, 'issue')
}

export function commentBody(missionId: string, g: ReportGroup, home?: string): string {
  return reportText(missionId, g, home, 'comment')
}

export type SentRecord = { entry: string; signature: string; url: string; at: string }

export type OpenIssue = { number: number; title: string; url: string }

export type PlannedSend =
  | { kind: 'issue'; title: string; body: string; group: ReportGroup }
  | { kind: 'comment'; issue: OpenIssue; body: string; group: ReportGroup }

type ListedIssue = OpenIssue & { body?: string | null }

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function issuesFilePath(id: string): string {
  return join(missionDir(id), 'issues.json')
}

export async function readSent(id: string): Promise<SentRecord[]> {
  const path = issuesFilePath(id)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return []
    throw new Error(`issues.json illisible (${path}) : ${errorDetail(err)}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`issues.json illisible (${path}) : ${errorDetail(err)}`)
  }
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { sent?: unknown }).sent)) {
    throw new Error(`issues.json illisible (${path}) : tableau sent absent`)
  }
  return (data as { sent: SentRecord[] }).sent
}

export async function pendingEntries(id: string): Promise<LogEntry[]> {
  let text: string
  try {
    text = await readFile(errorLogPath(), 'utf8')
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
  const sent = new Set((await readSent(id)).map((record) => record.entry))
  return parseErrorLog(text).filter((entry) => entry.mission === id && !sent.has(entryHash(entry)))
}

export async function planReport(id: string, runner: Runner, home?: string): Promise<PlannedSend[]> {
  const entries = await pendingEntries(id)
  if (entries.length === 0) return []
  const listed = await runner('gh', [
    'issue',
    'list',
    '--repo',
    ISSUES_REPO,
    '--state',
    'open',
    '--limit',
    '500',
    '--json',
    'number,title,body,url',
  ])
  const open = JSON.parse(listed.stdout) as ListedIssue[]
  return groupEntries(entries, home).map((group) => {
    const match = open.find((issue) => (issue.body ?? '').includes(group.signature))
    if (match) {
      return {
        kind: 'comment',
        issue: { number: match.number, title: match.title, url: match.url },
        body: commentBody(id, group, home),
        group,
      }
    }
    return { kind: 'issue', title: issueTitle(group, home), body: issueBody(id, group, home), group }
  })
}

export function previewLines(id: string, plan: PlannedSend[]): string[] {
  const lines = [`Erreurs herness de la mission ${id} à remonter sur ${ISSUES_REPO} (dépôt public) :`, '']
  for (const send of plan) {
    lines.push(
      send.kind === 'issue'
        ? `── Nouvelle issue : ${send.title}`
        : `── Commentaire sur #${send.issue.number} (${send.issue.title})`,
    )
    lines.push(...send.body.split('\n'), '')
  }
  lines.push('Relis : tout ce qui est affiché sera public.')
  return lines
}

function countLabel(count: number, one: string, many: string): string | undefined {
  if (count === 0) return undefined
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

export function confirmQuestion(plan: PlannedSend[]): string {
  const issues = plan.filter((send) => send.kind === 'issue').length
  const comments = plan.length - issues
  const parts = [countLabel(issues, 'issue', 'issues'), countLabel(comments, 'commentaire', 'commentaires')].filter(
    (part) => part !== undefined,
  )
  return `Envoyer ${parts.join(' et ')} sur ${ISSUES_REPO} ?`
}

async function writeSent(id: string, sent: SentRecord[]): Promise<void> {
  await mkdir(missionDir(id), { recursive: true })
  await writeFile(issuesFilePath(id), `${JSON.stringify({ sent }, null, 2)}\n`)
}

export async function sendReport(
  id: string,
  plan: PlannedSend[],
  runner: Runner,
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const sent = await readSent(id)
  const lines: string[] = []
  for (const send of plan) {
    const result =
      send.kind === 'issue'
        ? await runner('gh', ['issue', 'create', '--repo', ISSUES_REPO, '--title', send.title, '--body-file', '-'], {
            input: send.body,
          })
        : await runner(
            'gh',
            ['issue', 'comment', String(send.issue.number), '--repo', ISSUES_REPO, '--body-file', '-'],
            { input: send.body },
          )
    const url = result.stdout.trim()
    const at = now().toISOString()
    for (const entry of send.group.entries) {
      sent.push({ entry: entryHash(entry), signature: send.group.signature, url, at })
    }
    await writeSent(id, sent)
    lines.push(send.kind === 'issue' ? `issue créée : ${url}` : `commentaire ajouté : ${url}`)
  }
  return lines
}
