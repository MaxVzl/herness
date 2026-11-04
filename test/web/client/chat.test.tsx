// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Gate } from '../../../src/mission/state.ts'
import type { ChatItem, MissionDetail, MissionSummary, ProjectView } from '../../../src/web/protocol.ts'
import { App } from '../../../src/web/client/App.tsx'
import { Chat } from '../../../src/web/client/Chat.tsx'
import { GateCards } from '../../../src/web/client/GateCards.tsx'

const projects: ProjectView[] = [{ name: 'alpha', repoPath: '/a', preflight: [] }]

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

function detail(over: Partial<MissionDetail> = {}): MissionDetail {
  return {
    state: { id: 'm1', branch: 'feat/tache', step: 'tasks', paused: false, gates: [] },
    orchestrator: { state: null },
    files: {},
    ...over,
  }
}

function user(text: string, uuid = 'u'): ChatItem {
  return { kind: 'user', uuid, at: '', text }
}

function assistant(text: string, uuid = 'a'): ChatItem {
  return { kind: 'assistant', uuid, at: '', text }
}

function gate(over: Partial<Gate> & Pick<Gate, 'id'>): Gate {
  return {
    kind: 'spec',
    status: 'pending',
    summary: 'résumé',
    createdAt: '2026-11-03T00:00:00.000Z',
    ...over,
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

function classOf(el: Element): string[] {
  return ((el as unknown as { className?: string }).className ?? '').split(/\s+/).filter(Boolean)
}

function disabled(el: Element): boolean {
  return (el as unknown as { disabled?: boolean }).disabled === true
}

function valueOf(el: Element): string {
  return (el as unknown as { value?: string }).value ?? ''
}

function conversation(): Element {
  const found = (globalThis as unknown as { document: Document }).document.querySelector('.conversation')
  if (!found) throw new Error('colonne centrale absente')
  return found
}

function setHash(value: string) {
  ;(globalThis as unknown as { location: { hash: string } }).location.hash = value
}

const calls: { url: string; body?: string }[] = []

function installFetch(result: (url: string) => unknown = () => ({ ok: true, lines: [] })) {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), ...(init?.body !== undefined ? { body: init.body } : {}) })
    return { json: async () => result(String(url)) }
  }))
}

function renderChat(items: ChatItem[], orchestratorState: string | null = 'idle', onOpenHerdr = () => {}) {
  return render(<Chat missionId="m1" items={items} orchestratorState={orchestratorState} onOpenHerdr={onOpenHerdr} />)
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
}

function resultLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n')
}

function detailHasLine(line: string): boolean {
  const blocks = (globalThis as unknown as { document: Document }).document.querySelectorAll('.action-detail pre')
  return [...blocks].some((pre) => (pre.textContent ?? '').split('\n').includes(line))
}

beforeEach(() => {
  FakeSource.all = []
  localStorage.clear()
  setHash('')
  installFetch()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('un message utilisateur est a droite et une reponse rend le Markdown sans HTML brut', () => {
  renderChat([
    user('bonjour'),
    assistant('**gras**'),
    assistant('<script>alert(1)</script>', 'script'),
    assistant('voir https://exemple.test/a', 'lien'),
  ])

  const bonjour = screen.getByText('bonjour')
  expect(bonjour.closest('.droite')).toBeTruthy()
  expect(bonjour.closest('.gauche')).toBeNull()

  const gras = (globalThis as unknown as { document: Document }).document.querySelector('strong')
  expect(gras?.textContent).toBe('gras')
  expect(gras?.closest('.gauche')).toBeTruthy()
  expect(gras?.closest('.droite')).toBeNull()

  expect((globalThis as unknown as { document: Document }).document.querySelector('script')).toBeNull()
  expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy()

  const link = screen.getByRole('link', { name: 'https://exemple.test/a' })
  expect((link as unknown as { getAttribute(name: string): string | null }).getAttribute('href')).toBe('https://exemple.test/a')
  expect((link as unknown as { getAttribute(name: string): string | null }).getAttribute('target')).toBe('_blank')
})

test('un message du moteur est une ligne discrete', () => {
  renderChat([{ kind: 'engine', uuid: 'e', at: '', text: '[herness] reprise' }])
  const line = screen.getByText('[herness] reprise')
  expect(classOf(line).includes('moteur')).toBe(true)
})

test('les actions se replient puis montrent parametres et resultat tronque', () => {
  renderChat([{
    kind: 'actions',
    uuid: 'act',
    at: '',
    actions: [
      { id: 'a1', name: 'Bash', summary: 'Lister src', input: { command: 'ls src' }, result: resultLines(25) },
      { id: 'a2', name: 'Read', summary: 'state.ts', input: { file_path: 'state.ts' }, result: 'ok' },
    ],
  }])

  fireEvent.click(screen.getByRole('button', { name: '▸ 2 actions — Lister src, state.ts' }))
  fireEvent.click(screen.getByRole('button', { name: 'Lister src' }))
  expect(screen.getByText(/ls src/)).toBeTruthy()
  expect(detailHasLine('L1')).toBe(true)
  expect(detailHasLine('L20')).toBe(true)
  expect(detailHasLine('L21')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'voir tout' }))
  expect(detailHasLine('L21')).toBe(true)
  expect(detailHasLine('L25')).toBe(true)
  expect(screen.queryByRole('button', { name: 'voir tout' })).toBeNull()
})

