import { useCallback, useEffect, useRef, useState } from 'react'
import type { Gate } from '../../mission/state.ts'
import type { ActionResponse, ChatItem } from '../protocol.ts'
import { ActionBanner } from './ActionBanner.tsx'
import { post } from './api.ts'
import { Chat } from './Chat.tsx'
import { ConnectionBanner } from './ConnectionBanner.tsx'
import { ConfirmDialog } from './Dialogs.tsx'
import { GateCards } from './GateCards.tsx'
import { MissionHeader } from './MissionHeader.tsx'
import { MissionList } from './MissionList.tsx'
import { NewMissionForm } from './NewMissionForm.tsx'
import { SidePanel, type Onglet } from './SidePanel.tsx'
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

const emptyChat: ChatItem[] = []

function gatesOf(state: unknown): Gate[] {
  if (!state || typeof state !== 'object' || !('gates' in state)) return []
  const gates = (state as { gates?: unknown }).gates
  return Array.isArray(gates) ? gates as Gate[] : []
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
  const [ongletActif, setOngletActif] = useState<Onglet | ''>('')
  const [demande, setDemande] = useState<{ tab: 'spec' | 'plan'; seq: number } | null>(null)
  const [colonne, setColonne] = useState(360)
  const [tiroir, setTiroir] = useState(() => {
    try {
      return window.innerWidth < 1100
    } catch {
      return false
    }
  })
  const demandeSeq = useRef(0)
  const choisirOnglet = useCallback((tab: Onglet) => setOngletActif(tab), [])
  const ouvrirDoc = useCallback((tab: 'spec' | 'plan') => {
    demandeSeq.current += 1
    setDemande({ tab, seq: demandeSeq.current })
  }, [])
  const reglerColonne = useCallback((layout: { width: number; drawer: boolean }) => {
    setColonne((largeur) => largeur === layout.width ? largeur : layout.width)
    setTiroir((ouvert) => ouvert === layout.drawer ? ouvert : layout.drawer)
  }, [])
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
    void post(`/api/confirmations/${encodeURIComponent(confirmId)}`, { oui }).then((response) => {
      if (response.ok) {
        if (response.lines.length > 0) setResult(response)
        return
      }
      setResult(response)
      // Seul un échec de transport peut être retenté : le serveur attend encore.
      // Une confirmation inconnue ou expirée le resterait, et le dialogue ne se fermerait plus.
      if (response.lines.length === 1 && response.lines[0] === 'serveur injoignable') {
        setAnswered((ids) => ids.filter((id) => id !== confirmId))
      }
    })
  }

  return (
    <div className="shell" style={{ gridTemplateColumns: tiroir ? '230px 1fr 0px' : `230px 1fr ${colonne}px` }}>
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
        {!creating && summary && missionDetail ? (
          <div className="conversation-corps" key={summary.id}>
            <Chat
              missionId={summary.id}
              items={state.chats[summary.id] ?? emptyChat}
              orchestratorState={missionDetail.orchestrator.state}
              onOpenHerdr={() => {
                void post(`/api/missions/${encodeURIComponent(summary.id)}/ouvrir`).then(setResult)
              }}
              onResult={setResult}
            />
            <GateCards
              missionId={summary.id}
              gates={gatesOf(missionDetail.state)}
              onOpenDoc={ouvrirDoc}
              onResult={setResult}
            />
          </div>
        ) : null}
      </section>
      <section className="contexte" data-onglet={ongletActif}>
        {!creating && summary && missionDetail && selected ? (
          <SidePanel
            missionId={selected}
            state={missionDetail}
            spec={state.docs[selected]?.spec}
            plan={state.docs[selected]?.plan}
            ouvert={demande}
            onTab={choisirOnglet}
            onLayout={reglerColonne}
          />
        ) : null}
      </section>
    </div>
  )
}
