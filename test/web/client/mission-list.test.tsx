// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { MissionSummary, ProjectView } from '../../../src/web/protocol.ts'
import { App } from '../../../src/web/client/App.tsx'
import { MissionList } from '../../../src/web/client/MissionList.tsx'
import { deliverNotification } from '../../../src/web/client/notifications.ts'
import { useServerEvents, type ClientState } from '../../../src/web/client/store.ts'

const projects: ProjectView[] = [
  { name: 'alpha', repoPath: '/a', preflight: [] },
  { name: 'beta', repoPath: '/b', preflight: [] },
]

function mission(over: Partial<MissionSummary> & Pick<MissionSummary, 'id'>): MissionSummary {
  return {
    project: 'alpha',
    title: 'Titre',
    status: 'tâche 1/2',
    bucket: 'active',
    hidden: false,
    createdAt: '2026-11-03T10:00:00.000Z',
    step: 'tasks',
    ...over,
  }
}

function state(missions: MissionSummary[], hiddenCount = 0): ClientState {
  return {
    missions,
    hiddenCount,
    projects,
    details: {},
    chats: {},
    docs: {},
    agents: {},
    checks: {},
    confirmations: [],
    connected: true,
  }
}

class FakeSource {
  static all: FakeSource[] = []
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  readonly close = vi.fn()
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
}

function sourceOf(url: string): EventSource {
  return new FakeSource(url) as unknown as EventSource
}

function send(es: FakeSource, data: unknown) {
  es.onmessage?.({ data: JSON.stringify(data) })
}

function flux(index = 0): FakeSource {
  const es = FakeSource.all[index]
  if (!es) throw new Error('flux absent')
  return es
}

function classOf(el: Element): string[] {
  return ((el as unknown as { className?: string }).className ?? '').split(/\s+/).filter(Boolean)
}

function hash(): string {
  return (globalThis as unknown as { location: { hash: string } }).location.hash
}

function setHash(value: string) {
  ;(globalThis as unknown as { location: { hash: string } }).location.hash = value
}

const host = globalThis as unknown as {
  document: object
  focus: () => void
  Notification?: unknown
}

