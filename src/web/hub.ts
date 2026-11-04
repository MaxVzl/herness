import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listProjects } from '../config/project.ts'
import type { EngineHerdr } from '../engine/effects.ts'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionDir, missionsRoot, planPath, specPath } from '../paths.ts'
import { needsPrRefresh, type PrInfo } from '../ui/model.ts'
import type { PrCache } from '../ui/pr-cache.ts'
import type { Badge, DocView, MissionSummary, ServerEvent } from './protocol.ts'
import { findTranscript, TranscriptReader, type ChatItem } from './transcript.ts'
import { agentRefs, badgeOf, checksOf, missionFiles, readDoc, sortSummaries, summarize } from './views.ts'

export type HubHerdr = Pick<EngineHerdr, 'agentGet' | 'agentRead'>

export interface HubDeps {
  herdr: HubHerdr
  prCache: Pick<PrCache, 'get' | 'refresh'>
  now(): Date
  transcriptsRoot?: string
  tickMs?: number
}

export interface Subscription {
  mission?: string
  agents: boolean
}

interface Client {
  send: (event: ServerEvent) => void
  sub: Subscription
}

interface Live {
  state: MissionState
  stateMtime: number
  orch: string | null
  orchKnown: boolean
  items: ChatItem[]
  badge?: Badge
  badgeSeen: boolean
  reader?: TranscriptReader
  readerPath?: string
  transcriptMark?: string
  docs: Map<'spec' | 'plan', string>
  docMarks: Map<'spec' | 'plan', string>
  activity: Map<string, { tail: string; lastActivityAt: string }>
  agentsJson?: string
}

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function isFollowed(s: MissionState): boolean {
  return s.step !== 'pr-ouverte' && s.step !== 'fermée'
}

export class Hub {
  private readonly tickMs: number
  private readonly live = new Map<string, Live>()
  private readonly clients: Client[] = []
  private watcher?: FSWatcher
  private interval?: ReturnType<typeof setInterval>
  private debounce?: ReturnType<typeof setTimeout>
  private queued = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private ready = false
  private stopped = false
  private lastPr = 0
  private tickRunning = false
  private prRunning = false

  constructor(private readonly d: HubDeps) {
    this.tickMs = d.tickMs ?? 1000
  }

