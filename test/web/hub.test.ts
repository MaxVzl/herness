import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { implName } from '../../src/agents/names.ts'
import { listProjects } from '../../src/config/project.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir, missionsRoot } from '../../src/paths.ts'
import { newToken } from '../../src/web/auth.ts'
import { Hub, type HubDeps, type HubHerdr } from '../../src/web/hub.ts'
import type { ServerEvent } from '../../src/web/protocol.ts'
import { startWebServer } from '../../src/web/server.ts'

let home: string
let transcriptsRoot: string
const hubs: Hub[] = []
const servers: { close(): Promise<void> }[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-hub-'))
  transcriptsRoot = await mkdtemp(join(tmpdir(), 'herness-tr-'))
  process.env.HERNESS_HOME = home
})

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
  await rm(transcriptsRoot, { recursive: true, force: true })
})

function mk(over: Partial<MissionState> = {}): MissionState {
  const { id, source, project, repoPath, ...rest } = over
  return {
    ...newState({
      id: id ?? 'm1',
      source: source ?? { kind: 'text', ref: 'demande initiale' },
      project: project ?? 'demo',
      repoPath: repoPath ?? '/repo',
    }),
    createdAt: '2026-11-03T08:00:00.000Z',
    ...rest,
  }
}

interface Scripted extends HubHerdr {
  gets: string[]
  reads: string[]
  set(name: string, state: string | null, tail?: string): void
}

function scriptedHerdr(): Scripted {
  const agents = new Map<string, { state: string | null; tail: string }>()
  const gets: string[] = []
  const reads: string[] = []
  return {
    gets,
    reads,
    set(name, state, tail = '') {
      agents.set(name, { state, tail })
    },
    async agentGet(name) {
      gets.push(name)
      const found = agents.get(name)
      if (!found || found.state === null) return null
      return { state: found.state }
    },
    async agentRead(name) {
      reads.push(name)
      return agents.get(name)?.tail ?? ''
    },
  }
}

function deps(herdr: HubHerdr, now: () => Date = () => new Date('2026-11-04T10:00:00.000Z')): HubDeps {
  return {
    herdr,
    prCache: { get: () => undefined, refresh: async () => {} },
    now,
    transcriptsRoot,
    tickMs: 50,
  }
}

function line(type: 'user' | 'assistant', uuid: string, text: string): string {
  return `${JSON.stringify({
    type,
    uuid,
    timestamp: '2026-11-04T10:00:00.000Z',
    message: { role: type, content: [{ type: 'text', text }] },
  })}\n`
}

async function transcript(sessionId: string, body: string): Promise<string> {
  const dir = join(transcriptsRoot, 'proj')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, body)
  return path
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start >= ms) throw new Error('délai dépassé')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

test('attach envoie l\'état complet de la mission abonnée', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-vue'
  await saveState(mk({
    id,
    slug: 'vue',
    step: 'tasks',
    orchestrator: { agent: 'orch-vue', sessionId: 'sess-vue' },
  }))
  await transcript('sess-vue', line('user', 'u1', 'bonjour'))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: false })
  await waitFor(() => events.some((event) => event.type === 'checks'))
  expect(events.slice(0, 6).map((event) => event.type === 'doc' ? `doc:${event.kind}` : event.type)).toEqual([
    'missions',
    'mission',
    'chat',
    'doc:spec',
    'doc:plan',
    'checks',
  ])
  const missions = events[0]
  expect(missions?.type).toBe('missions')
  if (missions?.type !== 'missions') return
  const projects = await listProjects()
  expect(missions.projects).toEqual(projects.map((found) => ({
    name: found.config.name,
    repoPath: found.config.repoPath,
    preflight: found.config.preflight.map((check) => check.label),
  })))
  expect(missions.missions.map((mission) => mission.id)).toContain(id)
  const mission = events[1]
  expect(mission?.type).toBe('mission')
  if (mission?.type !== 'mission') return
  expect(mission.detail.state).toMatchObject({ id })
  const chat = events[2]
  expect(chat?.type).toBe('chat')
  if (chat?.type !== 'chat') return
  expect(chat.items.map((item) => item.kind === 'user' ? item.text : item.kind)).toEqual(['bonjour'])
})

