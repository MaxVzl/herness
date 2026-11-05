import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentArgs, type Role } from '../agents/adapters.ts'
import * as names from '../agents/names.ts'
import { fill, type ProjectConfig } from '../config/project.ts'
import { markDone, release, releaseTab, slot } from '../herdr/layout.ts'
import { nextTaskPhase, type LoopEvent } from '../mission/loop.ts'
import { proposalHash, proposedPlanPath, proposedSpecPath, readProposal, type Proposal } from '../mission/amendment.ts'
import { checkAmendment, parsePlan, type PlanTask } from '../mission/plan.ts'
import { freshLoops, saveState, type Gate, type MissionState, type PendingAsk, type Step, type TaskState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { render } from '../prompts/render.ts'
import type { Effects } from './effects.ts'
import { block, commitIfChanged, goto, informOrchestrator, log, notify, type StepResult } from './engine.ts'
import { openGate } from './gates.ts'

/** Délai d'attente d'un agent par consigne : une tâche (TDD, tests, commit) peut être longue. */
export const ASK_TIMEOUT_MS: Record<Role, number> = { implementer: 4 * 3_600_000, reviewer: 2 * 3_600_000, orchestrator: 3_600_000 }

/** Interdits communs (contraintes globales). */
const GLOBAL_FORBIDDEN = [
  '`git push`',
  '`git stash`',
  '`--no-verify`',
  'changer de branche',
  '`rebase`',
  '`reset --hard`',
  'sortir du worktree',
  'éditer les fichiers générés du projet',
  '`docker compose`',
  '`--author`',
  '`git -c user.*`',
  '`GIT_AUTHOR_*` / `GIT_COMMITTER_*`',
  '`git config`',
]

const ACTIVE_STEPS_AFTER_TASKS: Step[] = ['global-review', 'preflight', 'pr']

export const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

export const taskDir = (s: MissionState, t: TaskState): string => join(missionDir(s.id), 'taches', String(t.n))
const implName = (s: MissionState, t: TaskState): string => names.implName(s.id, t.n)
const strongName = (s: MissionState, t: TaskState): string => names.strongName(s.id, t.n)
const reviewerName = (s: MissionState, t: TaskState): string => names.reviewerName(s.id, t.n)

export function forbidden(cfg: ProjectConfig): string {
  const strip = (x: string) => x.replace(/`/g, '')
  const items = [...cfg.forbiddenCommands.map((c) => `\`${c}\``), ...GLOBAL_FORBIDDEN]
  const seen = new Set<string>()
  const lines: string[] = []
  for (const it of items) {
    if (seen.has(strip(it))) continue
    seen.add(strip(it))
    const generated = it === 'éditer les fichiers générés du projet' && cfg.forbiddenPaths.length > 0
    lines.push(`- ${generated ? `${it} (${cfg.forbiddenPaths.map((p) => `\`${p}\``).join(', ')})` : it}`)
  }
  return lines.join('\n')
}

async function approvedPlan(s: MissionState): Promise<PlanTask[]> {
  const parsed = parsePlan(await readFile(join(missionDir(s.id), 'plan.approved.md'), 'utf8'))
  if (!parsed.ok) throw new Error(`plan.approved.md invalide : ${parsed.errors.join(' ; ')}`)
  return parsed.tasks
}

/** Corps d'un rapport de revue sans sa ligne de verdict. */
export async function findingsOf(path: string | undefined): Promise<string> {
  if (!path) return '(aucune)'
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.split('\n').slice(1).join('\n').trim() || '(aucune)'
}

const CONTRADICTS_PLAN = /imposé par le plan/i

/**
 * Verdict CORRECTIONS (tâche, revue globale, re-revue du preflight) : l'orchestrateur est prévenu en une ligne ; des
 * remarques qui contredisent le plan (« imposé par le plan ») ouvrent une porte `arbitrage`, et les correctifs
 * attendent la décision de l'utilisateur (`arbitrationPending`), dont la note entre dans le fichier de correctifs.
 */
export async function onCorrections(s: MissionState, e: Effects, what: string, reviewPath: string, round: number): Promise<void> {
  await informOrchestrator(s, e, `${what} : revue CORRECTIONS (tour ${round}), remarques dans ${reviewPath}`)
  if (s.step === 'bloquée') return
  const raw = await readFile(reviewPath, 'utf8').catch(() => '')
  const lines = raw.split('\n').slice(1).map((l) => l.trim()).filter((l) => CONTRADICTS_PLAN.test(l))
  if (lines.length === 0) return
  const g = openGate(s, 'arbitrage', lines.join('\n'), reviewPath)
  log(s, e, `${what} : remarque(s) qui contredisent le plan, porte ${g.id} (arbitrage) ouverte`)
  await notify(s, e, `Arbitrage à trancher (${what}) : ${lines[0]}`)
  await informOrchestrator(
    s,
    e,
    `${what} : la revue contredit le plan (${lines.length} remarque(s)). Porte ${g.id} (arbitrage) ouverte : expose la situation à l'utilisateur, qui tranche (herness valider|refuser ${s.id} --porte ${g.id}, avec une note). Les correctifs attendent sa décision.`,
  )
}

/** Une porte `arbitrage` attend la décision de l'utilisateur : aucun fichier de correctifs n'est écrit. */
export const arbitrationPending = (s: MissionState): boolean => s.gates.some((g) => g.kind === 'arbitrage' && g.status === 'pending')

