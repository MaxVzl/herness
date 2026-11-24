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
  /** `obsolete`: nothing is waiting on the gate anymore (e.g. `agent-stopped` of a task restarted by an amendment); not decidable. */
  status: z.enum(['pending', 'approved', 'refused', 'obsolete']),
  summary: z.string(),
  path: z.string().optional(),
  /** `amendment` gate: sha256 of the proposal at request time (`proposalHash`). */
  hash: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
})
export type Gate = z.infer<typeof GateSchema>

/**
 * Brief sent to an agent whose issue is not handled yet; saved before sending so a restarted
 * engine waits for the agent instead of sending the brief again. `fromSha`: head before sending (implementer);
 * `out` and `head`: expected report and head read back (reviewer).
 */
export const PendingAskSchema = z.object({
  agent: z.string(),
  file: z.string(),
  fromSha: z.string().optional(),
  out: z.string().optional(),
  head: z.string().optional(),
  /** Implementer: its report and the size at send time; the brief is finished only once the report has grown. */
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
  /** Who fixes the current round (decided by `nextTaskPhase`). */
  fixer: z.enum(['same', 'strong']).optional(),
  /** Open `agent-blocked` gate for an agent of this task, waiting for a decision. */
  blockedGate: z.string().optional(),
  /** Open `agent-stopped` gate: the implementer stopped without a commit and left a report. */
  stopGate: z.string().optional(),
  /** User decision on this gate, to pass on in the next fixes file. */
  stopDecision: z.string().optional(),
  /** Report size when the last implementation brief was sent: did a stop without a commit complete it? */
  reportSize: z.number().int().optional(),
  /** Last review report (absolute path), source of the remarks for the next round. */
  lastReview: z.string().optional(),
  /** Brief in progress (see `PendingAskSchema`). */
  pendingAsk: PendingAskSchema.optional(),
})
export type TaskState = z.infer<typeof TaskStateSchema>

export const PreflightResultSchema = z.object({
  label: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number(),
  logPath: z.string(),
  /** Accepted red: ignored false positive, or also red on main with the PR approved anyway. */
  note: z.string().optional(),
})
export type PreflightResult = z.infer<typeof PreflightResultSchema>

/** Global review (step 8). `phase` absent: first review of the branch by `rg<id>`. */
export const GlobalReviewStateSchema = z.object({
  round: z.number().int(),
  phase: z.enum(['rereview', 'fix', 'control', 'test']).optional(),
  /** Last head reviewed by `rg<id>` (also used by preflight re-reviews). */
  reviewedSha: z.string().optional(),
  lastReview: z.string().optional(),
  lastFailure: z.string().optional(),
  fixer: z.enum(['new', 'strong']).optional(),
  /** Head before the correction of the current round (commit check). */
  fixBase: z.string().optional(),
  pendingAsk: PendingAskSchema.optional(),
  blockedGate: z.string().optional(),
  /** Open `agent-stopped` gate: the implementer stopped without a commit and left a report. */
  stopGate: z.string().optional(),
  /** User decision on this gate, to pass on in the next fixes file. */
  stopDecision: z.string().optional(),
  /** Report size when the last implementation brief was sent: did a stop without a commit complete it? */
  reportSize: z.number().int().optional(),
})
export type GlobalReviewState = z.infer<typeof GlobalReviewStateSchema>

/** Preflight (step 9). `phase` absent: checks run in sequence; `results` = checks passed in the current pass. */
export const PreflightStateSchema = z.object({
  round: z.number().int(),
  results: z.array(PreflightResultSchema),
  /** Checks also red on main, PR approved anyway (`pr-despite-main` gate): to cite in the PR. */
  acceptedRed: z.array(z.string()).default([]),
  phase: z.enum(['diagnose', 'proof', 'gate', 'fix', 'control', 'rereview']).optional(),
  /** Head validated by the last full preflight pass: the PR starts only from this head. */
  validatedSha: z.string().optional(),
  /** `origin/main` fetched for this pass (before the first check). */
  fetched: z.boolean().optional(),
  /** Indexes of false positives already applied to the current check (once each). */
  used: z.array(z.number().int()).default([]),
  /** Red check currently being diagnosed. */
  failing: PreflightResultSchema.extend({ tail: z.string() }).optional(),
  /** Number of diagnostics started (reviewer name `rd<id>-<n>`). */
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
  /** Open `agent-stopped` gate: the implementer stopped without a commit and left a report. */
  stopGate: z.string().optional(),
  /** User decision on this gate, to pass on in the next fixes file. */
  stopDecision: z.string().optional(),
  /** Report size when the last implementation brief was sent: did a stop without a commit complete it? */
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
    /** Automatic rebases of the PR step (followed by a preflight): only one is allowed, resuming resets it. */
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
    /** Opening prompt sent (absent = false); recorded by the engine on the `orchestrator-started` message. */
    started: z.boolean().optional(),
  }),
  prUrl: z.string().optional(),
  testDbUp: z.boolean().optional(),
  /** `<id>-main` test database of the proof on main, started and not removed yet. */
  proofDbUp: z.boolean().default(false),
  /** Generation of the global-review / preflight loops: +1 on every reset (fresh agents and directories). */
  loopGeneration: z.number().int().default(1),
  paused: z.boolean().default(false),
  /** Approved `amendment` gates already handled (applied or set aside). */
  appliedAmendments: z.array(z.string()).default([]),
  /** `arbitration` gates whose note is already included in a fixes file. */
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

// Compatibility: French values written by herness 0.8.
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
