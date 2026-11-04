// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Gate } from '../../../src/mission/state.ts'
import type { AgentView, CheckView, MissionDetail, MissionSummary, ProjectView } from '../../../src/web/protocol.ts'
import { AgentsTab } from '../../../src/web/client/AgentsTab.tsx'
import { App } from '../../../src/web/client/App.tsx'
import { ChecksTab } from '../../../src/web/client/ChecksTab.tsx'
import { SidePanel } from '../../../src/web/client/SidePanel.tsx'
import { ago } from '../../../src/web/client/ago.ts'

const NOW = new Date('2026-11-04T12:00:00.000Z')

const projects: ProjectView[] = [{ name: 'alpha', repoPath: '/a', preflight: ['typecheck', 'tests', 'lint'] }]

function ilYA(secondes: number): string {
  return new Date(NOW.getTime() - secondes * 1000).toISOString()
}

function agent(over: Partial<AgentView> & Pick<AgentView, 'name' | 'state'>): AgentView {
  return {
    role: 'Implémenteur',
    tool: 'Cursor',
    task: 2,
    lastActivityAt: ilYA(4),
    tail: `queue ${over.name}`,
    ...over,
  }
}

function check(over: Partial<CheckView> & Pick<CheckView, 'file' | 'label' | 'status'>): CheckView {
  return {
    startedAt: '2026-11-04T12:00:00.000Z',
    durationMs: 2000,
    lastOutputAt: ilYA(4),
    ...over,
  }
}

function porte(over: Partial<Gate> & Pick<Gate, 'id' | 'summary' | 'status'>): Gate {
  return {
    kind: 'agent-bloque',
    createdAt: '2026-11-04T11:00:00.000Z',
    ...over,
  }
}

const calls: string[] = []
const bodies = new Map<string, string>()

function installFetch() {
  calls.length = 0
  bodies.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cible = String(url)
    calls.push(cible)
    const text = bodies.get(cible) ?? ''
    return { text: async () => text, json: async () => ({ ok: true, lines: [] }) }
  }))
}

function classOf(el: Element): string[] {
  return ((el as unknown as { className?: string }).className ?? '').split(/\s+/).filter(Boolean)
}

function setLargeur(value: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value })
  window.dispatchEvent(new Event('resize'))
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

function setHash(value: string) {
  ;(globalThis as unknown as { location: { hash: string } }).location.hash = value
}

const detailVide: MissionDetail = {
  state: { tasks: [], gates: [], log: [], loops: { preflight: { results: [] }, globalReview: { round: 0 } } },
  orchestrator: { state: null },
  files: {},
}

function mission(id: string): MissionSummary {
  return {
    id,
    project: 'alpha',
    title: 'Titre',
    status: 'tâche 2/3',
    bucket: 'active',
    hidden: false,
    createdAt: '2026-11-03T10:00:00.000Z',
    step: 'tasks',
  }
}

beforeEach(() => {
  FakeSource.all = []
  localStorage.clear()
  setHash('')
  setLargeur(1400)
  installFetch()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('ago dit les secondes, les minutes avec le reste, puis les heures', () => {
  expect(ago(ilYA(4), NOW)).toBe('il y a 4 s')
  expect(ago(ilYA(100), NOW)).toBe('il y a 1 min 40')
  expect(ago(ilYA(7200), NOW)).toBe('il y a 2 h')
})

test('une carte par agent, dans l ordre reçu, avec rôle, tâche, outil, état, activité et queue', () => {
  const agents = [
    agent({ name: 'impl', role: 'Implémenteur', tool: 'Cursor', task: 2, state: 'working', tail: 'ligne impl' }),
    agent({ name: 'relu', role: 'Relecteur', tool: 'Claude', task: 3, state: 'idle', tail: 'ligne relu' }),
    agent({ name: 'diag', role: 'Diagnostic', tool: 'Claude', state: 'working', task: undefined, tail: 'ligne diag' }),
  ]
  render(<AgentsTab missionId="m1" agents={agents} gates={[]} />)
  const cartes = screen.getAllByRole('article')
  expect(cartes.map((carte) => carte.getAttribute('aria-label'))).toEqual(['impl', 'relu', 'diag'])
  expect(cartes[0]?.textContent).toContain('Implémenteur')
  expect(cartes[0]?.textContent).toContain('tâche 2')
  expect(cartes[0]?.textContent).toContain('Cursor')
  expect(cartes[0]?.textContent).toContain('working')
  expect(cartes[0]?.textContent).toContain('dernière activité il y a 4 s')
  expect(cartes[0]?.textContent).toContain('ligne impl')
  expect(cartes[1]?.textContent).toContain('Relecteur')
  expect(cartes[1]?.textContent).toContain('tâche 3')
  expect(cartes[1]?.textContent).toContain('Claude')
  expect(cartes[1]?.textContent).toContain('idle')
  expect(cartes[2]?.textContent).toContain('Diagnostic')
  expect(cartes[2]?.textContent).not.toContain('tâche')
  expect(screen.queryByRole('button', { name: /répondre/i })).toBeNull()
})

test('la dernière activité avance chaque seconde sans nouvel événement', () => {
  render(<AgentsTab missionId="m1" agents={[agent({ name: 'impl', state: 'working' })]} gates={[]} />)
  expect(screen.getByText(/dernière activité il y a 4 s/)).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1000) })
  expect(screen.getByText(/dernière activité il y a 5 s/)).toBeTruthy()
  expect(screen.queryByText(/dernière activité il y a 4 s/)).toBeNull()
})