test('une porte en attente met à jour les missions et notifie en moins d\'une seconde', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-porte'
  const state = mk({ id, slug: 'porte', step: 'spec' })
  await saveState(state)
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: false })
  await waitFor(() => events.some((event) => event.type === 'missions'))
  const before = events.length
  const t0 = Date.now()
  state.gates.push({
    id: 'g1',
    kind: 'spec',
    status: 'pending',
    summary: 'relire la spec',
    createdAt: '2026-11-04T10:01:00.000Z',
  })
  await saveState(state)
  await waitFor(() => events.slice(before).some((event) => event.type === 'notification' && event.key === `porte:${id}:g1`))
  expect(Date.now() - t0).toBeLessThan(1000)
  const note = events.slice(before).find((event) => event.type === 'notification' && event.key === `porte:${id}:g1`)
  expect(note).toMatchObject({
    type: 'notification',
    missionId: id,
    title: 'Porte g1 (spec)',
  })
  if (note?.type !== 'notification') return
  expect(note.body).toContain(`${id} · porte`)
  expect(note.body).toContain('relire la spec')
  const updated = events.slice(before).find((event) => event.type === 'missions'
    && event.missions.some((mission) => mission.id === id && mission.status === 'porte g1'))
  expect(updated).toBeTruthy()
})

test('blocage et badge notifient à l\'apparition, pas pour l\'état déjà présent', async () => {
  const herdr = scriptedHerdr()
  herdr.set('orch-deja', 'blocked', '')
  const deja = mk({
    id: 'm-deja',
    slug: 'deja',
    step: 'bloquée',
    blockedReason: 'déjà bloquée',
    gates: [{
      id: 'g0',
      kind: 'plan',
      status: 'pending',
      summary: 'déjà là',
      createdAt: '2026-11-03T09:00:00.000Z',
    }],
    orchestrator: { agent: 'orch-deja' },
  })
  await saveState(deja)
  const fraiche = mk({
    id: 'm-fraiche',
    slug: 'fraiche',
    step: 'tasks',
    orchestrator: { agent: 'orch-fraiche', sessionId: 'sess-fraiche' },
  })
  await saveState(fraiche)
  await transcript('sess-fraiche', line('user', 'u1', 'salut'))
  herdr.set('orch-fraiche', 'idle', '')
  let clock = new Date('2026-11-04T10:00:00.000Z')
  const hub = new Hub(deps(herdr, () => clock))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: 'm-fraiche', agents: false })
  await waitFor(() => events.some((event) => event.type === 'checks'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(events.filter((event) => event.type === 'notification')).toEqual([])

  clock = new Date('2026-11-04T10:00:05.000Z')
  herdr.set('orch-fraiche', 'blocked', '')
  await waitFor(() => events.some((event) => event.type === 'notification' && event.key === 'badge:m-fraiche:attend-herdr'))
  const badge = events.find((event) => event.type === 'notification' && event.key === 'badge:m-fraiche:attend-herdr')
  expect(badge).toMatchObject({
    missionId: 'm-fraiche',
    title: 'L\'orchestrateur attend dans herdr',
  })
  if (badge?.type === 'notification') expect(badge.body).toContain('m-fraiche · fraiche')

  fraiche.step = 'bloquée'
  fraiche.blockedReason = 'tests rouges'
  await saveState(fraiche)
  await waitFor(() => events.some((event) => event.type === 'notification' && event.key === 'bloquee:m-fraiche'))
  const bloquee = events.find((event) => event.type === 'notification' && event.key === 'bloquee:m-fraiche')
  expect(bloquee).toMatchObject({
    missionId: 'm-fraiche',
    title: 'Mission bloquée',
  })
  if (bloquee?.type === 'notification') {
    expect(bloquee.body).toContain('m-fraiche · fraiche')
    expect(bloquee.body).toContain('tests rouges')
  }
  expect(events.some((event) => event.type === 'notification' && event.missionId === 'm-deja')).toBe(false)
})

