import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { missionDir } from '../paths.ts'

/** On-disk state format. Absent means a mission written by herness 0.8 or earlier. */
export const STATE_FORMAT = 2

export const StepSchema = z.enum([
  'env', 'prepare', 'classify', 'brainstorm', 'spec', 'plan', 'tasks',
  'global-review', 'preflight', 'pr', 'pr-open', 'closed', 'blocked',
])
export type Step = z.infer<typeof StepSchema>

export const GateKindSchema = z.enum([
  'spec', 'plan', 'amendment', 'arbitration', 'pr-despite-main', 'agent-blocked', 'agent-stopped', 'resume-blocked', 'abandon',
])
export type GateKind = z.infer<typeof GateKindSchema>

export const GateSchema = z.object({
  id: z.string(),
  kind: GateKindSchema,
  /** `obsolete` : plus rien n'attend la porte (ex. `agent-stopped` d'une tâche reprise par un amendement) ; non décidable. */
  status: z.enum(['pending', 'approved', 'refused', 'obsolete']),
  summary: z.string(),
  path: z.string().optional(),
  /** Porte `amendment` : sha256 de la proposition au moment de la demande (`proposalHash`). */
  hash: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
})
export type Gate = z.infer<typeof GateSchema>

/**
 * Consigne envoyée à un agent dont l'issue n'est pas encore traitée ; enregistrée avant l'envoi pour qu'un
 * moteur redémarré attende l'agent au lieu de renvoyer la consigne. `fromSha` : tête avant l'envoi (implémenteur) ;
 * `out` et `head` : rapport attendu et tête relue (relecteur).
 */
export const PendingAskSchema = z.object({
  agent: z.string(),
  file: z.string(),
  fromSha: z.string().optional(),
  out: z.string().optional(),
  head: z.string().optional(),
  /** Implémenteur : son compte rendu et sa taille à l'envoi ; la consigne n'est finie qu'une fois qu'il a grossi. */
  report: z.object({ path: z.string(), size: z.number() }).optional(),
})
export type PendingAsk = z.infer<typeof PendingAskSchema>

export const TaskStateSchema = z.object({
  n: z.number().int(),
  title: z.string(),
  testCommand: z.string(),
  phase: z.enum(['pending', 'implement', 'control', 'test', 'review', 'fix', 'done']),
  round: z.number().int(),
  baseSha: z.string().optional(),
  reviewedSha: z.string().optional(),
  implementer: z.string().optional(),
  reviewer: z.string().optional(),
  lastFailure: z.string().optional(),
  /** Qui corrige le tour en cours (décidé par `nextTaskPhase`). */
  fixer: z.enum(['same', 'strong']).optional(),
  /** Porte `agent-blocked` ouverte pour un agent de cette tâche, en attente de décision. */
  blockedGate: z.string().optional(),
  /** Porte `agent-stopped` ouverte : l'implémenteur s'est arrêté sans commit en laissant un compte rendu. */
  stopGate: z.string().optional(),
  /** Décision de l'utilisateur sur cette porte, à transmettre dans le prochain fichier de correctifs. */
  stopDecision: z.string().optional(),
  /** Taille du compte rendu à l'envoi de la dernière consigne d'implémentation : un arrêt sans commit l'a-t-il complété ? */
  reportSize: z.number().int().optional(),
  /** Dernier rapport de revue (chemin absolu), source des remarques du tour suivant. */
  lastReview: z.string().optional(),
  /** Consigne en cours (voir `PendingAskSchema`). */
  pendingAsk: PendingAskSchema.optional(),
})
export type TaskState = z.infer<typeof TaskStateSchema>

export const PreflightResultSchema = z.object({
  label: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number(),
  logPath: z.string(),
  /** Rouge accepté : faux positif ignoré, ou rouge aussi sur main avec la PR validée malgré tout. */
  note: z.string().optional(),
})
export type PreflightResult = z.infer<typeof PreflightResultSchema>