test('la carte est ambre si l agent est blocked ou cité par une porte agent-bloque en attente', () => {
  const agents = [
    agent({ name: 'impl', state: 'blocked' }),
    agent({ name: 'relu', state: 'idle' }),
    agent({ name: 'diag', state: 'working' }),
  ]
  const gates = [
    porte({ id: 'g1', status: 'pending', summary: 'Agent relu (revue) bloqué, à débloquer dans son panneau :\nrelu ne répond plus' }),
    porte({ id: 'g2', status: 'approved', summary: 'Agent diag (diagnostic) bloqué, à débloquer dans son panneau :\ndiag était bloqué' }),
  ]
  render(<AgentsTab missionId="m1" agents={agents} gates={gates} />)
  const cartes = screen.getAllByRole('article')
  expect(classOf(cartes[0]!)).toContain('ambre')
  expect(classOf(cartes[1]!)).toContain('ambre')
  expect(classOf(cartes[2]!)).not.toContain('ambre')
})

test('une porte pour c1-t12 ne met pas en ambre c1-t1 ni un nom seulement cité dans la sortie', () => {
  const agents = [
    agent({ name: 'c1-t1', state: 'idle' }),
    agent({ name: 'c1-t1b', state: 'idle' }),
    agent({ name: 'c1-t12', state: 'idle' }),
  ]
  const gates = [
    porte({
      id: 'g12',
      status: 'pending',
      summary: 'Agent c1-t12 (implémentation) bloqué, à débloquer dans son panneau :\nmention de c1-t1 et de c1-t1b dans la sortie',
    }),
  ]
  render(<AgentsTab missionId="m1" agents={agents} gates={gates} />)
  const cartes = screen.getAllByRole('article')
  expect(classOf(cartes[0]!)).not.toContain('ambre')
  expect(classOf(cartes[1]!)).not.toContain('ambre')
  expect(classOf(cartes[2]!)).toContain('ambre')
})

test('un agent terminé est replié et se déplie sur demande', () => {
  render(<AgentsTab missionId="m1" agents={[agent({ name: 'fini', state: 'done', tail: 'sortie terminée' })]} gates={[]} />)
  const carte = screen.getByRole('article', { name: 'fini' })
  expect(classOf(carte)).toContain('replie')
  expect(carte.textContent).toContain('done')
  expect(screen.queryByText('sortie terminée')).toBeNull()
  expect(within(carte).queryByRole('button', { name: 'Voir toute la sortie' })).toBeNull()
  fireEvent.click(within(carte).getByRole('button', { name: 'Déplier' }))
  expect(screen.getByText('sortie terminée')).toBeTruthy()
  expect(classOf(carte)).not.toContain('replie')
})

test('voir toute la sortie charge 400 lignes et les recharge chaque seconde tant que c est ouvert', async () => {
  const url = '/api/missions/m1/agents/impl/sortie?lignes=400'
  bodies.set(url, 'sortie complète')
  render(<AgentsTab missionId="m1" agents={[agent({ name: 'impl', state: 'working', tail: 'ligne impl' })]} gates={[]} />)
  expect(calls.filter((item) => item.includes('/sortie'))).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Voir toute la sortie' }))
  expect(await screen.findByText('sortie complète')).toBeTruthy()
  expect(calls.filter((item) => item.includes('/sortie'))).toEqual([url])

  bodies.set(url, 'sortie suivante')
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(screen.getByText('sortie suivante')).toBeTruthy()
  expect(calls.filter((item) => item.includes('/sortie'))).toEqual([url, url])

  fireEvent.click(screen.getByRole('button', { name: 'Masquer la sortie' }))
  expect(screen.queryByText('sortie suivante')).toBeNull()
  await act(async () => { vi.advanceTimersByTime(3000) })
  expect(calls.filter((item) => item.includes('/sortie'))).toEqual([url, url])
})

