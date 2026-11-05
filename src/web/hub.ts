import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listProjects, projectDirs } from '../config/project.ts'
import type { EngineHerdr } from '../engine/effects.ts'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionDir, missionsRoot, planPath, specPath } from '../paths.ts'
import { needsPrRefresh, type PrInfo } from '../ui/model.ts'
import type { PrCache } from '../ui/pr-cache.ts'
import type { Badge, DocView, MissionSummary, ServerEvent } from './protocol.ts'
import { chatDelta, findTranscript, TranscriptReader, type ChatItem } from './transcript.ts'
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
  /** Dernier transcript déjà envoyé aux abonnés. */
  chatSent?: ChatItem[]
  activity: Map<string, { tail: string; lastActivityAt: string }>
  agentsJson?: string
}

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) continue
      out[index] = await fn(item)
    }
  }
  const workers = Math.min(limit, items.length)
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()))
  return out
}

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
  private herdrRunning = false
  private prRunning = false
  private readonly extraWatchers: FSWatcher[] = []
  private readonly watched = new Set<string>()
  private readonly transcriptMisses = new Map<string, number>()
  private projectsCache?: { stamp: string; projects: { name: string; repoPath: string; preflight: string[] }[] }

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
    for (const watcher of this.extraWatchers) watcher.close()
    this.extraWatchers.length = 0
    this.watched.clear()
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
    if (this.stopped) return
    if (!this.tickRunning) {
      this.tickRunning = true
      this.kickPr()
      try {
        await this.exclusive(async () => {
          if (this.stopped) return
          await this.scanStates()
          if (this.clients.length === 0) return
          await this.pollTranscripts()
          await this.pollDocs()
        })
      } finally {
        this.tickRunning = false
      }
    }
    if (this.stopped || this.clients.length === 0 || this.herdrRunning) return
    this.herdrRunning = true
    try {
      await this.pollOrchestrators()
      await this.pollAgents()
    } finally {
      this.herdrRunning = false
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
      await this.pushTranscript(live, client)
      client.send(await this.missionEvent(live))
      client.send({ type: 'chat', id, from: 0, items: live.items })
      this.armDocs(live)
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
    const jobs = [...this.live.values()]
      .filter((live) => isFollowed(live.state) && live.state.orchestrator.agent)
      .map((live) => ({ id: live.state.id, agent: live.state.orchestrator.agent as string }))
    if (jobs.length === 0 || this.clients.length === 0) return
    const results = await Promise.all(jobs.map(async (job) => {
      if (this.clients.length === 0) return null
      let state: string | null = null
      try {
        state = (await this.d.herdr.agentGet(job.agent))?.state ?? null
      } catch {
        state = null
      }
      return { id: job.id, state }
    }))
    await this.exclusive(async () => {
      if (this.stopped) return
      let any = false
      for (const result of results) {
        if (!result || this.clients.length === 0) continue
        const live = this.live.get(result.id)
        if (!live) continue
        try {
          const stateChanged = result.state !== live.orch
          live.orch = result.state
          live.orchKnown = true
          if (!live.badgeSeen) await this.readTranscript(live)
          const badgeChanged = this.observeBadge(live)
          if (stateChanged || badgeChanged) {
            await this.sendMission(live.state.id)
            any = true
          }
        } catch (err) {
          console.error(err)
        }
      }
      if (any) await this.broadcastMissions()
    })
  }

  private async pollTranscripts(): Promise<void> {
    const subscribed = new Set(this.clients.map((client) => client.sub.mission).filter((id): id is string => Boolean(id)))
    for (const live of this.live.values()) {
      if (this.clients.length === 0) return
      const id = live.state.id
      if (!isFollowed(live.state) && !subscribed.has(id)) continue
      try {
        await this.pushTranscript(live)
      } catch (err) {
        console.error(err)
      }
    }
  }

  private async pushTranscript(live: Live, skip?: Client): Promise<void> {
    await this.readTranscript(live)
    const from = chatDelta(live.chatSent ?? [], live.items)
    if (from < 0) return
    const badgeChanged = live.orchKnown && this.observeBadge(live)
    const items = live.items.slice(from)
    live.chatSent = live.items
    this.sendSub(live.state.id, { type: 'chat', id: live.state.id, from, items }, skip)
    if (badgeChanged) {
      await this.sendMission(live.state.id)
      await this.broadcastMissions()
    }
  }

  private async locateTranscript(session: string): Promise<string | null> {
    const until = this.transcriptMisses.get(session)
    if (until !== undefined && this.d.now().getTime() < until) return null
    const path = await findTranscript(session, this.d.transcriptsRoot)
    if (path) this.transcriptMisses.delete(session)
    else this.transcriptMisses.set(session, this.d.now().getTime() + 5_000)
    return path
  }

  private armWatch(key: string, path: string, recursive: boolean, fn: () => void): void {
    if (this.watched.has(key) || this.stopped) return
    let watcher: FSWatcher
    try {
      watcher = recursive ? watch(path, { recursive: true }, fn) : watch(path, fn)
    } catch {
      return
    }
    this.watched.add(key)
    watcher.on('error', () => {
      watcher.close()
      this.watched.delete(key)
    })
    this.extraWatchers.push(watcher)
  }

  private armTranscript(live: Live, path: string): void {
    this.armWatch(`tr:${path}`, path, false, () => {
      void this.exclusive(async () => {
        if (this.stopped) return
        await this.pushTranscript(live)
      })
    })
  }

  private armDocs(live: Live): void {
    const root = live.state.worktree
    if (!root) return
    const dir = join(root, 'docs', 'superpowers')
    this.armWatch(`doc:${dir}`, dir, true, () => {
      void this.exclusive(async () => {
        if (this.stopped) return
        await this.sendDoc(live.state.id, 'spec')
        await this.sendDoc(live.state.id, 'plan')
      })
    })
  }

  private async readTranscript(live: Live): Promise<void> {
    const session = live.state.orchestrator.sessionId
    if (!session) return
    const path = live.readerPath ?? await this.locateTranscript(session)
    if (!path) return
    this.armTranscript(live, path)
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
      this.armDocs(live)
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
    const jobs: { id: string; ref: ReturnType<typeof agentRefs>[number] }[] = []
    const seen = new Set<string>()
    for (const client of this.clients) {
      if (!client.sub.agents || !client.sub.mission) continue
      const live = this.live.get(client.sub.mission)
      if (!live) continue
      for (const ref of agentRefs(live.state)) {
        const key = `${client.sub.mission}\0${ref.name}`
        if (seen.has(key)) continue
        seen.add(key)
        jobs.push({ id: client.sub.mission, ref })
      }
    }
    if (jobs.length === 0 || this.clients.length === 0) return
    const fetched = await mapLimit(jobs, 8, async (job) => {
      let state: string | null = null
      try {
        state = (await this.d.herdr.agentGet(job.ref.name))?.state ?? null
      } catch {
        state = null
      }
      let tail = ''
      try {
        tail = await this.d.herdr.agentRead(job.ref.name, 5)
      } catch {
        tail = ''
      }
      return { id: job.id, ref: job.ref, state, tail }
    })
    await this.exclusive(async () => {
      if (this.stopped || this.clients.length === 0) return
      const byId = new Map<string, typeof fetched>()
      for (const row of fetched) {
        const list = byId.get(row.id) ?? []
        list.push(row)
        byId.set(row.id, list)
      }
      for (const [id, rows] of byId) {
        const live = this.live.get(id)
        if (!live) continue
        if (!this.clients.some((client) => client.sub.agents && client.sub.mission === id)) continue
        const views = rows.map((row) => {
          const prev = live.activity.get(row.ref.name)
          let lastActivityAt = prev?.lastActivityAt
          if (!prev || prev.tail !== row.tail) {
            lastActivityAt = this.d.now().toISOString()
            live.activity.set(row.ref.name, { tail: row.tail, lastActivityAt })
          }
          return {
            ...row.ref,
            state: row.state,
            tail: row.tail,
            ...(lastActivityAt ? { lastActivityAt } : {}),
          }
        })
        const json = JSON.stringify(views)
        if (json === live.agentsJson) continue
        live.agentsJson = json
        this.sendSub(id, { type: 'agents', id, agents: views })
      }
    })
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
    void this.refreshPr().catch((err: unknown) => {
      console.error(err)
    }).finally(() => {
      this.prRunning = false
    })
  }

  private async refreshPr(): Promise<void> {
    try {
      const urls: string[] = []
      for (const live of this.live.values()) {
        const url = live.state.prUrl
        if (!url) continue
        const pr: PrInfo | undefined = this.d.prCache.get(url)
        if (needsPrRefresh(live.state, pr, this.d.now())) urls.push(url)
      }
      if (urls.length > 0) await this.d.prCache.refresh(urls)
      if (this.stopped || urls.length === 0) return
      await this.exclusive(async () => {
        if (this.stopped) return
        await this.broadcastMissions()
      })
    } catch (err) {
      console.error(err)
    }
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

  private async projectStamp(): Promise<string> {
    const parts: string[] = []
    for (const dir of projectDirs()) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const file = join(dir, name, 'config.ts')
        try {
          const info = await stat(file)
          parts.push(`${file}:${info.mtimeMs}:${info.size}`)
        } catch {
          parts.push(`${file}:-`)
        }
      }
    }
    parts.sort()
    return parts.join('|')
  }

  private async projectViews(): Promise<{ name: string; repoPath: string; preflight: string[] }[]> {
    const stamp = await this.projectStamp()
    if (this.projectsCache?.stamp === stamp) return this.projectsCache.projects
    const projects = (await listProjects()).map((found) => ({
      name: found.config.name,
      repoPath: found.config.repoPath,
      preflight: found.config.preflight.map((check) => check.label),
    }))
    this.projectsCache = { stamp, projects }
    return projects
  }

  private async missionsEvent(): Promise<Extract<ServerEvent, { type: 'missions' }>> {
    const now = this.d.now()
    const summaries: MissionSummary[] = []
    for (const live of this.live.values()) {
      const pr = live.state.prUrl ? this.d.prCache.get(live.state.prUrl) : undefined
      summaries.push(summarize(live.state, pr, live.badge, now))
    }
    const projects = await this.projectViews()
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

  private sendSub(id: string, event: ServerEvent, skip?: Client): void {
    for (const client of this.clients) {
      if (client === skip || client.sub.mission !== id) continue
      client.send(event)
    }
  }
}
