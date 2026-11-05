// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DocView, MissionDetail, MissionSummary, ProjectView } from '../../../src/web/protocol.ts'
import { App } from '../../../src/web/client/App.tsx'
import { DiffView } from '../../../src/web/client/DiffView.tsx'
import { SidePanel } from '../../../src/web/client/SidePanel.tsx'

const projects: ProjectView[] = [{ name: 'alpha', repoPath: '/a', preflight: [] }]

function mission(over: Partial<MissionSummary> & Pick<MissionSummary, 'id'>): MissionSummary {
  return {
    project: 'alpha',
    title: 'Titre',
    status: 'tâche 2/3',
    bucket: 'active',
    hidden: false,
    createdAt: '2026-11-03T10:00:00.000Z',
    step: 'tasks',
    ...over,
  }
}

function detail(state: Record<string, unknown>, files: Record<string, string[]> = {}): MissionDetail {
  return { state, orchestrator: { state: null }, files }
}

const tasks = [
  { n: 1, title: 'Préparer', phase: 'done', round: 1 },
  { n: 2, title: 'Corriger', phase: 'review', round: 2 },
  { n: 3, title: 'Livrer', phase: 'pending', round: 0 },
]

function etat(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    step: 'tasks',
    tasks,
    log: [],
    loops: {
      globalReview: { round: 3 },
      preflight: {
        round: 1,
        results: [
          { label: 'typecheck', exitCode: 0, durationMs: 2000, logPath: '/a' },
          { label: 'tests', exitCode: 1, durationMs: 1500, logPath: '/b' },
        ],
      },
    },
    ...over,
  }
}

const files: Record<string, string[]> = {
  'taches/2': ['brief.md', 'note.txt', 'correctif.diff'],
  global: ['revue.md'],
  preflight: ['journal.txt'],
}

const bodies: Record<string, string> = {
  'taches/2/brief.md': '# Brief\n\nconsigne de la tâche',
  'taches/2/note.txt': 'texte brut du correctif',
  'taches/2/correctif.diff': '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-ancien\n+nouveau\n',
  'global/revue.md': '# Revue\n\nbilan global',
  'preflight/journal.txt': 'sortie preflight',
}

function fichier(id: string, chemin: string): string {
  return `/api/missions/${encodeURIComponent(id)}/fichier?${new URLSearchParams({ chemin })}`
}

const calls: string[] = []

function installFetch() {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    const chemin = new URL(String(url), 'http://localhost').searchParams.get('chemin') ?? ''
    const text = bodies[chemin] ?? ''
    return { text: async () => text, json: async () => ({ ok: true, lines: [] }) }
  }))
}

function setLargeur(value: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value })
  window.dispatchEvent(new Event('resize'))
}

