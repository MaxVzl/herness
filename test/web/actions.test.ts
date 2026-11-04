import { readdirSync, writeSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { PromptOutcome } from '../../src/herdr/client.ts'
import type { MissionState } from '../../src/mission/state.ts'
import { newState } from '../../src/mission/state.ts'
import { missionDir } from '../../src/paths.ts'
import type { ActionDeps, Spawner } from '../../src/ui/actions.ts'
import { newToken } from '../../src/web/auth.ts'
import type { ServerEvent } from '../../src/web/protocol.ts'
import { startWebServer } from '../../src/web/server.ts'

const servers: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function mission(over: Partial<MissionState> = {}): MissionState {
  return {
    ...newState({
      id: 'm1',
      source: { kind: 'text', ref: 'demande' },
      project: 'projet',
      repoPath: '/repo',
    }),
    orchestrator: { agent: 'o-m1' },
    herdr: { workspace: 'ws1', tabs: {}, panes: { worker: 'p1', orchestrator: 'p0' } },
    gates: [{ id: 'g1', kind: 'spec', status: 'pending', summary: 'spec', createdAt: '2026-11-04T00:00:00.000Z' }],
    ...over,
  }
}

function mk(over: Partial<ActionDeps> = {}, focused: string[] = []): ActionDeps {
  return {
    lifecycle: { e: { herdr: { workspaceFocus: async (id: string) => { focused.push(id) } } } as never },
    decide: (async () => {}) as never,
    resume: (async () => true) as never,
    close: (async () => true) as never,
    remove: (async () => true) as never,
    start: (async () => 'm9') as never,
    cwd: '/repo',
    ...over,
  }
}

interface Harness {
  state: MissionState
  events: ServerEvent[]
  depsCwds: string[]
  prompts: { name: string; text: string; wait: boolean }[]
  reads: { name: string; lines: number }[]
  post(path: string, body?: unknown): Promise<Response>
  get(path: string): Promise<Response>
  actionDeps: ActionDeps
}

async function boot(over: {
  state?: MissionState | null
  actionDeps?: Partial<ActionDeps>
  agentGet?: (name: string) => Promise<{ state: string } | null>
  agentPrompt?: (name: string, text: string, opts: { wait: boolean }) => Promise<PromptOutcome>
  projects?: () => Promise<{ name: string; repoPath: string }[]>
  spawn?: Spawner
  confirmTimeoutMs?: number
  focused?: string[]
} = {}): Promise<Harness> {
  const state = over.state === undefined ? mission() : over.state
  const states = new Map<string, MissionState>()
  if (state) states.set(state.id, state)
  const events: ServerEvent[] = []
  const depsCwds: string[] = []
  const prompts: Harness['prompts'] = []
  const reads: Harness['reads'] = []
  const focused = over.focused ?? []
  const actionDeps = mk(over.actionDeps, focused)
  const token = newToken()
  const server = await startWebServer({
    port: 0,
    token,
    actions: {
      hub: {
        current: (id: string) => states.get(id),
        emit: (event: ServerEvent) => { events.push(event) },
      },
      deps: (cwd: string) => {
        depsCwds.push(cwd)
        return { ...actionDeps, cwd }
      },
      ...(over.projects ? { projects: over.projects } : {}),
      herdr: {
        agentPrompt: async (name: string, text: string, opts: { wait: boolean }): Promise<PromptOutcome> => {
          prompts.push({ name, text, wait: opts.wait })
          if (over.agentPrompt) return over.agentPrompt(name, text, opts)
          return 'sent'
        },
        agentGet: over.agentGet ?? (async (name: string) => (name === 'o-m1' ? { state: 'idle' } : null)),
        agentRead: async (name: string, lines: number) => {
          reads.push({ name, lines })
          return `sortie:${name}:${lines}`
        },
      },
      ...(over.spawn ? { spawn: over.spawn } : {}),
      ...(over.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: over.confirmTimeoutMs } : {}),
    },
  })
  servers.push(server)
  const headers = {
    cookie: `herness_web=${token}`,
    origin: `http://127.0.0.1:${server.port}`,
    'content-type': 'application/json',
  }
  return {
    state: state ?? mission(),
    events,
    depsCwds,
    prompts,
    reads,
    actionDeps,
    post: (path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    get: (path) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { cookie: `herness_web=${token}` },
    }),
  }
}