test('une ligne de transcript arrive dans le chat en moins d\'une seconde', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-chat'
  await saveState(mk({
    id,
    step: 'tasks',
    orchestrator: { agent: 'orch-chat', sessionId: 'sess-chat' },
  }))
  const path = await transcript('sess-chat', line('user', 'u1', 'bonjour'))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: false })
  await waitFor(() => events.some((event) => event.type === 'chat'))
  const t0 = Date.now()
  await writeFile(path, line('user', 'u1', 'bonjour') + line('assistant', 'a1', 'je commence'), { flag: 'a' })
  await waitFor(() => events.some((event) => event.type === 'chat' && event.items.some((item) => item.kind === 'assistant' && item.text === 'je commence')))
  expect(Date.now() - t0).toBeLessThan(1000)
})

test('un state.json illisible et un dossier étranger laissent la dernière version lisible', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-stable'
  await saveState(mk({ id, slug: 'stable' }))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  await writeFile(join(missionDir(id), 'state.json'), '{')
  await mkdir(join(missionsRoot(), 'étranger'), { recursive: true })
  await writeFile(join(missionsRoot(), 'étranger', 'note.txt'), 'rien')
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(hub.current(id)?.slug).toBe('stable')
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { agents: false })
  await waitFor(() => events.some((event) => event.type === 'missions'))
  const missions = events.find((event) => event.type === 'missions')
  expect(missions?.type).toBe('missions')
  if (missions?.type !== 'missions') return
  expect(missions.missions.some((mission) => mission.id === id && mission.title === 'stable')).toBe(true)
  expect(missions.missions.some((mission) => mission.id === 'étranger')).toBe(false)
})

test('agents abonnés : sortie, état, activité seulement si la sortie change', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-agents'
  const name = implName(id, 2)
  herdr.set(name, 'working', 'ligne un')
  await saveState(mk({
    id,
    step: 'tasks',
    orchestrator: { agent: 'orch-agents' },
    herdr: { tabs: {}, panes: { orchestrator: 'p0', [name]: 'p1' } },
  }))
  let clock = new Date('2026-11-04T10:00:00.000Z')
  const hub = new Hub(deps(herdr, () => clock))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: true })
  await waitFor(() => events.some((event) => event.type === 'agents'))
  const first = events.find((event) => event.type === 'agents')
  expect(first?.type).toBe('agents')
  if (first?.type !== 'agents') return
  expect(first.agents).toEqual([{
    name,
    role: 'Implémenteur',
    tool: 'Cursor',
    task: 2,
    state: 'working',
    tail: 'ligne un',
    lastActivityAt: clock.toISOString(),
  }])
  expect(herdr.reads).toContain(name)

  clock = new Date('2026-11-04T10:00:10.000Z')
  await new Promise((resolve) => setTimeout(resolve, 180))
  const still = events.filter((event): event is Extract<ServerEvent, { type: 'agents' }> => event.type === 'agents')
  expect(still.every((event) => event.agents[0]?.lastActivityAt === '2026-11-04T10:00:00.000Z')).toBe(true)

  herdr.set(name, 'idle', 'ligne un\nligne deux')
  clock = new Date('2026-11-04T10:00:20.000Z')
  await waitFor(() => events.some((event) => event.type === 'agents' && event.agents[0]?.tail === 'ligne un\nligne deux'))
  const next = [...events].reverse().find((event) => event.type === 'agents' && event.agents[0]?.tail === 'ligne un\nligne deux')
  expect(next?.type).toBe('agents')
  if (next?.type !== 'agents') return
  expect(next.agents[0]).toMatchObject({ state: 'idle', lastActivityAt: '2026-11-04T10:00:20.000Z' })
})

