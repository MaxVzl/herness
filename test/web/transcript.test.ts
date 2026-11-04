import { readFileSync } from 'node:fs'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import {
  TranscriptReader,
  awaitingReply,
  chatDelta,
  findTranscript,
  parseTranscript,
  summarizeTool,
  type ChatItem,
} from '../../src/web/transcript.ts'

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/transcript/session.jsonl')
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function linesOf(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0)
}

function entry(type: 'user' | 'assistant', uuid: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    uuid,
    timestamp: `2026-11-03T12:00:00.000Z`,
    isSidechain: false,
    message: { role: type, content },
    ...extra,
  })
}

test('parseTranscript rend la conversation utile, outils regroupés', () => {
  const items = parseTranscript(linesOf(readFileSync(fixturePath, 'utf8')))
  expect(items).toEqual([
    { kind: 'user', uuid: 'u1', at: '2026-11-03T10:00:00.000Z', text: 'Commence la mission.' },
    {
      kind: 'actions',
      uuid: 'a3',
      at: '2026-11-03T10:00:02.000Z',
      actions: [
        {
          id: 'tool-bash',
          name: 'Bash',
          summary: 'Lister src',
          input: { command: 'ls src', description: 'Lister src' },
          result: 'src/web',
        },
        {
          id: 'tool-read',
          name: 'Read',
          summary: 'state.ts',
          input: { file_path: '/a/b/state.ts' },
          result: 'export state',
        },
      ],
    },
    { kind: 'assistant', uuid: 'a8', at: '2026-11-03T10:00:07.000Z', text: 'Mission classée.' },
    { kind: 'engine', uuid: 'u9', at: '2026-11-03T10:00:08.000Z', text: '[herness] Porte g1 (spec) ouverte.' },
    {
      kind: 'question',
      uuid: 'a12',
      at: '2026-11-03T10:00:11.000Z',
      question: 'Lequel ?',
      options: ['A', 'B'],
      answered: false,
    },
    { kind: 'user', uuid: 'u13', at: '2026-11-03T10:00:12.000Z', text: 'la A' },
  ] satisfies ChatItem[])
})

test('deux tool_use séparés par un tool_result restent une seule ligne actions', () => {
  const items = parseTranscript([
    entry('assistant', 'a', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd', description: 'Où' } }]),
    entry('user', 'r', [{ type: 'tool_result', tool_use_id: 't1', content: '/tmp' }]),
    entry('assistant', 'b', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/a.ts' } }]),
  ])
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    kind: 'actions',
    uuid: 'a',
    actions: [
      { id: 't1', name: 'Bash', summary: 'Où', result: '/tmp' },
      { id: 't2', name: 'Read', summary: 'a.ts' },
    ],
  })
})

test("un texte d'assistant entre deux appels d'outil crée deux lignes actions", () => {
  const items = parseTranscript([
    entry('assistant', 'a', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd', description: 'Où' } }]),
    entry('assistant', 'b', [{ type: 'text', text: 'Entre les deux.' }]),
    entry('assistant', 'c', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls', description: 'Lister' } }]),
  ])
  expect(items.map((item) => item.kind)).toEqual(['actions', 'assistant', 'actions'])
  expect(items[0]).toMatchObject({ uuid: 'a', actions: [{ id: 't1' }] })
  expect(items[2]).toMatchObject({ uuid: 'c', actions: [{ id: 't2' }] })
})

test('rappels système et notifications retirés, message vide ignoré', () => {
  const items = parseTranscript([
    entry('user', 'u1', '<system-reminder>rappel</system-reminder>\n<task-notification>fini</task-notification>  Suite.  '),
    entry('user', 'u2', '<system-reminder>seul</system-reminder><task-notification>rien</task-notification>'),
    entry('user', 'u3', '   '),
  ])
  expect(items).toEqual([{ kind: 'user', uuid: 'u1', at: '2026-11-03T12:00:00.000Z', text: 'Suite.' }])
})

test("résultat d'outil : blocs text concaténés, tronqué à 4000, erreur marquée", () => {
  const long = 'x'.repeat(4001)
  const items = parseTranscript([
    entry('assistant', 'a', [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo', description: 'Echo' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'boom', description: 'Boom' } },
    ]),
    entry('user', 'r', [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'aa' }, { type: 'text', text: 'bb' }] },
      { type: 'tool_result', tool_use_id: 't2', content: long, is_error: true },
    ]),
  ])
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    kind: 'actions',
    actions: [
      { id: 't1', result: 'aabb' },
      { id: 't2', result: 'x'.repeat(4000), isError: true },
    ],
  })
})

test('une entrée inconnue ou illisible est ignorée', () => {
  expect(parseTranscript(['pas du json', 'null', '[]', '{"type":"system"}', '{"type":"user"}', '{"type":"assistant","message":{"content":1}}'])).toEqual([])
})

