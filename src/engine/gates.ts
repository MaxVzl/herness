import { loadState, type Gate, type GateKind, type MissionState } from '../mission/state.ts'
import { postInbox, type InboxMessage } from '../mission/inbox.ts'

type Decision = Extract<InboxMessage, { type: 'decision' }>

export function openGate(s: MissionState, kind: GateKind, summary: string, path?: string, hash?: string): Gate {
  const gate: Gate = {
    id: `g${s.gates.length + 1}`,
    kind,
    status: 'pending',
    summary,
    createdAt: new Date().toISOString(),
    ...(path !== undefined ? { path } : {}),
    ...(hash !== undefined ? { hash } : {}),
  }
  s.gates.push(gate)
  return gate
}

/** Motif du refus d'une décision sur une porte qui n'est plus en attente. */
function notPending(gate: Gate): string {
  if (gate.status === 'caduque') return `porte ${gate.id} caduque : plus rien ne l'attend, décision ignorée`
  return `porte ${gate.id} déjà décidée (${gate.status})`
}

export function applyDecision(
  s: MissionState,
  msg: Decision,
): { ok: true; gate: Gate } | { ok: false; reason: string } {
  const gate = s.gates.find((g) => g.id === msg.gateId)
  if (!gate) return { ok: false, reason: `porte ${msg.gateId} introuvable` }
  if (gate.status !== 'pending') return { ok: false, reason: notPending(gate) }
  gate.status = msg.decision
  gate.decidedAt = new Date().toISOString()
  if (msg.note !== undefined) gate.note = msg.note
  return { ok: true, gate }
}

export function pendingGate(s: MissionState, kind?: GateKind): Gate | undefined {
  return s.gates.find((g) => g.status === 'pending' && (kind === undefined || g.kind === kind))
}

// Lecture seule de l'état : seul le moteur écrit state.json ; on ne fait que poster dans l'inbox.
export async function decide(
  id: string,
  decision: Decision['decision'],
  opts: { gateId?: string; note?: string; isTTY: boolean; confirm: () => Promise<boolean> },
): Promise<void> {
  if (!opts.isTTY) throw new Error('validation réservée à un terminal interactif')
  const s = await loadState(id)
  const gate = opts.gateId ? s.gates.find((g) => g.id === opts.gateId) : pendingGate(s)
  if (!gate) {
    throw new Error(opts.gateId ? `porte ${opts.gateId} introuvable` : 'aucune porte en attente')
  }
  if (gate.status !== 'pending') throw new Error(notPending(gate))
  console.log(`Porte ${gate.id} (${gate.kind}) : ${gate.summary}`)
  if (gate.path) console.log(`Fichier : ${gate.path}`)
  if (!(await opts.confirm())) return
  await postInbox(id, {
    type: 'decision',
    source: 'user',
    gateId: gate.id,
    decision,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  })
}