test('agents désactivés : aucun appel agentRead', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-sans'
  const name = implName(id, 1)
  herdr.set(name, 'working', 'secret')
  herdr.set('orch-sans', 'idle', '')
  await saveState(mk({
    id,
    step: 'tasks',
    orchestrator: { agent: 'orch-sans' },
    herdr: { tabs: {}, panes: { [name]: 'p1' } },
  }))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: false })
  await waitFor(() => events.some((event) => event.type === 'missions'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(herdr.reads).toEqual([])
  expect(events.some((event) => event.type === 'agents')).toBe(false)
})

test('aucun client connecté : aucun appel agentGet', async () => {
  const herdr = scriptedHerdr()
  herdr.set('orch-seul', 'idle', '')
  await saveState(mk({
    id: 'm-seul',
    step: 'tasks',
    orchestrator: { agent: 'orch-seul' },
  }))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(herdr.gets).toEqual([])
  const events: ServerEvent[] = []
  const detach = hub.attach((event) => events.push(event), { agents: false })
  await waitFor(() => herdr.gets.includes('orch-seul'))
  detach()
  herdr.gets.length = 0
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(herdr.gets).toEqual([])
})

test('un badge déjà présent sur la mission abonnée n\'est pas notifié', async () => {
  const herdr = scriptedHerdr()
  herdr.set('orch-bloque', 'blocked', '')
  const id = 'm-bloque'
  await saveState(mk({
    id,
    slug: 'bloque',
    step: 'tasks',
    orchestrator: { agent: 'orch-bloque', sessionId: 'sess-bloque' },
  }))
  await transcript('sess-bloque', line('assistant', 'a1', 'j\'attends'))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: false })
  await waitFor(() => events.some((event) => event.type === 'missions'
    && event.missions.some((mission) => mission.id === id && mission.badge === 'attend-herdr')))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(events.filter((event) => event.type === 'notification')).toEqual([])
})

test('un badge déjà présent sur une mission non abonnée n\'est pas notifié', async () => {
  const herdr = scriptedHerdr()
  herdr.set('orch-idle', 'idle', '')
  const id = 'm-idle'
  await saveState(mk({
    id,
    slug: 'idle',
    step: 'tasks',
    orchestrator: { agent: 'orch-idle', sessionId: 'sess-idle' },
  }))
  await transcript('sess-idle', line('assistant', 'a1', 'à toi'))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { agents: false })
  await waitFor(() => events.some((event) => event.type === 'missions'
    && event.missions.some((mission) => mission.id === id && mission.badge === 'attend-reponse')))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(events.filter((event) => event.type === 'notification')).toEqual([])
})

test('les lectures d\'agents restent bornées', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-foule'
  const panes: Record<string, string> = {}
  for (let n = 1; n <= 12; n++) {
    const name = implName(id, n)
    panes[name] = `p${n}`
    herdr.set(name, 'idle', 'ligne')
  }
  let inFlight = 0
  let maxInFlight = 0
  const occupy = async (): Promise<void> => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 40))
    inFlight -= 1
  }
  herdr.agentGet = async (name) => {
    herdr.gets.push(name)
    await occupy()
    return { state: 'idle' }
  }
  herdr.agentRead = async (name) => {
    herdr.reads.push(name)
    await occupy()
    return 'ligne'
  }
  await saveState(mk({
    id,
    step: 'tasks',
    herdr: { tabs: {}, panes },
  }))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: true })
  await waitFor(() => events.some((event) => event.type === 'agents' && event.agents.length === 12))
  expect(maxInFlight).toBeGreaterThan(1)
  expect(maxInFlight).toBeLessThanOrEqual(8)
})