beforeEach(() => {
  FakeSource.all = []
  localStorage.clear()
  setHash('')
  Object.defineProperty(host.document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  host.Notification = undefined
})

test('les missions restent dans l ordre reçu, avec la couleur du compartiment et le badge', () => {
  const missions = [
    mission({ id: '26110301-2', project: 'beta', title: 'Deuxième', status: 'bloquée', bucket: 'bloquee' }),
    mission({ id: '26110301-1', project: 'alpha', title: 'Première', status: 'porte spec', bucket: 'decision', badge: 'attend-reponse' }),
    mission({ id: '26110301-3', project: 'alpha', title: 'Troisième', status: 'en cours', bucket: 'active', badge: 'attend-herdr' }),
    mission({ id: '26110301-4', project: 'alpha', title: 'Quatrième', status: 'fermée', bucket: 'terminee' }),
  ]
  render(<MissionList state={state(missions)} selected="26110301-3" onSelect={() => {}} onNew={() => {}} />)

  const rows = screen.getAllByRole('listitem')
  expect(rows.map((row) => (row as unknown as { textContent: string }).textContent)).toEqual([
    expect.stringContaining('26110301-2'),
    expect.stringContaining('26110301-1'),
    expect.stringContaining('26110301-3'),
    expect.stringContaining('26110301-4'),
  ])
  expect(rows[0]?.textContent).toContain('beta')
  expect(rows[0]?.textContent).toContain('Deuxième')
  expect(rows[0]?.textContent).toContain('bloquée')
  expect(classOf(rows[0]!).includes('rouge')).toBe(true)
  expect(classOf(rows[1]!).includes('ambre')).toBe(true)
  expect(classOf(rows[2]!).some((name) => name === 'ambre' || name === 'rouge' || name === 'grise')).toBe(false)
  expect(classOf(rows[3]!).includes('grise')).toBe(true)
  expect(screen.getByText('attend ta réponse')).toBeTruthy()
  expect(screen.getByText('attend dans herdr')).toBeTruthy()
  expect((screen.getByRole('button', { current: true }) as unknown as { textContent: string }).textContent).toContain('26110301-3')
})

test('les missions masquées restent cachées jusqu au clic sur la ligne de décompte', () => {
  const missions = [
    mission({ id: '26110301-1', title: 'Visible' }),
    mission({ id: '26110301-2', title: 'Vieille', hidden: true, bucket: 'terminee', status: 'fermée' }),
    mission({ id: '26110301-3', title: 'Mergée', hidden: true, bucket: 'terminee', status: 'PR #4' }),
    mission({ id: '26110301-4', title: 'Archivée', hidden: true, bucket: 'terminee', status: 'fermée' }),
  ]
  render(<MissionList state={state(missions, 3)} selected={undefined} onSelect={() => {}} onNew={() => {}} />)

  expect(screen.queryByText('26110301-2')).toBeNull()
  expect(screen.getByText('26110301-1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '3 missions terminées masquées · afficher' }))
  expect(screen.queryByRole('button', { name: '3 missions terminées masquées · afficher' })).toBeNull()
  expect(screen.getByText('26110301-2')).toBeTruthy()
  expect(screen.getByText('26110301-3')).toBeTruthy()
  expect(screen.getByText('26110301-4')).toBeTruthy()
})

test('le décompte des missions masquées suit le filtre et peut se refermer', () => {
  const missions = [
    mission({ id: '26110301-1', project: 'alpha', title: 'Alpha visible' }),
    mission({ id: '26110301-2', project: 'alpha', title: 'Alpha finie', hidden: true, bucket: 'terminee', status: 'fermée' }),
    mission({ id: '26110301-3', project: 'beta', title: 'Beta finie', hidden: true, bucket: 'terminee', status: 'fermée' }),
    mission({ id: '26110301-4', project: 'beta', title: 'Beta visible' }),
  ]
  render(<MissionList state={state(missions, 99)} selected={undefined} onSelect={() => {}} onNew={() => {}} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } })
  expect(screen.getByRole('button', { name: '1 missions terminées masquées · afficher' })).toBeTruthy()
  expect(screen.queryByText('26110301-2')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '1 missions terminées masquées · afficher' }))
  expect(screen.getByText('26110301-3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'masquer les missions terminées' }))
  expect(screen.queryByText('26110301-3')).toBeNull()
  expect(screen.getByText('26110301-4')).toBeTruthy()
})

test('le sélecteur Projet : tous ▾ filtre et mémorise le projet', () => {
  const missions = [
    mission({ id: '26110301-1', project: 'alpha', title: 'Alpha' }),
    mission({ id: '26110301-2', project: 'beta', title: 'Beta' }),
  ]
  render(<MissionList state={state(missions)} selected={undefined} onSelect={() => {}} onNew={() => {}} />)
  expect(screen.getByRole('combobox', { name: 'Projet : tous ▾' })).toBeTruthy()

  fireEvent.change(screen.getByRole('combobox', { name: 'Projet : tous ▾' }), { target: { value: 'beta' } })
  expect(screen.queryByText('26110301-1')).toBeNull()
  expect(screen.getByText('26110301-2')).toBeTruthy()
  expect(localStorage.getItem('herness.projet')).toBe('beta')

  cleanup()
  render(<MissionList state={state(missions)} selected={undefined} onSelect={() => {}} onNew={() => {}} />)
  expect(screen.queryByText('26110301-1')).toBeNull()
  expect(screen.getByRole('combobox', { name: 'Projet : beta ▾' })).toBeTruthy()
})

test('un localStorage illisible n empêche ni l affichage ni le changement de filtre', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('bloqué')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('bloqué')
  })
  const missions = [mission({ id: '26110301-1', project: 'alpha' }), mission({ id: '26110301-2', project: 'beta' })]
  render(<MissionList state={state(missions)} selected={undefined} onSelect={() => {}} onNew={() => {}} />)
  expect(screen.getByText('26110301-1')).toBeTruthy()
  expect(() => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } })
  }).not.toThrow()
  expect(screen.queryByText('26110301-1')).toBeNull()
})

