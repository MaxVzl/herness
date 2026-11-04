import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Gate } from '../../mission/state.ts'
import { post } from './api.ts'
import { ConfirmDialog, NoteDialog } from './Dialogs.tsx'

type Decision = 'valider' | 'refuser'

type Flow =
  | { kind: 'confirm'; gate: Gate; decision: Decision; note?: string }
  | { kind: 'note'; gate: Gate; required: boolean }
  | { kind: 'choix'; gate: Gate; note: string }

function tabOf(path: string | undefined): 'spec' | 'plan' | undefined {
  if (!path) return undefined
  const normalized = path.replaceAll('\\', '/')
  if (normalized.includes('/specs/') || normalized.endsWith('spec.proposed.md')) return 'spec'
  if (normalized.includes('/plans/') || normalized.endsWith('plan.proposed.md') || normalized.endsWith('plan.approved.md')) return 'plan'
  return undefined
}

function usePortesSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const found = document.querySelector('.portes-slot')
    setSlot(found instanceof HTMLElement ? found : null)
  })
  return slot
}

export function GateCards({ missionId, gates, onOpenDoc }: {
  missionId: string
  gates: Gate[]
  onOpenDoc: (tab: 'spec' | 'plan') => void
}) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [held, setHeld] = useState<Set<string>>(new Set())
  const slot = usePortesSlot()

  useEffect(() => {
    const live = new Set(gates.filter((gate) => gate.status === 'pending').map((gate) => gate.id))
    setHeld((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)))
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev
      return next
    })
  }, [gates])

  const pending = gates
    .filter((gate) => gate.status === 'pending')
    .slice()
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)

  async function decide(gate: Gate, decision: Decision, note?: string) {
    if (busy.has(gate.id) || held.has(gate.id)) return
    setBusy((prev) => new Set(prev).add(gate.id))
    const res = await post(
      `/api/missions/${encodeURIComponent(missionId)}/portes/${encodeURIComponent(gate.id)}/${decision}`,
      note ? { note } : {},
    )
    setBusy((prev) => {
      const next = new Set(prev)
      next.delete(gate.id)
      return next
    })
    if (res.ok) setHeld((prev) => new Set(prev).add(gate.id))
  }

  function question(current: Extract<Flow, { kind: 'confirm' }>): string {
    const verb = current.decision === 'valider' ? 'Valider' : 'Refuser'
    return `${verb} ${current.gate.id} (${current.gate.kind}) de ${missionId} ?`
  }

  const body = (
    <div className="portes">
      {pending.map((gate) => {
        const tab = tabOf(gate.path)
        const locked = flow !== null || busy.has(gate.id) || held.has(gate.id)
        return (
          <article key={gate.id} className="porte">
            <p>{gate.kind}</p>
            <p>{gate.summary}</p>
            {gate.path ? <p>{gate.path}</p> : null}
            {tab ? (
              <button type="button" onClick={() => onOpenDoc(tab)}>{tab === 'spec' ? 'Spec' : 'Plan'}</button>
            ) : null}
            <button type="button" disabled={locked} onClick={() => { if (!locked) setFlow({ kind: 'confirm', gate, decision: 'valider' }) }}>Valider</button>
            <button type="button" disabled={locked} onClick={() => { if (!locked) setFlow({ kind: 'note', gate, required: true }) }}>Refuser</button>
            <button type="button" disabled={locked} onClick={() => { if (!locked) setFlow({ kind: 'note', gate, required: false }) }}>Avec une note…</button>
          </article>
        )
      })}
      {flow?.kind === 'confirm' ? (
        <ConfirmDialog
          question={question(flow)}
          onYes={() => {
            const current = flow
            setFlow(null)
            void decide(current.gate, current.decision, current.note)
          }}
          onNo={() => setFlow(null)}
        />
      ) : null}
      {flow?.kind === 'note' ? (
        <NoteDialog
          title={flow.required ? `Note de refus pour ${flow.gate.id}` : `Note pour ${flow.gate.id}`}
          required={flow.required}
          onSubmit={(note) => {
            const trimmed = note.trim()
            if (flow.required) setFlow({ kind: 'confirm', gate: flow.gate, decision: 'refuser', note: trimmed })
            else setFlow({ kind: 'choix', gate: flow.gate, note: trimmed })
          }}
          onCancel={() => setFlow(null)}
        />
      ) : null}
      {flow?.kind === 'choix' ? (
        <div role="dialog" aria-label="Valider ou refuser">
          <button
            type="button"
            onClick={() => setFlow({ kind: 'confirm', gate: flow.gate, decision: 'valider', ...(flow.note ? { note: flow.note } : {}) })}
          >
            Valider
          </button>
          <button
            type="button"
            disabled={flow.note.trim() === ''}
            onClick={() => {
              const note = flow.note.trim()
              if (note === '') return
              setFlow({ kind: 'confirm', gate: flow.gate, decision: 'refuser', note })
            }}
          >
            Refuser
          </button>
          <button type="button" onClick={() => setFlow(null)}>Annuler</button>
        </div>
      ) : null}
    </div>
  )

  return slot ? createPortal(body, slot) : body
}