/** Décisions d'arbitrage pas encore transmises, à ajouter au fichier de correctifs ; marquées consommées. */
export function consumeArbitrations(s: MissionState): string {
  const arbitrages = s.gates.filter((g) => g.kind === 'arbitrage' && (g.status === 'approved' || g.status === 'refused') && !s.consumedArbitrages.includes(g.id))
  const notes = arbitrages.filter((g) => g.note).map((g) => `- ${g.summary.split('\n')[0]} → ${g.status === 'approved' ? 'validé' : 'refusé'} : ${g.note}`)
  s.consumedArbitrages.push(...arbitrages.map((g) => g.id))
  return notes.length ? `\n\n## Décision de l'utilisateur\n\n${notes.join('\n')}\n` : ''
}

/** Porteur d'une porte `agent-arret` : une tâche, la revue globale ou le preflight. */
export type StopHolder = { stopGate?: string | undefined; stopDecision?: string | undefined; reportSize?: number | undefined }

/** Taille d'un fichier en octets, 0 s'il est absent. */
export const fileSize = (path: string): Promise<number> => stat(path).then((x) => x.size, () => 0)

/** Les dernières lignes de ce qui a été ajouté au compte rendu après `since` octets, ou `null` si rien ne l'a été. */
export async function reportTail(path: string, since = 0, lines = 40): Promise<string | null> {
  const raw = await readFile(path).catch(() => Buffer.alloc(0))
  if (raw.length <= since) return null
  const added = raw.subarray(since).toString('utf8')
  if (!added.trim()) return null
  return added.trimEnd().split('\n').slice(-lines).join('\n')
}

/**
 * Contrôle « aucun commit » : si l'implémenteur a complété le compte rendu depuis l'envoi de sa consigne
 * (`reportSize`), il s'est arrêté volontairement (son brief le lui demande quand quelque chose bloque). Une porte
 * `agent-arret` est ouverte et l'orchestrateur explique le compte rendu à l'utilisateur. Rend `null` sinon : le
 * contrôle bloque alors la mission comme avant.
 */
export async function stopWithoutCommit(s: MissionState, e: Effects, h: StopHolder, what: string, reportPath: string): Promise<StepResult | null> {
  const tail = await reportTail(reportPath, h.reportSize ?? 0)
  if (tail === null) return null
  const g = openGate(s, 'agent-arret', `${what} : l'implémenteur s'est arrêté sans commit\n${tail}`, reportPath)
  h.stopGate = g.id
  log(s, e, `${what} : l'implémenteur s'est arrêté sans commit, porte ${g.id} (agent-arret) ouverte (${reportPath})`)
  await notify(s, e, `${what} : l'implémenteur s'est arrêté sans commit, porte ${g.id} à trancher`)
  await informOrchestrator(
    s,
    e,
    `${what} : l'implémenteur s'est arrêté sans commit en laissant un compte rendu (${reportPath}). Porte ${g.id} (agent-arret) ouverte. ` +
      `Lis ce compte rendu et explique-le à l'utilisateur. Si le plan est en cause, propose un amendement (proposer_amendement) : validé, il est appliqué aussitôt et l'implémenteur repart de la consigne amendée. ` +
      `Sinon, l'utilisateur valide pour relancer l'implémenteur avec sa décision en note (herness valider ${s.id} --porte ${g.id} --note "…"), ou refuse pour bloquer la mission (herness refuser ${s.id} --porte ${g.id} --note "…").`,
  )
  return 'continue'
}

/**
 * Porte `agent-arret` du porteur : `wait` tant qu'elle attend, mission bloquée si elle est refusée. Validée, la
 * décision (note, ou « continue ») est gardée pour le prochain fichier de correctifs et rend `approved`.
 */
export async function settleStop(s: MissionState, e: Effects, h: StopHolder, what: string): Promise<'approved' | StepResult> {
  const id = h.stopGate
  const g = s.gates.find((x) => x.id === id)
  if (g?.status === 'pending') return 'wait'
  delete h.stopGate
  if (g?.status === 'caduque') return 'continue'
  if (!g || g.status === 'refused') {
    return block(s, e, `${what} : l'implémenteur s'est arrêté sans commit, porte ${id} refusée${g?.note ? ` (${g.note})` : ''}`)
  }
  h.stopDecision = g.note?.trim() || 'continue'
  log(s, e, `${what} : arrêt sans commit, porte ${g.id} validée (${h.stopDecision}), tour de correction`)
  return 'approved'
}

/** Remarques d'un tour de correction né d'un arrêt sans commit : la décision de l'utilisateur les remplace. */
export const STOP_FINDINGS = "(aucune : tu t'étais arrêté sans commit ; suis la décision de l'utilisateur ci-dessous)"

/** Section « Décision de l'utilisateur » d'un fichier de correctifs après un arrêt sans commit. */
export function stopSection(decision: string, amendedTask?: string): string {
  const amended = amendedTask
    ? `\n## Consigne amendée de la tâche\n\nLe plan a été amendé depuis ton brief : voici le texte actuel de ta tâche, qui remplace celui du brief.\n\n${amendedTask}\n`
    : ''
  return `\n\n## Décision de l'utilisateur\n\nTu t'étais arrêté sans commit ; l'utilisateur a lu ton compte rendu et tranché.\n\nDécision de l'utilisateur : ${decision}\n${amended}`
}

/** Où et sous quel nom un agent est lancé : `what` pour le journal (« tâche 1 »), `pane` préfixe du libellé du panneau. */
export type AgentSite = { what: string; pane: string }
const siteOf = (t: TaskState): AgentSite => ({ what: `tâche ${t.n}`, pane: `T${t.n}` })