function renderPanel(state = etat(), docs: { spec?: DocView; plan?: DocView } = {}) {
  return render(
    <SidePanel missionId="m1" state={detail(state, files)} spec={docs.spec} plan={docs.plan} onTab={() => {}} />,
  )
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

function flux(): FakeSource {
  const es = FakeSource.all[0]
  if (!es) throw new Error('flux absent')
  return es
}

function setHash(value: string) {
  ;(globalThis as unknown as { location: { hash: string } }).location.hash = value
}

function classOf(el: Element): string[] {
  return ((el as unknown as { className?: string }).className ?? '').split(/\s+/).filter(Boolean)
}

beforeEach(() => {
  FakeSource.all = []
  localStorage.clear()
  setHash('')
  setLargeur(1400)
  installFetch()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('chaque tâche affiche son numéro, son titre, sa phase, son tour et sa pastille', () => {
  renderPanel()
  const faite = screen.getByRole('button', { name: /1 · Préparer/ })
  const cours = screen.getByRole('button', { name: /2 · Corriger/ })
  const faire = screen.getByRole('button', { name: /3 · Livrer/ })
  expect(faite.textContent).toContain('done')
  expect(faite.textContent).toContain('tour 1/3')
  expect(faite.querySelector('.pastille.faite')).toBeTruthy()
  expect(cours.textContent).toContain('review')
  expect(cours.textContent).toContain('tour 2/3')
  expect(cours.querySelector('.pastille.en-cours')).toBeTruthy()
  expect(faire.textContent).toContain('pending')
  expect(faire.textContent).toContain('tour 0/3')
  expect(faire.querySelector('.pastille.a-faire')).toBeTruthy()
})

test('la tâche courante est en échec quand la mission est bloquée', () => {
  renderPanel(etat({ step: 'bloquée' }))
  const cours = screen.getByRole('button', { name: /2 · Corriger/ })
  expect(cours.querySelector('.pastille.echec')).toBeTruthy()
  expect(cours.querySelector('.pastille.en-cours')).toBeNull()
  expect(screen.getByRole('button', { name: /1 · Préparer/ }).querySelector('.pastille.faite')).toBeTruthy()
})

test('un clic sur une tâche montre ses fichiers, un clic charge le fichier', async () => {
  renderPanel()
  expect(screen.queryByRole('button', { name: 'brief.md' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /2 · Corriger/ }))
  fireEvent.click(screen.getByRole('button', { name: 'brief.md' }))
  expect(await screen.findByRole('heading', { name: 'Brief' })).toBeTruthy()
  expect(screen.getByText('consigne de la tâche')).toBeTruthy()
  expect(calls).toContain(fichier('m1', 'taches/2/brief.md'))

  fireEvent.click(screen.getByRole('button', { name: 'note.txt' }))
  expect(await screen.findByText('texte brut du correctif')).toBeTruthy()
  const brut = screen.getByText('texte brut du correctif')
  expect(brut.tagName).toBe('PRE')
  expect(calls).toContain(fichier('m1', 'taches/2/note.txt'))

  fireEvent.click(screen.getByRole('button', { name: 'correctif.diff' }))
  expect(await screen.findByText(/nouveau/)).toBeTruthy()
  const ajout = document.querySelector('.diff-ajout')
  const retrait = document.querySelector('.diff-retrait')
  expect(ajout?.textContent).toContain('nouveau')
  expect(retrait?.textContent).toContain('ancien')
  expect(calls).toContain(fichier('m1', 'taches/2/correctif.diff'))
})

test('la revue globale et le preflight montrent le tour, les résultats et leurs fichiers', async () => {
  renderPanel()
  const globale = screen.getByRole('region', { name: 'Revue globale' })
  expect(globale.textContent).toContain('tour 3')
  fireEvent.click(within(globale).getByRole('button', { name: 'revue.md' }))
  expect(await screen.findByRole('heading', { name: 'Revue' })).toBeTruthy()
  expect(calls).toContain(fichier('m1', 'global/revue.md'))

  const preflight = screen.getByRole('region', { name: 'Preflight' })
  expect(preflight.textContent).toContain('tour 1')
  const typecheck = within(preflight).getByText(/typecheck/, { selector: 'li' })
  expect(typecheck.textContent).toContain('✓')
  expect(typecheck.textContent).toContain('2 s')
  const tests = within(preflight).getByText(/tests/, { selector: 'li' })
  expect(tests.textContent).toContain('✗')
  expect(tests.textContent).toContain('1,5 s')
  fireEvent.click(within(preflight).getByRole('button', { name: 'journal.txt' }))
  expect(await screen.findByText('sortie preflight')).toBeTruthy()
  expect(calls).toContain(fichier('m1', 'preflight/journal.txt'))
})

test('spec et plan : worktree, proposition, approuvé et absent', () => {
  const view = renderPanel(etat(), {
    spec: { source: 'worktree', text: '# Spec\n\ntexte du worktree' },
    plan: { source: 'absent', reason: 'pas encore écrit' },
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Spec' }))
  expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy()
  expect(screen.getByText('texte du worktree')).toBeTruthy()
  expect(screen.queryByText("Proposition d'amendement en attente")).toBeNull()
  expect(classOf(screen.getByRole('tab', { name: 'Spec' })).includes('point')).toBe(false)

  fireEvent.click(screen.getByRole('tab', { name: 'Plan' }))
  expect(screen.getByText('pas encore écrit')).toBeTruthy()

  view.rerender(
    <SidePanel
      missionId="m1"
      state={detail(etat(), files)}
      spec={{ source: 'proposition', text: 'ligne a\nligne c\n', current: 'ligne a\nligne b\n' }}
      plan={{ source: 'approuve', text: '# Plan\n\nversion validée' }}
      onTab={() => {}}
    />,
  )
  const spec = screen.getByRole('tab', { name: 'Spec' })
  expect(classOf(spec).includes('point')).toBe(true)
  fireEvent.click(spec)
  expect(screen.getByText("Proposition d'amendement en attente")).toBeTruthy()
  expect(screen.getByText(/ligne c/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Différences avec la version actuelle' }))
  expect(document.querySelector('.diff-ajout')?.textContent).toContain('ligne c')
  expect(document.querySelector('.diff-retrait')?.textContent).toContain('ligne b')

  const plan = screen.getByRole('tab', { name: 'Plan' })
  expect(classOf(plan).includes('point')).toBe(false)
  fireEvent.click(plan)
  expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy()
  expect(screen.getByText('version validée')).toBeTruthy()
  expect(screen.getByText('plan validé (worktree supprimé)')).toBeTruthy()
})

test('un point marque le plan quand sa proposition est en attente', () => {
  renderPanel(etat(), {
    plan: { source: 'proposition', text: 'nouveau plan', current: 'ancien plan' },
  })
  expect(classOf(screen.getByRole('tab', { name: 'Plan' })).includes('point')).toBe(true)
  expect(classOf(screen.getByRole('tab', { name: 'Spec' })).includes('point')).toBe(false)
})

function heureLocale(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

test('le journal montre toutes les entrées, la plus récente en haut, avec l heure locale', () => {
  renderPanel(etat({
    log: [
      { at: 'pas une date', msg: 'brouillon' },
      { at: '2026-11-03T09:15:00.000Z', msg: 'mission créée' },
      { at: '2026-11-03T14:30:00.000Z', msg: 'tâche 2 en revue' },
    ],
  }))
  fireEvent.click(screen.getByRole('tab', { name: 'Journal' }))
  const lignes = document.querySelectorAll('.journal li')
  expect(lignes).toHaveLength(3)
  expect(lignes[0]?.textContent).toContain(heureLocale('2026-11-03T14:30:00.000Z'))
  expect(lignes[0]?.textContent).toContain('tâche 2 en revue')
  expect(lignes[1]?.textContent).toContain(heureLocale('2026-11-03T09:15:00.000Z'))
  expect(lignes[1]?.textContent).toContain('mission créée')
  expect(lignes[2]?.textContent).toContain('pas une date')
  expect(lignes[2]?.textContent).toContain('brouillon')
})

test('deux entrées identiques du journal restent deux lignes', () => {
  const erreur = vi.spyOn(console, 'error').mockImplementation(() => {})
  renderPanel(etat({
    log: [
      { at: '2026-11-03T14:30:00.000Z', msg: 'même' },
      { at: '2026-11-03T14:30:00.000Z', msg: 'même' },
    ],
  }))
  fireEvent.click(screen.getByRole('tab', { name: 'Journal' }))
  expect(document.querySelectorAll('.journal li')).toHaveLength(2)
  const doublon = erreur.mock.calls.some((args) => args.map(String).join(' ').includes('same key'))
  expect(doublon).toBe(false)
})

test('les onglets Agents et Checks sont vides, et l onglet est mémorisé', () => {
  localStorage.setItem('herness.onglet', 'journal')
  const onTab = vi.fn()
  render(<SidePanel missionId="m1" state={detail(etat(), files)} onTab={onTab} />)
  const journal = screen.getByRole('tab', { name: 'Journal' })
  expect(journal.getAttribute('aria-selected')).toBe('true')
  expect(onTab).toHaveBeenCalledWith('journal')

  fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
  expect(screen.getByRole('tabpanel').textContent).toBe('')
  expect(localStorage.getItem('herness.onglet')).toBe('agents')

  fireEvent.click(screen.getByRole('tab', { name: 'Checks' }))
  expect(screen.getByRole('tabpanel').textContent).toBe('')
  expect(localStorage.getItem('herness.onglet')).toBe('checks')

  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('bloque')
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Tâches' }))
  expect(screen.getByRole('tab', { name: 'Tâches' }).getAttribute('aria-selected')).toBe('true')

  cleanup()
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('bloque')
  })
  render(<SidePanel missionId="m2" state={detail(etat(), files)} onTab={() => {}} />)
  expect(screen.getByRole('tab', { name: 'Tâches' }).getAttribute('aria-selected')).toBe('true')
})

test('le diff unifié et le diff par lignes colorent les ajouts et les retraits', () => {
  const view = render(<DiffView diff={'--- a/f\n+++ b/f\n@@ -1 +1 @@\n-ancien\n+nouveau\n'} />)
  expect(document.querySelector('.diff-retrait')?.textContent).toContain('ancien')
  expect(document.querySelector('.diff-ajout')?.textContent).toContain('nouveau')
  expect(document.querySelector('.diff-ajout')?.textContent).not.toContain('+++')

  view.rerender(<DiffView before={'ligne a\nligne b\n'} after={'ligne a\nligne c\n'} />)
  expect(document.querySelector('.diff-retrait')?.textContent).toContain('ligne b')
  expect(document.querySelector('.diff-ajout')?.textContent).toContain('ligne c')
})

test('le panneau se redimensionne entre 280 et 600 px', () => {
  renderPanel()
  const panneau = document.querySelector('.panneau')
  if (!(panneau instanceof HTMLElement)) throw new Error('panneau absent')
  expect(panneau.style.width).toBe('360px')
  const poignee = screen.getByRole('separator', { name: 'Redimensionner' })
  fireEvent.pointerDown(poignee, { clientX: 300, pointerId: 1 })
  fireEvent.pointerMove(poignee, { clientX: 200, pointerId: 1 })
  expect(panneau.style.width).toBe('460px')
  fireEvent.pointerMove(poignee, { clientX: -1000, pointerId: 1 })
  expect(panneau.style.width).toBe('600px')
  fireEvent.pointerDown(poignee, { clientX: 0, pointerId: 1 })
  fireEvent.pointerMove(poignee, { clientX: 1000, pointerId: 1 })
  expect(panneau.style.width).toBe('280px')
})

test('sous 1100 px le panneau devient un tiroir ouvert par Contexte et refermé par Fermer', () => {
  setLargeur(1000)
  renderPanel()
  expect(screen.queryByRole('tab', { name: 'Tâches' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Contexte' }))
  expect(screen.getByRole('tab', { name: 'Tâches' })).toBeTruthy()
  expect(document.querySelector('.tiroir')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
  expect(screen.queryByRole('tab', { name: 'Tâches' })).toBeNull()
  expect(document.querySelector('.tiroir')).toBeNull()
  expect(screen.getByRole('button', { name: 'Contexte' })).toBeTruthy()
})

test('un lien vers Spec ou Plan ouvre le tiroir quand l écran est étroit', () => {
  setLargeur(1000)
  const view = render(
    <SidePanel
      missionId="m1"
      state={detail(etat(), files)}
      spec={{ source: 'worktree', text: '# Spec\n\ntexte du worktree' }}
      onTab={() => {}}
    />,
  )
  expect(screen.queryByRole('tab', { name: 'Spec' })).toBeNull()
  view.rerender(
    <SidePanel
      missionId="m1"
      state={detail(etat(), files)}
      spec={{ source: 'worktree', text: '# Spec\n\ntexte du worktree' }}
      ouvert={{ tab: 'spec', seq: 1 }}
      onTab={() => {}}
    />,
  )
  expect(document.querySelector('.tiroir')).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'Spec' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy()
})

test('un échec de lecture annonce que le fichier est illisible', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('reseau')
  }))
  renderPanel()
  fireEvent.click(screen.getByRole('button', { name: /2 · Corriger/ }))
  fireEvent.click(screen.getByRole('button', { name: 'brief.md' }))
  expect(await screen.findByText('fichier illisible : serveur injoignable')).toBeTruthy()
})

test('un fichier ouvert ne se rouvre pas sur la mission suivante', async () => {
  const view = render(<SidePanel missionId="m1" state={detail(etat(), files)} onTab={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /2 · Corriger/ }))
  fireEvent.click(screen.getByRole('button', { name: 'brief.md' }))
  expect(await screen.findByRole('heading', { name: 'Brief' })).toBeTruthy()
  calls.length = 0
  view.rerender(<SidePanel missionId="m2" state={detail(etat(), files)} onTab={() => {}} />)
  await act(async () => {})
  expect(screen.queryByRole('heading', { name: 'Brief' })).toBeNull()
  expect(calls.some((url) => url.includes('/missions/m2/'))).toBe(false)
})

test('la bascule des différences repart de la proposition en revenant sur l onglet', () => {
  renderPanel(etat(), {
    spec: { source: 'proposition', text: 'ligne a\nligne c\n', current: 'ligne a\nligne b\n' },
    plan: { source: 'worktree', text: '# Plan\n\nversion du plan' },
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Spec' }))
  fireEvent.click(screen.getByRole('button', { name: 'Différences avec la version actuelle' }))
  expect(document.querySelector('.diff-retrait')?.textContent).toContain('ligne b')
  fireEvent.click(screen.getByRole('tab', { name: 'Plan' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Spec' }))
  expect(screen.getByText(/ligne c/)).toBeTruthy()
  expect(document.querySelector('.diff-ajout')).toBeNull()
})

test('la colonne de droite affiche le panneau et une porte ouvre Spec ou Plan', () => {
  setHash('#/m1')
  render(<App source={sourceOf} />)
  const es = flux()
  act(() => {
    es.onopen?.({})
    send(es, { type: 'missions', hiddenCount: 0, projects, missions: [mission({ id: 'm1' })] })
    send(es, {
      type: 'mission',
      id: 'm1',
      detail: detail({
        ...etat(),
        gates: [{
          id: 'g1',
          kind: 'spec',
          status: 'pending',
          summary: 'relire la spec',
          path: 'docs/superpowers/specs/a.md',
          createdAt: '2026-11-03T00:00:00.000Z',
        }],
      }, files),
    })
    send(es, {
      type: 'doc',
      id: 'm1',
      kind: 'spec',
      doc: { source: 'worktree', text: '# Spec\n\ntexte du worktree' },
    })
  })

  const colonne = document.querySelector('.contexte')
  if (!(colonne instanceof HTMLElement)) throw new Error('colonne absente')
  expect(within(colonne).getByRole('tab', { name: 'Tâches' })).toBeTruthy()
  const shell = document.querySelector('.shell')
  if (!(shell instanceof HTMLElement)) throw new Error('shell absent')
  expect(shell.style.gridTemplateColumns).toContain('360px')

  fireEvent.click(screen.getByRole('button', { name: 'Spec' }))
  expect(within(colonne).getByRole('heading', { name: 'Spec' })).toBeTruthy()
  expect(within(colonne).getByText('texte du worktree')).toBeTruthy()
})