  async start(): Promise<void> {
    await mkdir(missionsRoot(), { recursive: true })
    await this.scanStates()
    this.ready = true
    this.watcher = watch(missionsRoot(), { recursive: true }, (_event, filename) => {
      this.onWatch(filename?.toString() ?? null)
    })
    this.watcher.on('error', (err) => {
      console.error(err)
    })
    this.interval = setInterval(() => {
      void this.tick()
    }, this.tickMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.clients.length = 0
  }

  attach(send: (event: ServerEvent) => void, sub: Subscription): () => void {
    const client: Client = { send, sub }
    let detached = false
    void this.exclusive(async () => {
      if (detached || this.stopped) return
      this.clients.push(client)
      await this.snapshot(client)
    })
    return () => {
      detached = true
      const index = this.clients.indexOf(client)
      if (index >= 0) this.clients.splice(index, 1)
    }
  }

  current(id: string): MissionState | undefined {
    return this.live.get(id)?.state
  }

  emit(event: ServerEvent): void {
    this.sendAll(event)
  }

  private exclusive(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        await fn()
      } catch (err) {
        console.error(err)
      }
    })
    this.chain = run.then(() => {}, () => {})
    return run
  }

  private onWatch(filename: string | null): void {
    this.queued.add(filename ?? '*')
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      const batch = [...this.queued]
      this.queued.clear()
      this.debounce = undefined
      void this.exclusive(() => this.flush(batch))
    }, 50)
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickRunning) return
    this.tickRunning = true
    this.kickPr()
    try {
      await this.exclusive(async () => {
        if (this.stopped) return
        await this.scanStates()
        if (this.clients.length === 0) return
        await this.pollOrchestrators()
        await this.pollTranscripts()
        await this.pollDocs()
        await this.pollAgents()
      })
    } finally {
      this.tickRunning = false
    }
  }

  private async flush(batch: string[]): Promise<void> {
    if (this.stopped) return
    if (batch.includes('*')) {
      await this.scanStates()
      return
    }
    const byMission = new Map<string, string[]>()
    for (const raw of batch) {
      const id = raw.split(/[/\\]/)[0]
      if (!id) continue
      const hits = byMission.get(id) ?? []
      hits.push(raw)
      byMission.set(id, hits)
    }
    for (const [id, hits] of byMission) {
      try {
        await this.reload(id)
        await this.react(id, hits)
      } catch (err) {
        console.error(err)
      }
    }
  }

  private async scanStates(): Promise<void> {
    const ids = await readdir(missionsRoot()).catch(() => [] as string[])
    for (const id of ids) {
      try {
        await this.reload(id)
      } catch (err) {
        console.error(err)
      }
    }
  }

  private async reload(id: string): Promise<void> {
    if (!MISSION_ID.test(id)) return
    let file: string
    try {
      file = join(missionDir(id), 'state.json')
    } catch {
      return
    }
    let mtime: number
    try {
      mtime = (await stat(file)).mtimeMs
    } catch {
      return
    }
    const prev = this.live.get(id)
    if (prev && prev.stateMtime === mtime) return
    let next: MissionState
    try {
      next = await loadState(id)
    } catch {
      if (prev) prev.stateMtime = mtime
      return
    }
    if (!prev) {
      const created: Live = {
        state: next,
        stateMtime: mtime,
        orch: null,
        orchKnown: false,
        items: [],
        badgeSeen: false,
        docs: new Map(),
        docMarks: new Map(),
        activity: new Map(),
      }
      this.live.set(id, created)
      if (this.ready) {
        this.noteArrival(created)
        await this.publish(id)
      }
      return
    }
    const prevStep = prev.state.step
    const prevGates = new Set(prev.state.gates.filter((gate) => gate.status === 'pending').map((gate) => gate.id))
    prev.state = next
    prev.stateMtime = mtime
    if (!this.ready) return
    for (const gate of next.gates) {
      if (gate.status === 'pending' && !prevGates.has(gate.id)) this.notifyGate(next, gate)
    }
    if (next.step === 'bloquée' && prevStep !== 'bloquée') this.notifyBlocked(next)
    if (prev.orchKnown) this.observeBadge(prev)
    await this.publish(id)
  }

  private noteArrival(live: Live): void {
    for (const gate of live.state.gates) {
      if (gate.status === 'pending') this.notifyGate(live.state, gate)
    }
    if (live.state.step === 'bloquée') this.notifyBlocked(live.state)
  }

  private async react(id: string, hits: string[]): Promise<void> {
    if (!this.live.has(id)) return
    let files = false
    let logs = false
    let spec = false
    let plan = false
    for (const hit of hits) {
      const rest = hit.split(/[/\\]/).slice(1).join('/')
      if (rest === 'taches' || rest.startsWith('taches/') || rest === 'global' || rest.startsWith('global/') || rest === 'preflight' || rest.startsWith('preflight/')) {
        files = true
      }
      if (rest === 'logs' || rest.startsWith('logs/')) logs = true
      if (rest.endsWith('spec.proposed.md')) spec = true
      if (rest.endsWith('plan.proposed.md') || rest.endsWith('plan.approved.md')) plan = true
    }
    if (files) await this.sendMission(id)
    if (logs) await this.sendChecks(id)
    if (spec) await this.sendDoc(id, 'spec')
    if (plan) await this.sendDoc(id, 'plan')
  }

  private async snapshot(client: Client): Promise<void> {
    try {
      if (this.stopped || !this.clients.includes(client)) return
      client.send(await this.missionsEvent())
      const id = client.sub.mission
      if (!id) return
      const live = this.live.get(id)
      if (!live) return
      await this.readTranscript(live)
      client.send(await this.missionEvent(live))
      client.send({ type: 'chat', id, items: live.items })
      for (const kind of ['spec', 'plan'] as const) {
        const doc = await readDoc(live.state, kind)
        live.docs.set(kind, JSON.stringify(doc))
        live.docMarks.set(kind, await this.docMark(live.state, kind))
        client.send({ type: 'doc', id, kind, doc })
      }
      client.send({ type: 'checks', id, checks: await checksOf(id, this.d.now()) })
    } catch (err) {
      console.error(err)
    }
  }

  private async pollOrchestrators(): Promise<void> {
    const followed = [...this.live.values()].filter((live) => isFollowed(live.state) && live.state.orchestrator.agent)
    const changed = await Promise.all(followed.map(async (live) => {
      try {
        if (this.clients.length === 0) return false
        const name = live.state.orchestrator.agent as string
        let state: string | null = null
        try {
          state = (await this.d.herdr.agentGet(name))?.state ?? null
        } catch {
          state = null
        }
        if (this.clients.length === 0) return false
        const stateChanged = state !== live.orch
        live.orch = state
        live.orchKnown = true
        const badgeChanged = this.observeBadge(live)
        if (stateChanged || badgeChanged) await this.sendMission(live.state.id)
        return stateChanged || badgeChanged
      } catch (err) {
        console.error(err)
        return false
      }
    }))
    if (changed.some(Boolean)) await this.broadcastMissions()
  }

  private async pollTranscripts(): Promise<void> {
    const subscribed = new Set(this.clients.map((client) => client.sub.mission).filter((id): id is string => Boolean(id)))
    for (const live of this.live.values()) {
      if (this.clients.length === 0) return
      const id = live.state.id
      if (!isFollowed(live.state) && !subscribed.has(id)) continue
      try {
        const before = live.items
        await this.readTranscript(live)
        if (live.items === before) continue
        const badgeChanged = live.orchKnown && this.observeBadge(live)
        this.sendSub(id, { type: 'chat', id, items: live.items })
        if (badgeChanged) {
          await this.sendMission(id)
          await this.broadcastMissions()
        }
      } catch (err) {
        console.error(err)
      }
    }
  }

  private async readTranscript(live: Live): Promise<void> {
    const session = live.state.orchestrator.sessionId
    if (!session) return
    const path = live.readerPath ?? await findTranscript(session, this.d.transcriptsRoot)
    if (!path) return
    let mark: string
    try {
      const info = await stat(path)
      mark = `${info.mtimeMs}:${info.size}`
    } catch {
      return
    }
    if (live.transcriptMark === mark && live.reader) return
    if (!live.reader || live.readerPath !== path) {
      live.reader = new TranscriptReader(path)
      live.readerPath = path
    }
    try {
      const polled = await live.reader.poll()
      live.transcriptMark = mark
      if (polled.changed) live.items = polled.items
    } catch {
      // transcript disparu entre-temps
    }
  }

  private async pollDocs(): Promise<void> {
    const ids = new Set(this.clients.map((client) => client.sub.mission).filter((id): id is string => Boolean(id)))
    for (const id of ids) {
      const live = this.live.get(id)
      if (!live) continue
      for (const kind of ['spec', 'plan'] as const) {
        try {
          const mark = await this.docMark(live.state, kind)
          if (live.docMarks.get(kind) === mark) continue
          live.docMarks.set(kind, mark)
          await this.sendDoc(id, kind)
        } catch (err) {
          console.error(err)
        }
      }
    }
  }

  /** Dates des fichiers qui peuvent fournir la spec ou le plan, pour ne relire que si l'un a changé. */
  private async docMark(s: MissionState, kind: 'spec' | 'plan'): Promise<string> {
    const paths = [join(missionDir(s.id), `${kind}.proposed.md`)]
    if (s.slug && s.worktree) paths.push(join(s.worktree, (kind === 'spec' ? specPath : planPath)(s)))
    if (kind === 'plan') paths.push(join(missionDir(s.id), 'plan.approved.md'))
    const parts: string[] = []
    for (const path of paths) {
      try {
        const info = await stat(path)
        parts.push(`${info.mtimeMs}:${info.size}`)
      } catch {
        parts.push('-')
      }
    }
    return parts.join('|')
  }

  private async pollAgents(): Promise<void> {
    const ids = new Set<string>()
    for (const client of this.clients) {
      if (client.sub.agents && client.sub.mission) ids.add(client.sub.mission)
    }
    for (const id of ids) {
      if (this.clients.length === 0) return
      const live = this.live.get(id)
      if (!live) continue
      const refs = agentRefs(live.state)
      const views = await Promise.all(refs.map(async (ref) => {
        let state: string | null = null
        try {
          state = (await this.d.herdr.agentGet(ref.name))?.state ?? null
        } catch {
          state = null
        }
        let tail = ''
        try {
          tail = await this.d.herdr.agentRead(ref.name, 5)
        } catch {
          tail = ''
        }
        const prev = live.activity.get(ref.name)
        let lastActivityAt = prev?.lastActivityAt
        if (!prev || prev.tail !== tail) {
          lastActivityAt = this.d.now().toISOString()
          live.activity.set(ref.name, { tail, lastActivityAt })
        }
        return {
          ...ref,
          state,
          tail,
          ...(lastActivityAt ? { lastActivityAt } : {}),
        }
      }))
      const json = JSON.stringify(views)
      if (json === live.agentsJson) continue
      live.agentsJson = json
      this.sendSub(id, { type: 'agents', id, agents: views })
    }
  }

  private observeBadge(live: Live): boolean {
    const badge = badgeOf(live.state, live.orch, live.items)
    if (!live.badgeSeen) {
      live.badge = badge
      live.badgeSeen = true
      return badge !== undefined
    }
    if (badge === live.badge) return false
    if (badge) this.notifyBadge(live.state, badge)
    live.badge = badge
    return true
  }

  private kickPr(): void {
    if (this.prRunning || this.stopped) return
    const t = this.d.now().getTime()
    if (this.lastPr !== 0 && t - this.lastPr < 60_000) return
    this.lastPr = t
    this.prRunning = true
    void this.refreshPr().finally(() => {
      this.prRunning = false
    })
  }

  private async refreshPr(): Promise<void> {
    const urls: string[] = []
    for (const live of this.live.values()) {
      const url = live.state.prUrl
      if (!url) continue
      const pr: PrInfo | undefined = this.d.prCache.get(url)
      if (needsPrRefresh(live.state, pr, this.d.now())) urls.push(url)
    }
    try {
      if (urls.length > 0) await this.d.prCache.refresh(urls)
    } catch (err) {
      console.error(err)
    }
    if (this.stopped || urls.length === 0) return
    await this.exclusive(async () => {
      if (this.stopped) return
      await this.broadcastMissions()
    })
  }

  private titleOf(s: MissionState): string {
    return summarize(s, s.prUrl ? this.d.prCache.get(s.prUrl) : undefined, undefined, this.d.now()).title
  }

  private notify(key: string, s: MissionState, title: string, extra?: string): void {
    const head = `${s.id} · ${this.titleOf(s)}`
    this.sendAll({
      type: 'notification',
      key,
      missionId: s.id,
      title,
      body: extra ? `${head}\n${extra}` : head,
    })
  }

  private notifyGate(s: MissionState, gate: MissionState['gates'][number]): void {
    this.notify(`porte:${s.id}:${gate.id}`, s, `Porte ${gate.id} (${gate.kind})`, gate.summary)
  }

  private notifyBlocked(s: MissionState): void {
    this.notify(`bloquee:${s.id}`, s, 'Mission bloquée', s.blockedReason)
  }

  private notifyBadge(s: MissionState, badge: Badge): void {
    const title = badge === 'attend-reponse'
      ? 'L\'orchestrateur attend ta réponse'
      : 'L\'orchestrateur attend dans herdr'
    this.notify(`badge:${s.id}:${badge}`, s, title)
  }

  private async missionsEvent(): Promise<Extract<ServerEvent, { type: 'missions' }>> {
    const now = this.d.now()
    const summaries: MissionSummary[] = []
    for (const live of this.live.values()) {
      const pr = live.state.prUrl ? this.d.prCache.get(live.state.prUrl) : undefined
      summaries.push(summarize(live.state, pr, live.badge, now))
    }
    const projects = (await listProjects()).map((found) => ({
      name: found.config.name,
      repoPath: found.config.repoPath,
      preflight: found.config.preflight.map((check) => check.label),
    }))
    const missions = sortSummaries(summaries)
    return {
      type: 'missions',
      missions,
      hiddenCount: missions.filter((mission) => mission.hidden).length,
      projects,
    }
  }

  private async missionEvent(live: Live): Promise<Extract<ServerEvent, { type: 'mission' }>> {
    return {
      type: 'mission',
      id: live.state.id,
      detail: {
        state: live.state,
        ...(live.badge ? { badge: live.badge } : {}),
        orchestrator: { state: live.orch },
        files: await missionFiles(live.state.id),
      },
    }
  }

  private async broadcastMissions(): Promise<void> {
    if (this.clients.length === 0) return
    this.sendAll(await this.missionsEvent())
  }

  private async publish(id: string): Promise<void> {
    await this.broadcastMissions()
    await this.sendMission(id)
  }

  private async sendMission(id: string): Promise<void> {
    const live = this.live.get(id)
    if (!live || !this.clients.some((client) => client.sub.mission === id)) return
    this.sendSub(id, await this.missionEvent(live))
  }

  private async sendChecks(id: string): Promise<void> {
    if (!this.clients.some((client) => client.sub.mission === id)) return
    this.sendSub(id, { type: 'checks', id, checks: await checksOf(id, this.d.now()) })
  }

  private async sendDoc(id: string, kind: 'spec' | 'plan'): Promise<void> {
    const live = this.live.get(id)
    if (!live || !this.clients.some((client) => client.sub.mission === id)) return
    const doc: DocView = await readDoc(live.state, kind)
    const json = JSON.stringify(doc)
    if (live.docs.get(kind) === json) return
    live.docs.set(kind, json)
    this.sendSub(id, { type: 'doc', id, kind, doc })
  }

  private sendAll(event: ServerEvent): void {
    for (const client of [...this.clients]) client.send(event)
  }

  private sendSub(id: string, event: ServerEvent): void {
    for (const client of this.clients) {
      if (client.sub.mission === id) client.send(event)
    }
  }
}
