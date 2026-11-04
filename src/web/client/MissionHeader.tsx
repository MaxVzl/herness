import { useRef, useState } from 'react'
import type { MissionState } from '../../mission/state.ts'
import type { ActionResponse, MissionDetail, MissionSummary } from '../protocol.ts'
import { post } from './api.ts'
import { ConfirmDialog } from './Dialogs.tsx'

export function MissionHeader({ summary, detail, onResult }: {
  summary: MissionSummary
  detail: MissionDetail
  onResult: (result: ActionResponse) => void
}) {
  const state = detail.state as MissionState
  const step = state.step || summary.step
  const finished = step === 'pr-ouverte' || step === 'fermée'
  const [menu, setMenu] = useState(false)
  const [ask, setAsk] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const lock = useRef(false)
  const id = summary.id
  const base = `/api/missions/${encodeURIComponent(id)}`

  async function run(action: string, path: string) {
    if (lock.current) return
    lock.current = true
    setBusy(action)
    try {
      onResult(await post(path))
    } finally {
      lock.current = false
      setBusy(null)
    }
  }

  function label(action: string, text: string): string {
    return busy === action ? `${text} — en cours` : text
  }

  return (
    <header className="mission-courante">
      <h1>{id} · {summary.title}</h1>
      <p>{summary.project}</p>
      {state.branch ? <p>{state.branch}</p> : null}
      <p>{step}</p>
      {state.paused ? <p>EN PAUSE</p> : null}
      {state.blockedReason ? <p className="rouge" style={{ color: 'var(--red)' }}>{state.blockedReason}</p> : null}
      {state.prUrl ? <p><a href={state.prUrl}>{state.prUrl}</a></p> : null}
      <button type="button" disabled={busy === 'open'} onClick={() => void run('open', `${base}/ouvrir`)}>
        {label('open', 'Ouvrir dans herdr')}
      </button>
      <button
        type="button"
        disabled={finished || busy === 'resume'}
        title={finished ? 'reprendre indisponible : mission terminée' : undefined}
        onClick={() => { if (!finished) void run('resume', `${base}/reprendre`) }}
      >
        {label('resume', 'Reprendre')}
      </button>
      <button type="button" disabled={busy === 'restart'} onClick={() => void run('restart', `${base}/redemarrer`)}>
        {label('restart', 'Redémarrer')}
      </button>
      <button type="button" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>⋯</button>
      {menu ? (
        <div>
          <button type="button" onClick={() => { setMenu(false); setAsk(`Fermer ${id} ?`) }}>Fermer</button>
          {step === 'fermée' ? (
            <button
              type="button"
              onClick={() => {
                setMenu(false)
                setAsk(`Supprimer définitivement ${id} (état, spec, plan, journaux) ?`)
              }}
            >
              Supprimer
            </button>
          ) : null}
        </div>
      ) : null}
      {ask ? (
        <ConfirmDialog
          question={ask}
          onYes={() => {
            const question = ask
            setAsk(null)
            if (question.startsWith('Supprimer')) void run('remove', `${base}/supprimer`)
            else void run('close', `${base}/fermer`)
          }}
          onNo={() => setAsk(null)}
        />
      ) : null}
    </header>
  )
}