test('un échec de chargement garde la dernière sortie et le signale', async () => {
  const url = '/api/missions/m1/agents/impl/sortie?lignes=400'
  bodies.set(url, 'sortie complète')
  render(<AgentsTab missionId="m1" agents={[agent({ name: 'impl', state: 'working', tail: 'ligne impl' })]} gates={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Voir toute la sortie' }))
  expect(await screen.findByText('sortie complète')).toBeTruthy()

  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('réseau')
  }))
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(screen.getByText('sortie complète')).toBeTruthy()
  expect(screen.getByText('sortie illisible : serveur injoignable')).toBeTruthy()

  vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => 'sortie reprise', json: async () => ({ ok: true, lines: [] }) })))
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(screen.getByText('sortie reprise')).toBeTruthy()
  expect(screen.queryByText('sortie complète')).toBeNull()
  expect(screen.queryByText('sortie illisible : serveur injoignable')).toBeNull()
})

test('un point marque l onglet Agents quand une porte agent-bloque est en attente, même sans liste d agents', () => {
  render(
    <SidePanel
      missionId="m1"
      state={{
        ...detailVide,
        state: {
          tasks: [],
          gates: [porte({ id: 'g1', summary: 'Agent impl (Implémenteur) bloqué', status: 'pending' })],
          log: [],
          loops: { preflight: { results: [] }, globalReview: { round: 0 } },
        },
      }}
      agents={[]}
      onTab={() => {}}
    />,
  )
  expect(classOf(screen.getByRole('tab', { name: 'Agents' }))).toContain('point')
})

test('un point marque l onglet Agents quand une carte est ambre', () => {
  render(
    <SidePanel
      missionId="m1"
      state={detailVide}
      agents={[agent({ name: 'impl', state: 'blocked' })]}
      onTab={() => {}}
    />,
  )
  expect(classOf(screen.getByRole('tab', { name: 'Agents' }))).toContain('point')
  expect(classOf(screen.getByRole('tab', { name: 'Checks' }))).not.toContain('point')
})

test('une carte par check avec nom, état et durée ; en cours dit l âge de la sortie, un rouge montre l erreur', () => {
  const checks = [
    check({ file: '300-lint.log', label: 'lint', status: 'en-cours', durationMs: 5000, startedAt: '2026-11-04T11:00:00.000Z' }),
    check({ file: '200-tests.log', label: 'tests', status: 'rouge', durationMs: 1500, startedAt: '2026-11-04T10:00:00.000Z', errorTail: 'assertion cassée' }),
    check({ file: '100-typecheck.log', label: 'typecheck', status: 'vert', durationMs: 2000, startedAt: '2026-11-04T09:00:00.000Z' }),
  ]
  render(<ChecksTab missionId="m1" checks={checks} preflight={[]} results={[]} />)
  const cartes = screen.getAllByRole('article')
  expect(cartes.map((carte) => carte.getAttribute('aria-label'))).toEqual(['lint', 'tests', 'typecheck'])
  expect(cartes[0]?.textContent).toContain('en-cours')
  expect(cartes[0]?.textContent).toContain('5 s')
  expect(cartes[0]?.textContent).toContain('dernière sortie il y a 4 s')
  expect(cartes[1]?.textContent).toContain('rouge')
  expect(cartes[1]?.textContent).toContain('1,5 s')
  expect(cartes[1]?.textContent).toContain('assertion cassée')
  expect(cartes[1]?.textContent).not.toContain('dernière sortie')
  expect(cartes[2]?.textContent).toContain('vert')
  expect(cartes[2]?.textContent).toContain('2 s')
  act(() => { vi.advanceTimersByTime(1000) })
  expect(cartes[0]?.textContent).toContain('dernière sortie il y a 5 s')
})