test('valider poste approved avec la porte et la note', async () => {
  const seen: unknown[] = []
  const h = await boot({
    actionDeps: {
      decide: (async (id: string, decision: string, opts: { gateId?: string; note?: string }) => {
        seen.push([id, decision, opts.gateId, opts.note])
      }) as never,
    },
  })
  const res = await h.post('/api/missions/m1/portes/g1/valider', { note: 'ok' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, lines: [] })
  expect(seen).toEqual([['m1', 'approved', 'g1', 'ok']])
  expect(h.depsCwds).toEqual(['/repo'])
})

test('refuser sans note ne poste rien', async () => {
  let called = false
  const h = await boot({
    actionDeps: { decide: (async () => { called = true }) as never },
  })
  const res = await h.post('/api/missions/m1/portes/g1/refuser', { note: '  ' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, lines: ['une note est obligatoire pour refuser'] })
  expect(called).toBe(false)
})

test('deux valider simultanés n\'appellent decide qu\'une fois ; la porte encore pending reste bloquée ; une porte décidée répond déjà décidée', async () => {
  let calls = 0
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  const h = await boot({
    actionDeps: {
      decide: (async () => {
        calls += 1
        await hold
      }) as never,
    },
  })
  const reads = [h.post('/api/missions/m1/portes/g1/valider', {}), h.post('/api/missions/m1/portes/g1/valider', {})]
    .map(async (pending) => {
      const res = await pending
      return { status: res.status, body: await res.json() }
    })
  const early = await Promise.race(reads)
  expect(early.status).toBe(409)
  expect(early.body).toEqual({ ok: false, lines: ['décision déjà envoyée'] })
  expect(calls).toBe(1)
  release()
  const both = await Promise.all(reads)
  expect(both).toContainEqual({ status: 200, body: { ok: true, lines: [] } })

  const again = await h.post('/api/missions/m1/portes/g1/valider', {})
  expect(again.status).toBe(409)
  expect(await again.json()).toEqual({ ok: false, lines: ['décision déjà envoyée'] })
  expect(calls).toBe(1)

  h.state.gates[0]!.status = 'approved'
  const decided = await h.post('/api/missions/m1/portes/g1/valider', {})
  expect(decided.status).toBe(409)
  expect(await decided.json()).toEqual({ ok: false, lines: ['porte déjà décidée'] })
  expect(calls).toBe(1)
})

test('fermer émet une confirmation, attend la réponse, et refuse une seconde fermeture', async () => {
  let answer: boolean | undefined
  const h = await boot({
    actionDeps: {
      close: (async (_id: string, deps: { confirm?: (q: string) => Promise<boolean>; out?: (l: string) => void }) => {
        answer = await deps.confirm!('sûr ?')
        deps.out?.(answer ? 'fermée' : 'annulée')
        return answer
      }) as never,
    },
  })
  const pending = h.post('/api/missions/m1/fermer')
  await expect.poll(() => h.events.length).toBe(1)
  const event = h.events[0]
  expect(event).toMatchObject({ type: 'confirmation', missionId: 'm1', question: 'sûr ?' })
  if (event?.type !== 'confirmation') throw new Error('confirmation attendue')

  const second = await h.post('/api/missions/m1/fermer')
  expect(second.status).toBe(409)
  expect(await second.json()).toEqual({ ok: false, lines: ['action en cours'] })

  const ack = await h.post(`/api/confirmations/${event.confirmId}`, { oui: true })
  expect(ack.status).toBe(200)
  const res = await pending
  expect(answer).toBe(true)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, lines: ['fermée'] })
})