test('un clic sélectionne la mission et Nouvelle mission ouvre le formulaire', () => {
  const onSelect = vi.fn()
  const onNew = vi.fn()
  const missions = [mission({ id: '26110301-1' }), mission({ id: '26110301-2', title: 'Autre' })]
  const view = state(missions)
  const { rerender } = render(<MissionList state={view} selected={undefined} onSelect={onSelect} onNew={onNew} />)
  fireEvent.click(screen.getByRole('button', { name: /26110301-2/ }))
  expect(onSelect).toHaveBeenCalledTimes(1)
  expect(onSelect).toHaveBeenCalledWith('26110301-2')
  fireEvent.click(screen.getByRole('button', { name: '+ Nouvelle mission' }))
  expect(onNew).toHaveBeenCalledTimes(1)

  rerender(<MissionList state={state([missions[1]!, missions[0]!])} selected="26110301-2" onSelect={onSelect} onNew={onNew} />)
  const rows = screen.getAllByRole('listitem')
  expect(rows[0]?.textContent).toContain('26110301-2')
  expect((screen.getByRole('button', { current: true }) as unknown as { textContent: string }).textContent).toContain('26110301-2')
})

test('Activer les notifications demande la permission au clic seulement', () => {
  const requestPermission = vi.fn(async () => 'granted')
  class FakeNotification {
    static permission = 'default'
    static requestPermission = requestPermission
  }
  host.Notification = FakeNotification
  render(<MissionList state={state([])} selected={undefined} onSelect={() => {}} onNew={() => {}} />)
  expect(requestPermission).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Activer les notifications' }))
  expect(requestPermission).toHaveBeenCalledTimes(1)
})

test('une coupure de plus de 2 s affiche le bandeau ; un open le retire et le nouvel état remplace l ancien', async () => {
  vi.useFakeTimers()
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  expect(es.url).toBe('/api/evenements?agents=0')
  expect(screen.queryByText('connexion perdue, reconnexion…')).toBeNull()

  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      missions: [mission({ id: 'ancienne', title: 'Ancienne' })],
      hiddenCount: 0,
      projects,
    })
    send(es, {
      type: 'mission',
      id: 'ancienne',
      detail: { state: { id: 'ancienne' }, orchestrator: { state: null }, files: {} },
    })
  })
  expect(screen.getByText('Ancienne')).toBeTruthy()

  act(() => { es.onerror?.({}) })
  expect(screen.queryByText('connexion perdue, reconnexion…')).toBeNull()
  await act(async () => { vi.advanceTimersByTime(1999) })
  expect(screen.queryByText('connexion perdue, reconnexion…')).toBeNull()
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(screen.getByText('connexion perdue, reconnexion…')).toBeTruthy()

  act(() => { es.onopen?.({}) })
  expect(screen.queryByText('connexion perdue, reconnexion…')).toBeNull()
  expect(screen.getByText('Ancienne')).toBeTruthy()
  act(() => {
    send(es, {
      type: 'missions',
      missions: [mission({ id: 'nouvelle', title: 'Nouvelle' })],
      hiddenCount: 0,
      projects,
    })
  })
  expect(screen.getByText('Nouvelle')).toBeTruthy()
  expect(screen.queryByText('Ancienne')).toBeNull()
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(screen.queryByText('connexion perdue, reconnexion…')).toBeNull()
})

