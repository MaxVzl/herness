import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

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
      ? `Remontée automatiquement par \`herness signaler\` (mission ${missionId}).`
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