test('fermer sans réponse avant le délai confirme false', async () => {
  let answer: boolean | undefined
  const h = await boot({
    confirmTimeoutMs: 30,
    actionDeps: {
      close: (async (_id: string, deps: { confirm?: (q: string) => Promise<boolean> }) => {
        answer = await deps.confirm!('sûr ?')
        return answer
      }) as never,
    },
  })
  const res = await h.post('/api/missions/m1/fermer')
  expect(answer).toBe(false)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, lines: [] })
})

test('supprimer une mission non fermée répond 409', async () => {
  let called = false
  const h = await boot({
    actionDeps: { remove: (async () => { called = true; return true }) as never },
  })
  const res = await h.post('/api/missions/m1/supprimer')
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ ok: false, lines: ['seule une mission fermée peut être supprimée'] })
  expect(called).toBe(false)

  h.state.step = 'fermée'
  const gone = await h.post('/api/missions/m1/supprimer')
  expect(gone.status).toBe(200)
  expect(await gone.json()).toEqual({ ok: true, lines: [] })
  expect(called).toBe(true)
})

test('message envoie le texte exact sans attendre ; un agent absent le dit', async () => {
  const present = await boot()
  const res = await present.post('/api/missions/m1/message', { texte: 'bonjour' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, lines: [] })
  expect(present.prompts).toEqual([{ name: 'o-m1', text: 'bonjour', wait: false }])

  const absent = await boot({ agentGet: async () => null })
  const stopped = await absent.post('/api/missions/m1/message', { texte: 'bonjour' })
  expect(stopped.status).toBe(200)
  expect(await stopped.json()).toEqual({ ok: false, lines: ['orchestrateur arrêté — Reprendre'] })
  expect(absent.prompts).toEqual([])

  const empty = await present.post('/api/missions/m1/message', { texte: '  ' })
  expect(empty.status).toBe(400)

  const blocked = await boot({ agentPrompt: async () => 'blocked' })
  const refused = await blocked.post('/api/missions/m1/message', { texte: 'bonjour' })
  expect(refused.status).toBe(200)
  expect(await refused.json()).toEqual({ ok: false, lines: ['orchestrateur bloqué dans herdr'] })

  const stalled = await boot({ agentPrompt: async () => 'stalled' })
  expect(await (await stalled.post('/api/missions/m1/message', { texte: 'bonjour' })).json()).toEqual({
    ok: false,
    lines: ['orchestrateur sans nouvelle sortie (stalled)'],
  })

  const timed = await boot({ agentPrompt: async () => 'timeout' })
  expect(await (await timed.post('/api/missions/m1/message', { texte: 'bonjour' })).json()).toEqual({
    ok: false,
    lines: ['délai dépassé'],
  })

  const broken = await boot({
    agentPrompt: async () => {
      throw new Error('herdr cassé')
    },
  })
  const failed = await broken.post('/api/missions/m1/message', { texte: 'bonjour' })
  expect(failed.status).toBe(200)
  expect(await failed.json()).toEqual({ ok: false, lines: ['herdr cassé'] })
})

test('créer une mission résout le nom du projet et passe son repoPath comme cwd', async () => {
  const seen: unknown[] = []
  const h = await boot({
    projects: async () => [{ name: 'beta', repoPath: '/depot/beta' }],
    actionDeps: {
      start: (async (input: string, cwd: string, deps: { out: (l: string) => void }, opts?: { note?: string }) => {
        seen.push([input, cwd, opts?.note])
        deps.out('Mission m9 lancée')
        return 'm9'
      }) as never,
    },
  })
  const res = await h.post('/api/missions', { projet: 'beta', demande: 'une demande', note: 'précision' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, lines: ['Mission m9 lancée'], id: 'm9' })
  expect(seen).toEqual([['une demande', '/depot/beta', 'précision']])
  expect(h.depsCwds).toEqual(['/depot/beta'])

  const before = h.depsCwds.length
  const unknown = await h.post('/api/missions', { projet: '/depot/beta', demande: 'une demande' })
  expect(unknown.status).toBe(400)
  expect(await unknown.json()).toEqual({ ok: false, lines: ['projet inconnu'] })
  expect(h.depsCwds).toHaveLength(before)
})