test('l ouverture garde le détail jusqu au premier instantané, qui oublie les missions absentes', async () => {
  const { result } = renderHook(() => useServerEvents({ agents: false }, sourceOf))
  await act(async () => {})
  const es = flux()
  const detail = { state: { id: 'ancienne' }, orchestrator: { state: 'working' }, files: {} }
  const items = [{ kind: 'user' as const, uuid: 'u', at: '2026-11-03T10:00:00.000Z', text: 'vieux' }]
  act(() => {
    es.onopen?.({})
    send(es, { type: 'mission', id: 'ancienne', detail })
    send(es, { type: 'chat', id: 'ancienne', items })
  })
  expect(result.current.details.ancienne).toEqual(detail)
  expect(result.current.chats.ancienne).toEqual(items)

  act(() => { es.onopen?.({}) })
  expect(result.current.details.ancienne).toEqual(detail)
  expect(result.current.chats.ancienne).toEqual(items)
  expect(result.current.connected).toBe(true)

  act(() => {
    send(es, { type: 'missions', missions: [mission({ id: 'nouvelle' })], hiddenCount: 0, projects: [] })
  })
  expect(result.current.missions.map((item) => item.id)).toEqual(['nouvelle'])
  expect(result.current.details.ancienne).toBeUndefined()
  expect(result.current.chats.ancienne).toBeUndefined()
})

test('une reconnexion garde les confirmations en attente', async () => {
  const { result } = renderHook(() => useServerEvents({ agents: false }, sourceOf))
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, { type: 'confirmation', confirmId: 'c1', missionId: '26110301-1', question: 'Fermer ?' })
  })
  expect(result.current.confirmations).toEqual([
    { confirmId: 'c1', missionId: '26110301-1', question: 'Fermer ?' },
  ])

  act(() => { es.onopen?.({}) })
  expect(result.current.confirmations).toEqual([
    { confirmId: 'c1', missionId: '26110301-1', question: 'Fermer ?' },
  ])
  expect(result.current.connected).toBe(true)
  expect(result.current.missions).toEqual([])

  act(() => {
    send(es, { type: 'missions', missions: [mission({ id: '26110301-1' })], hiddenCount: 0, projects: [] })
  })
  expect(result.current.missions.map((item) => item.id)).toEqual(['26110301-1'])
  expect(result.current.confirmations).toEqual([
    { confirmId: 'c1', missionId: '26110301-1', question: 'Fermer ?' },
  ])
})

test('changer de mission rouvre le flux avec le nouvel abonnement', async () => {
  const { rerender } = renderHook(
    ({ missionId, agents }: { missionId?: string; agents: boolean }) => useServerEvents({ mission: missionId, agents }, sourceOf),
    { initialProps: { missionId: undefined as string | undefined, agents: false } },
  )
  await act(async () => {})
  expect(FakeSource.all[0]?.url).toBe('/api/evenements?agents=0')
  rerender({ missionId: '26110301-2', agents: true })
  await act(async () => {})
  expect(FakeSource.all[0]?.close).toHaveBeenCalled()
  expect(FakeSource.all[1]?.url).toBe('/api/evenements?mission=26110301-2&agents=1')
})

test('le hash choisit la mission au chargement et l ordre suivant ne la quitte pas', async () => {
  setHash('#/26110301-2')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  expect(es.url).toBe('/api/evenements?mission=26110301-2&agents=0')
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [
        mission({ id: '26110301-1', title: 'Une' }),
        mission({ id: '26110301-2', title: 'Deux' }),
      ],
    })
  })
  expect((screen.getByRole('button', { current: true }) as unknown as { textContent: string }).textContent).toContain('26110301-2')

  act(() => {
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [
        mission({ id: '26110301-2', title: 'Deux' }),
        mission({ id: '26110301-1', title: 'Une' }),
      ],
    })
  })
  const rows = screen.getAllByRole('listitem')
  expect(rows[0]?.textContent).toContain('26110301-2')
  expect((screen.getByRole('button', { current: true }) as unknown as { textContent: string }).textContent).toContain('26110301-2')
  expect(hash()).toBe('#/26110301-2')
})

