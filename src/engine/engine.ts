import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fill, type ProjectConfig } from '../config/project.ts'
import { drainInbox, type InboxMessage } from '../mission/inbox.ts'
import { parsePlan } from '../mission/plan.ts'
import { loadState, saveState, type Gate, type GateKind, type MissionState, type Step } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { proposedPlanPath } from '../mission/amendment.ts'
import type { Effects } from './effects.ts'
import { checkEnv } from './envcheck.ts'
import { markDone } from '../herdr/layout.ts'
import { applyDecision, openGate } from './gates.ts'
import { stepGlobalReview, stepPr, stepPreflight } from './finish.ts'
import { amendmentWouldResume, applyAmendment, applyPendingAmendment, stepTasks, taskDir, unblocksMission } from './tasks.ts'

export type StepResult = 'continue' | 'wait' | 'stop'
/** Une étape lit et modifie l'état en mémoire ; le moteur l'enregistre après chaque appel. */
export type StepFn = (s: MissionState, e: Effects, cfg: ProjectConfig) => Promise<StepResult>

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** Worktree détaché temporaire de la preuve sur main. */
export const proofWorktree = (id: string): string => join(missionDir(id), 'preuve-main')
const fileExists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

export function log(s: MissionState, e: Effects, msg: string): void {
  s.log.push({ at: e.now().toISOString(), msg })
}

/** Message du moteur à la session orchestrateur, sans attente ; ne lève jamais. */
export async function informOrchestrator(s: MissionState, e: Effects, text: string): Promise<void> {
  const agent = s.orchestrator.agent
  if (!agent) return
  try {
    await e.herdr.agentPrompt(agent, `[herness] ${text}`, { wait: false })
  } catch (err) {
    log(s, e, `message à l'orchestrateur non remis : ${errMsg(err)}`)
  }
}

export async function notify(s: MissionState, e: Effects, body: string): Promise<void> {
  try {
    await e.herdr.notify(`herness ${s.id}`, body, 'request')
  } catch (err) {
    log(s, e, `notification non affichée : ${errMsg(err)}`)
  }
}

/** Passe la mission en `bloquée`, prévient l'utilisateur et l'orchestrateur. */
export async function block(s: MissionState, e: Effects, reason: string): Promise<StepResult> {
  if (s.step !== 'bloquée') s.blockedFrom = s.step
  s.step = 'bloquée'
  s.blockedReason = reason
  log(s, e, `mission bloquée : ${reason}`)
  await notify(s, e, `Mission bloquée : ${reason.split('\n')[0]}`)
  await informOrchestrator(s, e, `Mission bloquée : ${reason}`)
  return 'continue'
}

async function dbDown(s: MissionState, e: Effects, cfg: ProjectConfig, flag: 'testDbUp' | 'proofDbUp', id: string, worktree: string): Promise<string | null> {
  if (!s[flag] || !cfg.testDb) return null
  const cwd = s.worktree ?? s.repoPath
  // `{worktree}` : le worktree dont le .env pointe sur cette base (celui de la mission, ou celui de la preuve).
  const [cmd, ...args] = fill(cfg.testDb.down, { id, worktree })
  if (!cmd) return null
  let error: string
  try {
    const r = await e.run(cmd, args, { cwd, reject: false })
    if (r.exitCode === 0) {
      s[flag] = false
      return null
    }
    error = `code ${r.exitCode} : ${(r.stderr || r.stdout).trim()}`
  } catch (err) {
    error = errMsg(err)
  }
  log(s, e, `arrêt de la base de test ${id} en échec (${error})`)
  return error
}

