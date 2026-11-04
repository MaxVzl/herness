import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EngineHerdr } from '../engine/effects.ts'
import type { MissionState } from '../mission/state.ts'
import {
  close as closeAction,
  open,
  refuse,
  remove as removeAction,
  restartDetached,
  resume,
  validate,
  type ActionDeps,
  type Spawner,
} from '../ui/actions.ts'
import type { Hub } from './hub.ts'
import type { ActionResponse } from './protocol.ts'
import type { Route } from './server.ts'
import { agentRefs } from './views.ts'

export interface WebActionDeps {
  hub: Pick<Hub, 'current' | 'emit'>
  /** `realActionDeps` en production. */
  deps(cwd: string): ActionDeps
  herdr: Pick<EngineHerdr, 'agentPrompt' | 'agentGet' | 'agentRead'>
  spawn?: Spawner
  /** Délai avant qu'une confirmation sans réponse vaille non. Défaut : 300000. */
  confirmTimeoutMs?: number
}

const OPENED = 'espace ouvert dans herdr — bascule sur ta fenêtre herdr'
const STOPPED = 'orchestrateur arrêté — Reprendre'

/** Routes d'action. La garde `<id>:<gateId>` est posée avant l'appel et reste tant que la porte est `pending`. */
export function actionRoutes(d: WebActionDeps): Route[] {
  const sent = new Set<string>()
  const confirms = new Map<string, (oui: boolean) => void>()
  let closing = false
  const timeoutMs = d.confirmTimeoutMs ?? 300_000

  const gate = (pattern: RegExp, handle: Route['handle']): Route => ({ method: 'POST', pattern, handle })

  return [
    gate(/^\/api\/missions\/([^/]+)\/portes\/([^/]+)\/valider$/, (_req, res, match, body) =>
      onDecision(d, sent, res, match, body, 'approved')),
    gate(/^\/api\/missions\/([^/]+)\/portes\/([^/]+)\/refuser$/, (_req, res, match, body) =>
      onDecision(d, sent, res, match, body, 'refused')),
    gate(/^\/api\/missions\/([^/]+)\/reprendre$/, async (_req, res, match) => {
      const found = mission(d, res, match)
      if (!found) return
      json(res, 200, await resume(found.id, d.deps(found.repoPath), { focus: false }))
    }),
    gate(/^\/api\/missions\/([^/]+)\/redemarrer$/, async (_req, res, match) => {
      const found = mission(d, res, match)
      if (!found) return
      const result = d.spawn ? await restartDetached(found.id, d.spawn) : await restartDetached(found.id)
      json(res, 200, result)
    }),
    gate(/^\/api\/missions\/([^/]+)\/ouvrir$/, async (_req, res, match) => {
      const found = mission(d, res, match)
      if (!found) return
      const result = await open(found, d.deps(found.repoPath))
      if (result.ok) result.lines.push(OPENED)
      json(res, 200, result)
    }),
    gate(/^\/api\/missions\/([^/]+)\/fermer$/, async (_req, res, match) => {
      const found = mission(d, res, match)
      if (!found) return
      if (closing) {
        json(res, 409, { ok: false, lines: ['action en cours'] })
        return
      }
      closing = true
      try {
        json(res, 200, await closeAction(found.id, d.deps(found.repoPath), (question) => ask(d, confirms, timeoutMs, found.id, question)))
      } finally {
        closing = false
      }
    }),
    gate(/^\/api\/missions\/([^/]+)\/supprimer$/, async (_req, res, match) => {
      const found = mission(d, res, match)
      if (!found) return
      if (found.step !== 'fermée') {
        json(res, 409, { ok: false, lines: ['seule une mission fermée peut être supprimée'] })
        return
      }
      json(res, 200, await removeAction(found.id, d.deps(found.repoPath)))
    }),
    gate(/^\/api\/missions\/([^/]+)\/message$/, async (_req, res, match, body) => {
      const found = mission(d, res, match)
      if (!found) return
      const fields = object(body)
      if (!fields) {
        json(res, 400, { ok: false, lines: ['corps illisible'] })
        return
      }
      const texte = fields.texte
      if (typeof texte !== 'string' || texte.trim() === '') {
        json(res, 400, { ok: false, lines: ['un texte est obligatoire'] })
        return
      }
      const name = found.orchestrator.agent
      if (!name || (await d.herdr.agentGet(name)) === null) {
        json(res, 200, { ok: false, lines: [STOPPED] })
        return
      }
      await d.herdr.agentPrompt(name, texte, { wait: false })
      json(res, 200, { ok: true, lines: [] })
    }),
    gate(/^\/api\/missions$/, async (_req, res, _match, body) => {
      const fields = object(body)
      if (!fields) {
        json(res, 400, { ok: false, lines: ['corps illisible'] })
        return
      }
      const projet = fields.projet
      const demande = fields.demande
      if (typeof projet !== 'string' || projet.trim() === '' || typeof demande !== 'string' || demande.trim() === '') {
        json(res, 400, { ok: false, lines: ['projet et demande sont obligatoires'] })
        return
      }
      const note = fields.note
      if (note !== undefined && typeof note !== 'string') {
        json(res, 400, { ok: false, lines: ['note illisible'] })
        return
      }
      const lines: string[] = []
      const ad = d.deps(projet)
      try {
        const id = await ad.start(demande, projet, { ...ad.lifecycle, out: (line) => lines.push(line) }, note !== undefined ? { note } : {})
        json(res, 200, { ok: true, lines, id })
      } catch (err) {
        lines.push(err instanceof Error ? err.message : String(err))
        json(res, 200, { ok: false, lines })
      }
    }),
    gate(/^\/api\/confirmations\/([^/]+)$/, async (_req, res, match, body) => {
      const confirmId = decode(match[1])
      const answer = confirmId ? confirms.get(confirmId) : undefined
      if (!confirmId || !answer) {
        json(res, 404, { ok: false, lines: ['confirmation inconnue'] })
        return
      }
      const fields = object(body)
      if (!fields || typeof fields.oui !== 'boolean') {
        json(res, 400, { ok: false, lines: ['oui est obligatoire'] })
        return
      }
      answer(fields.oui)
      json(res, 200, { ok: true, lines: [] })
    }),
    {
      method: 'GET',
      pattern: /^\/api\/missions\/([^/]+)\/agents\/([^/]+)\/sortie$/,
      handle: async (req, res, match) => {
        const found = mission(d, res, match)
        if (!found) return
        const nom = decode(match[2])
        if (!nom || !knownAgent(found, nom)) {
          json(res, 404, { ok: false, lines: ['agent inconnu'] })
          return
        }
        const text = await d.herdr.agentRead(nom, lineCount(req))
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(text)
      },
    },
  ]
}

