import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Box, Text, useInput, useStdin } from 'ink'
import React, { useRef, useState } from 'react'

export interface NoteKey {
  input: string
  return?: boolean
  backspace?: boolean
  ctrlS?: boolean
}

export function noteReducer(state: { lines: string[] }, key: NoteKey): { lines: string[]; done: boolean } {
  const lines = state.lines.length > 0 ? [...state.lines] : ['']
  if (key.ctrlS) return { lines, done: true }
  if (key.return) return { lines: [...lines, ''], done: false }
  if (key.backspace) {
    const last = lines[lines.length - 1] ?? ''
    if (last.length > 0) lines[lines.length - 1] = last.slice(0, -1)
    else if (lines.length > 1) lines.pop()
    return { lines, done: false }
  }
  if (key.input) {
    const [first, ...rest] = key.input.split(/\r\n|\r|\n/)
    lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + (first ?? '')
    lines.push(...rest)
  }
  return { lines, done: false }
}

function hasCommand(name: string, spawn: typeof spawnSync): boolean {
  try {
    return spawn('which', [name], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export async function openInEditor(text: string, env: NodeJS.ProcessEnv = process.env, spawn: typeof spawnSync = spawnSync): Promise<string | null> {
  const configured = (env.VISUAL?.trim() || env.EDITOR?.trim() || '').split(/\s+/).filter(Boolean)
  const parts = configured.length > 0 ? configured : [hasCommand('nano', spawn) ? 'nano' : 'vi']
  const dir = await mkdtemp(join(tmpdir(), 'herness-note-'))
  const file = join(dir, 'note.md')
  try {
    await writeFile(file, text)
    const r = spawn(parts[0]!, [...parts.slice(1), file], { stdio: 'inherit' })
    if (r.error || r.status !== 0) return null
    return await readFile(file, 'utf8')
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function NoteInput({ initial = '', onSubmit, onCancel, editor = (t) => openInEditor(t) }: {
  initial?: string
  onSubmit: (note: string) => void
  onCancel: () => void
  editor?: (text: string) => Promise<string | null>
}): React.ReactElement {
  const [lines, setLines] = useState<string[]>(initial ? initial.split('\n') : [''])
  const [message, setMessage] = useState<string | undefined>()
  const editing = useRef(false)
  const { setRawMode } = useStdin()

  useInput((input, key) => {
    if (editing.current) return
    if (key.escape) return onCancel()
    if (key.ctrl && input === 's') return onSubmit(lines.join('\n'))
    if (key.ctrl && input === 'e') {
      editing.current = true
      setRawMode(false)
      void editor(lines.join('\n'))
        .catch(() => null)
        .then((out) => {
          setRawMode(true)
          editing.current = false
          if (out === null) setMessage('éditeur indisponible')
          else {
            setMessage(undefined)
            setLines(out.replace(/\n$/, '').split('\n'))
          }
        })
      return
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return
    setMessage(undefined)
    setLines((l) => noteReducer({ lines: l }, { input, return: key.return, backspace: key.backspace || key.delete }).lines)
  })

  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{i === lines.length - 1 ? `${l}▏` : l}</Text>
      ))}
      <Text dimColor>ctrl+s valider · ctrl+e éditeur · Échap annuler</Text>
      {message ? <Text color="yellow">{message}</Text> : null}
    </Box>
  )
}

export function Confirm({ question, onYes, onNo }: { question: string; onYes: () => void; onNo: () => void }): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) onYes()
    else if (key.escape) onNo()
  })
  return (
    <Box flexDirection="column">
      <Text color="yellow">{question}</Text>
      <Text dimColor>Entrée oui · Échap non</Text>
    </Box>
  )
}

/** Champ d'une ligne : Entrée valide, Échap annule ; un collage multi-ligne est mis sur une ligne. */
export function LineInput({ label, onSubmit, onCancel }: {
  label: string
  onSubmit: (text: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [text, setText] = useState('')
  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.return) return onSubmit(text)
    if (key.backspace || key.delete) return setText((t) => t.slice(0, -1))
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return
    if (input) setText((t) => t + input.replace(/\r\n|\r|\n/g, ' '))
  })
  return (
    <Box flexDirection="column">
      <Text color="yellow">{`${label} ${text}▏`}</Text>
      <Text dimColor>Entrée valider · Échap annuler</Text>
    </Box>
  )
}