/** Revue globale (étape 8). `phase` absente : première revue de la branche par `rg<id>`. */
export const GlobalReviewStateSchema = z.object({
  round: z.number().int(),
  phase: z.enum(['rereview', 'fix', 'control', 'test']).optional(),
  /** Dernière tête relue par `rg<id>` (sert aussi aux re-revues du preflight). */
  reviewedSha: z.string().optional(),
  lastReview: z.string().optional(),
  lastFailure: z.string().optional(),
  fixer: z.enum(['new', 'strong']).optional(),
  /** Tête avant la correction du tour en cours (contrôle des commits). */
  fixBase: z.string().optional(),
  pendingAsk: PendingAskSchema.optional(),
  blockedGate: z.string().optional(),
  /** Porte `agent-stopped` ouverte : l'implémenteur s'est arrêté sans commit en laissant un compte rendu. */
  stopGate: z.string().optional(),
  /** Décision de l'utilisateur sur cette porte, à transmettre dans le prochain fichier de correctifs. */
  stopDecision: z.string().optional(),
  /** Taille du compte rendu à l'envoi de la dernière consigne d'implémentation : un arrêt sans commit l'a-t-il complété ? */
  reportSize: z.number().int().optional(),
})
export type GlobalReviewState = z.infer<typeof GlobalReviewStateSchema>

/** Preflight (étape 9). `phase` absente : les checks s'enchaînent ; `results` = checks passés du passage en cours. */
export const PreflightStateSchema = z.object({
  round: z.number().int(),
  results: z.array(PreflightResultSchema),
  /** Checks rouges aussi sur main, PR validée malgré tout (porte `pr-despite-main`) : à citer dans la PR. */
  acceptedRed: z.array(z.string()).default([]),
  phase: z.enum(['diagnose', 'proof', 'gate', 'fix', 'control', 'rereview']).optional(),
  /** Tête validée par le dernier passage complet du preflight : la PR ne part que de cette tête. */
  validatedSha: z.string().optional(),
  /** `origin/main` récupéré pour ce passage (avant le premier check). */
  fetched: z.boolean().optional(),
  /** Index des faux positifs déjà appliqués au check en cours (une fois chacun). */
  used: z.array(z.number().int()).default([]),
  /** Check rouge en cours de diagnostic. */
  failing: PreflightResultSchema.extend({ tail: z.string() }).optional(),
  /** Nombre de diagnostics lancés (nom du relecteur `rd<id>-<n>`). */
  diag: z.number().int().default(0),
  diagnosis: z.string().optional(),
  gate: z.string().optional(),
  fixer: z.enum(['new', 'strong']).optional(),
  fixBase: z.string().optional(),
  fixFindings: z.string().optional(),
  fixFailure: z.string().optional(),
  lastReview: z.string().optional(),
  pendingAsk: PendingAskSchema.optional(),
  blockedGate: z.string().optional(),
  /** Porte `agent-stopped` ouverte : l'implémenteur s'est arrêté sans commit en laissant un compte rendu. */
  stopGate: z.string().optional(),
  /** Décision de l'utilisateur sur cette porte, à transmettre dans le prochain fichier de correctifs. */
  stopDecision: z.string().optional(),
  /** Taille du compte rendu à l'envoi de la dernière consigne d'implémentation : un arrêt sans commit l'a-t-il complété ? */
  reportSize: z.number().int().optional(),
})
export type PreflightState = z.infer<typeof PreflightStateSchema>

export function freshLoops(): { globalReview: GlobalReviewState; preflight: PreflightState; prRebases: number } {
  return { globalReview: { round: 0 }, preflight: { round: 0, results: [], acceptedRed: [], used: [], diag: 0 }, prRebases: 0 }
}