test('cliquer une mission écrit le hash', async () => {
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [mission({ id: '26110301-1', title: 'Une' }), mission({ id: '26110301-2', title: 'Deux' })],
    })
  })
  fireEvent.click(screen.getByRole('button', { name: /26110301-2/ }))
  expect(hash()).toBe('#/26110301-2')
})

class Noted {
  static notes: Noted[] = []
  onclick: (() => void) | null = null
  constructor(readonly title: string, readonly options?: { body?: string; tag?: string }) {
    Noted.notes.push(this)
  }
}

async function settleNotes(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

function stubNotification(permission: 'default' | 'granted' | 'denied') {
  Noted.notes = []
  class FakeNotification extends Noted {
    static permission = permission
    static requestPermission = vi.fn(async () => 'granted')
  }
  host.Notification = FakeNotification
}

test('changer de mission ne vide pas la liste avant le prochain instantané', async () => {
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [mission({ id: '26110301-1', title: 'Une' }), mission({ id: '26110301-2', title: 'Deux' })],
    })
  })
  fireEvent.click(screen.getByRole('button', { name: /26110301-2/ }))
  await act(async () => {})
  act(() => { flux(1).onopen?.({}) })
  expect(screen.getByText('Une')).toBeTruthy()
  expect(screen.getByText('Deux')).toBeTruthy()
})

test('une notification part une seule fois, sauf si la mission sélectionnée est déjà sous les yeux', async () => {
  stubNotification('granted')
  const focus = vi.spyOn(host, 'focus').mockImplementation(() => {})
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  const event = { type: 'notification', key: 'porte:26110301-1:spec', missionId: '26110301-1', title: 'Porte spec', body: 'à valider' }
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [mission({ id: '26110301-1', title: 'Une' }), mission({ id: '26110301-2', title: 'Deux' })],
    })
    send(es, event)
    send(es, event)
  })
  await settleNotes()
  expect(Noted.notes).toHaveLength(1)
  expect(Noted.notes[0]?.title).toBe('Porte spec')
  expect(Noted.notes[0]?.options).toEqual({ body: 'à valider', tag: 'porte:26110301-1:spec' })

  act(() => { Noted.notes[0]?.onclick?.() })
  expect(hash()).toBe('#/26110301-1')
  expect(focus).toHaveBeenCalled()
  expect((screen.getByRole('button', { current: true }) as unknown as { textContent: string }).textContent).toContain('26110301-1')
})

test('page visible et mission sélectionnée : pas de notification', async () => {
  stubNotification('granted')
  setHash('#/26110301-1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'notification',
      key: 'badge:26110301-1',
      missionId: '26110301-1',
      title: 'Attend ta réponse',
      body: '26110301-1',
    })
  })
  await settleNotes()
  expect(Noted.notes).toHaveLength(0)
})

test('page masquée : la mission sélectionnée est quand même notifiée', async () => {
  stubNotification('granted')
  Object.defineProperty(host.document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  setHash('#/26110301-1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'notification',
      key: 'bloquee:26110301-1',
      missionId: '26110301-1',
      title: 'Mission bloquée',
      body: 'motif',
    })
  })
  await settleNotes()
  expect(Noted.notes).toHaveLength(1)
  expect(Noted.notes[0]?.options).toEqual({ body: 'motif', tag: 'bloquee:26110301-1' })
})

test('un autre onglet visible empêche une seconde notification du même événement', async () => {
  stubNotification('granted')
  Object.defineProperty(host.document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  const peer = new BroadcastChannel('herness-notifications')
  peer.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { type?: string; key?: string; at?: number }
    if (data?.type === 'claim' && data.key) {
      peer.postMessage({ type: 'claim', key: data.key, id: 'autre', at: (data.at ?? 0) + 1, visible: true })
    }
  }
  try {
    deliverNotification({
      key: 'porte:autre:1',
      missionId: '26110301-9',
      title: 'Porte ailleurs',
      body: 'corps',
    }, undefined)
    await settleNotes()
    expect(Noted.notes).toHaveLength(0)
  } finally {
    peer.close()
  }
})
