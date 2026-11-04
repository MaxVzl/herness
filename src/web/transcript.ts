import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export interface ToolAction {
  id: string
  name: string
  summary: string
  input: unknown
  result?: string
  isError?: boolean
}

export type ChatItem =
  | { kind: 'user'; uuid: string; at: string; text: string }
  | { kind: 'engine'; uuid: string; at: string; text: string }
  | { kind: 'assistant'; uuid: string; at: string; text: string }
  | { kind: 'actions'; uuid: string; at: string; actions: ToolAction[] }
  | { kind: 'question'; uuid: string; at: string; question: string; options: string[]; answered: boolean }

const RESULT_MAX = 4000

interface Entry {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { content?: unknown }
}

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** Cherche `<sessionId>.jsonl` dans les sous-dossiers de `root` (par défaut `~/.claude/projects`). */
export async function findTranscript(sessionId: string, root = join(homedir(), '.claude', 'projects')): Promise<string | null> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, `${sessionId}.jsonl`)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // ce dossier ne contient pas la session
    }
  }
  return null
}

/**
 * Lit un transcript au fil de l'eau. Reprend au dernier octet lu, conserve une fin de ligne
 * sans `\n` pour le tour suivant, et repart de zéro si le fichier a rétréci.
 */
export class TranscriptReader {
  private offset = 0
  private rest = Buffer.alloc(0)
  private lines: string[] = []
  private items: ChatItem[] = []

  constructor(private readonly path: string) {}

  async poll(): Promise<{ changed: boolean; items: ChatItem[] }> {
    const fh = await open(this.path, 'r')
    try {
      const { size } = await fh.stat()
      const reset = size < this.offset
      if (reset) {
        this.offset = 0
        this.rest = Buffer.alloc(0)
        this.lines = []
      }
      if (!reset && size === this.offset) return { changed: false, items: this.items }

      if (size > this.offset) {
        const n = size - this.offset
        const buf = Buffer.alloc(n)
        let got = 0
        while (got < n) {
          const { bytesRead } = await fh.read(buf, got, n - got, this.offset + got)
          if (bytesRead === 0) break
          got += bytesRead
        }
        this.offset += got
        const chunk = got === n ? buf : buf.subarray(0, got)
        this.rest = this.rest.length === 0 ? chunk : Buffer.concat([this.rest, chunk])
      }

      const nl = this.rest.lastIndexOf(0x0a)
      if (nl < 0) {
        if (reset) return this.publish([])
        return { changed: false, items: this.items }
      }
      const complete = this.rest.subarray(0, nl).toString('utf8')
      this.rest = Buffer.from(this.rest.subarray(nl + 1))
      if (complete.length > 0) this.lines.push(...complete.split('\n'))
      return this.publish(parseTranscript(this.lines))
    } finally {
      await fh.close()
    }
  }

  private publish(items: ChatItem[]): { changed: boolean; items: ChatItem[] } {
    const changed = JSON.stringify(items) !== JSON.stringify(this.items)
    this.items = items
    return { changed, items }
  }
}

export function parseTranscript(lines: string[]): ChatItem[] {
  const items: ChatItem[] = []
  let group: { uuid: string; at: string; actions: ToolAction[] } | null = null
  const actions = new Map<string, ToolAction>()
  const openQuestions = new Map<string, Extract<ChatItem, { kind: 'question' }>>()

  const flush = (): void => {
    if (!group || group.actions.length === 0) {
      group = null
      return
    }
    items.push({ kind: 'actions', uuid: group.uuid, at: group.at, actions: group.actions })
    group = null
  }

  const applyResult = (block: Block): void => {
    const id = block.tool_use_id
    if (typeof id !== 'string') return
    const question = openQuestions.get(id)
    if (question) {
      question.answered = true
      return
    }
    const action = actions.get(id)
    if (!action) return
    action.result = resultText(block.content)
    if (block.is_error === true) action.isError = true
  }

  const emitUser = (uuid: string, at: string, raw: string): void => {
    const text = visibleUserText(raw)
    if (!text) return
    flush()
    items.push(text.startsWith('[herness]') ? { kind: 'engine', uuid, at, text } : { kind: 'user', uuid, at, text })
  }

  for (const line of lines) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Entry
    if (entry.isMeta === true || entry.isSidechain === true) continue
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const blocks = asBlocks(entry.message?.content)
    if (!blocks) continue
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : ''
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : ''

    if (entry.type === 'user') {
      const texts: string[] = []
      for (const block of blocks) {
        if (block.type === 'tool_result') applyResult(block)
        else if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
      if (texts.length > 0) emitUser(uuid, at, texts.join(''))
      continue
    }

    const texts: string[] = []
    const tools: Block[] = []
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'tool_use') tools.push(block)
    }
    const text = texts.join('')
    if (text.trim()) {
      flush()
      items.push({ kind: 'assistant', uuid, at, text })
    }
    for (const tool of tools) {
      const name = typeof tool.name === 'string' ? tool.name : ''
      const id = typeof tool.id === 'string' ? tool.id : ''
      if (!name) continue
      if (name === 'AskUserQuestion') {
        flush()
        const parsed = questionOf(tool.input)
        const item = { kind: 'question' as const, uuid, at, question: parsed.question, options: parsed.options, answered: false }
        items.push(item)
        if (id) openQuestions.set(id, item)
        continue
      }
      if (!id) continue
      const action: ToolAction = { id, name, summary: summarizeTool(name, tool.input), input: tool.input }
      if (!group) group = { uuid, at, actions: [] }
      group.actions.push(action)
      actions.set(id, action)
    }
  }

  flush()
  return items
}

export function awaitingReply(items: ChatItem[]): boolean {
  return items.at(-1)?.kind === 'assistant'
}

export function summarizeTool(name: string, input: unknown): string {
  if (name === 'Bash') {
    const description = field(input, 'description')
    if (description) return description
    const command = field(input, 'command')
    if (command !== undefined) return command.slice(0, 80)
    return name
  }
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    const path = field(input, 'file_path')
    return path ? basename(path) : name
  }
  if (name === 'Grep' || name === 'Glob') return field(input, 'pattern') ?? name
  const herness = /^mcp__herness__(.+)$/.exec(name)
  if (herness?.[1]) return `herness ${herness[1]}`
  return name
}

function visibleUserText(raw: string): string {
  return raw.replace(/<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g, '').trim()
}

function field(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function asBlocks(content: unknown): Block[] | null {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return null
  return content.filter((item): item is Block => !!item && typeof item === 'object')
}

function resultText(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text
        return ''
      })
      .join('')
  }
  return text.length > RESULT_MAX ? text.slice(0, RESULT_MAX) : text
}

function questionOf(input: unknown): { question: string; options: string[] } {
  if (!input || typeof input !== 'object') return { question: '', options: [] }
  const questions = (input as { questions?: unknown }).questions
  const first = Array.isArray(questions) ? questions[0] : undefined
  if (!first || typeof first !== 'object') return { question: '', options: [] }
  const question = typeof (first as { question?: unknown }).question === 'string' ? (first as { question: string }).question : ''
  const rawOptions = (first as { options?: unknown }).options
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap((option) => {
        if (!option || typeof option !== 'object') return []
        const label = (option as { label?: unknown }).label
        return typeof label === 'string' ? [label] : []
      })
    : []
  return { question, options }
}