export const MissionStateSchema = z.object({
  format: z.literal(STATE_FORMAT).optional(),
  id: z.string(),
  source: z.object({ kind: z.enum(['wrike', 'github', 'text']), ref: z.string() }),
  project: z.string(),
  repoPath: z.string(),
  createdAt: z.string(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  type: z.string().optional(),
  slug: z.string().optional(),
  step: StepSchema,
  blockedReason: z.string().optional(),
  blockedFrom: StepSchema.optional(),
  tasks: z.array(TaskStateSchema),
  gates: z.array(GateSchema),
  loops: z.object({
    globalReview: GlobalReviewStateSchema,
    preflight: PreflightStateSchema,
    /** Rebases automatiques de l'étape PR (suivis d'un preflight) : un seul permis, la reprise le remet à zéro. */
    prRebases: z.number().int().default(0),
  }),
  herdr: z.object({
    workspace: z.string().optional(),
    tabs: z.record(z.string(), z.string()),
    panes: z.record(z.string(), z.string()),
  }),
  orchestrator: z.object({
    agent: z.string().optional(),
    sessionId: z.string().optional(),
    /** Prompt d'ouverture envoyé (absent = faux) ; enregistré par le moteur sur le message `orchestrator-started`. */
    started: z.boolean().optional(),
  }),
  prUrl: z.string().optional(),
  testDbUp: z.boolean().optional(),
  /** Base de test `<id>-main` de la preuve sur main, lancée et pas encore supprimée. */
  proofDbUp: z.boolean().default(false),
  /** Génération des boucles revue globale / preflight : +1 à chaque remise à zéro (agents et dossiers neufs). */
  loopGeneration: z.number().int().default(1),
  paused: z.boolean().default(false),
  /** Portes `amendment` approuvées déjà traitées (appliquées ou écartées). */
  appliedAmendments: z.array(z.string()).default([]),
  /** Portes `arbitration` dont la note est déjà entrée dans un fichier de correctifs. */
  consumedArbitrages: z.array(z.string()).default([]),
  log: z.array(z.object({ at: z.string(), msg: z.string() })),
})
export type MissionState = z.infer<typeof MissionStateSchema>

export function newState(
  init: Pick<MissionState, 'id' | 'source' | 'project' | 'repoPath'>,
): MissionState {
  return {
    ...init,
    format: STATE_FORMAT,
    createdAt: new Date().toISOString(),
    step: 'env',
    tasks: [],
    gates: [],
    loops: freshLoops(),
    herdr: { tabs: {}, panes: {} },
    orchestrator: {},
    paused: false,
    proofDbUp: false,
    loopGeneration: 1,
    appliedAmendments: [],
    consumedArbitrages: [],
    log: [],
  }
}

function stateFile(id: string): string {
  return join(missionDir(id), 'state.json')
}

const LEGACY_STEPS: Record<string, string> = {
  'pr-ouverte': 'pr-open',
  'fermée': 'closed',
  'bloquée': 'blocked',
}

const LEGACY_KINDS: Record<string, string> = {
  amendement: 'amendment',
  arbitrage: 'arbitration',
  'pr-malgre-main': 'pr-despite-main',
  'agent-bloque': 'agent-blocked',
  'agent-arret': 'agent-stopped',
  'reprise-bloquee': 'resume-blocked',
}

const LEGACY_STATUSES: Record<string, string> = {
  caduque: 'obsolete',
}

function fromLegacy(value: unknown, table: Record<string, string>): unknown {
  if (typeof value !== 'string') return value
  return table[value] ?? value
}

/** Translates French state values written before `format` existed. A value already in English, or unknown, is kept. */
export function migrateLegacy(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  if ('format' in raw) return raw
  const copy = structuredClone(raw) as Record<string, unknown>
  if ('step' in copy) copy.step = fromLegacy(copy.step, LEGACY_STEPS)
  if ('blockedFrom' in copy) copy.blockedFrom = fromLegacy(copy.blockedFrom, LEGACY_STEPS)
  if (Array.isArray(copy.gates)) {
    copy.gates = copy.gates.map((gate) => {
      if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) return gate
      const next = { ...(gate as Record<string, unknown>) }
      if ('kind' in next) next.kind = fromLegacy(next.kind, LEGACY_KINDS)
      if ('status' in next) next.status = fromLegacy(next.status, LEGACY_STATUSES)
      return next
    })
  }
  return copy
}

export function isLegacy(s: MissionState): boolean {
  return s.format !== STATE_FORMAT
}

export function isFinished(s: MissionState): boolean {
  return s.step === 'pr-open' || s.step === 'closed'
}

export class LegacyMissionError extends Error {}

export function assertResumable(s: MissionState): void {
  if (isLegacy(s) && !isFinished(s)) {
    throw new LegacyMissionError(
      `mission ${s.id} was created by herness 0.8 or earlier and is still running: finish it with that version (herness update --version 0.8.1) or close it (herness close ${s.id})`,
    )
  }
}

export async function loadState(id: string): Promise<MissionState> {
  const raw = await readFile(stateFile(id), 'utf8')
  return MissionStateSchema.parse(migrateLegacy(JSON.parse(raw)))
}

export async function saveState(s: MissionState): Promise<void> {
  s.format = STATE_FORMAT
  MissionStateSchema.parse(s)
  const file = stateFile(s.id)
  await mkdir(missionDir(s.id), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n')
  await rename(tmp, file)
}