test('un tool_result répond à la question à choix', () => {
  const items = parseTranscript([
    entry('assistant', 'q', [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Oui ?', options: [{ label: 'Oui' }] }] } }]),
    entry('user', 'r', [{ type: 'tool_result', tool_use_id: 'ask', content: 'Oui' }]),
  ])
  expect(items).toEqual([
    { kind: 'question', uuid: 'q', at: '2026-11-03T12:00:00.000Z', question: 'Oui ?', options: ['Oui'], answered: true },
  ])
})

test('awaitingReply vrai seulement si le dernier élément est une réponse', () => {
  const assistant: ChatItem = { kind: 'assistant', uuid: '1', at: 't', text: 'réponse' }
  const user: ChatItem = { kind: 'user', uuid: '2', at: 't', text: 'bonjour' }
  const engine: ChatItem = { kind: 'engine', uuid: '3', at: 't', text: '[herness] suite' }
  const actions: ChatItem = { kind: 'actions', uuid: '4', at: 't', actions: [] }
  expect(awaitingReply([user, assistant])).toBe(true)
  expect(awaitingReply([assistant, user])).toBe(false)
  expect(awaitingReply([assistant, engine])).toBe(false)
  expect(awaitingReply([assistant, actions])).toBe(false)
  expect(awaitingReply([])).toBe(false)
})

test('summarizeTool résume chaque outil', () => {
  expect(summarizeTool('Bash', { command: 'echo hi', description: 'Dire bonjour' })).toBe('Dire bonjour')
  expect(summarizeTool('Bash', { command: 'y'.repeat(81) })).toBe('y'.repeat(80))
  expect(summarizeTool('Bash', { command: 'pwd' })).toBe('pwd')
  expect(summarizeTool('Read', { file_path: '/a/b/state.ts' })).toBe('state.ts')
  expect(summarizeTool('Edit', { file_path: '/a/b/state.ts' })).toBe('state.ts')
  expect(summarizeTool('Write', { file_path: 'note.md' })).toBe('note.md')
  expect(summarizeTool('Grep', { pattern: 'awaitingReply' })).toBe('awaitingReply')
  expect(summarizeTool('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  expect(summarizeTool('mcp__herness__porte', { id: 'g1' })).toBe('herness porte')
  expect(summarizeTool('WebSearch', { query: 'x' })).toBe('WebSearch')
})

test('TranscriptReader suit les ajouts, ignore une fin de ligne incomplète puis un JSON invalide', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herness-transcript-'))
  temps.push(dir)
  const file = join(dir, 'session.jsonl')
  const first = entry('user', 'u1', 'Bonjour')
  const partial = '{"type":"user","uuid":"u2","timestamp":"2026-11-03T12:00:00.000Z","isSidechain":false,"message":{"role":"user","content":"Suite'
  await writeFile(file, `${first}\n${partial}`)

  const reader = new TranscriptReader(file)
  const initial = await reader.poll()
  expect(initial.changed).toBe(true)
  expect(initial.items).toEqual([{ kind: 'user', uuid: 'u1', at: '2026-11-03T12:00:00.000Z', text: 'Bonjour' }])

  const idle = await reader.poll()
  expect(idle.changed).toBe(false)
  expect(idle.items).toEqual(initial.items)

  await appendFile(file, '"}}\n{cassé\n')
  const after = await reader.poll()
  expect(after.changed).toBe(true)
  expect(after.from).toBe(1)
  expect(after.items).toEqual([
    { kind: 'user', uuid: 'u1', at: '2026-11-03T12:00:00.000Z', text: 'Bonjour' },
    { kind: 'user', uuid: 'u2', at: '2026-11-03T12:00:00.000Z', text: 'Suite' },
  ])
})

test('une ligne incomplète seule ne casse pas la lecture, puis compte une fois complétée', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herness-transcript-'))
  temps.push(dir)
  const file = join(dir, 'session.jsonl')
  const partial = entry('user', 'u', 'Seul').slice(0, -4)
  await writeFile(file, partial)
  const reader = new TranscriptReader(file)
  const pending = await reader.poll()
  expect(pending).toEqual({ changed: false, from: -1, items: [] })
  await appendFile(file, entry('user', 'u', 'Seul').slice(-4) + '\n')
  const done = await reader.poll()
  expect(done.changed).toBe(true)
  expect(done.items).toEqual([{ kind: 'user', uuid: 'u', at: '2026-11-03T12:00:00.000Z', text: 'Seul' }])
})

test('si le fichier rétrécit, la lecture reprend au début', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herness-transcript-'))
  temps.push(dir)
  const file = join(dir, 'session.jsonl')
  await writeFile(file, `${entry('user', 'u1', 'Un')}\n${entry('user', 'u2', 'Deux')}\n`)
  const reader = new TranscriptReader(file)
  expect((await reader.poll()).items).toHaveLength(2)
  await writeFile(file, `${entry('assistant', 'a', [{ type: 'text', text: 'Reset' }])}\n`)
  const next = await reader.poll()
  expect(next.changed).toBe(true)
  expect(next.items).toEqual([{ kind: 'assistant', uuid: 'a', at: '2026-11-03T12:00:00.000Z', text: 'Reset' }])
})

test('chatDelta pointe le premier élément ajouté ou modifié', () => {
  const premier: ChatItem = { kind: 'user', uuid: 'u', at: '', text: 'bonjour' }
  const suite: ChatItem = { kind: 'assistant', uuid: 'a', at: '', text: 'je commence' }
  expect(chatDelta([premier], [premier, suite])).toBe(1)
  expect(chatDelta([premier, suite], [premier, suite])).toBe(-1)
  expect(chatDelta([premier], [{ ...premier, text: 'autre' }])).toBe(0)
})

test('findTranscript trouve la session dans un sous-dossier, sinon null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herness-projects-'))
  temps.push(root)
  await writeFile(join(root, 'abc.jsonl'), '{}\n')
  await mkdir(join(root, 'autre'))
  await mkdir(join(root, 'encoded cwd'))
  await writeFile(join(root, 'encoded cwd', 'abc.jsonl'), '{}\n')
  expect(await findTranscript('abc', root)).toBe(join(root, 'encoded cwd', 'abc.jsonl'))
  expect(await findTranscript('absent', root)).toBeNull()
  expect(await findTranscript('abc', join(root, 'inexistant'))).toBeNull()
})