/** Démarre un agent dans un panneau libre de l'onglet agents et l'enregistre dans l'état. */
export async function startAgent(s: MissionState, e: Effects, site: AgentSite, name: string, role: Role, model: string): Promise<void> {
  const tab = s.herdr.tabs['agents'] as string
  const wt = s.worktree as string
  const pane = await slot(e.herdr, tab, wt, `${site.pane} · ${model}`)
  await e.agents.start(name, role, pane, agentArgs(role, { model, worktree: wt, missionDir: missionDir(s.id) }))
  s.herdr.panes[name] = pane
  log(s, e, `${site.what} : agent ${name} démarré (${model})`)
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Arrête l'agent nommé. Absent du registre : rien. Un échec est journalisé, jamais levé. */
export async function stopAgent(s: MissionState, e: Effects, what: string, name: string): Promise<void> {
  const pane = s.herdr.panes[name]
  if (!pane) return
  try {
    if (await release(e.herdr, pane)) log(s, e, `${what} : agent ${name} arrêté`)
  } catch (err) {
    log(s, e, `${what} : agent ${name} non arrêté (${errText(err)})`)
  }
}

/** Arrête les agents de l'onglet agents : ceux marqués ✓ ou ✗ (`done`), ou tous (`all`). Ne lève jamais. */
export async function stopAgentsTab(s: MissionState, e: Effects, which: 'done' | 'all', why: string): Promise<void> {
  const tab = s.herdr.tabs['agents']
  if (!tab) return
  try {
    const { released, failed } = await releaseTab(e.herdr, tab, which)
    if (released.length > 0) log(s, e, `${why} : agent(s) arrêté(s) dans ${released.join(', ')}`)
    for (const message of failed) log(s, e, `${why} : arrêt impossible (${message})`)
  } catch (err) {
    log(s, e, `${why} : arrêt impossible (${errText(err)})`)
  }
}

/** Démarre l'agent s'il n'est pas vivant (premier passage ou redémarrage du moteur). */
export async function ensureAgent(s: MissionState, e: Effects, site: AgentSite, name: string, role: Role, model: string): Promise<void> {
  if (await e.herdr.agentGet(name)) return
  await startAgent(s, e, site, name, role, model)
}

/** Porteur d'une consigne en cours : une tâche, la revue globale ou le preflight. */
export type AskHolder = { pendingAsk?: PendingAsk | undefined; blockedGate?: string | undefined }

/**
 * Donne un fichier de consigne à un agent. La consigne est enregistrée dans l'état AVANT l'envoi : un moteur
 * redémarré pendant l'attente attend l'agent (`resumeAsk`) au lieu de renvoyer la consigne.
 */
export async function askAgent(s: MissionState, e: Effects, h: AskHolder, what: string, role: Role, pending: PendingAsk): Promise<'done' | StepResult> {
  h.pendingAsk = pending
  await saveState(s)
  const r = await e.agents.ask(pending.agent, pending.file, ASK_TIMEOUT_MS[role])
  return settle(s, e, h, what, pending.agent, await proven(s, e, what, pending, r))
}

/** Attente d'une consigne déjà envoyée (reprise après un redémarrage du moteur ou un déblocage), sans renvoi. */
export async function awaitAgent(s: MissionState, e: Effects, h: AskHolder, what: string, role: Role, pa: PendingAsk): Promise<'done' | StepResult> {
  const r = await e.agents.wait(pa.agent, ASK_TIMEOUT_MS[role])
  return settle(s, e, h, what, pa.agent, await proven(s, e, what, pa, r))
}

/** Attente d'un compte rendu : intervalle de vérification, et durée au repos sans compte rendu avant de contrôler quand même. */
export const PROOF = { pollMs: 15_000, idleGraceMs: 10 * 60_000 }

/**
 * herdr juge la fin d'un agent sur son écran : un cursor-agent paraît au repos pendant une longue commande (une
 * suite vitest, par exemple). Pour un implémenteur, `done` ne vaut donc fin qu'une fois son compte rendu complété
 * (son brief l'exige avant `TERMINÉ`). Sinon le moteur revérifie ; après `idleGraceMs` au repos sans compte rendu
 * (le compte repart quand l'agent travaille), il contrôle quand même, comme avant.
 */
async function proven(s: MissionState, e: Effects, what: string, pa: PendingAsk, r: 'done' | 'blocked' | 'timeout'): Promise<'done' | 'blocked' | 'timeout'> {
  const report = pa.report
  if (r !== 'done' || !report) return r
  let idle = 0
  for (;;) {
    if ((await fileSize(report.path)) > report.size) return 'done'
    if (idle >= PROOF.idleGraceMs) {
      log(s, e, `${what} : ${pa.agent} au repos depuis ${PROOF.idleGraceMs / 60_000} min sans compte rendu, contrôle du travail`)
      return 'done'
    }
    if (idle === 0) log(s, e, `${what} : ${pa.agent} vu au repos sans compte rendu, attente de la fin réelle`)
    await e.sleep(PROOF.pollMs)
    const state = (await e.herdr.agentGet(pa.agent))?.state
    // Agent disparu : la reprise sait constater son travail.
    if (state === undefined) return 'done'
    if (state === 'blocked') return 'blocked'
    idle = state === 'working' ? 0 : idle + PROOF.pollMs
  }
}

/**
 * Traite l'issue d'une consigne. `done` et `timeout` (mission bloquée) effacent `pendingAsk`. `blocked` le garde
 * et ouvre une porte `agent-bloque` : rien n'est envoyé à l'agent, l'utilisateur le débloque dans son panneau,
 * puis la porte validée, le moteur attend l'agent (`resumeAsk`) sans renvoyer la consigne.
 */
export async function settle(s: MissionState, e: Effects, h: AskHolder, what: string, name: string, r: 'done' | 'blocked' | 'timeout'): Promise<'done' | StepResult> {
  if (r !== 'blocked') delete h.pendingAsk
  if (r === 'done') return 'done'
  if (r === 'timeout') return block(s, e, `agent ${name} sans réponse (${what})`)
  const tail = await e.herdr.agentRead(name, 40).catch(() => '')
  const g = openGate(s, 'agent-bloque', `Agent ${name} (${what}) bloqué, à débloquer dans son panneau :\n${tail}`)
  h.blockedGate = g.id
  log(s, e, `porte ${g.id} (agent-bloque) ouverte pour ${name}`)
  await notify(s, e, `Agent ${name} bloqué : porte ${g.id} à valider une fois débloqué`)
  await informOrchestrator(
    s,
    e,
    `L'agent ${name} (${what}) attend une intervention dans son panneau. Porte ${g.id} (agent-bloque) ouverte : l'utilisateur le débloque puis valide (herness valider ${s.id} --porte ${g.id}).`,
  )
  return 'wait'
}

async function markTaskPanes(s: MissionState, e: Effects, t: TaskState): Promise<void> {
  for (const name of [implName(s, t), strongName(s, t), reviewerName(s, t)]) {
    const pane = s.herdr.panes[name]
    if (!pane) continue
    try {
      await markDone(e.herdr, pane, '✓')
    } catch (err) {
      log(s, e, `marque ✓ non posée sur ${pane} : ${errText(err)}`)
    }
    await stopAgent(s, e, `tâche ${t.n}`, name)
  }
}

/** Applique un événement de la boucle de la tâche (décision pure de `nextTaskPhase`). */
async function apply(s: MissionState, e: Effects, t: TaskState, ev: LoopEvent, detail = ''): Promise<StepResult> {
  const d = nextTaskPhase(t, ev)
  t.round = d.round
  if (d.blocked) return block(s, e, `tâche ${t.n} : ${d.blocked}${detail ? `\n${detail}` : ''}`)
  if (d.fixer !== 'none') t.fixer = d.fixer
  log(s, e, `tâche ${t.n} : ${ev}, ${t.phase} → ${d.phase}${d.fixer !== 'none' ? ` (tour ${d.round}, ${d.fixer})` : ''}`)
  t.phase = d.phase
  if (d.phase === 'done') await markTaskPanes(s, e, t)
  return 'continue'
}

/** Première porte `amendement` approuvée et pas encore traitée. */
export function pendingAmendment(s: MissionState): Gate | undefined {
  return s.gates.find((x) => x.kind === 'amendement' && x.status === 'approved' && !s.appliedAmendments.includes(x.id))
}

/**
 * Revue globale et preflight repartent de zéro : leurs dossiers sont archivés en `<dossier>.<n>` (rien d'ancien
 * n'est relu comme rapport ou correctif du nouveau passage) et la génération change, donc les noms d'agents aussi :
 * les agents de la boucle précédente, avec leur contexte, ne sont jamais réutilisés.
 */
async function resetLoops(s: MissionState, e: Effects): Promise<void> {
  await stopAgentsTab(s, e, 'all', 'nouvelle génération des boucles de fin')
  for (const name of ['global', 'preflight']) {
    const dir = join(missionDir(s.id), name)
    if (!(await exists(dir))) continue
    let n = 1
    while (await exists(`${dir}.${n}`)) n++
    await rename(dir, `${dir}.${n}`)
    log(s, e, `dossier ${dir} archivé en ${dir}.${n}`)
  }
  s.loops = freshLoops()
  s.loopGeneration += 1
}

/**
 * Raison pour laquelle un amendement doit encore attendre, ou `undefined` : une consigne est en cours chez un agent
 * (`pendingAsk`), ou une porte `agent-bloque`/`agent-arret` attend. Exception : la porte `agent-arret` de la tâche en
 * cours, qui attend justement qu'on corrige sa consigne.
 */
function amendmentHold(s: MissionState): string | undefined {
  const asks = [...s.tasks.map((t) => t.pendingAsk), s.loops.globalReview.pendingAsk, s.loops.preflight.pendingAsk]
  if (asks.some((a) => a !== undefined)) return 'consigne en cours chez un agent'
  const current = s.tasks.find((t) => t.phase !== 'done' && t.phase !== 'pending')
  const waiting = s.gates.filter((g) => g.status === 'pending' && (g.kind === 'agent-bloque' || g.kind === 'agent-arret'))
  const other = waiting.find((g) => !(g.kind === 'agent-arret' && current?.stopGate === g.id))
  return other ? `porte ${other.id} (${other.kind}) en attente` : undefined
}

const REPRISE =
  "## Reprise\n\nLe plan a été amendé pendant ta tâche : le texte de la tâche ci-dessous remplace ta consigne précédente. " +
  "Du travail est déjà présent dans l'arbre : garde-le, adapte-le à la nouvelle consigne, puis lance les tests et commite.\n\n"

/** Marque d'un brief réécrit par l'amendement `gateId` (reprise après un arrêt du moteur). */
const repriseMark = (gateId: string): string => `<!-- amendement ${gateId} -->`

/**
 * Écrit le brief de la tâche ; `reprise` (porte de l'amendement) : consigne amendée en cours de tâche, section
 * « Reprise » en tête.
 */
async function writeBrief(s: MissionState, cfg: ProjectConfig, t: TaskState, body: PlanTask, reprise?: string): Promise<string> {
  const dir = taskDir(s, t)
  await mkdir(dir, { recursive: true })
  let brief = await render('brief', {
    taskBody: `### Tâche ${t.n} : ${body.title}\n\n${body.body}`,
    specPath: specPath(s),
    planPath: planPath(s),
    testCommand: t.testCommand,
    commitFormat: fill([cfg.commitFormat], { id: s.id })[0] as string,
    forbidden: forbidden(cfg),
    reportPath: join(dir, 'rapport.md'),
  })
  if (reprise) brief = brief.replace(/^# Brief de tâche\n\n/, `# Brief de tâche\n\n${REPRISE}${repriseMark(reprise)}\n\n`)
  const file = join(dir, 'brief.md')
  await writeFile(file, brief)
  return file
}

/**
 * Proposition d'un amendement interrompu après la suppression de `plan.proposed.md` mais avant l'enregistrement de
 * l'état : `plan.approved.md` (et la spec du worktree) est déjà la proposition validée, au hachage près.
 */
async function interruptedProposal(s: MissionState, e: Effects, g: Gate): Promise<Proposal | null> {
  const plan = await readFile(join(missionDir(s.id), 'plan.approved.md'), 'utf8').catch(() => undefined)
  if (plan === undefined || g.hash === undefined) return null
  const spec = s.worktree ? await readFile(join(s.worktree, specPath(s)), 'utf8').catch(() => undefined) : undefined
  const candidates: Proposal[] = [{ plan, hash: proposalHash(plan) }]
  if (spec !== undefined) candidates.push({ plan, spec, hash: proposalHash(plan, spec) })
  const found = candidates.find((c) => c.hash === g.hash)
  if (found) log(s, e, `amendement ${g.id} interrompu (proposition déjà supprimée, plan approuvé à jour) : application reprise`)
  return found ?? null
}

/** Applique la première porte `amendement` approuvée non traitée (voir `applyAmendment`). Rend vrai si l'état a changé. */
export async function applyPendingAmendment(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<boolean> {
  return (await applyAmendment(s, e, cfg)).status !== 'none'
}

/**
 * Applique la première porte `amendement` approuvée non traitée, dès qu'aucun agent n'a de consigne en cours
 * (`amendmentHold`). La proposition (`plan.proposed.md`, `spec.proposed.md` du dossier de mission) doit être celle
 * que l'utilisateur a validée (même hachage) ; elle est alors copiée dans le worktree, commitée, puis supprimée.
 * Si la tâche en cours change, son brief est réécrit avec une section « Reprise » et elle repart en `implement`
 * (même tour) ; une porte `agent-arret` qu'elle attendait n'est plus attendue. `none` : rien à faire ou attente.
 */
export type AmendmentResult = { status: 'none' | 'rejected' } | { status: 'applied'; resumed?: number | undefined }

export async function applyAmendment(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<AmendmentResult> {
  const none = { status: 'none' } as const
  const g = pendingAmendment(s)
  if (!g) return none
  if (amendmentHold(s) !== undefined) return none
  if (!s.worktree) return none
  const reject = async (reason: string): Promise<AmendmentResult> => {
    s.appliedAmendments.push(g.id)
    log(s, e, `amendement ${g.id} non appliqué : ${reason}`)
    await informOrchestrator(s, e, `Amendement ${g.id} non appliqué : ${reason}`)
    return { status: 'rejected' }
  }
  const proposal = (await readProposal(s.id)) ?? (await interruptedProposal(s, e, g))
  if (!proposal) return reject(`proposition introuvable (${proposedPlanPath(s.id)})`)
  if (g.hash === undefined || g.hash !== proposal.hash) {
    return reject('la proposition a changé après la demande ; redemande la validation avec proposer_amendement')
  }
  const next = parsePlan(proposal.plan)
  const approved = await approvedPlan(s)
  const done = s.tasks
    .filter((t) => t.phase === 'done')
    .map((t) => ({ n: t.n, body: approved.find((x) => x.n === t.n)?.body ?? '' }))
  const cur = currentTask(s)
  const curBody = cur && approved.find((x) => x.n === cur.n)
  const check = checkAmendment(done, next, curBody ? { n: curBody.n, body: curBody.body } : undefined)
  if (!check.ok || !next.ok) return reject(check.ok ? 'plan amendé invalide' : check.reason)
  // Reprise sûre après un arrêt du moteur à n'importe quel point : toutes les écritures avant l'enregistrement de
  // l'état sont rejouables, et la proposition n'est supprimée qu'une fois l'amendement enregistré comme appliqué.
  // Copie dans le worktree et commit : seul le moteur écrit dans le worktree après la validation du plan.
  const docs: [string, string][] = [[planPath(s), proposal.plan]]
  if (proposal.spec !== undefined) docs.push([specPath(s), proposal.spec])
  for (const [rel, body] of docs) {
    await mkdir(dirname(join(s.worktree, rel)), { recursive: true })
    await writeFile(join(s.worktree, rel), body)
  }
  const headBefore = await e.git.headSha(s.worktree)
  if ((await commitIfChanged(s, e, docs.map(([rel]) => rel), `docs(${s.id}): amende le plan`, 'amendement du plan')) === 'committed') {
    // Le commit des documents ne fait pas partie du travail de la tâche en cours : sa base passe après lui, sinon
    // le contrôle verrait un commit, un agent disparu passerait pour livré et la revue relirait les documents.
    const headAfter = await e.git.headSha(s.worktree)
    for (const t of s.tasks) {
      if (t.phase === 'done' || t.phase === 'pending' || t.baseSha !== headBefore) continue
      t.baseSha = headAfter
      log(s, e, `tâche ${t.n} : base déplacée après le commit de l'amendement (${headBefore} → ${headAfter})`)
    }
    // Enregistré aussitôt : rejoué, le commit serait « déjà fait » et la base ne serait plus déplacée.
    await saveState(s)
  }
  const before = new Map(s.tasks.map((t) => [t.n, t]))
  s.tasks = next.tasks.map((nt) => {
    const old = before.get(nt.n)
    if (old?.phase === 'done') return old
    return { ...(old ?? { n: nt.n, phase: 'pending' as const, round: 0 }), title: nt.title, testCommand: nt.testCommand }
  })
  const added = next.tasks.filter((nt) => !before.has(nt.n)).map((nt) => nt.n)
  const dropped = [...before.keys()].filter((n) => !next.tasks.some((nt) => nt.n === n))
  const resumed = await resumeAmendedTask(s, e, cfg, g.id, approved, next.tasks)
  await writeFile(join(missionDir(s.id), 'plan.approved.md'), proposal.plan)
  s.appliedAmendments.push(g.id)
  log(s, e, `amendement ${g.id} appliqué : tâches ajoutées ${added.join(', ') || 'aucune'}${dropped.length ? `, retirées ${dropped.join(', ')}` : ''}${proposal.spec !== undefined ? ', spec amendée' : ''}`)
  if (ACTIVE_STEPS_AFTER_TASKS.includes(s.step)) {
    // Revue globale et preflight seront rejoués après les nouvelles tâches. La base de test est supprimée par
    // l'étape preflight avant d'appliquer l'amendement.
    await resetLoops(s, e)
    goto(s, e, 'tasks')
  }
  await saveState(s)
  await rm(proposedPlanPath(s.id), { force: true })
  await rm(proposedSpecPath(s.id), { force: true })
  await informOrchestrator(
    s,
    e,
    `Amendement ${g.id} appliqué au plan (tâches ajoutées : ${added.join(', ') || 'aucune'}).${resumed ? ` La tâche ${resumed} en cours reprend avec sa consigne amendée.` : ''}`,
  )
  return { status: 'applied', resumed }
}

/** Texte de la tâche tel que le brief le contient. */
const taskText = (n: number, body: PlanTask): string => `### Tâche ${n} : ${body.title}\n\n${body.body}`

/** Tâche en cours : ni `pending` ni `done`. */
const currentTask = (s: MissionState): TaskState | undefined => s.tasks.find((x) => x.phase !== 'done' && x.phase !== 'pending')

/**
 * Le texte `body` diffère-t-il de la consigne de la tâche ? Référence : son `brief.md` (idempotent, survit à un
 * arrêt du moteur) ; sans brief, l'ancien plan approuvé.
 */
async function taskChanged(s: MissionState, t: TaskState, body: PlanTask, approved?: PlanTask[]): Promise<boolean> {
  const brief = await readFile(join(taskDir(s, t), 'brief.md'), 'utf8').catch(() => undefined)
  if (brief !== undefined) return !brief.includes(taskText(t.n, body))
  const old = approved?.find((x) => x.n === t.n)
  return !!old && (old.body !== body.body || old.title !== body.title)
}

/** La mission est bloquée par la tâche `n` elle-même (contrôle, arrêt sans commit, tours épuisés…). */
const blockedByTask = (s: MissionState, n: number): boolean =>
  s.step === 'bloquée' && s.blockedFrom === 'tasks' && (s.blockedReason ?? '').startsWith(`tâche ${n} :`)

/**
 * Mission bloquée : la tâche que relancerait la validation de ce plan amendé (elle bloque la mission et
 * l'amendement change son texte), sinon `undefined`. Sert à annoncer l'effet de la porte à son ouverture.
 */
export async function amendmentWouldResume(s: MissionState, plan: string): Promise<number | undefined> {
  const t = currentTask(s)
  if (!t || !blockedByTask(s, t.n)) return undefined
  const parsed = parsePlan(plan)
  const body = parsed.ok ? parsed.tasks.find((x) => x.n === t.n) : undefined
  if (!body) return undefined
  return (await taskChanged(s, t, body, await approvedPlan(s).catch(() => undefined))) ? t.n : undefined
}

/** Une mission bloquée par la tâche `resumed` peut repartir après l'amendement qui l'a relancée. */
export const unblocksMission = (s: MissionState, resumed: number | undefined): boolean => resumed !== undefined && blockedByTask(s, resumed)

/**
 * Tâche en cours dont l'amendement change le texte : brief réécrit avec une reprise, retour en `implement` au même
 * tour, porte `agent-arret` caduque. Rend son numéro, ou `undefined` si rien ne change.
 */
async function resumeAmendedTask(
  s: MissionState,
  e: Effects,
  cfg: ProjectConfig,
  gateId: string,
  approved: PlanTask[],
  next: PlanTask[],
): Promise<number | undefined> {
  const t = currentTask(s)
  if (!t) return undefined
  const body = next.find((x) => x.n === t.n)
  if (!body) return undefined
  // Brief déjà réécrit pour cet amendement par une tentative interrompue avant l'enregistrement : on refait tout.
  const rewritten = (await readFile(join(taskDir(s, t), 'brief.md'), 'utf8').catch(() => '')).includes(repriseMark(gateId))
  if (!rewritten && !(await taskChanged(s, t, body, approved))) return undefined
  const file = await writeBrief(s, cfg, t, body, gateId)
  log(s, e, `tâche ${t.n} : consigne amendée, brief réécrit (${file}), ${t.phase} → implement (tour ${t.round})`)
  t.phase = 'implement'
  if (t.stopGate) {
    const g = s.gates.find((x) => x.id === t.stopGate)
    if (g?.status === 'pending') {
      g.status = 'caduque'
      g.decidedAt = e.now().toISOString()
    }
    log(s, e, `tâche ${t.n} : porte ${t.stopGate} (agent-arret) caduque, la tâche reprend avec la consigne amendée`)
    await informOrchestrator(s, e, `La porte ${t.stopGate} (agent-arret) est caduque : l'amendement a fait reprendre la tâche ${t.n} avec sa consigne amendée. Plus rien à valider sur cette porte.`)
    delete t.stopGate
  }
  delete t.stopDecision
  return t.n
}

async function stepPending(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const wt = s.worktree as string
  t.baseSha = await e.git.headSha(wt)
  const body = (await approvedPlan(s)).find((x) => x.n === t.n)
  if (!body) return block(s, e, `tâche ${t.n} absente de plan.approved.md`)
  const brief = await writeBrief(s, cfg, t, body)
  const name = implName(s, t)
  // Idempotent : un arrêt entre le démarrage et l'enregistrement ne démarre pas un second agent.
  await ensureAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementer)
  t.implementer = name
  t.phase = 'implement'
  log(s, e, `tâche ${t.n} : base ${t.baseSha}, brief ${brief}`)
  return 'continue'
}

async function stepImplement(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const wt = s.worktree as string
  const dir = taskDir(s, t)
  const name = implName(s, t)
  if (!(await e.herdr.agentGet(name))) {
    // Reprise après un redémarrage : l'agent a disparu.
    if ((await e.git.headSha(wt)) !== t.baseSha) {
      log(s, e, `tâche ${t.n} : reprise, ${name} absent mais des commits existent depuis ${t.baseSha}`)
      return apply(s, e, t, 'implemented')
    }
    log(s, e, `tâche ${t.n} : reprise, ${name} absent sans commit, redémarrage avec le même brief`)
    await startAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementer)
    t.implementer = name
  }
  t.reportSize = await fileSize(join(dir, 'rapport.md'))
  const report = { path: join(dir, 'rapport.md'), size: t.reportSize }
  const r = await askAgent(s, e, t, `tâche ${t.n}`, 'implementer', { agent: name, file: join(dir, 'brief.md'), fromSha: t.baseSha as string, report })
  if (r !== 'done') return r
  return finishImplement(s, e, t)
}

async function finishImplement(s: MissionState, e: Effects, t: TaskState): Promise<StepResult> {
  const report = join(taskDir(s, t), 'rapport.md')
  if (!(await exists(report))) log(s, e, `tâche ${t.n} : compte rendu absent (${report})`)
  return apply(s, e, t, 'implemented')
}

async function stepControl(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const r = await e.git.controlCommits(s.worktree as string, t.baseSha as string, cfg.forbiddenPaths)
  if (r.ok) return apply(s, e, t, 'control-ok')
  if (r.code === 'no-commit') {
    const stop = await stopWithoutCommit(s, e, t, `tâche ${t.n}`, join(taskDir(s, t), 'rapport.md'))
    if (stop) return stop
  }
  return apply(s, e, t, 'control-ko', r.reason)
}

async function stepTest(s: MissionState, e: Effects, t: TaskState): Promise<StepResult> {
  const tab = s.herdr.tabs['checks']
  if (!tab) return block(s, e, `tests de la tâche ${t.n} impossibles : onglet checks inconnu`)
  const r = await e.runInPane(e.herdr, tab, s.worktree as string, `T${t.n} · tests`, ['bash', '-c', t.testCommand], join(missionDir(s.id), 'logs'))
  if (r.exitCode === 0) {
    delete t.lastFailure
    return apply(s, e, t, 'tests-green')
  }
  t.lastFailure = `Commande : ${t.testCommand}\nCode de sortie : ${r.exitCode}\nJournal complet : ${r.logPath}\n\n${r.tail}`
  return apply(s, e, t, 'tests-red')
}

async function stepReview(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  const wt = s.worktree as string
  const dir = taskDir(s, t)
  const name = reviewerName(s, t)
  const common = {
    briefPath: join(dir, 'brief.md'),
    reportPath: join(dir, 'rapport.md'),
    constraints: `Celles de la spec (\`${specPath(s)}\`), et ces interdits :\n${forbidden(cfg)}`,
  }
  let prompt: string
  let outPath: string
  let head: string
  await mkdir(dir, { recursive: true })
  if (!t.reviewedSha) {
    const diffPath = join(dir, 'tache.diff')
    head = (await e.git.diffPackage(wt, t.baseSha as string, diffPath)).head
    outPath = join(dir, 'revue.md')
    prompt = join(dir, 'consigne-revue.md')
    await writeFile(prompt, await render('review', { ...common, baseSha: t.baseSha as string, headSha: head, diffPath, outPath }))
  } else {
    const diffPath = join(dir, `correction-${t.round}.diff`)
    head = (await e.git.diffPackage(wt, t.reviewedSha, diffPath)).head
    outPath = join(dir, `rerevue-${t.round}.md`)
    prompt = join(dir, `consigne-rerevue-${t.round}.md`)
    const findings = await findingsOf(t.lastReview)
    await writeFile(prompt, await render('rereview', { ...common, baseSha: t.reviewedSha, headSha: head, diffPath, outPath, findings }))
  }
  await ensureAgent(s, e, siteOf(t), name, 'reviewer', cfg.models.reviewer)
  t.reviewer = name
  const r = await askAgent(s, e, t, `tâche ${t.n}`, 'reviewer', { agent: name, file: prompt, out: outPath, head })
  if (r !== 'done') return r
  return finishReview(s, e, t, outPath, head)
}

/** Première ligne du rapport de revue : l'événement correspondant, ou `undefined` si illisible. */
export async function readVerdict(outPath: string): Promise<{ first: string; ev: LoopEvent | undefined }> {
  const first = (await readFile(outPath, 'utf8').catch(() => '')).replace(/^\uFEFF/, '').split('\n')[0]!.trim()
  const ev: LoopEvent | undefined = first === 'VERDICT: APPROUVÉ' ? 'review-approved' : first === 'VERDICT: CORRECTIONS' ? 'review-changes' : undefined
  return { first, ev }
}

async function finishReview(s: MissionState, e: Effects, t: TaskState, outPath: string, head: string): Promise<StepResult> {
  const { first, ev } = await readVerdict(outPath)
  if (!ev) return block(s, e, `tâche ${t.n} : verdict de revue illisible dans ${outPath} (« ${first} »)`)
  t.reviewedSha = head
  t.lastReview = outPath
  const r = await apply(s, e, t, ev)
  if (ev === 'review-changes') await onCorrections(s, e, `tâche ${t.n}`, outPath, t.round)
  return r
}

/** Texte actuel de la tâche si un amendement l'a changé depuis l'écriture de son brief, sinon `undefined`. */
async function amendedTaskText(s: MissionState, t: TaskState): Promise<string | undefined> {
  const body = (await approvedPlan(s)).find((x) => x.n === t.n)
  if (!body) return undefined
  return (await taskChanged(s, t, body)) ? taskText(t.n, body) : undefined
}

async function stepFix(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState): Promise<StepResult> {
  if (arbitrationPending(s)) return 'wait'
  const dir = taskDir(s, t)
  const file = join(dir, `correctifs-${t.round}.md`)
  // Écrit une seule fois : une reprise renvoie le même fichier.
  if (!(await exists(file))) {
    const stop = t.stopDecision
    const failure = stop ? '' : (t.lastFailure ?? '')
    const findings = stop ? STOP_FINDINGS : failure ? '' : await findingsOf(t.lastReview)
    const body = await render('correction', { findings, failure, forbidden: forbidden(cfg), reportPath: join(dir, 'rapport.md') })
    const head =
      `Brief de la tâche d'origine : \`${join(dir, 'brief.md')}\` (lis-le d'abord si tu ne le connais pas).\n` +
      `Ajoute ton compte rendu à la fin de \`${join(dir, 'rapport.md')}\`, sans effacer les comptes rendus précédents.\n\n`
    const decision = stop ? stopSection(stop, await amendedTaskText(s, t)) : ''
    await mkdir(dir, { recursive: true })
    await writeFile(file, head + body + decision + consumeArbitrations(s))
  }
  delete t.stopDecision
  let name: string
  if (t.fixer === 'strong') {
    name = strongName(s, t)
    await ensureAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementerStrong)
  } else {
    name = implName(s, t)
    await ensureAgent(s, e, siteOf(t), name, 'implementer', cfg.models.implementer)
  }
  t.implementer = name
  const fromSha = await e.git.headSha(s.worktree as string)
  t.reportSize = await fileSize(join(dir, 'rapport.md'))
  const report = { path: join(dir, 'rapport.md'), size: t.reportSize }
  const r = await askAgent(s, e, t, `tâche ${t.n}`, 'implementer', { agent: name, file, fromSha, report })
  if (r !== 'done') return r
  return apply(s, e, t, 'fixed')
}

/**
 * Reprise d'une consigne envoyée avant un redémarrage du moteur : rien n'est renvoyé à un agent vivant, on
 * attend son issue. Agent disparu : implement/fix → commits depuis la tête d'avant l'envoi = travail livré,
 * sinon redémarrage et renvoi ; review → verdict déjà écrit utilisé, sinon relecteur redémarré et renvoi.
 */
async function resumeAsk(s: MissionState, e: Effects, cfg: ProjectConfig, t: TaskState, pa: PendingAsk): Promise<StepResult> {
  const role: Role = t.phase === 'review' ? 'reviewer' : 'implementer'
  const headNow = async () => pa.head ?? (await e.git.headSha(s.worktree as string))
  if (await e.herdr.agentGet(pa.agent)) {
    log(s, e, `tâche ${t.n} : reprise, attente de ${pa.agent} sans renvoi de ${pa.file}`)
    const r = await awaitAgent(s, e, t, `tâche ${t.n}`, role, pa)
    if (r !== 'done') return r
    if (t.phase === 'implement') return finishImplement(s, e, t)
    if (t.phase === 'fix') return apply(s, e, t, 'fixed')
    if (t.phase === 'review' && pa.out) return finishReview(s, e, t, pa.out, await headNow())
    return 'continue'
  }
  delete t.pendingAsk
  log(s, e, `tâche ${t.n} : reprise, ${pa.agent} disparu pendant ${pa.file}`)
  switch (t.phase) {
    case 'implement':
      return stepImplement(s, e, cfg, t)
    case 'fix':
      if (pa.fromSha && (await e.git.headSha(s.worktree as string)) !== pa.fromSha) return apply(s, e, t, 'fixed')
      return stepFix(s, e, cfg, t)
    case 'review':
      if (pa.out && (await readVerdict(pa.out)).ev) return finishReview(s, e, t, pa.out, await headNow())
      return stepReview(s, e, cfg, t)
    default:
      return 'continue'
  }
}

/** Étape 7 : une transition de la première tâche non `done` ; plus de tâche → `global-review`. */
export async function stepTasks(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  if (await applyPendingAmendment(s, e, cfg)) return 'continue'
  const t = s.tasks.find((x) => x.phase !== 'done')
  if (!t) return goto(s, e, 'global-review')
  if (!s.worktree || !s.herdr.tabs['agents']) return block(s, e, 'boucle des tâches impossible : worktree ou onglet agents inconnu')

  if (t.blockedGate) {
    const g = s.gates.find((x) => x.id === t.blockedGate)
    if (g?.status === 'pending') return 'wait'
    delete t.blockedGate
    if (g?.status === 'refused') return block(s, e, `tâche ${t.n} : agent bloqué, porte ${g.id} refusée${g.note ? ` (${g.note})` : ''}`)
    log(s, e, `tâche ${t.n} : agent débloqué, attente de sa fin sans renvoi`)
  }
  if (t.stopGate) {
    const r = await settleStop(s, e, t, `tâche ${t.n}`)
    if (r !== 'approved') return r
    return apply(s, e, t, 'stopped')
  }
  if (t.pendingAsk) return resumeAsk(s, e, cfg, t, t.pendingAsk)

  switch (t.phase) {
    case 'pending': return stepPending(s, e, cfg, t)
    case 'implement': return stepImplement(s, e, cfg, t)
    case 'control': return stepControl(s, e, cfg, t)
    case 'test': return stepTest(s, e, t)
    case 'review': return stepReview(s, e, cfg, t)
    case 'fix': return stepFix(s, e, cfg, t)
    case 'done': return 'continue'
  }
}