test('un cache de PR qui lève ne laisse pas un rejet non traité', async () => {
  const herdr = scriptedHerdr()
  await saveState(mk({
    id: 'm-cache',
    step: 'pr-ouverte',
    prUrl: 'https://github.com/o/r/pull/9',
  }))
  const rejections: unknown[] = []
  const onRejection = (err: unknown): void => {
    rejections.push(err)
  }
  process.on('unhandledRejection', onRejection)
  try {
    const hub = new Hub({
      ...deps(herdr),
      prCache: {
        get: () => {
          throw new Error('cache cassé')
        },
        refresh: async () => {},
      },
    })
    hubs.push(hub)
    await hub.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(rejections).toEqual([])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('un tour lent n\'empile pas les suivants', async () => {
  const herdr = scriptedHerdr()
  let calls = 0
  herdr.agentGet = async (name) => {
    calls += 1
    herdr.gets.push(name)
    if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 400))
    return { state: 'idle' }
  }
  await saveState(mk({
    id: 'm-lent',
    step: 'tasks',
    orchestrator: { agent: 'orch-lent' },
  }))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  hub.attach(() => {}, { mission: 'm-lent', agents: false })
  await new Promise((resolve) => setTimeout(resolve, 550))
  expect(calls).toBeLessThanOrEqual(3)
})

test('un rafraîchissement de PR lent ne retarde pas une porte', async () => {
  const herdr = scriptedHerdr()
  let releaseRefresh!: () => void
  const refreshing = new Promise<void>((resolve) => {
    releaseRefresh = resolve
  })
  let started!: () => void
  const refreshStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const prCache = {
    get: () => undefined,
    refresh: async () => {
      started()
      await refreshing
    },
  }
  const id = 'm-pr'
  const state = mk({ id, slug: 'pr', step: 'spec', prUrl: 'https://github.com/o/r/pull/4' })
  await saveState(state)
  const hub = new Hub({ ...deps(herdr), prCache })
  hubs.push(hub)
  await hub.start()
  const events: ServerEvent[] = []
  hub.attach((event) => events.push(event), { mission: id, agents: false })
  await waitFor(() => events.some((event) => event.type === 'checks'))
  await refreshStarted
  const t0 = Date.now()
  state.gates.push({
    id: 'g9',
    kind: 'spec',
    status: 'pending',
    summary: 'relire',
    createdAt: '2026-11-04T10:02:00.000Z',
  })
  await saveState(state)
  try {
    await waitFor(() => events.some((event) => event.type === 'notification' && event.key === `porte:${id}:g9`), 900)
    expect(Date.now() - t0).toBeLessThan(1000)
  } finally {
    releaseRefresh()
  }
})

test('un journal disparu ne provoque pas de rejet non traité', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-casse'
  await saveState(mk({ id, slug: 'casse', step: 'tasks' }))
  const logs = join(missionDir(id), 'logs')
  await mkdir(logs, { recursive: true })
  await symlink(join(logs, 'absent.log'), join(logs, '1700000000000-T1-tests.log'))
  const rejections: unknown[] = []
  const onRejection = (err: unknown) => {
    rejections.push(err)
  }
  process.on('unhandledRejection', onRejection)
  try {
    const hub = new Hub(deps(herdr))
    hubs.push(hub)
    await hub.start()
    const events: ServerEvent[] = []
    hub.attach((event) => events.push(event), { mission: id, agents: false })
    await waitFor(() => events.some((event) => event.type === 'checks'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rejections).toEqual([])
    const checks = events.find((event) => event.type === 'checks')
    expect(checks?.type).toBe('checks')
    if (checks?.type === 'checks') expect(checks.checks).toEqual([])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('GET /api/evenements pousse les événements en flux SSE', async () => {
  const herdr = scriptedHerdr()
  const id = 'm-sse'
  await saveState(mk({ id, slug: 'sse', step: 'tasks' }))
  const hub = new Hub(deps(herdr))
  hubs.push(hub)
  await hub.start()
  const token = newToken()
  const server = await startWebServer({ port: 0, token, hub })
  servers.push(server)
  const text = await new Promise<string>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/api/evenements?mission=${id}&agents=0`,
      headers: { cookie: `herness_web=${token}`, host: `127.0.0.1:${server.port}` },
    }, (res) => {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
        if (body.includes('"type":"missions"')) {
          req.destroy()
          resolve(body)
        }
      })
      res.on('error', reject)
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNRESET') reject(err)
    })
    req.end()
  })
  expect(text).toContain('data: ')
  expect(text).toContain('"type":"missions"')
})
