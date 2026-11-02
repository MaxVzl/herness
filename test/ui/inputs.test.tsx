import { render } from 'ink-testing-library'
import React from 'react'
import { expect, test, vi } from 'vitest'
import { Confirm, noteReducer, NoteInput, openInEditor } from '../../src/ui/inputs.tsx'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

test('noteReducer : saisie, nouvelle ligne, effacement, ctrl+s', () => {
  let s = { lines: [''] }
  s = { lines: noteReducer(s, { input: 'ab' }).lines }
  expect(noteReducer(s, { input: 'ab' }).lines).toEqual(['abab'])
  const nl = noteReducer(s, { input: '', return: true })
  expect(nl.lines).toEqual(['ab', ''])
  expect(noteReducer(nl, { input: '', backspace: true })).toEqual({ lines: ['ab'], done: false })
  expect(noteReducer({ lines: ['ab'] }, { input: '', backspace: true }).lines).toEqual(['a'])
  expect(noteReducer({ lines: [''] }, { input: '', backspace: true }).lines).toEqual([''])
  expect(noteReducer(s, { input: 's', ctrlS: true })).toEqual({ lines: ['ab'], done: true })
})

test("Confirm n'envoie rien sur une autre touche", async () => {
  const onYes = vi.fn()
  const onNo = vi.fn()
  const { stdin, lastFrame } = render(<Confirm question="Valider g1 ?" onYes={onYes} onNo={onNo} />)
  expect(lastFrame()).toContain('Valider g1 ?')
  await tick()
  stdin.write('x')
  await tick()
  expect(onYes).not.toHaveBeenCalled()
  expect(onNo).not.toHaveBeenCalled()
  stdin.write('\r')
  await tick()
  expect(onYes).toHaveBeenCalledTimes(1)
})

test('Confirm : Échap appelle onNo', async () => {
  const onYes = vi.fn()
  const onNo = vi.fn()
  const { stdin } = render(<Confirm question="?" onYes={onYes} onNo={onNo} />)
  await tick()
  stdin.write('\x1b')
  await tick(100)
  expect(onNo).toHaveBeenCalledTimes(1)
  expect(onYes).not.toHaveBeenCalled()
})

test('NoteInput : saisie multi-ligne et ctrl+s', async () => {
  const onSubmit = vi.fn()
  const { stdin } = render(<NoteInput onSubmit={onSubmit} onCancel={() => {}} />)
  await tick()
  stdin.write('a')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('b')
  await tick()
  stdin.write('\x13')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('a\nb')
})

test('NoteInput garde la note quand léditeur rend null', async () => {
  const editor = vi.fn(async () => null)
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<NoteInput initial="garde" onSubmit={onSubmit} onCancel={() => {}} editor={editor} />)
  await tick()
  stdin.write('\x05')
  await tick(100)
  expect(editor).toHaveBeenCalledWith('garde')
  expect(lastFrame()).toContain('garde')
  expect(lastFrame()).toContain('éditeur indisponible')
  stdin.write('\x13')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('garde')
})

test("NoteInput remplace la note par le texte de l'éditeur ; Échap annule", async () => {
  const onCancel = vi.fn()
  const { stdin, lastFrame } = render(<NoteInput onSubmit={() => {}} onCancel={onCancel} editor={async () => 'x\ny'} />)
  await tick()
  stdin.write('\x05')
  await tick(100)
  expect(lastFrame()).toContain('x')
  expect(lastFrame()).toContain('y')
  stdin.write('\x1b')
  await tick(100)
  expect(onCancel).toHaveBeenCalled()
})

function fakeSpawn(existing: string[]) {
  const calls: { cmd: string; args: string[] }[] = []
  const spawn = ((cmd: string, args: string[]) => {
    if (cmd === 'which') return { status: existing.includes(args[0]!) ? 0 : 1 }
    calls.push({ cmd, args })
    return { status: 0 }
  }) as never
  return { calls, spawn }
}

test('openInEditor choisit VISUAL puis EDITOR puis nano puis vi', async () => {
  let f = fakeSpawn(['nano'])
  await openInEditor('t', { VISUAL: 'code --wait', EDITOR: 'ed' }, f.spawn)
  expect(f.calls[0]!.cmd).toBe('code')
  expect(f.calls[0]!.args[0]).toBe('--wait')
  f = fakeSpawn(['nano'])
  await openInEditor('t', { EDITOR: 'ed' }, f.spawn)
  expect(f.calls[0]!.cmd).toBe('ed')
  f = fakeSpawn(['nano'])
  await openInEditor('t', {}, f.spawn)
  expect(f.calls[0]!.cmd).toBe('nano')
  f = fakeSpawn([])
  await openInEditor('t', {}, f.spawn)
  expect(f.calls[0]!.cmd).toBe('vi')
})

test("openInEditor rend le texte modifié, supprime le fichier, null en cas d'échec", async () => {
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
  let path = ''
  const ok = ((cmd: string, args: string[]) => {
    path = args[args.length - 1]!
    expect(readFileSync(path, 'utf8')).toBe('avant')
    writeFileSync(path, 'après')
    return { status: 0 }
  }) as never
  expect(await openInEditor('avant', { EDITOR: 'ed' }, ok)).toBe('après')
  expect(existsSync(path)).toBe(false)
  expect(await openInEditor('a', { EDITOR: 'ed' }, (() => ({ status: 1 })) as never)).toBeNull()
  expect(await openInEditor('a', { EDITOR: 'ed' }, (() => ({ status: null, error: new Error('x') })) as never)).toBeNull()
})