test('une question a choix reste en lecture seule et ouvre herdr', () => {
  const onOpenHerdr = vi.fn()
  renderChat([{
    kind: 'question',
    uuid: 'q',
    at: '',
    question: 'Continuer ?',
    options: ['Oui', 'Non'],
    answered: false,
  }], 'idle', onOpenHerdr)

  expect(screen.getByText('Continuer ?')).toBeTruthy()
  expect(screen.getByText('Oui')).toBeTruthy()
  expect(screen.getByText('Non')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Oui' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Non' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Répondre dans herdr' }))
  expect(onOpenHerdr).toHaveBeenCalledOnce()
})

test('l etat de l orchestrateur pilote l indicateur, le bandeau et la saisie', () => {
  const onOpenHerdr = vi.fn()
  const view = renderChat([], 'working', onOpenHerdr)
  expect(screen.getByText("● l'orchestrateur travaille…")).toBeTruthy()
  expect(disabled(textbox())).toBe(false)

  view.rerender(<Chat missionId="m1" items={[]} orchestratorState="blocked" onOpenHerdr={onOpenHerdr} />)
  expect(screen.getByText("l'orchestrateur attend une intervention dans herdr")).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir dans herdr' }))
  expect(onOpenHerdr).toHaveBeenCalledOnce()

  view.rerender(<Chat missionId="m1" items={[]} orchestratorState={null} onOpenHerdr={onOpenHerdr} />)
  expect(screen.getByText('orchestrateur arrêté — Reprendre')).toBeTruthy()
  expect(disabled(textbox())).toBe(true)
})

test('Entree envoie le message en attente, Maj+Entree ajoute une ligne, le vide ne part pas', async () => {
  const view = renderChat([])
  const area = textbox()
  fireEvent.keyDown(area, { key: 'Enter' })
  expect(calls).toHaveLength(0)

  fireEvent.change(area, { target: { value: '   ' } })
  fireEvent.keyDown(area, { key: 'Enter' })
  expect(calls).toHaveLength(0)

  fireEvent.change(area, { target: { value: 'salut' } })
  area.selectionStart = 5
  area.selectionEnd = 5
  fireEvent.keyDown(area, { key: 'Enter', shiftKey: true })
  expect(valueOf(textbox())).toBe('salut\n')
  expect(calls).toHaveLength(0)

  fireEvent.change(textbox(), { target: { value: 'salut' } })
  fireEvent.keyDown(textbox(), { key: 'Enter' })
  expect(calls).toEqual([{ url: '/api/missions/m1/message', body: JSON.stringify({ texte: 'salut' }) }])
  expect(screen.getByText('salut').closest('.droite')).toBeTruthy()
  expect(screen.getByText('en attente')).toBeTruthy()

  view.rerender(<Chat missionId="m1" items={[user('autre')]} orchestratorState="idle" onOpenHerdr={() => {}} />)
  expect(screen.getByText('en attente')).toBeTruthy()

  view.rerender(<Chat missionId="m1" items={[user('autre'), user('salut', 'u2')]} orchestratorState="idle" onOpenHerdr={() => {}} />)
  expect(screen.queryByText('en attente')).toBeNull()
  expect(screen.getAllByText('salut')).toHaveLength(1)
})

test('le defilement suit le bas, sinon un bouton ramene aux nouveaux messages', () => {
  const premier = [assistant('un')]
  const suite = [assistant('un'), assistant('deux')]
  const view = renderChat(premier)
  const fil = (globalThis as unknown as { document: Document }).document.querySelector('.fil')
  if (!fil) throw new Error('fil absent')
  Object.defineProperty(fil, 'scrollHeight', { configurable: true, get: () => 500 })
  Object.defineProperty(fil, 'clientHeight', { configurable: true, get: () => 100 })

  fil.scrollTop = 400
  fireEvent.scroll(fil)
  view.rerender(<Chat missionId="m1" items={suite} orchestratorState="idle" onOpenHerdr={() => {}} />)
  expect(fil.scrollTop).toBe(500)
  expect(screen.queryByRole('button', { name: 'nouveaux messages ↓' })).toBeNull()

  fil.scrollTop = 0
  fireEvent.scroll(fil)
  view.rerender(<Chat missionId="m1" items={[...suite, assistant('trois')]} orchestratorState="idle" onOpenHerdr={() => {}} />)
  expect(fil.scrollTop).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'nouveaux messages ↓' }))
  expect(fil.scrollTop).toBe(500)
  expect(screen.queryByRole('button', { name: 'nouveaux messages ↓' })).toBeNull()
})

