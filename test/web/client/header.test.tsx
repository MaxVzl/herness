// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { MissionDetail, MissionSummary, ProjectView } from '../../../src/web/protocol.ts'
import { ActionBanner } from '../../../src/web/client/ActionBanner.tsx'
import { App } from '../../../src/web/client/App.tsx'
import { ConfirmDialog } from '../../../src/web/client/Dialogs.tsx'
import { MissionHeader } from '../../../src/web/client/MissionHeader.tsx'
import { NewMissionForm } from '../../../src/web/client/NewMissionForm.tsx'

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

function detail(over: Record<string, unknown> = {}): MissionDetail {
  return {
    state: {
      id: '26110301-1',
      branch: 'feat/tache',
      step: 'tasks',
      paused: false,
      ...over,
    },
    orchestrator: { state: null },
    files: {},
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

function disabled(el: Element): boolean {
  return (el as unknown as { disabled?: boolean }).disabled === true
}

function titleOf(el: Element): string {
  return (el as unknown as { title?: string }).title ?? ''
}

function valueOf(el: Element): string {
  return (el as unknown as { value?: string }).value ?? ''
}

function colorOf(el: Element): string {
  return (el as unknown as { style?: { color?: string } }).style?.color ?? ''
}

function hrefOf(el: Element): string {
  return (el as unknown as { getAttribute(name: string): string | null }).getAttribute('href') ?? ''
}

function setHash(value: string) {
  ;(globalThis as unknown as { location: { hash: string } }).location.hash = value
}

function conversation(): Element {
  const found = (globalThis as unknown as { document: Document }).document.querySelector('.conversation')
  if (!found) throw new Error('colonne centrale absente')
  return found
}

const calls: { url: string; body?: string }[] = []

function installFetch(result: (url: string) => unknown = () => ({ ok: true, lines: [] })) {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), ...(init?.body !== undefined ? { body: init.body } : {}) })
    return { json: async () => result(String(url)) }
  }))
}

beforeEach(() => {
  FakeSource.all = []
  localStorage.clear()
  setHash('')
  installFetch()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('l en-tête montre l identifiant, le titre, le projet, la branche, l étape, la pause, le motif et la PR', () => {
  const summary = mission({ id: '26110301-1', title: 'Corriger le tri', project: 'alpha', step: 'tasks' })
  render(<MissionHeader summary={summary} detail={detail({
    paused: true,
    blockedReason: 'conflit sur src/a.ts',
    prUrl: 'https://github.com/org/repo/pull/12',
  })} onResult={() => {}} />)

  expect(screen.getByText('26110301-1 · Corriger le tri')).toBeTruthy()
  expect(screen.getByText('alpha')).toBeTruthy()
  expect(screen.getByText('feat/tache')).toBeTruthy()
  expect(screen.getByText('tasks')).toBeTruthy()
  expect(screen.getByText('EN PAUSE')).toBeTruthy()
  const reason = screen.getByText('conflit sur src/a.ts')
  expect(classOf(reason).includes('rouge')).toBe(true)
  expect(colorOf(reason)).toBe('var(--red)')
  const link = screen.getByRole('link', { name: 'https://github.com/org/repo/pull/12' })
  expect(hrefOf(link)).toBe('https://github.com/org/repo/pull/12')
})

test('Reprendre est grisé sur une mission terminée et Supprimer n est dans le menu que si elle est fermée', () => {
  const summary = mission({ id: '26110301-1', step: 'tasks' })
  render(<MissionHeader summary={summary} detail={detail()} onResult={() => {}} />)
  expect(disabled(screen.getByRole('button', { name: 'Reprendre' }))).toBe(false)
  expect(screen.queryByText('EN PAUSE')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '⋯' }))
  expect(screen.getByRole('button', { name: 'Fermer' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull()

  for (const step of ['pr-ouverte', 'fermée']) {
    cleanup()
    render(<MissionHeader summary={mission({ id: '26110301-1', step })} detail={detail({ step })} onResult={() => {}} />)
    const reprendre = screen.getByRole('button', { name: 'Reprendre' })
    expect(disabled(reprendre)).toBe(true)
    expect(titleOf(reprendre)).toBe('reprendre indisponible : mission terminée')
    expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '⋯' }))
    if (step === 'fermée') expect(screen.getByRole('button', { name: 'Supprimer' })).toBeTruthy()
    else expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull()
  }
})

