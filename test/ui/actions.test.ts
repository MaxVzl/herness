import { expect, test } from 'vitest'
import { close, open, refuse, restart, resume, startNew, validate, type ActionDeps } from '../../src/ui/actions.ts'
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

test('startNew rend l\'id de la mission', async () => {
  const r = await startNew('texte', mk())
  expect(r.ok).toBe(true)
  expect(r.lines.at(-1)).toContain('m1')
})

test('resume et restart passent { restart } à resumeMission', async () => {
  const opts: unknown[] = []
  const d = mk({ resume: (async (_id: string, _deps: unknown, o: unknown) => { opts.push(o) }) as never })
  await resume('m1', d)
  await restart('m1', d)
  expect(opts).toEqual([{ restart: false }, { restart: true }])
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