async function onDecision(
  d: WebActionDeps,
  sent: Set<string>,
  res: ServerResponse,
  match: RegExpMatchArray,
  body: unknown,
  decision: 'approved' | 'refused',
): Promise<void> {
  const found = mission(d, res, match)
  if (!found) return
  const gateId = decode(match[2])
  if (!gateId) {
    json(res, 400, { ok: false, lines: ['porte illisible'] })
    return
  }
  const fields = object(body)
  if (!fields) {
    json(res, 400, { ok: false, lines: ['corps illisible'] })
    return
  }
  const note = fields.note
  if (note !== undefined && typeof note !== 'string') {
    json(res, 400, { ok: false, lines: ['note illisible'] })
    return
  }
  const key = `${found.id}:${gateId}`
  releaseSettled(d, sent, found.id)
  if (sent.has(key)) {
    json(res, 409, { ok: false, lines: ['décision déjà envoyée'] })
    return
  }
  const gate = found.gates.find((g) => g.id === gateId)
  if (!gate || gate.status !== 'pending') {
    json(res, 409, { ok: false, lines: ['porte déjà décidée'] })
    return
  }
  const ad = d.deps(found.repoPath)
  if (decision === 'refused' && (note ?? '').trim() === '') {
    json(res, 200, await refuse(found.id, gateId, note ?? '', ad))
    return
  }
  sent.add(key)
  const result = decision === 'approved'
    ? await validate(found.id, gateId, note, ad)
    : await refuse(found.id, gateId, note ?? '', ad)
  if (!result.ok || !isPending(d, found.id, gateId)) sent.delete(key)
  json(res, 200, result)
}

function releaseSettled(d: WebActionDeps, sent: Set<string>, id: string): void {
  for (const key of sent) {
    if (!key.startsWith(`${id}:`)) continue
    if (!isPending(d, id, key.slice(id.length + 1))) sent.delete(key)
  }
}

function isPending(d: WebActionDeps, id: string, gateId: string): boolean {
  return d.hub.current(id)?.gates.some((g) => g.id === gateId && g.status === 'pending') ?? false
}

function ask(
  d: WebActionDeps,
  confirms: Map<string, (oui: boolean) => void>,
  timeoutMs: number,
  missionId: string,
  question: string,
): Promise<boolean> {
  const confirmId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      confirms.delete(confirmId)
      resolve(false)
    }, timeoutMs)
    confirms.set(confirmId, (oui) => {
      clearTimeout(timer)
      confirms.delete(confirmId)
      resolve(oui)
    })
    d.hub.emit({ type: 'confirmation', confirmId, missionId, question })
  })
}

function knownAgent(s: MissionState, nom: string): boolean {
  if (s.orchestrator.agent === nom) return true
  return agentRefs(s).some((agent) => agent.name === nom)
}

function lineCount(req: IncomingMessage): number {
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('lignes')
  const n = raw === null ? 2000 : Number(raw)
  if (!Number.isFinite(n)) return 2000
  return Math.min(n, 2000)
}

function mission(d: WebActionDeps, res: ServerResponse, match: RegExpMatchArray): MissionState | undefined {
  const id = decode(match[1])
  const found = id ? d.hub.current(id) : undefined
  if (!found) {
    json(res, 404, { ok: false, lines: ['mission inconnue'] })
    return undefined
  }
  return found
}

function object(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return {}
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>
  return undefined
}

function decode(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

function json(res: ServerResponse, status: number, body: ActionResponse): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