test('Fermer demande une confirmation, Entrée envoie le POST, puis la confirmation reçue part en Oui', async () => {
  setHash('#/26110301-1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [mission({ id: '26110301-1', title: 'Titre', step: 'tasks' })],
    })
    send(es, { type: 'mission', id: '26110301-1', detail: detail() })
  })

  const column = conversation()
  const menu = screen.getByRole('button', { name: '⋯' })
  expect(column.contains(menu)).toBe(true)
  fireEvent.click(menu)
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
  expect(screen.getByText('Fermer 26110301-1 ?')).toBeTruthy()
  await act(async () => {
    fireEvent.keyDown(window, { key: 'Enter' })
  })
  expect(calls).toContainEqual({ url: '/api/missions/26110301-1/fermer' })

  act(() => {
    send(es, {
      type: 'confirmation',
      confirmId: 'c9',
      missionId: '26110301-1',
      question: 'Il reste du travail, fermer quand même ?',
    })
  })
  expect(screen.getByText('Il reste du travail, fermer quand même ?')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  })
  expect(calls).toContainEqual({ url: '/api/confirmations/c9', body: JSON.stringify({ oui: true }) })
})

test('Échap sur une confirmation vaut non', () => {
  const onYes = vi.fn()
  const onNo = vi.fn()
  render(<ConfirmDialog question="Fermer 26110301-1 ?" onYes={onYes} onNo={onNo} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onNo).toHaveBeenCalledTimes(1)
  expect(onYes).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  expect(onYes).toHaveBeenCalledTimes(1)
})

test('Entrée sur Non ou dans un champ ne valide pas la confirmation', () => {
  const onYes = vi.fn()
  const onNo = vi.fn()
  render(
    <>
      <textarea aria-label="Demande" />
      <ConfirmDialog question="Fermer 26110301-1 ?" onYes={onYes} onNo={onNo} />
    </>,
  )
  const non = screen.getByRole('button', { name: 'Non' })
  non.focus()
  fireEvent.keyDown(non, { key: 'Enter' })
  expect(onYes).not.toHaveBeenCalled()

  const demande = screen.getByRole('textbox', { name: 'Demande' })
  demande.focus()
  fireEvent.keyDown(demande, { key: 'Enter' })
  expect(onYes).not.toHaveBeenCalled()
})

test('une confirmation inconnue s affiche et la question disparaît', async () => {
  installFetch(() => ({ ok: false, lines: ['confirmation inconnue'] }))
  setHash('#/26110301-1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'confirmation',
      confirmId: 'c9',
      missionId: '26110301-1',
      question: 'Il reste du travail, fermer quand même ?',
    })
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  })
  expect(await screen.findByText('confirmation inconnue')).toBeTruthy()
  expect(screen.queryByText('Il reste du travail, fermer quand même ?')).toBeNull()
  expect(calls).toContainEqual({ url: '/api/confirmations/c9', body: JSON.stringify({ oui: true }) })
})

test('un serveur injoignable laisse la confirmation à renvoyer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('réseau')
  }))
  setHash('#/26110301-1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'confirmation',
      confirmId: 'c9',
      missionId: '26110301-1',
      question: 'Il reste du travail, fermer quand même ?',
    })
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  })
  expect(await screen.findByText('serveur injoignable')).toBeTruthy()
  expect(screen.getByText('Il reste du travail, fermer quand même ?')).toBeTruthy()
})

test('pendant une action son bouton est désactivé et indique en cours', async () => {
  let release: () => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
    release = () => resolve({ json: async () => ({ ok: true, lines: ['ouvert'] }) })
  })))
  render(<MissionHeader summary={mission({ id: '26110301-1' })} detail={detail()} onResult={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir dans herdr' }))
  const busy = screen.getByRole('button', { name: 'Ouvrir dans herdr — en cours' })
  expect(disabled(busy)).toBe(true)
  await act(async () => { release() })
  expect(screen.getByRole('button', { name: 'Ouvrir dans herdr' })).toBeTruthy()
})

