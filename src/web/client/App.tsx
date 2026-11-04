import { useEffect, useState } from 'react'
import type { ActionResponse } from '../protocol.ts'
import { ActionBanner } from './ActionBanner.tsx'
import { post } from './api.ts'
import { ConnectionBanner } from './ConnectionBanner.tsx'
import { ConfirmDialog } from './Dialogs.tsx'
import { MissionHeader } from './MissionHeader.tsx'
import { MissionList } from './MissionList.tsx'
import { NewMissionForm } from './NewMissionForm.tsx'
import { useServerEvents } from './store.ts'

function browser() {
  return globalThis as unknown as {
    location: { hash: string }
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  }
}

function missionFromHash(): string | undefined {
  let hash = ''
  try {
    hash = browser().location.hash
  } catch {
    return undefined
  }
  if (!hash.startsWith('#/')) return undefined
  try {
    const id = decodeURIComponent(hash.slice(2))
    return id || undefined
  } catch {
    return undefined
  }
}

function readProject(): string {
  try {
    return localStorage.getItem('herness.projet') ?? ''
  } catch {
    return ''
  }
}

export function App({ source }: { source?: (url: string) => EventSource } = {}) {
  const [selected, setSelected] = useState(missionFromHash)
  const [creating, setCreating] = useState(false)
  const [defaultProject, setDefaultProject] = useState('')
  const [result, setResult] = useState<ActionResponse | null>(null)
  const [answered, setAnswered] = useState<string[]>([])
  useEffect(() => {
    const onHash = () => setSelected(missionFromHash())
    const root = browser()
    root.addEventListener('hashchange', onHash)
    return () => root.removeEventListener('hashchange', onHash)
  }, [])

  const select = (id: string) => {
    setSelected(id)
    const next = `#/${encodeURIComponent(id)}`
    try {
      if (browser().location.hash !== next) browser().location.hash = next
    } catch {
      // l'adresse ne peut pas être écrite : la sélection reste en mémoire
    }
  }

  const state = useServerEvents({ mission: selected, agents: false }, source)
  const summary = state.missions.find((item) => item.id === selected)
  const missionDetail = selected ? state.details[selected] : undefined
  const pending = selected
    ? state.confirmations.find((item) => item.missionId === selected && !answered.includes(item.confirmId))
    : undefined

  function reply(confirmId: string, oui: boolean) {
    setAnswered((ids) => ids.includes(confirmId) ? ids : [...ids, confirmId])
    void post(`/api/confirmations/${encodeURIComponent(confirmId)}`, { oui })
  }

  return (
    <div className="shell">
      <section className="missions">
        <ConnectionBanner connected={state.connected} />
        <MissionList
          state={state}
          selected={selected}
          onSelect={(id) => {
            setCreating(false)
            select(id)
          }}
          onNew={() => {
            setDefaultProject(readProject())
            setCreating(true)
          }}
        />
      </section>
      <section className="conversation">
        {creating ? (
          <NewMissionForm
            projects={state.projects}
            defaultProject={defaultProject}
            onStarted={(id) => {
              setCreating(false)
              select(id)
            }}
            onCancel={() => setCreating(false)}
          />
        ) : summary && missionDetail ? (
          <MissionHeader summary={summary} detail={missionDetail} onResult={setResult} />
        ) : null}
        <ActionBanner result={result} />
        {pending ? (
          <ConfirmDialog
            question={pending.question}
            onYes={() => reply(pending.confirmId, true)}
            onNo={() => reply(pending.confirmId, false)}
          />
        ) : null}
      </section>
      <section className="contexte" />
    </div>
  )
}
