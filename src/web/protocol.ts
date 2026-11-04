import type { ChatItem } from './transcript.ts'

export type { ChatItem }

export type Badge = 'attend-reponse' | 'attend-herdr'

/** Libellés du preflight, pas les commandes. */
export interface ProjectView {
  name: string
  repoPath: string
  preflight: string[]
}

export interface MissionSummary {
  id: string
  project: string
  title: string
  status: string
  bucket: 'decision' | 'bloquee' | 'active' | 'terminee'
  badge?: Badge
  hidden: boolean
  createdAt: string
  step: string
}

export type DocView =
  | { source: 'proposition'; text: string; current: string | null }
  | { source: 'worktree' | 'approuve'; text: string }
  | { source: 'absent'; reason: string }

export interface AgentView {
  name: string
  role: string
  tool: 'Claude' | 'Cursor'
  task?: number
  state: string | null
  lastActivityAt?: string
  tail: string
}

export interface CheckView {
  file: string
  label: string
  status: 'en-cours' | 'vert' | 'rouge'
  startedAt: string
  durationMs: number
  lastOutputAt: string
  errorTail?: string
}

export interface MissionDetail {
  /** MissionState sérialisé ; la page le type par `import type` de src/mission/state.ts. */
  state: unknown
  badge?: Badge
  orchestrator: { state: string | null }
  /** 'taches/1', 'global', 'preflight' → noms de fichiers présents. */
  files: Record<string, string[]>
}

export type ServerEvent =
  | { type: 'missions'; missions: MissionSummary[]; hiddenCount: number; projects: ProjectView[] }
  | { type: 'mission'; id: string; detail: MissionDetail }
  /** `from` est l'index du premier élément ajouté ou modifié. Absent ou 0 : liste complète. */
  | { type: 'chat'; id: string; from?: number; items: ChatItem[] }
  | { type: 'doc'; id: string; kind: 'spec' | 'plan'; doc: DocView }
  | { type: 'agents'; id: string; agents: AgentView[] }
  | { type: 'checks'; id: string; checks: CheckView[] }
  | { type: 'notification'; key: string; missionId: string; title: string; body: string }
  | { type: 'confirmation'; confirmId: string; missionId: string; question: string }

export interface ActionResponse {
  ok: boolean
  lines: string[]
  id?: string
}
