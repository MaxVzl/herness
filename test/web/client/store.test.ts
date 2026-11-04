import { afterEach, expect, test, vi } from 'vitest'
import type { ActionResponse } from '../../../src/web/protocol.ts'
import { initialState, reduce } from '../../../src/web/client/store.ts'
import { getText, post } from '../../../src/web/client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mission = {
  id: '26110301-1',
  project: 'demo',
  title: 'Porte spec',
  status: 'porte spec',
  bucket: 'decision' as const,
  hidden: false,
  createdAt: '2026-11-03T10:00:00.000Z',
  step: 'tasks',
}

test('reduce range missions, détail, chat, document, agents et checks sans réordonner', () => {
  const missions = [
    { ...mission, id: '26110301-2', title: 'Deux' },
    mission,
  ]
  const projects = [{ name: 'demo', repoPath: '/r', preflight: ['Typecheck'] }]
  let state = reduce(initialState, { type: 'missions', missions, hiddenCount: 4, projects })

  expect(state.missions.map((item) => item.id)).toEqual(['26110301-2', '26110301-1'])
  expect(state.hiddenCount).toBe(4)
  expect(state.projects).toEqual(projects)
  expect(initialState.missions).toEqual([])

  const detail = { state: { id: '26110301-1' }, orchestrator: { state: 'working' }, files: { global: ['note.md'] } }
  state = reduce(state, { type: 'mission', id: '26110301-1', detail })
  expect(state.details['26110301-1']).toEqual(detail)

  const items = [{ kind: 'user' as const, uuid: 'u1', at: '2026-11-03T10:01:00.000Z', text: 'bonjour' }]
  state = reduce(state, { type: 'chat', id: '26110301-1', items })
  expect(state.chats['26110301-1']).toEqual(items)

  const spec = { source: 'worktree' as const, text: '# spec' }
  state = reduce(state, { type: 'doc', id: '26110301-1', kind: 'spec', doc: spec })
  const plan = { source: 'absent' as const, reason: 'pas encore de plan' }
  state = reduce(state, { type: 'doc', id: '26110301-1', kind: 'plan', doc: plan })
  expect(state.docs['26110301-1']?.spec).toEqual(spec)
  expect(state.docs['26110301-1']?.plan).toEqual(plan)

  const agents = [{ name: 'impl', role: 'implémenteur', tool: 'Cursor' as const, state: 'working', tail: 'ok' }]
  state = reduce(state, { type: 'agents', id: '26110301-1', agents })
  expect(state.agents['26110301-1']).toEqual(agents)

  const checks = [{
    file: '1.log', label: 'tests', status: 'vert' as const,
    startedAt: '2026-11-03T10:02:00.000Z', durationMs: 1200, lastOutputAt: '2026-11-03T10:02:01.000Z',
  }]
  state = reduce(state, { type: 'checks', id: '26110301-1', checks })
  expect(state.checks['26110301-1']).toEqual(checks)
})

test('confirmation-traitee retire seulement la confirmation répondue', () => {
  let state = reduce(initialState, {
    type: 'confirmation', confirmId: 'c1', missionId: '26110301-1', question: 'Fermer ?',
  })
  state = reduce(state, {
    type: 'confirmation', confirmId: 'c2', missionId: '26110301-1', question: 'Supprimer ?',
  })
  state = reduce(state, { type: 'confirmation-traitee', confirmId: 'c1' })
  expect(state.confirmations).toEqual([
    { confirmId: 'c2', missionId: '26110301-1', question: 'Supprimer ?' },
  ])
})

test('connexion change connected', () => {
  expect(initialState.connected).toBe(false)
  const on = reduce(initialState, { type: 'connexion', connected: true })
  expect(on.connected).toBe(true)
  expect(reduce(on, { type: 'connexion', connected: false }).connected).toBe(false)
})

test('post envoie du JSON et getText lit le corps ; une coupure devient serveur injoignable', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const created: ActionResponse = { ok: true, lines: ['mission 26110301-3'], id: '26110301-3' }
  fetchMock.mockResolvedValueOnce({ json: async () => created })

  expect(await post('/api/missions', { projet: 'demo', demande: 'ajouter un export' })).toEqual(created)
  expect(fetchMock).toHaveBeenCalledWith('/api/missions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projet: 'demo', demande: 'ajouter un export' }),
  })

  fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, lines: ['mission inconnue'] }) })
  expect(await post('/api/missions/26110301-1/fermer')).toEqual({ ok: false, lines: ['mission inconnue'] })
  const second = fetchMock.mock.calls[1]?.[1] as { body?: string }
  expect(second.body).toBeUndefined()

  fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
  expect(await post('/api/missions')).toEqual({ ok: false, lines: ['serveur injoignable'] })

  fetchMock.mockResolvedValueOnce({ text: async () => '# spec\n' })
  expect(await getText('/api/missions/26110301-1/fichier?chemin=spec.md')).toBe('# spec\n')
})
