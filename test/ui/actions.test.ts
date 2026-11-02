import { writeSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { missionDir } from '../../src/paths.ts'
import { close, open, refuse, restart, restartDetached, resume, startNew, validate, type ActionDeps, type Spawner } from '../../src/ui/actions.ts'
import type { MissionState } from '../../src/mission/state.ts'

function mk(over: Partial<ActionDeps> = {}, focused: string[] = []): ActionDeps {
  return {
    lifecycle: { e: { herdr: { workspaceFocus: async (id: string) => { focused.push(id) } } } as never },
    decide: (async () => {}) as never,
    resume: (async () => {}) as never,
    close: (async () => true) as never,
    start: (async () => 'm1') as never,
    cwd: '/x',
    ...over,
  }
}

test('validate poste une décision et rend ses lignes', async () => {
  const seen: unknown[] = []
  const d = mk({
    decide: (async (id: string, decision: string, opts: { gateId?: string; note?: string; isTTY: boolean; confirm: () => Promise<boolean>; out?: (l: string) => void }) => {
      seen.push([id, decision, opts.gateId, opts.note, opts.isTTY, await opts.confirm()])
      opts.out?.('décision postée')
    }) as never,
  })
  expect(await validate('m1', 'g1', 'ok', d)).toEqual({ ok: true, lines: ['décision postée'] })
  expect(seen).toEqual([['m1', 'approved', 'g1', 'ok', true, true]])
})

test('refuse sans note ne poste rien', async () => {
  let called = false
  const d = mk({ decide: (async () => { called = true }) as never })
  expect(await refuse('m1', 'g1', '  ', d)).toEqual({ ok: false, lines: ['une note est obligatoire pour refuser'] })
  expect(called).toBe(false)
})

test('refuse poste refused et une exception devient ok:false', async () => {
  const d = mk({ decide: (async () => { throw new Error('boum') }) as never })
  expect(await refuse('m1', 'g1', 'non', d)).toEqual({ ok: false, lines: ['boum'] })
})

test('close transmet la question de confirmation de closeMission à confirm', async () => {
  const asked: string[] = []
  const d = mk({
    close: (async (_id: string, deps: { isTTY?: boolean; confirm?: (q: string) => Promise<boolean> }) => {
      expect(deps.isTTY).toBe(true)
      return deps.confirm!('sûr ?')
    }) as never,
  })
  const r = await close('m1', d, async (q) => { asked.push(q); return false })
  expect(asked).toEqual(['sûr ?'])
  expect(r.ok).toBe(false)
})

test('startNew rend l\'erreur de checkEnv sans lever', async () => {
  const d = mk({ start: (async () => { throw new Error('environnement incomplet') }) as never })
  expect(await startNew('texte', d)).toEqual({ ok: false, lines: ['environnement incomplet'] })
})

test('startNew rend la sortie du lancement sans ligne en double', async () => {
  const d = mk({ start: (async (_input: string, _cwd: string, deps: { out: (l: string) => void }) => { deps.out('Mission m1 lancée : espace herdr « m1 »'); return 'm1' }) as never })
  expect(await startNew('texte', d)).toEqual({ ok: true, lines: ['Mission m1 lancée : espace herdr « m1 »'] })
})

test('resume et restart passent { restart } à resumeMission', async () => {
  const opts: unknown[] = []
  const d = mk({ resume: (async (_id: string, _deps: unknown, o: unknown) => { opts.push(o) }) as never })
  await resume('m1', d)
  await restart('m1', d)
  await resume('m1', d, { focus: false })
  await restart('m1', d, { focus: false })
  expect(opts).toEqual([{ restart: false }, { restart: true }, { restart: false, focus: false }, { restart: true, focus: false }])
})

test('open focus l\'espace, ou rend un message', async () => {
  const focused: string[] = []
  const d = mk({}, focused)
  const s = { herdr: { workspace: 'w1', tabs: {}, panes: {} } } as unknown as MissionState
  expect((await open(s, d)).ok).toBe(true)
  expect(focused).toEqual(['w1'])
  const none = { herdr: { tabs: {}, panes: {} } } as unknown as MissionState
  expect(await open(none, d)).toEqual({ ok: false, lines: ['espace herdr inconnu'] })
})

test('restartDetached lance herness reprendre --redemarrer détaché via execPath, sortie dans un journal ; une erreur de lancement devient ok:false', async () => {
  const home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
  try {
    const seen: unknown[] = []
    const spawn: Spawner = (cmd, args, opts) => {
      seen.push([cmd, args, opts])
      writeSync(opts.stdio[1], 'sortie du redémarrage\n')
      return { unref: () => seen.push('unref'), once: (ev: string, fn: (e?: Error) => void) => { if (ev === 'spawn') fn() } }
    }
    const r = await restartDetached('m1', spawn, () => new Date('2026-11-02T10:11:12.000Z'))
    const log = join(missionDir('m1'), 'logs', 'redemarrage-2026-11-02T10-11-12-000Z.log')
    expect(r).toEqual({ ok: true, lines: [`redémarrage lancé (ce panneau va se relancer) ; journal : ${log}`] })
    const [cmd, args, opts] = seen[0] as [string, string[], { detached: boolean; stdio: unknown[] }]
    expect(cmd).toBe(process.execPath)
    expect(args[0]).toMatch(/bin\/herness\.js$/)
    expect(args.slice(1)).toEqual(['reprendre', 'm1', '--redemarrer'])
    expect(opts.detached).toBe(true)
    expect(opts.stdio[0]).toBe('ignore')
    expect(typeof opts.stdio[1]).toBe('number')
    expect(opts.stdio[2]).toBe(opts.stdio[1])
    expect(seen[1]).toBe('unref')
    expect(await readFile(log, 'utf8')).toBe('sortie du redémarrage\n')
    const bad: Spawner = () => ({ unref: () => {}, once: (ev: string, fn: (e?: Error) => void) => { if (ev === 'error') fn(new Error('node introuvable')) } })
    expect(await restartDetached('m1', bad)).toEqual({ ok: false, lines: ['node introuvable'] })
  } finally {
    delete process.env.HERNESS_HOME
    await rm(home, { recursive: true, force: true })
  }
})