test('voir tout le journal ouvre le fichier logs du check', async () => {
  const chemin = 'logs/200-tests.log'
  const url = `/api/missions/${encodeURIComponent('m1')}/fichier?${new URLSearchParams({ chemin })}`
  bodies.set(url, 'journal complet du check')
  render(
    <ChecksTab
      missionId="m1"
      checks={[check({ file: '200-tests.log', label: 'tests', status: 'rouge', errorTail: 'assertion cassée' })]}
      preflight={[]}
      results={[]}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Voir tout le journal' }))
  expect(await screen.findByText('journal complet du check')).toBeTruthy()
  expect(calls).toContain(url)
})

test('le preflight liste chaque étape configurée, son issue, ou pas lancé', () => {
  render(
    <ChecksTab
      missionId="m1"
      checks={[]}
      preflight={['typecheck', 'tests', 'lint']}
      results={[
        { label: 'typecheck', exitCode: 0, durationMs: 2000 },
        { label: 'tests', exitCode: 1, durationMs: 1500 },
      ]}
    />,
  )
  const bloc = screen.getByRole('region', { name: 'Preflight' })
  const lignes = within(bloc).getAllByRole('listitem')
  expect(lignes.map((ligne) => ligne.textContent)).toEqual([
    '✓ typecheck 2 s',
    '✗ tests 1,5 s',
    'lint pas lancé',
  ])
  expect(classOf(lignes[2]!)).toContain('gris')
  expect(classOf(lignes[0]!)).not.toContain('gris')
})

test('un point marque l onglet Checks quand le check le plus récent est rouge', () => {
  const rougePuisVert = [
    check({ file: '200-tests.log', label: 'tests', status: 'vert', startedAt: '2026-11-04T12:00:02.000Z' }),
    check({ file: '100-typecheck.log', label: 'typecheck', status: 'rouge', startedAt: '2026-11-04T12:00:01.000Z', errorTail: 'boom' }),
  ]
  const view = render(
    <SidePanel missionId="m1" state={detailVide} checks={rougePuisVert} onTab={() => {}} />,
  )
  expect(classOf(screen.getByRole('tab', { name: 'Checks' }))).not.toContain('point')

  view.rerender(
    <SidePanel
      missionId="m1"
      state={detailVide}
      checks={[
        check({ file: '100-typecheck.log', label: 'typecheck', status: 'rouge', startedAt: '2026-11-04T12:00:03.000Z', errorTail: 'boom' }),
        check({ file: '200-tests.log', label: 'tests', status: 'vert', startedAt: '2026-11-04T12:00:02.000Z' }),
      ]}
      onTab={() => {}}
    />,
  )
  expect(classOf(screen.getByRole('tab', { name: 'Checks' }))).toContain('point')
})

test('l onglet Agents ouvert abonne le flux aux agents et affiche leurs cartes', async () => {
  setHash('#/m1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = FakeSource.all[0]
  if (!es) throw new Error('flux absent')
  expect(es.url).toContain('agents=0')
  act(() => {
    es.onopen?.({})
    send(es, { type: 'missions', missions: [mission('m1')], hiddenCount: 0, projects })
    send(es, { type: 'mission', id: 'm1', detail: detailVide })
  })
  expect(screen.getByRole('tab', { name: 'Agents' })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
  await act(async () => {})
  const suivant = FakeSource.all[1]
  expect(es.close).toHaveBeenCalled()
  expect(suivant?.url).toBe('/api/evenements?mission=m1&agents=1')
  act(() => {
    suivant?.onopen?.({})
    send(suivant!, { type: 'missions', missions: [mission('m1')], hiddenCount: 0, projects })
    send(suivant!, { type: 'mission', id: 'm1', detail: detailVide })
    send(suivant!, {
      type: 'agents',
      id: 'm1',
      agents: [agent({ name: 'impl', state: 'working', tail: 'queue live' })],
    })
  })
  expect(screen.getByText('queue live')).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: 'Journal' }))
  await act(async () => {})
  expect(FakeSource.all[2]?.url).toBe('/api/evenements?mission=m1&agents=0')
})

test('ouvrir ou quitter l onglet Agents ne vide pas la page', async () => {
  setHash('#/m1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = FakeSource.all[0]
  if (!es) throw new Error('flux absent')
  const detail = { ...detailVide, orchestrator: { state: 'idle' } }
  act(() => {
    es.onopen?.({})
    send(es, { type: 'missions', missions: [mission('m1')], hiddenCount: 0, projects })
    send(es, { type: 'mission', id: 'm1', detail })
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'brouillon' } })
  fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
  await act(async () => {})
  const suivant = FakeSource.all[1]
  act(() => { suivant?.onopen?.({}) })
  expect(screen.getByText('Titre')).toBeTruthy()
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('brouillon')
  expect(screen.getByRole('tab', { name: 'Agents' })).toBeTruthy()
})
