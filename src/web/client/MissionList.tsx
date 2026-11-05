import { useState } from 'react'
import type { MissionSummary } from '../protocol.ts'
import { notificationPermission, requestNotificationPermission } from './notifications.ts'
import type { ClientState } from './store.ts'

const PROJECT_KEY = 'herness.projet'

function readProject(): string {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeProject(value: string) {
  try {
    if (value) localStorage.setItem(PROJECT_KEY, value)
    else localStorage.removeItem(PROJECT_KEY)
  } catch {
    // navigation privée ou stockage refusé : le filtre reste en mémoire
  }
}

function bucketClass(bucket: MissionSummary['bucket']): string | undefined {
  if (bucket === 'decision') return 'ambre'
  if (bucket === 'bloquee') return 'rouge'
  if (bucket === 'terminee') return 'grise'
  return undefined
}

function badgeLabel(badge: MissionSummary['badge']): string | undefined {
  if (badge === 'attend-reponse') return 'attend ta réponse'
  if (badge === 'attend-herdr') return 'attend dans herdr'
  return undefined
}

function NotifyButton() {
  const [perm, setPerm] = useState(notificationPermission)
  if (!perm || perm === 'granted') return null
  return (
    <button
      type="button"
      onClick={() => {
        void requestNotificationPermission()?.then((next) => setPerm(next))
      }}
    >
      Activer les notifications
    </button>
  )
}

export function MissionList({ state, selected, onSelect, onNew }: {
  state: ClientState
  selected?: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const [project, setProject] = useState(readProject)
  const [showHidden, setShowHidden] = useState(false)
  const label = project || 'tous'
  const hiddenHere = state.missions.filter((mission) => mission.hidden && (!project || mission.project === project)).length
  const rows = state.missions.filter((mission) => {
    if (project && mission.project !== project) return false
    if (!showHidden && mission.hidden) return false
    return true
  })

  return (
    <div className="mission-colonne">
      <header className="mission-entete">
        <select
          aria-label={`Projet : ${label} ▾`}
          value={project}
          onChange={(ev) => {
            const value = ev.target.value
            setProject(value)
            writeProject(value)
          }}
        >
          <option value="">tous</option>
          {state.projects.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <NotifyButton />
      </header>
      <ul className="mission-liste">
        {rows.map((mission) => {
          const badge = badgeLabel(mission.badge)
          return (
            <li key={mission.id} className={bucketClass(mission.bucket)}>
              <button
                type="button"
                className="mission-ligne"
                aria-current={selected === mission.id ? 'true' : undefined}
                onClick={() => onSelect(mission.id)}
              >
                <span className="mission-id">{mission.id}</span>
                <span className="mission-projet">{mission.project}</span>
                <span className="mission-titre">{mission.title}</span>
                <span className="mission-statut">{mission.status}</span>
                {badge ? <span className="mission-badge">{badge}</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {hiddenHere > 0 ? (
        <button type="button" className="masquees" onClick={() => setShowHidden((value) => !value)}>
          {showHidden ? 'masquer les missions terminées' : `${hiddenHere} missions terminées masquées · afficher`}
        </button>
      ) : null}
      <button type="button" className="nouvelle" onClick={onNew}>+ Nouvelle mission</button>
    </div>
  )
}
