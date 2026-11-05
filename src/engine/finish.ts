import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Role } from '../agents/adapters.ts'
import { diagnosticName, globalFixerName, globalReviewerName, preflightFixerName } from '../agents/names.ts'
import { fill, type ProjectConfig } from '../config/project.ts'
import { markDone } from '../herdr/layout.ts'
import { nextLoopRound } from '../mission/loop.ts'
import { freshLoops, saveState, type MissionState, type PendingAsk, type PreflightResult, type PreflightState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { render } from '../prompts/render.ts'
import type { Effects } from './effects.ts'
import { block, blockDbNotDown, goto, proofWorktree, informOrchestrator, log, notify, proofDbDown, testDbDown, type StepResult } from './engine.ts'
import { openGate } from './gates.ts'
import {
  applyPendingAmendment,
  arbitrationPending,
  ASK_TIMEOUT_MS,
  askAgent,
  awaitAgent,
  ensureAgent,
  exists,
  findingsOf,
  fileSize,
  consumeArbitrations,
  forbidden,
  onCorrections,
  pendingAmendment,
  settle,
  settleStop,
  stopAgent,
  stopAgentsTab,
  stopSection,
  stopWithoutCommit,
  type AgentSite,
  type AskHolder,
} from './tasks.ts'

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const globalDir = (s: MissionState): string => join(missionDir(s.id), 'global')
const preflightDir = (s: MissionState): string => join(missionDir(s.id), 'preflight')
const logsDir = (s: MissionState): string => join(missionDir(s.id), 'logs')
const mainRef = (cfg: ProjectConfig): string => `origin/${cfg.mainBranch}`
/** Relecteur global : relit la branche, puis chaque correction de la revue globale et du preflight. */
const globalReviewer = (s: MissionState): string => globalReviewerName(s.id, s.loopGeneration)

const constraints = (s: MissionState, cfg: ProjectConfig): string => `Celles de la spec (\`${specPath(s)}\`), et ces interdits :\n${forbidden(cfg)}`

async function firstLine(path: string): Promise<string> {
  return (await readFile(path, 'utf8').catch(() => '')).replace(/^﻿/, '').split('\n')[0]!.trim()
}

const VERDICTS: Record<string, 'approved' | 'changes'> = { 'VERDICT: APPROUVÉ': 'approved', 'VERDICT: CORRECTIONS': 'changes' }
const causeOf = (line: string): 'BRANCHE' | 'MAIN' | 'ENVIRONNEMENT' | undefined =>
  /^CAUSE: (BRANCHE|MAIN|ENVIRONNEMENT)$/.exec(line)?.[1] as 'BRANCHE' | 'MAIN' | 'ENVIRONNEMENT' | undefined

async function markPane(s: MissionState, e: Effects, name: string): Promise<void> {
  const pane = s.herdr.panes[name]
  if (!pane) return
  try {
    await markDone(e.herdr, pane, '✓')
  } catch (err) {
    log(s, e, `marque ✓ non posée sur ${pane} : ${errMsg(err)}`)
  }
  await stopAgent(s, e, 'fin de mission', name)
}

type Agent = { site: AgentSite; name: string; role: Role; model: string }

/**
 * Une consigne à un agent, reprise comprise (mêmes règles que la boucle des tâches). Une consigne en cours
 * (`h.pendingAsk`) n'est jamais renvoyée à un agent vivant : on attend son issue. Agent disparu : si
 * `delivered` constate son travail, il est pris tel quel ; sinon l'agent est relancé et la même consigne renvoyée.
 * Rend la consigne traitée, ou le résultat de l'étape (attente d'une porte, blocage).
 */
async function converse(
  s: MissionState,
  e: Effects,
  h: AskHolder,
  a: Agent,
  make: () => Promise<PendingAsk>,
  delivered: (pa: PendingAsk) => Promise<boolean>,
): Promise<PendingAsk | StepResult> {
  const what = a.site.what
  if (h.blockedGate) {
    const g = s.gates.find((x) => x.id === h.blockedGate)
    if (g?.status === 'pending') return 'wait'
    delete h.blockedGate
    if (g?.status === 'refused') return block(s, e, `${what} : agent bloqué, porte ${g.id} refusée${g.note ? ` (${g.note})` : ''}`)
    log(s, e, `${what} : agent débloqué, attente de sa fin sans renvoi`)
  }
  let pa = h.pendingAsk
  if (pa) {
    if (await e.herdr.agentGet(pa.agent)) {
      log(s, e, `${what} : reprise, attente de ${pa.agent} sans renvoi de ${pa.file}`)
      const r = await awaitAgent(s, e, h, what, a.role, pa)
      return r === 'done' ? pa : r
    }
    delete h.pendingAsk
    log(s, e, `${what} : reprise, ${pa.agent} disparu pendant ${pa.file}`)
    if (await delivered(pa)) return pa
  } else {
    pa = await make()
  }
  await ensureAgent(s, e, a.site, a.name, a.role, a.model)
  const r = await askAgent(s, e, h, what, a.role, pa)
  return r === 'done' ? pa : r
}

const reviewerDelivered = async (pa: PendingAsk): Promise<boolean> => !!pa.out && (await firstLine(pa.out)) in VERDICTS
const implementerDelivered =
  (s: MissionState, e: Effects) =>
  async (pa: PendingAsk): Promise<boolean> =>
    !!pa.fromSha && (await e.git.headSha(s.worktree as string)) !== pa.fromSha

/** Fichier de correction d'un implémenteur neuf (revue globale ou preflight) : écrit une fois par tour. */
async function writeFix(
  s: MissionState,
  cfg: ProjectConfig,
  dir: string,
  file: string,
  origin: string,
  findings: string,
  failure: string,
  stopDecision?: string,
): Promise<void> {
  const reportPath = join(dir, 'rapport.md')
  const head =
    `Correction demandée par ${origin}, sur toute la branche. Spec : \`${specPath(s)}\`, plan : \`${planPath(s)}\`. ` +
    `Il n'y a pas de brief de tâche : ton périmètre est ce qui est décrit ci-dessous.\n` +
    `Ajoute ton compte rendu à la fin de \`${reportPath}\`, sans effacer les comptes rendus précédents.\n\n`
  const body = await render('correction', { findings, failure, forbidden: forbidden(cfg), reportPath })
  await mkdir(dir, { recursive: true })
  await writeFile(file, head + body + (stopDecision ? stopSection(stopDecision) : '') + consumeArbitrations(s))
}

/** Re-revue par `rg<id>` du diff depuis sa dernière tête relue. */
async function rereviewAsk(s: MissionState, e: Effects, cfg: ProjectConfig, dir: string, round: number, findings: string): Promise<PendingAsk> {
  const wt = s.worktree as string
  const base = s.loops.globalReview.reviewedSha ?? (await e.git.mergeBase(wt, mainRef(cfg)))
  await mkdir(dir, { recursive: true })
  const diffPath = join(dir, `correction-${round}.diff`)
  const head = (await e.git.diffPackage(wt, base, diffPath)).head
  const out = join(dir, `rerevue-${round}.md`)
  const file = join(dir, `consigne-rerevue-${round}.md`)
  await writeFile(
    file,
    await render('rereview', {
      briefPath: join(globalDir(s), 'consigne-revue.md'),
      reportPath: join(dir, 'rapport.md'),
      constraints: constraints(s, cfg),
      baseSha: base,
      headSha: head,
      diffPath,
      outPath: out,
      findings,
    }),
  )
  return { agent: globalReviewer(s), file, out, head }
}

const reviewerAgent = (s: MissionState, cfg: ProjectConfig, what: string): Agent => ({
  site: { what, pane: 'RG' },
  name: globalReviewer(s),
  role: 'reviewer',
  model: cfg.models.reviewer,
})
const fixerAgent = (cfg: ProjectConfig, what: string, name: string, pane: string, fixer: 'new' | 'strong' | undefined): Agent => {
  const model = fixer === 'strong' ? cfg.models.implementerStrong : cfg.models.implementer
  return { site: { what, pane }, name, role: 'implementer', model }
}

// ---------------------------------------------------------------- revue globale (étape 8)

const GR = 'revue globale'

/**
 * Étape 8 : relecteur neuf `rg<id>` sur `merge-base(origin/main)..HEAD` ; corrections → implémenteur neuf
 * `cg<id>-<r>` → contrôle → tests des tâches touchées → re-revue par `rg<id>`. Approuvée → `preflight`.
 */
export async function stepGlobalReview(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  // Un amendement attend la fin d'une boucle de correction en cours (R14).
  const busy = G.round > 0 || G.pendingAsk !== undefined || G.blockedGate !== undefined
  if (!busy && (await applyPendingAmendment(s, e, cfg))) return 'continue'
  if (!s.worktree || !s.herdr.tabs['agents'] || !s.herdr.tabs['checks']) {
    return block(s, e, 'revue globale impossible : worktree ou onglets agents/checks inconnus')
  }
  if (G.stopGate) {
    const r = await settleStop(s, e, G, GR)
    if (r !== 'approved') return r
    return nextGlobalRound(s, e, G.lastFailure)
  }
  switch (G.phase) {
    case undefined:
    case 'rereview':
      return globalReview(s, e, cfg)
    case 'fix':
      return globalFix(s, e, cfg)
    case 'control': {
      const r = await e.git.controlCommits(s.worktree, G.fixBase ?? '', cfg.forbiddenPaths)
      if (!r.ok && r.code === 'no-commit') {
        const stop = await stopWithoutCommit(s, e, G, GR, join(globalDir(s), 'rapport.md'))
        if (stop) return stop
      }
      if (!r.ok) return block(s, e, `${GR} (tour ${G.round}) : contrôle du commit en échec\n${r.reason}`)
      G.phase = 'test'
      return 'continue'
    }
    case 'test':
      return globalTests(s, e)
  }
}

async function globalReview(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  const wt = s.worktree as string
  const dir = globalDir(s)
  const first = async (): Promise<PendingAsk> => {
    await mkdir(dir, { recursive: true })
    const base = await e.git.mergeBase(wt, mainRef(cfg))
    const diffPath = join(dir, 'branche.diff')
    const head = (await e.git.diffPackage(wt, base, diffPath)).head
    const out = join(dir, 'revue.md')
    const file = join(dir, 'consigne-revue.md')
    const vars = { baseSha: base, headSha: head, diffPath, specPath: specPath(s), planPath: planPath(s), constraints: constraints(s, cfg), outPath: out }
    await writeFile(file, await render('global-review', vars))
    log(s, e, `${GR} : branche ${base}..${head}`)
    return { agent: globalReviewer(s), file, out, head }
  }
  const make = G.phase === 'rereview' ? async () => rereviewAsk(s, e, cfg, dir, G.round, await findingsOf(G.lastReview)) : first
  const pa = await converse(s, e, G, reviewerAgent(s, cfg, GR), make, reviewerDelivered)
  if (typeof pa === 'string') return pa
  const out = pa.out as string
  const line = await firstLine(out)
  const v = VERDICTS[line]
  if (!v) return block(s, e, `${GR} : verdict illisible dans ${out} (« ${line} »)`)
  G.reviewedSha = pa.head ?? (await e.git.headSha(wt))
  G.lastReview = out
  if (v === 'approved') {
    log(s, e, `${GR} approuvée${G.round > 0 ? ` au tour ${G.round}` : ''}`)
    s.loops.globalReview = { round: 0, reviewedSha: G.reviewedSha, lastReview: out }
    s.loops.preflight = freshLoops().preflight
    return goto(s, e, 'preflight')
  }
  const r = await nextGlobalRound(s, e)
  await onCorrections(s, e, GR, out, G.round)
  return r
}

/** Nouveau tour de la revue globale : remarques de la dernière revue, ou sortie rouge des tests (`failure`). */
async function nextGlobalRound(s: MissionState, e: Effects, failure?: string): Promise<StepResult> {
  const G = s.loops.globalReview
  const d = nextLoopRound(G.round)
  G.round = d.round
  if (d.blocked) return block(s, e, `${GR} : ${d.blocked}${failure ? `\n${failure}` : ''}`)
  G.fixer = d.fixer === 'strong' ? 'strong' : 'new'
  if (failure) G.lastFailure = failure
  else delete G.lastFailure
  delete G.fixBase
  G.phase = 'fix'
  log(s, e, `${GR} : tour de correction ${G.round} (${G.fixer}), ${failure ? 'tests rouges' : 'remarques de revue'}`)
  return 'continue'
}

async function globalFix(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const G = s.loops.globalReview
  const dir = globalDir(s)
  const file = join(dir, `correctifs-${G.round}.md`)
  if (!(await exists(file))) {
    if (arbitrationPending(s)) return 'wait'
    const failure = G.lastFailure ?? ''
    await writeFix(s, cfg, dir, file, 'la revue globale', failure ? '' : await findingsOf(G.lastReview), failure, G.stopDecision)
  }
  delete G.stopDecision
  G.fixBase ??= await e.git.headSha(s.worktree as string)
  const name = globalFixerName(s.id, s.loopGeneration, G.round)
  const fixBase = G.fixBase
  const make = async (): Promise<PendingAsk> => {
    G.reportSize = await fileSize(join(dir, 'rapport.md'))
    return { agent: name, file, fromSha: fixBase, report: { path: join(dir, 'rapport.md'), size: G.reportSize } }
  }
  const pa = await converse(s, e, G, fixerAgent(cfg, GR, name, `CG${G.round}`, G.fixer), make, implementerDelivered(s, e))
  if (typeof pa === 'string') return pa
  await markPane(s, e, name)
  G.phase = 'control'
  return 'continue'
}

/** Tâches dont les fichiers recoupent ceux de la correction ; aucune → toutes. Une commande n'est lancée qu'une fois. */
async function touchedTasks(s: MissionState, e: Effects, fixBase: string): Promise<MissionState['tasks']> {
  const wt = s.worktree as string
  const fixed = new Set(await e.git.changedFiles(wt, fixBase))
  const touched: MissionState['tasks'] = []
  for (const t of s.tasks) {
    if (!t.baseSha || !t.reviewedSha) continue
    if ((await e.git.changedFiles(wt, t.baseSha, t.reviewedSha)).some((f) => fixed.has(f))) touched.push(t)
  }
  const list = touched.length > 0 ? touched : s.tasks
  const seen = new Set<string>()
  return list.filter((t) => !seen.has(t.testCommand) && seen.add(t.testCommand))
}

async function globalTests(s: MissionState, e: Effects): Promise<StepResult> {
  const G = s.loops.globalReview
  const wt = s.worktree as string
  const tab = s.herdr.tabs['checks'] as string
  for (const t of await touchedTasks(s, e, G.fixBase ?? (await e.git.headSha(wt)))) {
    const r = await e.runInPane(e.herdr, tab, wt, `RG · tests T${t.n}`, ['bash', '-c', t.testCommand], logsDir(s))
    if (r.exitCode !== 0) {
      return nextGlobalRound(s, e, `Tests de la tâche ${t.n}\nCommande : ${t.testCommand}\nCode de sortie : ${r.exitCode}\nJournal complet : ${r.logPath}\n\n${r.tail}`)
    }
  }
  G.phase = 'rereview'
  return 'continue'
}

// ---------------------------------------------------------------- preflight (étape 9)

const PF = 'preflight'

type FalsePositive = ProjectConfig['falsePositives'][number]

/**
 * Premier faux positif connu qui s'applique : `label` égal (ou absent), `pattern` trouvé sur une ligne du journal,
 * pas déjà appliqué à ce check (`used`). Une règle `ignore` ne s'applique que si aucun fichier touché par la branche
 * n'apparaît dans le journal (R5).
 */
export function findFalsePositive(
  result: { label: string; log: string },
  cfg: ProjectConfig,
  touchedFiles: string[],
  used: number[] = [],
): { index: number; rule: FalsePositive } | undefined {
  const lines = result.log.split('\n')
  for (const [index, rule] of cfg.falsePositives.entries()) {
    if (used.includes(index)) continue
    if (rule.label !== undefined && rule.label !== result.label) continue
    const re = new RegExp(rule.pattern)
    if (!lines.some((l) => re.test(l))) continue
    if (rule.action === 'ignore' && touchedFiles.some((f) => result.log.includes(f))) continue
    return { index, rule }
  }
  return undefined
}

export function triage(
  result: { label: string; log: string },
  cfg: ProjectConfig,
  touchedFiles: string[],
  used: number[] = [],
): 'retry' | 'ignore' | { cleanup: string[] } | 'diagnose' {
  const fp = findFalsePositive(result, cfg, touchedFiles, used)
  if (!fp) return 'diagnose'
  if (fp.rule.action === 'cleanup') return { cleanup: fp.rule.cleanup ?? [] }
  return fp.rule.action
}

/** Le passage de preflight reprend du premier check (après une correction, ou pour une reprise après blocage). */
function restartRun(P: PreflightState): void {
  P.results = []
  P.used = []
  P.fetched = false
  delete P.phase
  delete P.failing
  delete P.gate
}

/**
 * Étape 9. Garantie : toute sortie de l'étape (vers `pr`, `bloquée`, `tasks` après un amendement, ou exception)
 * arrête la base de test de la mission. Pendant une boucle de correction, la base reste en place d'un tour à l'autre.
 */
export async function stepPreflight(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  let failed = false
  try {
    return await preflight(s, e, cfg)
  } catch (err) {
    failed = true
    throw err
  } finally {
    if (failed) {
      // Erreurs d'arrêt rapportées par `Engine.fail`, qui réessaie sur l'état enregistré.
      await testDbDown(s, e, cfg)
      await proofDbDown(s, e, cfg)
    } else if (s.step !== 'preflight') {
      const err = await testDbDown(s, e, cfg)
      if (err) await blockDbNotDown(s, e, s.id, err)
    }
  }
}

async function preflight(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const busy = P.round > 0 || P.phase !== undefined || P.pendingAsk !== undefined || P.blockedGate !== undefined
  if (!busy && pendingAmendment(s)) {
    // La base est supprimée AVANT d'appliquer l'amendement : en cas d'échec, la mission reste au preflight (R14).
    const err = await testDbDown(s, e, cfg)
    if (err) return blockDbNotDown(s, e, s.id, err)
    if (await applyPendingAmendment(s, e, cfg)) return 'continue'
  }
  if (!s.worktree || !s.herdr.tabs['agents'] || !s.herdr.tabs['checks'] || !s.herdr.tabs['process']) {
    return block(s, e, 'preflight impossible : worktree ou onglets agents/checks/process inconnus')
  }
  if (P.stopGate) {
    const r = await settleStop(s, e, P, PF)
    if (r !== 'approved') return r
    return startFix(s, e, P.fixFindings ?? '', P.fixFailure ?? '')
  }
  switch (P.phase) {
    case undefined:
      return nextCheck(s, e, cfg)
    case 'diagnose':
      return diagnose(s, e, cfg)
    case 'proof':
      return proveOnMain(s, e, cfg)
    case 'gate':
      return mainGate(s, e)
    case 'fix':
      return preflightFix(s, e, cfg)
    case 'control': {
      const r = await e.git.controlCommits(s.worktree, P.fixBase ?? '', cfg.forbiddenPaths)
      if (!r.ok && r.code === 'no-commit') {
        const stop = await stopWithoutCommit(s, e, P, PF, join(preflightDir(s), 'rapport.md'))
        if (stop) return stop
      }
      if (!r.ok) return block(s, e, `${PF} (tour ${P.round}) : contrôle du commit en échec\n${r.reason}`)
      P.phase = 'rereview'
      return 'continue'
    }
    case 'rereview':
      return preflightRereview(s, e, cfg)
  }
}

async function nextCheck(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const wt = s.worktree as string
  const vars = { id: s.id, worktree: wt }
  if (cfg.testDb && !s.testDbUp) {
    // Enregistré avant le lancement : une base à moitié créée est quand même supprimée après un arrêt du moteur.
    s.testDbUp = true
    await saveState(s)
    const r = await e.runInPane(e.herdr, s.herdr.tabs['process'] as string, wt, 'base de test', fill(cfg.testDb.up, vars), logsDir(s))
    if (r.exitCode !== 0) return block(s, e, `${PF} : base de test non créée (code ${r.exitCode}), journal : ${r.logPath}\n${r.tail}`)
    log(s, e, `${PF} : base de test ${s.id} créée`)
    return 'continue'
  }
  const check = cfg.preflight[P.results.length]
  if (!check) {
    const err = await testDbDown(s, e, cfg)
    if (err) return blockDbNotDown(s, e, s.id, err)
    await markPane(s, e, globalReviewer(s))
    P.validatedSha = await e.git.headSha(wt)
    const red = P.results.filter((r) => r.exitCode !== 0).map((r) => r.label)
    log(s, e, `${PF} terminé : ${P.results.length} checks${red.length ? `, rouges acceptés : ${red.join(', ')}` : ', tout vert'}`)
    return goto(s, e, 'pr')
  }
  if (!P.fetched) {
    // Le build filtre sur `...[origin/main]` (R6) : origin/main à jour avant le premier check du passage.
    await e.git.fetchMain(wt, cfg.mainBranch)
    P.fetched = true
  }
  const r = await e.runInPane(e.herdr, s.herdr.tabs['checks'] as string, wt, `${PF} · ${check.label}`, fill(check.command, vars), logsDir(s))
  const result: PreflightResult = { label: check.label, exitCode: r.exitCode, durationMs: r.durationMs, logPath: r.logPath }
  if (r.exitCode === 0) {
    P.results.push(result)
    P.used = []
    return 'continue'
  }
  if (P.acceptedRed.includes(check.label)) {
    P.results.push({ ...result, note: `rouge aussi sur ${mainRef(cfg)}, PR validée malgré tout` })
    P.used = []
    log(s, e, `${PF} : ${check.label} rouge, déjà accepté (rouge aussi sur main)`)
    return 'continue'
  }
  const text = await readFile(r.logPath, 'utf8').catch(() => r.tail)
  const touched = await e.git.changedFiles(wt, await e.git.mergeBase(wt, mainRef(cfg)))
  const fp = findFalsePositive({ label: check.label, log: text }, cfg, touched, P.used)
  if (fp) {
    P.used.push(fp.index)
    log(s, e, `${PF} : ${check.label} rouge, faux positif connu (${fp.rule.action}) : ${fp.rule.explanation}`)
    if (fp.rule.action === 'ignore') {
      P.results.push({ ...result, note: `faux positif ignoré : ${fp.rule.explanation}` })
      P.used = []
    } else if (fp.rule.action === 'cleanup' && fp.rule.cleanup?.length) {
      const c = await e.runInPane(e.herdr, s.herdr.tabs['process'] as string, wt, 'nettoyage', fill(fp.rule.cleanup, vars), logsDir(s))
      log(s, e, `${PF} : nettoyage terminé (code ${c.exitCode}), ${check.label} relancé`)
    }
    // retry et cleanup : le même check est relancé au prochain tour.
    return 'continue'
  }
  P.failing = { ...result, tail: r.tail }
  P.diag += 1
  P.phase = 'diagnose'
  log(s, e, `${PF} : ${check.label} rouge (code ${r.exitCode}), diagnostic ${P.diag}`)
  return 'continue'
}

async function diagnose(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const f = P.failing
  if (!f) return block(s, e, `${PF} : diagnostic demandé sans check rouge connu`)
  const dir = preflightDir(s)
  const n = P.diag
  const name = diagnosticName(s.id, s.loopGeneration, n)
  const make = async (): Promise<PendingAsk> => {
    await mkdir(dir, { recursive: true })
    const out = join(dir, `diagnostic-${n}.md`)
    const file = join(dir, `consigne-diagnostic-${n}.md`)
    const command = cfg.preflight.find((c) => c.label === f.label)?.command.join(' ') ?? '?'
    const body = await render('diagnostic', { logPath: f.logPath, outPath: out })
    await writeFile(
      file,
      `${body}\n## Check concerné\n\n- Libellé : \`${f.label}\`\n- Commande : \`${command}\`\n- Code de sortie : ${f.exitCode}\n- Branche comparée à : \`${mainRef(cfg)}\`\n`,
    )
    return { agent: name, file, out }
  }
  const agent: Agent = { site: { what: PF, pane: `RD${n}` }, name, role: 'reviewer', model: cfg.models.reviewer }
  const pa = await converse(s, e, P, agent, make, async (x) => !!x.out && causeOf(await firstLine(x.out)) !== undefined)
  if (typeof pa === 'string') return pa
  await markPane(s, e, name)
  const out = pa.out as string
  const line = await firstLine(out)
  const cause = causeOf(line)
  if (!cause) return block(s, e, `${PF} : cause illisible dans ${out} (« ${line} »)`)
  P.diagnosis = out
  log(s, e, `${PF} : ${f.label} rouge, cause ${cause} (${out})`)
  switch (cause) {
    case 'BRANCHE':
      return startFix(s, e, '', await diagnosisBrief(s, cfg, false))
    case 'MAIN':
      P.phase = 'proof'
      return 'continue'
    case 'ENVIRONNEMENT':
      restartRun(P)
      return block(s, e, `${PF} : check « ${f.label} » rouge, cause ENVIRONNEMENT (diagnostic : ${out})\n${await findingsOf(out)}`)
  }
}

/** Le diagnostic devient le brief de l'implémenteur correcteur. */
async function diagnosisBrief(s: MissionState, cfg: ProjectConfig, greenOnMain: boolean): Promise<string> {
  const P = s.loops.preflight
  const f = P.failing!
  return (
    `Check du preflight rouge : « ${f.label} » (code ${f.exitCode}), journal complet : ${f.logPath}\n` +
    (greenOnMain ? `Le même check est vert sur ${mainRef(cfg)} : la cause est dans la branche.\n` : '') +
    `\nDiagnostic (${P.diagnosis}) :\n\n${await findingsOf(P.diagnosis)}`
  )
}

async function startFix(s: MissionState, e: Effects, findings: string, failure: string): Promise<StepResult> {
  const P = s.loops.preflight
  const d = nextLoopRound(P.round)
  P.round = d.round
  if (d.blocked) return block(s, e, `${PF} : ${d.blocked}${P.failing ? ` (check « ${P.failing.label} »)` : ''}`)
  P.fixer = d.fixer === 'strong' ? 'strong' : 'new'
  P.fixFindings = findings
  P.fixFailure = failure
  delete P.fixBase
  P.phase = 'fix'
  log(s, e, `${PF} : tour de correction ${P.round} (${P.fixer})`)
  return 'continue'
}

/**
 * Preuve qu'un rouge existe déjà sur main : worktree détaché temporaire sur `origin/<main>`, préparation, base de
 * test `<id>-main`, puis la même commande. Worktree et base supprimés quoi qu'il arrive.
 */
async function proveOnMain(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const f = P.failing
  const check = f && cfg.preflight.find((c) => c.label === f.label)
  if (!f || !check) return block(s, e, `${PF} : preuve sur main impossible, check rouge inconnu`)
  const wt = s.worktree as string
  const tab = s.herdr.tabs['process'] as string
  const path = proofWorktree(s.id)
  const vars = { id: `${s.id}-main`, worktree: path }
  const logs = logsDir(s)
  let downError: string | undefined
  const cleanup = async (): Promise<void> => {
    if (cfg.testDb && s.proofDbUp) {
      try {
        const r = await e.runInPane(e.herdr, tab, wt, 'preuve main · arrêt de la base', fill(cfg.testDb.down, vars), logs)
        if (r.exitCode === 0) s.proofDbUp = false
        else downError = `code ${r.exitCode}, journal : ${r.logPath}`
      } catch (err) {
        downError = errMsg(err)
      }
      if (downError) log(s, e, `${PF} : arrêt de la base ${vars.id} en échec (${downError})`)
    }
    try {
      await e.git.worktreeRemove(s.repoPath, path)
    } catch (err) {
      log(s, e, `${PF} : suppression du worktree ${path} en échec : ${errMsg(err)}`)
    }
  }
  if (s.proofDbUp || (await exists(path))) {
    log(s, e, `${PF} : restes d'une preuve interrompue dans ${path}, nettoyage`)
    await cleanup()
  }
  let failure: string | undefined
  let proof: Awaited<ReturnType<Effects['runInPane']>> | undefined
  try {
    await e.git.worktreeAddDetached(s.repoPath, path, mainRef(cfg))
    const prep = await e.runInPane(e.herdr, tab, path, 'preuve main · préparation', fill(cfg.prepare, vars), logs)
    if (prep.exitCode !== 0) failure = `préparation en échec (code ${prep.exitCode}), journal : ${prep.logPath}`
    if (!failure && cfg.testDb) {
      // Enregistré avant le lancement : `fermée` et `Engine.fail` la suppriment aussi.
      s.proofDbUp = true
      await saveState(s)
      const up = await e.runInPane(e.herdr, tab, path, 'preuve main · base de test', fill(cfg.testDb.up, vars), logs)
      if (up.exitCode !== 0) failure = `base de test ${vars.id} non créée (code ${up.exitCode}), journal : ${up.logPath}`
    }
    if (!failure) proof = await e.runInPane(e.herdr, tab, path, `preuve main · ${f.label}`, fill(check.command, vars), logs)
  } finally {
    await cleanup()
  }
  if (s.proofDbUp) return blockDbNotDown(s, e, vars.id, downError ?? 'arrêt non confirmé')
  if (failure || !proof) {
    restartRun(P)
    return block(s, e, `${PF} : preuve sur ${mainRef(cfg)} impossible pour « ${f.label} » : ${failure ?? 'aucun résultat'}`)
  }
  if (proof.exitCode === 0) {
    log(s, e, `${PF} : ${f.label} vert sur ${mainRef(cfg)}, rouge dû à la branche`)
    return startFix(s, e, '', await diagnosisBrief(s, cfg, true))
  }
  const g = openGate(
    s,
    'pr-malgre-main',
    `Le check « ${f.label} » est rouge sur la branche et aussi sur ${mainRef(cfg)} (preuve : ${proof.logPath} ; branche : ${f.logPath}). ` +
      `Ouvrir la PR malgré tout ?`,
    P.diagnosis,
  )
  P.gate = g.id
  P.phase = 'gate'
  log(s, e, `${PF} : ${f.label} rouge aussi sur ${mainRef(cfg)}, porte ${g.id} (pr-malgre-main) ouverte`)
  await notify(s, e, `Porte pr-malgre-main à valider : « ${f.label} » rouge aussi sur main`)
  await informOrchestrator(
    s,
    e,
    `Le check « ${f.label} » est rouge aussi sur ${mainRef(cfg)} (diagnostic : ${P.diagnosis}). Porte ${g.id} (pr-malgre-main) ouverte : l'utilisateur décide s'il ouvre la PR malgré tout (herness valider|refuser ${s.id} --porte ${g.id}).`,
  )
  return 'continue'
}

async function mainGate(s: MissionState, e: Effects): Promise<StepResult> {
  const P = s.loops.preflight
  const f = P.failing
  const g = s.gates.find((x) => x.id === P.gate)
  if (!f || !g) return block(s, e, `${PF} : porte pr-malgre-main introuvable`)
  if (g.status === 'pending') return 'wait'
  if (g.status === 'refused') {
    restartRun(P)
    return block(s, e, `${PF} : check « ${f.label} » rouge aussi sur main, PR refusée par l'utilisateur${g.note ? ` (${g.note})` : ''}`)
  }
  P.acceptedRed.push(f.label)
  P.results.push({ label: f.label, exitCode: f.exitCode, durationMs: f.durationMs, logPath: f.logPath, note: `rouge aussi sur origin/main, PR ouverte malgré tout (porte ${g.id})` })
  P.used = []
  delete P.failing
  delete P.gate
  delete P.phase
  log(s, e, `${PF} : ${f.label} accepté rouge (porte ${g.id}), checks suivants`)
  return 'continue'
}

async function preflightFix(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const dir = preflightDir(s)
  const file = join(dir, `correctifs-${P.round}.md`)
  if (!(await exists(file)) && arbitrationPending(s)) return 'wait'
  if (!(await exists(file))) await writeFix(s, cfg, dir, file, 'le preflight', P.fixFindings ?? '', P.fixFailure ?? '', P.stopDecision)
  delete P.stopDecision
  P.fixBase ??= await e.git.headSha(s.worktree as string)
  const name = preflightFixerName(s.id, s.loopGeneration, P.round)
  const fixBase = P.fixBase
  const make = async (): Promise<PendingAsk> => {
    P.reportSize = await fileSize(join(dir, 'rapport.md'))
    return { agent: name, file, fromSha: fixBase, report: { path: join(dir, 'rapport.md'), size: P.reportSize } }
  }
  const pa = await converse(s, e, P, fixerAgent(cfg, PF, name, `CP${P.round}`, P.fixer), make, implementerDelivered(s, e))
  if (typeof pa === 'string') return pa
  await markPane(s, e, name)
  // La branche a changé : un rouge accepté avant (rouge aussi sur main) repasse par le tri et la preuve.
  P.acceptedRed = []
  P.phase = 'control'
  return 'continue'
}

async function preflightRereview(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  const P = s.loops.preflight
  const findings = P.fixFindings || P.fixFailure || '(aucune)'
  const pa = await converse(s, e, P, reviewerAgent(s, cfg, PF), () => rereviewAsk(s, e, cfg, preflightDir(s), P.round, findings), reviewerDelivered)
  if (typeof pa === 'string') return pa
  const out = pa.out as string
  const line = await firstLine(out)
  const v = VERDICTS[line]
  if (!v) return block(s, e, `${PF} : verdict de re-revue illisible dans ${out} (« ${line} »)`)
  s.loops.globalReview.reviewedSha = pa.head ?? (await e.git.headSha(s.worktree as string))
  P.lastReview = out
  if (v === 'changes') {
    const r = await startFix(s, e, await findingsOf(out), '')
    await onCorrections(s, e, PF, out, P.round)
    return r
  }
  restartRun(P)
  log(s, e, `${PF} : correction ${P.round} approuvée, preflight rejoué en entier`)
  return 'continue'
}

// ---------------------------------------------------------------- PR (étape 10)

/** `4 s`, `2 min 05 s`. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} s`
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
}

/** Titre (premier `# `) et premier paragraphe hors titres de la spec. */
export function specSummary(md: string): { title: string | undefined; context: string } {
  const lines = md.replace(/^﻿/, '').split('\n')
  const title = lines.find((l) => /^# /.test(l))?.slice(2).trim()
  const paragraphs = lines.join('\n').split(/\n\s*\n/).map((p) => p.trim())
  const context = paragraphs.find((p) => p !== '' && !p.startsWith('#')) ?? ''
  return { title, context }
}

async function prBody(s: MissionState, cfg: ProjectConfig, context: string): Promise<string> {
  const P = s.loops.preflight
  const preflight = P.results.map((r) => {
    const accepted = P.acceptedRed.includes(r.label) ? ' — rouge déjà sur main, accepté' : r.note && r.exitCode !== 0 ? ` — ${r.note}` : ''
    return `- ${r.label} ${r.exitCode === 0 ? '✓' : '✗'} (${formatDuration(r.durationMs)})${accepted}`
  })
  return render('pr-body', {
    ticket: s.source.kind === 'text' ? 'demande écrite' : s.source.ref,
    contexte: context || '(voir la spec)',
    changements: s.tasks.map((t) => `- Tâche ${t.n} : ${t.title}`).join('\n') || '(aucune tâche)',
    tests: s.tasks.map((t) => `- Tâche ${t.n} : \`${t.testCommand}\``).join('\n') || '(aucun)',
    preflight: preflight.join('\n') || `(aucun check configuré pour ${cfg.name})`,
    specFile: specPath(s),
    planFile: planPath(s),
  })
}

/**
 * Étape 10. Refusée hors de la branche de la mission. Le moteur rebase lui-même la branche sur `origin/<main>` si
 * main a avancé (conflit → rebase annulé et mission bloquée) ; une tête autre que celle validée par le dernier
 * preflight complet (rebase, résolution à la main) → preflight rejoué. Puis push et ouverture de la PR. Idempotente : PR déjà
 * enregistrée ou déjà ouverte sur GitHub réutilisée, branche déjà poussée non repoussée.
 */
export async function stepPr(s: MissionState, e: Effects, cfg: ProjectConfig): Promise<StepResult> {
  if (s.prUrl) {
    await stopAgentsTab(s, e, 'all', 'PR ouverte')
    return goto(s, e, 'pr-ouverte')
  }
  const wt = s.worktree
  const branch = s.branch
  if (!wt || !branch || !s.type || !s.slug) return block(s, e, 'PR impossible : worktree, branche, type ou slug inconnu')
  if (branch === cfg.mainBranch) return block(s, e, `PR refusée : la branche de la mission est la branche principale (${branch})`)
  const current = await e.git.currentBranch(wt)
  if (current !== branch) return block(s, e, `PR refusée : le worktree est sur ${current}, pas sur la branche de la mission ${branch}`)
  const main = mainRef(cfg)
  await e.git.fetchMain(wt, cfg.mainBranch)
  if (!(await e.git.isAncestor(wt, main, 'HEAD'))) {
    if (s.loops.prRebases >= 1) {
      return block(s, e, `PR : main a encore bougé pendant le preflight ; reprends la mission pour relancer (${main} n'est pas ancêtre de la branche après un rebase automatique et son preflight)`)
    }
    const r = await e.git.rebaseOnto(wt, main)
    if (!r.ok) return block(s, e, `PR : conflit en rebasant la branche sur ${main} ; rebase annulé, la branche est inchangée. Résous le conflit puis reprends la mission.`)
    s.loops.prRebases += 1
    if (r.changedCode) log(s, e, `PR : branche rebasée sur ${main}`)
  }
  // Rebase (automatique ou résolu à la main) ou tout autre commit : seule la tête validée par le preflight part en PR.
  const head = await e.git.headSha(wt)
  if (head !== s.loops.preflight.validatedSha) {
    log(s, e, `PR : tête ${head} non validée par le preflight (${s.loops.preflight.validatedSha ?? 'aucune'}), preflight complet rejoué`)
    s.loops.preflight = freshLoops().preflight
    // La branche relue est la même, rejouée sur une nouvelle base : les re-revues partent de la nouvelle tête.
    s.loops.globalReview.reviewedSha = head
    return goto(s, e, 'preflight')
  }
  if ((await e.git.unpushedCount(wt, main)) > 0) {
    await e.git.push(wt, branch)
    log(s, e, `PR : branche ${branch} poussée`)
  } else {
    log(s, e, `PR : branche ${branch} déjà poussée`)
  }
  let url = await e.forge.findPr(wt, branch)
  if (url) {
    log(s, e, `PR : PR déjà ouverte pour ${branch}, réutilisée`)
  } else {
    const spec = specSummary(await readFile(join(wt, specPath(s)), 'utf8').catch(() => ''))
    const bodyFile = join(missionDir(s.id), 'pr-body.md')
    await mkdir(missionDir(s.id), { recursive: true })
    await writeFile(bodyFile, await prBody(s, cfg, spec.context))
    url = await e.forge.createPr(wt, { base: cfg.mainBranch, title: `${s.type}(${s.slug}): ${spec.title ?? s.slug}`, bodyFile })
  }
  s.prUrl = url
  log(s, e, `PR ouverte : ${url}`)
  await notify(s, e, `PR ouverte : ${url}`)
  await stopAgentsTab(s, e, 'all', 'PR ouverte')
  await informOrchestrator(s, e, `La PR est ouverte : ${url}. La mission est terminée.`)
  return goto(s, e, 'pr-ouverte')
}