test('ouvrir ajoute la ligne qui demande de basculer sur herdr', async () => {
  const focused: string[] = []
  const h = await boot({ focused })
  const res = await h.post('/api/missions/m1/ouvrir')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    lines: ['espace ouvert dans herdr — bascule sur ta fenêtre herdr'],
  })
  expect(focused).toEqual(['ws1'])
})

test('la sortie d\'un agent hors mission est 404 et lignes est plafonné à 2000', async () => {
  const h = await boot()
  const missing = await h.get('/api/missions/m1/agents/intrus/sortie?lignes=10')
  expect(missing.status).toBe(404)
  expect(h.reads).toEqual([])

  const capped = await h.get('/api/missions/m1/agents/worker/sortie?lignes=9000')
  expect(capped.status).toBe(200)
  expect(capped.headers.get('content-type')).toContain('text/plain')
  expect(await capped.text()).toBe('sortie:worker:2000')
  expect(h.reads).toEqual([{ name: 'worker', lines: 2000 }])

  const orchestrator = await h.get('/api/missions/m1/agents/o-m1/sortie?lignes=3')
  expect(orchestrator.status).toBe(200)
  expect(await orchestrator.text()).toBe('sortie:o-m1:3')

  const negative = await h.get('/api/missions/m1/agents/worker/sortie?lignes=-5')
  expect(await negative.text()).toBe('sortie:worker:1')
  const zero = await h.get('/api/missions/m1/agents/worker/sortie?lignes=0')
  expect(await zero.text()).toBe('sortie:worker:1')
})

test('une mission inconnue répond 404', async () => {
  const h = await boot({ state: null })
  const res = await h.post('/api/missions/absente/reprendre')
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ ok: false, lines: ['mission inconnue'] })
})

test('reprendre appelle resume sans focaliser herdr', async () => {
  const opts: unknown[] = []
  const h = await boot({
    actionDeps: {
      resume: (async (_id: string, _deps: unknown, o: unknown) => {
        opts.push(o)
        return true
      }) as never,
    },
  })
  const res = await h.post('/api/missions/m1/reprendre')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, lines: [] })
  expect(opts).toEqual([{ restart: false, focus: false }])
})

test('redémarrer lance le processus détaché fourni', async () => {
  const home = await mkdtemp(join(tmpdir(), 'herness-web-'))
  const previous = process.env.HERNESS_HOME
  process.env.HERNESS_HOME = home
  const seen: unknown[] = []
  const spawn: Spawner = (cmd, args, opts) => {
    seen.push([cmd, args.slice(1), opts.detached])
    writeSync(opts.stdio[1], 'journal\n')
    return { unref: () => {}, once: (ev, fn) => { if (ev === 'spawn') fn() } }
  }
  try {
    const h = await boot({ spawn })
    const res = await h.post('/api/missions/m1/redemarrer')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; lines: string[] }
    expect(body.ok).toBe(true)
    expect(body.lines[0]).toContain(join(missionDir('m1'), 'logs'))
    expect(seen[0]).toEqual([process.execPath, ['reprendre', 'm1', '--redemarrer'], true])
    const logs = readdirSync(join(missionDir('m1'), 'logs'))
    expect(await readFile(join(missionDir('m1'), 'logs', logs[0]!), 'utf8')).toBe('journal\n')
  } finally {
    if (previous === undefined) delete process.env.HERNESS_HOME
    else process.env.HERNESS_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