/** Arrête la base de test de la mission si elle tourne ; ne lève jamais. Rend l'erreur, ou null si la base est arrêtée. */
export function testDbDown(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<string | null> {
  return dbDown(s, e, cfg, 'testDbUp', s.id, s.worktree ?? s.repoPath)
}

/** Arrête la base `<id>-main` d'une preuve sur main restée en place ; ne lève jamais. */
export function proofDbDown(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<string | null> {
  return dbDown(s, e, cfg, 'proofDbUp', `${s.id}-main`, proofWorktree(s.id))
}

/** Bloque la mission parce qu'une base de test n'a pas pu être supprimée (`testDbUp`/`proofDbUp` restent vrais). */
export async function blockDbNotDown(s: MissionState, e: Effects, id: string, error: string): Promise<StepResult> {
  const previous = s.step === 'bloquée' && s.blockedReason ? `\n(blocage précédent : ${s.blockedReason})` : ''
  return block(s, e, `base de test ${id} non supprimée : ${error}${previous}`)
}

export function latestGate(s: MissionState, kind: GateKind): Gate | undefined {
  return s.gates.filter((g) => g.kind === kind).at(-1)
}

export function goto(s: MissionState, e: Effects, step: Step): StepResult {
  log(s, e, `étape ${s.step} → ${step}`)
  s.step = step
  return 'continue'
}

/**
 * Commit idempotent : un fichier déjà commité (par un agent ou avant un redémarrage) n'est pas recommité. Rend
 * `missing` si un fichier est absent du worktree (rien n'est commité), `clean` si tout est déjà commité.
 */
export async function commitIfChanged(
  s: MissionState,
  e: Effects,
  rels: string | string[],
  message: string,
  what: string,
): Promise<'committed' | 'clean' | 'missing'> {
  const wt = s.worktree as string
  const files = typeof rels === 'string' ? [rels] : rels
  const missing: string[] = []
  for (const rel of files) if (!(await fileExists(join(wt, rel)))) missing.push(rel)
  if (missing.length > 0) {
    log(s, e, `${what} : fichier absent du worktree, aucun commit : ${missing.map((m) => join(wt, m)).join(', ')}`)
    return 'missing'
  }
  const changed: string[] = []
  for (const rel of files) if (!(await e.git.isClean(wt, rel))) changed.push(rel)
  if (changed.length === 0) {
    log(s, e, `${what} déjà commitée, aucun commit : ${files.join(', ')}`)
    return 'clean'
  }
  await e.git.commitFiles(wt, changed, message)
  return 'committed'
}

const stepEnv: StepFn = async (s, e) => {
  const res = await checkEnv(s.repoPath, e)
  const kos = res.filter((r) => r.status === 'KO')
  if (kos.length === 0) return goto(s, e, 'prepare')
  return block(s, e, `environnement incomplet :\n${kos.map((k) => `- ${k.label} : ${k.detail}`).join('\n')}`)
}

const stepPrepare: StepFn = async (s, e, cfg) => {
  const tab = s.herdr.tabs['process']
  if (!s.worktree || !tab) return block(s, e, 'préparation impossible : worktree ou onglet process inconnu')
  const r = await e.runInPane(e.herdr, tab, s.worktree, 'préparation', fill(cfg.prepare, { worktree: s.worktree, id: s.id }), join(missionDir(s.id), 'logs'))
  if (r.exitCode === 0) return goto(s, e, 'classify')
  return block(s, e, `préparation du worktree en échec (code ${r.exitCode}), journal : ${r.logPath}\n${r.tail}`)
}

const stepClassify: StepFn = async (s, e, cfg) => {
  if (!s.type || !s.slug) return 'wait'
  if (!s.worktree) return block(s, e, 'renommage de la branche impossible : worktree inconnu')
  const target = `${cfg.branchPrefixes[s.type]}/${s.id}-${s.slug}`
  // Reprise : le renommage a pu être fait avant un arrêt du moteur, sans être enregistré.
  if ((await e.git.currentBranch(s.worktree)) === target) {
    log(s, e, `branche déjà nommée ${target}`)
  } else {
    await e.git.renameBranch(s.worktree, `herness/${s.id}`, target)
    log(s, e, `branche renommée en ${target}`)
  }
  s.branch = target
  return goto(s, e, 'brainstorm')
}

const stepBrainstorm: StepFn = async (s, e) => {
  const g = latestGate(s, 'spec')
  return g && g.status !== 'refused' ? goto(s, e, 'spec') : 'wait'
}

const stepSpec: StepFn = async (s, e) => {
  const g = latestGate(s, 'spec')
  if (!g || g.status === 'refused') return goto(s, e, 'brainstorm')
  if (g.status === 'pending') return 'wait'
  if (!s.worktree) return block(s, e, 'commit de la spec impossible : worktree inconnu')
  const r = await commitIfChanged(s, e, specPath(s), `docs(${s.id}): spec ${s.slug}`, 'spec')
  if (r === 'missing') return block(s, e, `spec validée mais absente du worktree : ${join(s.worktree, specPath(s))}`)
  return goto(s, e, 'plan')
}

const stepPlan: StepFn = async (s, e) => {
  const g = latestGate(s, 'plan')
  if (!g || g.status !== 'approved') return 'wait'
  if (!s.worktree) return block(s, e, 'lecture du plan impossible : worktree inconnu')
  const rel = planPath(s)
  let md: string
  try {
    md = await readFile(join(s.worktree, rel), 'utf8')
  } catch {
    return block(s, e, `plan validé mais absent du worktree : ${join(s.worktree, rel)}`)
  }
  const parsed = parsePlan(md)
  if (!parsed.ok) return block(s, e, `plan approuvé invalide (${rel}) :\n- ${parsed.errors.join('\n- ')}`)
  await mkdir(missionDir(s.id), { recursive: true })
  await writeFile(join(missionDir(s.id), 'plan.approved.md'), md)
  s.tasks = parsed.tasks.map((t) => ({ n: t.n, title: t.title, testCommand: t.testCommand, phase: 'pending', round: 0 }))
  if ((await commitIfChanged(s, e, rel, `docs(${s.id}): plan ${s.slug}`, 'plan')) === 'missing') {
    return block(s, e, `plan validé mais absent du worktree : ${join(s.worktree, rel)}`)
  }
  return goto(s, e, 'tasks')
}

const waiting: StepFn = async () => 'wait'
const stopped: StepFn = async () => 'stop'

/** Après les tâches, un amendement approuvé s'applique avant l'étape et peut ramener la mission à `tasks`. */
const afterAmendment =
  (next: StepFn): StepFn =>
  async (s, e, cfg) => {
    if (await applyPendingAmendment(s, e, cfg)) return 'continue'
    return next(s, e, cfg)
  }

/** Une fonction par étape. */
export const steps: Record<Step, StepFn> = {
  env: stepEnv,
  prepare: stepPrepare,
  classify: stepClassify,
  brainstorm: stepBrainstorm,
  spec: stepSpec,
  plan: stepPlan,
  // Appels différés : `tasks.ts` et `finish.ts` importent ce module (import circulaire).
  tasks: (s, e, cfg) => stepTasks(s, e, cfg),
  // Ces deux étapes appliquent elles-mêmes les amendements, hors boucle de correction en cours (R14).
  'global-review': (s, e, cfg) => stepGlobalReview(s, e, cfg),
  preflight: (s, e, cfg) => stepPreflight(s, e, cfg),
  pr: afterAmendment((s, e, cfg) => stepPr(s, e, cfg)),
  bloquée: waiting,
  'pr-ouverte': stopped,
  fermée: stopped,
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Archive les fichiers de correction `correctifs-<n>.md` du dossier : un tour rejoué en écrit un neuf. */
async function archiveCorrections(s: MissionState, e: Effects, dir: string, gateId: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const m = /^correctifs-(\d+)\.md$/.exec(name)
    if (!m) continue
    await rename(join(dir, name), join(dir, `correctifs-${m[1]}.avant-${gateId}.md`))
    log(s, e, `${join(dir, name)} archivé avant la reprise`)
  }
}

/**
 * Porte `reprise-bloquee` validée (R12/R13), ou amendement validé sur une mission bloquée dans la boucle des tâches :
 * la mission repart de l'étape où elle s'était arrêtée, avec un budget de tours neuf pour la boucle concernée
 * (tâche en cours, revue globale ou preflight). `why` : la décision de l'utilisateur, pour l'orchestrateur.
 */
async function resumeBlocked(s: MissionState, e: Effects, gateId: string, why = 'la reprise de la mission'): Promise<void> {
  const from = s.blockedFrom
  if (s.step !== 'bloquée' || !from) {
    log(s, e, `reprise ${gateId} ignorée : mission ${s.step === 'bloquée' ? "sans étape d'origine connue" : 'non bloquée'}`)
    return
  }
  const dir = missionDir(s.id)
  if (from === 'tasks') {
    const t = s.tasks.find((x) => x.phase !== 'done')
    if (t) {
      t.round = 0
      await archiveCorrections(s, e, taskDir(s, t), gateId)
      // Aucun commit depuis la base : rejouer le contrôle rebloquerait. L'implémenteur reçoit de nouveau son brief
      // (peut-être réécrit par un amendement) au lieu d'attendre une consigne déjà close.
      if ((t.phase === 'control' || t.phase === 'implement') && t.baseSha && s.worktree && (await e.git.headSha(s.worktree)) === t.baseSha) {
        log(s, e, `tâche ${t.n} : aucun commit depuis ${t.baseSha}, ${t.phase} → implement, l'implémenteur reçoit de nouveau son brief`)
        t.phase = 'implement'
        delete t.pendingAsk
      }
    }
  } else if (from === 'global-review') {
    s.loops.globalReview.round = 0
    await archiveCorrections(s, e, join(dir, 'global'), gateId)
  } else if (from === 'preflight') {
    s.loops.preflight.round = 0
    await archiveCorrections(s, e, join(dir, 'preflight'), gateId)
  }
  // Budget neuf aussi pour le rebase automatique de l'étape PR.
  s.loops.prRebases = 0
  const reason = s.blockedReason
  delete s.blockedReason
  delete s.blockedFrom
  log(s, e, `reprise validée (${gateId}) : retour à l'étape ${from}`)
  s.step = from
  await informOrchestrator(s, e, `L'utilisateur a validé ${why} (blocage : ${reason ?? '?'}). Retour à l'étape ${from}.`)
}

/** Vrai si une correction (tâche, revue globale ou preflight) est en phase `fix` : elle attend un arbitrage éventuel. */
function correctionWaiting(s: MissionState): boolean {
  return s.tasks.some((t) => t.phase === 'fix') || s.loops.globalReview.phase === 'fix' || s.loops.preflight.phase === 'fix'
}

/** Vrai si une tâche, la revue globale ou le preflight attend encore cette porte `agent-arret`. */
function stopGateHeld(s: MissionState, id: string): boolean {
  return s.tasks.some((t) => t.stopGate === id) || s.loops.globalReview.stopGate === id || s.loops.preflight.stopGate === id
}

/** Porte `abandon` validée : bases de test supprimées, puis mission `fermée` ; un échec bloque la mission. */
async function abandonMission(s: MissionState, e: Effects, cfg: ProjectConfig, gateId: string): Promise<void> {
  const test = await testDbDown(s, e, cfg)
  const proof = await proofDbDown(s, e, cfg)
  if (test || proof) {
    await blockDbNotDown(s, e, test ? s.id : `${s.id}-main`, [test, proof].filter(Boolean).join(' ; '))
    return
  }
  log(s, e, `abandon validé (${gateId}) : mission fermée`)
  s.step = 'fermée'
  await informOrchestrator(s, e, `L'utilisateur a validé l'abandon (porte ${gateId}) : la mission est fermée.`)
}

export class Engine {
  constructor(
    private readonly id: string,
    private readonly e: Effects,
    private readonly cfg: ProjectConfig,
  ) {}

  private print(s: MissionState, from: number): void {
    if (!process.stdout.isTTY) return
    for (const l of s.log.slice(from)) console.log(`${l.at} ${l.msg}`)
  }

  private async handle(s: MissionState, m: InboxMessage): Promise<void> {
    const { e, cfg } = this
    switch (m.type) {
      case 'decision': {
        const r = applyDecision(s, m)
        if (!r.ok) {
          log(s, e, `décision ignorée : ${r.reason}`)
          return
        }
        const g = r.gate
        if (g.kind === 'abandon') {
          if (g.status === 'approved') await abandonMission(s, e, cfg, g.id)
          else {
            log(s, e, `abandon refusé (${g.id})${g.note ? ` : ${g.note}` : ''}`)
            await informOrchestrator(s, e, `L'utilisateur a refusé l'abandon (porte ${g.id})${g.note ? `, avec la note : ${g.note}` : ''}. La mission continue.`)
          }
          return
        }
        if (g.kind === 'reprise-bloquee') {
          if (g.status === 'approved') await resumeBlocked(s, e, g.id)
          else log(s, e, `reprise refusée (${g.id}) : la mission reste bloquée${g.note ? ` (${g.note})` : ''}`)
          return
        }
        if (g.kind === 'arbitrage' && !correctionWaiting(s)) {
          // Consommée : sa note n'entrera pas dans un fichier de correctifs ultérieur sans rapport avec elle.
          s.consumedArbitrages.push(g.id)
          log(s, e, `arbitrage ${g.id} ${g.status === 'approved' ? 'validé' : 'refusé'} sans effet : aucune correction n'attendait de décision`)
          const hint = s.step === 'bloquée' ? ` La mission reste bloquée : l'utilisateur la reprend avec herness reprendre ${s.id} puis validation, ou la débloque en validant un amendement.` : ''
          await informOrchestrator(s, e, `arbitrage ${g.id} sans effet : aucune correction n'attendait de décision.${hint}`)
          return
        }
        if (g.kind === 'agent-arret' && !stopGateHeld(s, g.id)) {
          // Un amendement a déjà fait reprendre la tâche : rien n'attend plus cette décision.
          log(s, e, `porte ${g.id} (agent-arret) ${g.status === 'approved' ? 'validée' : 'refusée'} sans effet : la tâche a déjà repris avec sa consigne amendée`)
          return
        }
        if (g.status === 'approved') {
          log(s, e, `porte ${g.id} (${g.kind}) validée`)
          await informOrchestrator(s, e, `L'utilisateur a validé la porte ${g.id} (${g.kind})${g.note ? `, avec la note : ${g.note}` : ''}.`)
          if (g.kind === 'amendement' && s.step === 'bloquée' && s.blockedFrom === 'tasks') await this.amendBlocked(s, g.id)
        } else {
          log(s, e, `porte ${g.id} (${g.kind}) refusée : ${g.note ?? ''}`)
          const again = g.kind === 'spec' || g.kind === 'plan' ? ` Corrige puis redemande la validation avec demander_validation('${g.kind}').` : ''
          await informOrchestrator(s, e, `L'utilisateur a refusé la porte ${g.id} (${g.kind}). Motif : ${g.note ?? '(aucun)'}.${again}`)
        }
        return
      }
      case 'request-gate': {
        const summary = m.kind === 'amendement' ? m.summary + (await this.blockedAmendmentNote(s)) : m.summary
        if (m.kind === 'reprise-bloquee' && s.step !== 'bloquée') {
          log(s, e, `demande de reprise ignorée : la mission n'est pas bloquée (étape ${s.step})`)
          return
        }
        const dup = s.gates.find((x) => x.kind === m.kind && x.status === 'pending')
        if (dup) {
          dup.summary = summary
          if (m.path !== undefined) dup.path = m.path
          if (m.hash !== undefined) dup.hash = m.hash
          log(s, e, `demande de porte ${m.kind} : la porte ${dup.id} est déjà en attente, mise à jour`)
          await informOrchestrator(s, e, `La porte ${dup.id} (${m.kind}) est déjà en attente de la décision de l'utilisateur ; résumé mis à jour, aucune nouvelle porte ouverte.`)
          return
        }
        const g = openGate(s, m.kind, summary, m.path, m.hash)
        log(s, e, `porte ${g.id} (${g.kind}) ouverte : ${g.summary}`)
        await notify(s, e, `Porte ${g.kind} à valider : ${g.summary}`)
        await informOrchestrator(s, e, `Porte ${g.id} (${g.kind}) ouverte, en attente de la décision de l'utilisateur (herness valider|refuser ${s.id} --porte ${g.id}).`)
        return
      }
      case 'classified': {
        if (s.branch && s.branch !== `herness/${s.id}`) {
          log(s, e, `classement ${m.workType}/${m.slug} ignoré : branche déjà nommée ${s.branch}`)
          return
        }
        if (!(m.workType in cfg.branchPrefixes)) {
          log(s, e, `classement ignoré : type « ${m.workType} » inconnu (${Object.keys(cfg.branchPrefixes).join(', ')})`)
          return
        }
        if (!SLUG.test(m.slug)) {
          log(s, e, `classement ignoré : slug « ${m.slug} » invalide`)
          return
        }
        s.type = m.workType
        s.slug = m.slug
        log(s, e, `mission classée : ${m.workType} / ${m.slug}`)
        const at = (rel: string): string => (s.worktree ? join(s.worktree, rel) : rel)
        await informOrchestrator(s, e, `Mission classée ${m.workType} / ${m.slug}. Écris la spec dans ${at(specPath(s))} et le plan dans ${at(planPath(s))} (chemins exacts).`)
        return
      }
      case 'orchestrator-started':
        s.orchestrator.started = true
        log(s, e, "prompt d'ouverture envoyé à l'orchestrateur")
        return
      case 'pause':
        s.paused = true
        log(s, e, 'pause')
        return
      case 'resume':
        s.paused = false
        log(s, e, 'reprise')
        return
      case 'abandon': {
        // Seul l'utilisateur ferme : la demande ouvre une porte `abandon`.
        const dup = s.gates.find((x) => x.kind === 'abandon' && x.status === 'pending')
        if (dup) {
          log(s, e, `demande d'abandon : la porte ${dup.id} est déjà en attente`)
          return
        }
        const g = openGate(s, 'abandon', m.reason)
        log(s, e, `porte ${g.id} (abandon) ouverte : ${m.reason}`)
        await notify(s, e, `Abandon à valider : ${m.reason}`)
        await informOrchestrator(s, e, `Porte ${g.id} (abandon) ouverte, en attente de la décision de l'utilisateur (herness valider|refuser ${s.id} --porte ${g.id}).`)
        return
      }
    }
  }

  /**
   * Amendement validé alors que la mission est bloquée dans la boucle des tâches : il est appliqué aussitôt. Si
   * c'est la tâche qui bloque la mission et qu'il change son texte, valider le changement vaut décision de
   * continuer : la mission reprend comme après une reprise validée. Sinon elle reste bloquée.
   */
  private async amendBlocked(s: MissionState, gateId: string): Promise<void> {
    const { e } = this
    const r = await applyAmendment(s, e, this.cfg)
    if (r.status === 'none') log(s, e, `amendement ${gateId} validé : pas encore applicable, la mission reste bloquée`)
    if (r.status !== 'applied') return
    if (unblocksMission(s, r.resumed)) {
      await resumeBlocked(s, e, gateId, `l'amendement ${gateId}, qui relance la tâche ${r.resumed}`)
      return
    }
    log(s, e, `amendement ${gateId} appliqué, la mission reste bloquée (${s.blockedReason ?? '?'})`)
    await informOrchestrator(s, e, `Amendement ${gateId} appliqué, mission toujours bloquée : herness reprendre ${s.id} pour la relancer.`)
  }

  /** Mission bloquée : ce que changera la validation d'un amendement, à ajouter au résumé de sa porte. */
  private async blockedAmendmentNote(s: MissionState): Promise<string> {
    if (s.step !== 'bloquée') return ''
    const plan = await readFile(proposedPlanPath(s.id), 'utf8').catch(() => '')
    const n = plan ? await amendmentWouldResume(s, plan) : undefined
    return n !== undefined ? ` (mission bloquée : valider cet amendement relancera la tâche ${n})` : " (mission bloquée : valider n'enlève pas le blocage)"
  }

  async tick(): Promise<StepResult> {
    const s = await loadState(this.id)
    const from = s.log.length
    const msgs = await drainInbox(this.id)
    for (const m of msgs) await this.handle(s, m)
    if (msgs.length > 0) await saveState(s)
    let r: StepResult
    if (s.step === 'pr-ouverte' || s.step === 'fermée') r = 'stop'
    else if (s.paused) r = 'wait'
    else {
      r = await steps[s.step](s, this.e, this.cfg)
      await saveState(s)
    }
    this.print(s, from)
    return r
  }

  /** Erreur imprévue : la mission passe en `bloquée` (base de test arrêtée) et le moteur continue. */
  private async fail(err: unknown): Promise<void> {
    const msg = `erreur du moteur : ${errMsg(err)}`
    console.error(`herness ${this.id} : ${msg}`)
    try {
      const s = await loadState(this.id)
      const dbErrors = [await testDbDown(s, this.e, this.cfg), await proofDbDown(s, this.e, this.cfg)].filter((x) => x !== null)
      await block(s, this.e, dbErrors.length ? `${msg}\nbase(s) de test non supprimée(s) : ${dbErrors.join(' ; ')}` : msg)
      await saveState(s)
    } catch (err2) {
      console.error(`herness ${this.id} : impossible d'enregistrer le blocage : ${errMsg(err2)}`)
    }
  }

  /**
   * Démarrage du moteur : une commande lancée par un moteur précédent (libellé terminé par « … » dans les onglets
   * checks et process) tourne peut-être encore ; elle est interrompue (double ctrl+c) et marquée ✗.
   */
  private async interruptStaleCommands(): Promise<void> {
    const { e } = this
    const s = await loadState(this.id)
    const stale: string[] = []
    for (const kind of ['checks', 'process']) {
      const tab = s.herdr.tabs[kind]
      if (!tab) continue
      try {
        const panes = (await e.herdr.paneList(tab.split(':')[0] as string)).filter((p) => p.tabId === tab && p.label?.endsWith('…'))
        for (const p of panes) {
          await e.herdr.paneSendKeys(p.paneId, 'ctrl+c')
          await e.herdr.paneSendKeys(p.paneId, 'ctrl+c')
          await e.herdr.paneRename(p.paneId, (p.label ?? '').replace(/\s*…$/, ''))
          await markDone(e.herdr, p.paneId, '✗')
          stale.push(p.label ?? p.paneId)
        }
      } catch (err) {
        log(s, e, `onglet ${kind} : commandes en cours non interrompues (${errMsg(err)})`)
      }
    }
    if (stale.length) log(s, e, `démarrage du moteur : commande(s) d'un moteur précédent interrompue(s) : ${stale.join(', ')}`)
    await saveState(s)
  }

  async run(): Promise<void> {
    try {
      await this.interruptStaleCommands()
    } catch (err) {
      console.error(`herness ${this.id} : nettoyage des panneaux au démarrage impossible : ${errMsg(err)}`)
    }
    for (;;) {
      let r: StepResult
      try {
        r = await this.tick()
      } catch (err) {
        await this.fail(err)
        r = 'wait'
      }
      if (r === 'stop') return
      if (r === 'wait') await this.e.sleep(1000)
    }
  }
}
