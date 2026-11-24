import { assertResumable, loadState, type Gate, type GateKind, type MissionState } from '../mission/state.ts'
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

/** Reason for rejecting a decision on a gate that is no longer pending. */
function notPending(gate: Gate): string {
  if (gate.status === 'obsolete') return `gate ${gate.id} obsolete: nothing is waiting for it, decision ignored`
  return `gate ${gate.id} already decided (${gate.status})`
}

export function applyDecision(
  s: MissionState,
  msg: Decision,
): { ok: true; gate: Gate } | { ok: false; reason: string } {
  const gate = s.gates.find((g) => g.id === msg.gateId)
  if (!gate) return { ok: false, reason: `gate ${msg.gateId} not found` }
  if (gate.status !== 'pending') return { ok: false, reason: notPending(gate) }
  gate.status = msg.decision
  gate.decidedAt = new Date().toISOString()
  if (msg.note !== undefined) gate.note = msg.note
  return { ok: true, gate }
}

export function pendingGate(s: MissionState, kind?: GateKind): Gate | undefined {
  return s.gates.find((g) => g.status === 'pending' && (kind === undefined || g.kind === kind))
}

// Read-only state: only the engine writes state.json; this only posts to the inbox.
export async function decide(
  id: string,
  decision: Decision['decision'],
  opts: { gateId?: string; note?: string; isTTY: boolean; confirm: () => Promise<boolean>; out?: (line: string) => void },
): Promise<void> {
  const out = opts.out ?? console.log
  if (!opts.isTTY) throw new Error('approval requires an interactive terminal')
  const s = await loadState(id)
  assertResumable(s)
  const gate = opts.gateId ? s.gates.find((g) => g.id === opts.gateId) : pendingGate(s)
  if (!gate) {
    throw new Error(opts.gateId ? `gate ${opts.gateId} not found` : 'no gate pending')
  }
  if (gate.status !== 'pending') throw new Error(notPending(gate))
  out(`Gate ${gate.id} (${gate.kind}): ${gate.summary}`)
  if (gate.path) out(`File: ${gate.path}`)
  if (!(await opts.confirm())) return
  await postInbox(id, {
    type: 'decision',
    source: 'user',
    gateId: gate.id,
    decision,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  })
}
