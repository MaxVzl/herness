import { useEffect, useRef, useState } from 'react'
import type { Gate, MissionState } from '../../mission/state.ts'
import type { AgentView, CheckView, DocView, MissionDetail } from '../protocol.ts'
import { agentAmbre, AgentsTab } from './AgentsTab.tsx'
import { checkRecentRouge, ChecksTab } from './ChecksTab.tsx'
import { DocTab } from './DocTab.tsx'
import { JournalTab } from './JournalTab.tsx'
import { TasksTab } from './TasksTab.tsx'

export type Onglet = 'taches' | 'spec' | 'plan' | 'agents' | 'checks' | 'journal'

const onglets: { id: Onglet; label: string }[] = [
  { id: 'taches', label: 'Tâches' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'agents', label: 'Agents' },
  { id: 'checks', label: 'Checks' },
  { id: 'journal', label: 'Journal' },
]

const MIN = 280
const MAX = 600
const DEFAUT = 360

function largeurEcran(): number {
  try {
    return window.innerWidth
  } catch {
    return 1400
  }
}

function ongletMemorise(): Onglet {
  try {
    const value = localStorage.getItem('herness.onglet')
    if (onglets.some((onglet) => onglet.id === value)) return value as Onglet
  } catch {
    // stockage indisponible
  }
  return 'taches'
}

function missionDe(state: unknown): MissionState | null {
  if (!state || typeof state !== 'object' || !('tasks' in state) || !('loops' in state)) return null
  return state as MissionState
}

function gatesDe(state: unknown): Gate[] {
  if (!state || typeof state !== 'object' || !('gates' in state)) return []
  const gates = (state as { gates?: unknown }).gates
  return Array.isArray(gates) ? gates as Gate[] : []
}

function resultatsDe(state: unknown): { label: string; exitCode: number; durationMs: number }[] {
  if (!state || typeof state !== 'object' || !('loops' in state)) return []
  const loops = (state as { loops?: { preflight?: { results?: unknown } } }).loops
  const results = loops?.preflight?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as { label?: unknown; exitCode?: unknown; durationMs?: unknown }
    if (typeof row.label !== 'string' || typeof row.exitCode !== 'number' || typeof row.durationMs !== 'number') return []
    return [{ label: row.label, exitCode: row.exitCode, durationMs: row.durationMs }]
  })
}

export function SidePanel({ missionId, state, spec, plan, ouvert, onTab, onLayout, agents = [], checks = [], preflight = [] }: {
  missionId: string
  state: MissionDetail
  spec?: DocView
  plan?: DocView
  ouvert?: { tab: 'spec' | 'plan'; seq: number } | null
  onTab?: (tab: Onglet) => void
  onLayout?: (layout: { width: number; drawer: boolean }) => void
  agents?: AgentView[]
  checks?: CheckView[]
  preflight?: string[]
}) {
  const [tab, setTab] = useState<Onglet>(ongletMemorise)
  const [largeur, setLargeur] = useState(DEFAUT)
  const [etroit, setEtroit] = useState(() => largeurEcran() < 1100)
  const [tiroirOuvert, setTiroirOuvert] = useState(false)
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onTabRef = useRef(onTab)
  const onLayoutRef = useRef(onLayout)
  onTabRef.current = onTab
  onLayoutRef.current = onLayout

  useEffect(() => {
    if (!ouvert) return
    setTab(ouvert.tab)
    setTiroirOuvert(true)
  }, [ouvert])

  useEffect(() => {
    try {
      localStorage.setItem('herness.onglet', tab)
    } catch {
      // stockage indisponible
    }
    onTabRef.current?.(tab)
  }, [tab])

  useEffect(() => {
    const onResize = () => setEtroit(largeurEcran() < 1100)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    onLayoutRef.current?.({ width: largeur, drawer: etroit })
  }, [largeur, etroit])

  const mission = missionDe(state.state)
  const gates = gatesDe(state.state)
  const results = resultatsDe(state.state)
  const contenu = tab === 'taches' && mission
    ? <TasksTab key={missionId} missionId={missionId} mission={mission} files={state.files} />
    : tab === 'spec'
      ? <DocTab key="spec" doc={spec} />
      : tab === 'plan'
        ? <DocTab key="plan" doc={plan} />
        : tab === 'agents'
          ? <AgentsTab key="agents" missionId={missionId} agents={agents} gates={gates} />
          : tab === 'checks'
            ? <ChecksTab key="checks" missionId={missionId} checks={checks} preflight={preflight} results={results} />
            : tab === 'journal' && mission
              ? <JournalTab log={mission.log} />
              : null

  const corps = (
    <>
      <div role="tablist" aria-label="Contexte">
        {onglets.map((onglet) => {
          const agentEnAttente = gates.some((gate) => gate.kind === 'agent-bloque' && gate.status === 'pending')
          const point = (onglet.id === 'spec' && spec?.source === 'proposition')
            || (onglet.id === 'plan' && plan?.source === 'proposition')
            || (onglet.id === 'agents' && (agentEnAttente || agents.some((agent) => agentAmbre(agent, gates))))
            || (onglet.id === 'checks' && checkRecentRouge(checks))
          return (
            <button
              key={onglet.id}
              type="button"
              role="tab"
              aria-selected={tab === onglet.id}
              className={point ? 'onglet point' : 'onglet'}
              onClick={() => setTab(onglet.id)}
            >
              {onglet.label}
            </button>
          )
        })}
      </div>
      <div role="tabpanel">{contenu}</div>
    </>
  )

  if (etroit) {
    if (!tiroirOuvert) {
      return (
        <button type="button" className="contexte-ouvrir" onClick={() => setTiroirOuvert(true)}>Contexte</button>
      )
    }
    return (
      <div className="tiroir">
        <button type="button" onClick={() => setTiroirOuvert(false)}>Fermer</button>
        {corps}
      </div>
    )
  }

  return (
    <div className="panneau" style={{ width: largeur }}>
      <div
        className="poignee"
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionner"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, w: largeur }
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // le pointeur n'est pas capturable ici
          }
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          const next = Math.min(MAX, Math.max(MIN, drag.current.w + (drag.current.x - event.clientX)))
          setLargeur(next)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
      />
      <div className="panneau-corps">{corps}</div>
    </div>
  )
}