test('les portes en attente, la plus ancienne d abord, se valident ou se refusent', async () => {
  const onOpenDoc = vi.fn()
  const gates = [
    gate({ id: 'g2', kind: 'plan', summary: 'récente', path: 'docs/superpowers/plans/a.md', createdAt: '2026-11-04T00:00:00.000Z' }),
    gate({ id: 'g1', summary: 'ancienne', path: 'docs/superpowers/specs/a.md', createdAt: '2026-11-03T00:00:00.000Z' }),
    gate({ id: 'g0', status: 'approved', summary: 'déjà décidée' }),
  ]
  const view = render(<GateCards missionId="m1" gates={gates} onOpenDoc={onOpenDoc} />)
  const cards = (globalThis as unknown as { document: Document }).document.querySelectorAll('.porte')
  expect(cards).toHaveLength(2)
  expect(cards[0]?.textContent).toContain('ancienne')
  expect(cards[0]?.textContent).toContain('spec')
  expect(cards[1]?.textContent).toContain('récente')
  expect(screen.queryByText('déjà décidée')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Spec' }))
  fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
  expect(onOpenDoc.mock.calls).toEqual([['spec'], ['plan']])

  fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Valider' }))
  const confirm = screen.getByRole('dialog', { name: 'Valider g1 (spec) de m1 ?' })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Non' }))
  expect(calls).toHaveLength(0)

  fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Valider' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Valider g1 (spec) de m1 ?' })).getByRole('button', { name: 'Oui' }))
  expect(calls).toEqual([{ url: '/api/missions/m1/portes/g1/valider', body: '{}' }])
})