test('le succès disparaît après 5 s, l erreur reste jusqu au clic, 8 lignes au plus', async () => {
  vi.useFakeTimers()
  const view = render(<ActionBanner result={{ ok: true, lines: ['c est fait'] }} />)
  expect(screen.getByText('c est fait')).toBeTruthy()
  await act(async () => { vi.advanceTimersByTime(4999) })
  expect(screen.getByText('c est fait')).toBeTruthy()
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(screen.queryByText('c est fait')).toBeNull()

  const lines = Array.from({ length: 10 }, (_, i) => `ligne-${i}`)
  view.rerender(<ActionBanner result={{ ok: false, lines }} />)
  expect(screen.queryByText('ligne-0')).toBeNull()
  expect(screen.queryByText('ligne-1')).toBeNull()
  expect(screen.getByText('ligne-2')).toBeTruthy()
  expect(screen.getByText('ligne-9')).toBeTruthy()
  expect(screen.getAllByRole('listitem')).toHaveLength(8)
  await act(async () => { vi.advanceTimersByTime(10_000) })
  expect(screen.getByText('ligne-9')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '✕' }))
  expect(screen.queryByText('ligne-9')).toBeNull()
})

test('Ouvrir dans herdr affiche la ligne renvoyée par le serveur', async () => {
  installFetch(() => ({ ok: true, lines: ['espace ouvert dans herdr — bascule sur ta fenêtre herdr'] }))
  setHash('#/26110301-1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: [mission({ id: '26110301-1' })],
    })
    send(es, { type: 'mission', id: '26110301-1', detail: detail() })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir dans herdr' }))
  const line = await screen.findByText('espace ouvert dans herdr — bascule sur ta fenêtre herdr')
  expect(conversation().contains(line)).toBe(true)
})

test('Nouvelle mission présélectionne le projet, exige la demande et envoie projet, demande et note', async () => {
  installFetch(() => ({ ok: true, lines: [], id: '26110301-9' }))
  const onStarted = vi.fn()
  const { rerender } = render(<NewMissionForm projects={projects} defaultProject="beta" onStarted={onStarted} onCancel={() => {}} />)
  expect(valueOf(screen.getByRole('combobox', { name: 'Projet' }))).toBe('beta')
  const start = screen.getByRole('button', { name: 'Démarrer' })
  expect(disabled(start)).toBe(true)
  expect(screen.getByRole('textbox', { name: 'Note' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Demande' }), { target: { value: 'corriger le tri' } })
  expect(disabled(screen.getByRole('button', { name: 'Démarrer' }))).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'sans urgence' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Démarrer' }))
  })
  expect(calls).toContainEqual({
    url: '/api/missions',
    body: JSON.stringify({ projet: 'beta', demande: 'corriger le tri', note: 'sans urgence' }),
  })
  expect(onStarted).toHaveBeenCalledWith('26110301-9')

  onStarted.mockClear()
  installFetch(() => ({ ok: false, lines: ['KO preflight', 'repo absent'] }))
  rerender(<NewMissionForm projects={projects} defaultProject="beta" onStarted={onStarted} onCancel={() => {}} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Demande' }), { target: { value: 'autre demande' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Démarrer' }))
  })
  expect(onStarted).not.toHaveBeenCalled()
  expect(screen.getByText('KO preflight')).toBeTruthy()
  expect(screen.getByText('repo absent')).toBeTruthy()
})

test('le formulaire de nouvelle mission s ouvre dans la colonne centrale sur le projet filtré', async () => {
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, { type: 'missions', missions: [], hiddenCount: 0, projects })
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Projet : tous ▾' }), { target: { value: 'beta' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Nouvelle mission' }))
  const projet = screen.getByRole('combobox', { name: 'Projet' })
  expect(valueOf(projet)).toBe('beta')
  expect(conversation().contains(projet)).toBe(true)
})