test('Refuser exige une note puis une confirmation', async () => {
  render(<GateCards missionId="m1" gates={[gate({ id: 'g1', summary: 'ancienne' })]} onOpenDoc={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Refuser' }))
  const note = screen.getByRole('dialog', { name: 'Note de refus pour g1' })
  expect(disabled(within(note).getByRole('button', { name: 'Valider' }))).toBe(true)
  fireEvent.change(within(note).getByRole('textbox'), { target: { value: 'trop vague' } })
  fireEvent.click(within(note).getByRole('button', { name: 'Valider' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Refuser g1 (spec) de m1 ?' })).getByRole('button', { name: 'Oui' }))
  expect(calls).toEqual([{
    url: '/api/missions/m1/portes/g1/refuser',
    body: JSON.stringify({ note: 'trop vague' }),
  }])
})

test('Avec une note propose Valider ou Refuser puis confirme', () => {
  render(<GateCards missionId="m1" gates={[gate({ id: 'g1', kind: 'plan', summary: 'le plan' })]} onOpenDoc={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Avec une note…' }))
  const note = screen.getByRole('dialog', { name: 'Note pour g1' })
  fireEvent.change(within(note).getByRole('textbox'), { target: { value: 'précision' } })
  fireEvent.click(within(note).getByRole('button', { name: 'Valider' }))
  const choix = screen.getByRole('dialog', { name: 'Valider ou refuser' })
  fireEvent.click(within(choix).getByRole('button', { name: 'Refuser' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Refuser g1 (plan) de m1 ?' })).getByRole('button', { name: 'Oui' }))
  expect(calls).toEqual([{
    url: '/api/missions/m1/portes/g1/refuser',
    body: JSON.stringify({ note: 'précision' }),
  }])
})

test('Avec une note peut valider', () => {
  render(<GateCards missionId="m1" gates={[gate({ id: 'g1', summary: 'ancienne' })]} onOpenDoc={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Avec une note…' }))
  const note = screen.getByRole('dialog', { name: 'Note pour g1' })
  fireEvent.change(within(note).getByRole('textbox'), { target: { value: 'ok' } })
  fireEvent.click(within(note).getByRole('button', { name: 'Valider' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Valider ou refuser' })).getByRole('button', { name: 'Valider' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Valider g1 (spec) de m1 ?' })).getByRole('button', { name: 'Oui' }))
  expect(calls).toEqual([{
    url: '/api/missions/m1/portes/g1/valider',
    body: JSON.stringify({ note: 'ok' }),
  }])
})

test('les boutons d une porte restent désactivés pendant l envoi et tant qu elle est pending', async () => {
  let release: (body: { ok: boolean; lines: string[] }) => void = () => {}
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { body?: string }) => {
    calls.length = 0
    calls.push({ url: String(url), ...(init?.body !== undefined ? { body: init.body } : {}) })
    return new Promise((resolve) => {
      release = (body) => resolve({ json: async () => body })
    })
  }))
  const pending = gate({ id: 'g1', summary: 'ancienne' })
  const view = render(<GateCards missionId="m1" gates={[pending]} onOpenDoc={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  for (const name of ['Valider', 'Refuser', 'Avec une note…']) {
    expect(disabled(screen.getByRole('button', { name }))).toBe(true)
  }

  await act(async () => { release({ ok: true, lines: [] }) })
  for (const name of ['Valider', 'Refuser', 'Avec une note…']) {
    expect(disabled(screen.getByRole('button', { name }))).toBe(true)
  }

  view.rerender(<GateCards missionId="m1" gates={[{ ...pending, status: 'approved' }]} onOpenDoc={() => {}} />)
  expect(screen.queryByText('ancienne')).toBeNull()

  view.rerender(<GateCards missionId="m1" gates={[gate({ id: 'g2', summary: 'suivante' })]} onOpenDoc={() => {}} />)
  expect(disabled(screen.getByRole('button', { name: 'Valider' }))).toBe(false)
})

test('un envoi refuse reactive les boutons', async () => {
  let release: (body: { ok: boolean; lines: string[] }) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
    release = (body) => resolve({ json: async () => body })
  })))
  render(<GateCards missionId="m1" gates={[gate({ id: 'g1', summary: 'ancienne' })]} onOpenDoc={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  expect(disabled(screen.getByRole('button', { name: 'Valider' }))).toBe(true)
  await act(async () => { release({ ok: false, lines: ['non'] }) })
  expect(disabled(screen.getByRole('button', { name: 'Valider' }))).toBe(false)
})

test('la colonne centrale epingle les portes au-dessus de la saisie', async () => {
  setHash('#/m1')
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = FakeSource.all[0]
  if (!es) throw new Error('flux absent')
  act(() => {
    es.onopen?.({})
    send(es, { type: 'missions', missions: [mission({ id: 'm1' })], hiddenCount: 0, projects })
    send(es, {
      type: 'mission',
      id: 'm1',
      detail: detail({
        state: {
          id: 'm1',
          branch: 'feat/tache',
          step: 'tasks',
          paused: false,
          gates: [gate({ id: 'g1', summary: 'valider la spec', path: 'docs/superpowers/specs/a.md' })],
        },
        orchestrator: { state: 'working' },
      }),
    })
    send(es, { type: 'chat', id: 'm1', items: [assistant('**bonjour**')] })
  })

  const col = conversation()
  expect(col.contains(screen.getByText('bonjour'))).toBe(true)
  expect(col.contains(screen.getByText("● l'orchestrateur travaille…"))).toBe(true)
  expect(col.contains(screen.getByText('valider la spec'))).toBe(true)
  const slot = col.querySelector('.portes-slot')
  const saisie = col.querySelector('.saisie')
  if (!slot || !saisie) throw new Error('saisie ou portes absentes')
  expect(slot.querySelector('.porte')).toBeTruthy()
  expect(slot.compareDocumentPosition(saisie) & 4).toBe(4)
})

function missionDetail(id: string, summary: string, orchestrator: string | null = 'idle') {
  return detail({
    state: {
      id,
      branch: 'feat/tache',
      step: 'tasks',
      paused: false,
      gates: [gate({ id: 'g1', summary })],
    },
    orchestrator: { state: orchestrator },
  })
}

async function pageWith(ids: string[]) {
  render(<App source={sourceOf} />)
  await act(async () => {})
  const es = FakeSource.all[0]
  if (!es) throw new Error('flux absent')
  act(() => {
    es.onopen?.({})
    send(es, {
      type: 'missions',
      hiddenCount: 0,
      projects,
      missions: ids.map((id) => mission({ id, title: id })),
    })
    for (const id of ids) send(es, { type: 'mission', id, detail: missionDetail(id, `porte ${id}`) })
  })
  return es
}

function showMission(id: string) {
  setHash(`#/${id}`)
  act(() => {
    globalThis.dispatchEvent(new Event('hashchange'))
  })
}

test('changer de mission oublie le brouillon, l attente et le verrou des portes', async () => {
  setHash('#/a')
  await pageWith(['a', 'b'])
  fireEvent.change(textbox(), { target: { value: 'pour A' } })
  fireEvent.keyDown(textbox(), { key: 'Enter' })
  expect(screen.getByText('en attente')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  expect(disabled(screen.getByRole('button', { name: 'Valider' }))).toBe(true)

  showMission('b')
  expect(screen.queryByText('en attente')).toBeNull()
  expect(screen.queryByText('pour A')).toBeNull()
  expect(valueOf(textbox())).toBe('')
  expect(screen.getByText('porte b')).toBeTruthy()
  expect(disabled(screen.getByRole('button', { name: 'Valider' }))).toBe(false)

  const before = calls.length
  fireEvent.keyDown(textbox(), { key: 'Enter' })
  expect(calls).toHaveLength(before)
  fireEvent.change(textbox(), { target: { value: 'pour B' } })
  fireEvent.keyDown(textbox(), { key: 'Enter' })
  expect(calls.at(-1)).toEqual({ url: '/api/missions/b/message', body: JSON.stringify({ texte: 'pour B' }) })
})

test('un retour a la ligne final est rogne et l attente se leve sur le transcript', () => {
  const view = renderChat([])
  fireEvent.change(textbox(), { target: { value: 'salut\n' } })
  fireEvent.keyDown(textbox(), { key: 'Enter' })
  expect(calls).toEqual([{ url: '/api/missions/m1/message', body: JSON.stringify({ texte: 'salut' }) }])
  expect(screen.getByText('en attente')).toBeTruthy()
  view.rerender(<Chat missionId="m1" items={[user('salut')]} orchestratorState="idle" onOpenHerdr={() => {}} />)
  expect(screen.queryByText('en attente')).toBeNull()
  expect(screen.getAllByText('salut')).toHaveLength(1)
})

test('un message refuse revient dans la saisie et la raison s affiche', async () => {
  installFetch(() => ({ ok: false, lines: ['orchestrateur arrêté'] }))
  setHash('#/a')
  await pageWith(['a'])
  fireEvent.change(textbox(), { target: { value: 'salut' } })
  fireEvent.keyDown(textbox(), { key: 'Enter' })
  const reason = await screen.findByText('orchestrateur arrêté')
  expect(conversation().contains(reason)).toBe(true)
  expect(screen.queryByText('en attente')).toBeNull()
  expect(valueOf(textbox())).toBe('salut')
})

test('une decision de porte refusee affiche la raison et reactive les boutons', async () => {
  installFetch(() => ({ ok: false, lines: ['porte déjà décidée'] }))
  setHash('#/a')
  await pageWith(['a'])
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Oui' }))
  const reason = await screen.findByText('porte déjà décidée')
  expect(conversation().contains(reason)).toBe(true)
  expect(disabled(screen.getByRole('button', { name: 'Valider' }))).toBe(false)
})
