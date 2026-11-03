import { randomUUID } from 'node:crypto'
import { access, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentArgs } from './agents/adapters.ts'
import { orchestratorName } from './agents/names.ts'
import { loadProjectConfig, type ProjectConfig } from './config/project.ts'
import type { Effects } from './engine/effects.ts'
import { proofDbDown, testDbDown } from './engine/engine.ts'
import { checkEnv } from './engine/envcheck.ts'
import { createMissionSpace, paneIsIdle, type MissionSpace } from './herdr/layout.ts'
import { missionMcpConfig } from './mcp/server.ts'
import { nextFreeTextId, parseDemande, type Demande } from './mission/ids.ts'
import { postInbox } from './mission/inbox.ts'
import { loadState, newState, saveState, type MissionState } from './mission/state.ts'
import { missionDir, missionsRoot, planPath, specPath } from './paths.ts'
import { render } from './prompts/render.ts'

/** Dépendances des commandes de cycle de vie ; les tests injectent des doublures. */
export interface LifecycleDeps {
  e: Effects
  /** Défaut : `loadProjectConfig`. */
  loadConfig?: (cwd: string) => Promise<ProjectConfig>
  /** Sortie pour l'utilisateur ; défaut : `console.log`. */
  out?: (line: string) => void
  /** Terminal interactif (confirmation de `fermer`). */
  isTTY?: boolean
  confirm?: (question: string) => Promise<boolean>
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(packageRoot, 'bin', 'herness.js')
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)
const mainRef = (cfg: ProjectConfig): string => `origin/${cfg.mainBranch}`

/** État d'une mission existante, avec un message clair si elle n'existe pas. */
async function load(id: string): Promise<MissionState> {
  if (!(await exists(join(missionDir(id), 'state.json')))) throw new Error(`mission ${id} introuvable (${missionDir(id)})`)
  return loadState(id)
}

function worktreePath(repoPath: string, id: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}-worktrees`, id)
}

async function demandeText(d: Demande, e: Effects): Promise<string> {
  if (d.kind === 'text') return `${d.ref}\n`
  if (d.kind === 'wrike') return `${d.ref}\n`
  const issue = await e.forge.readIssue(d.ref)
  const comments = issue.comments.length ? issue.comments.join('\n\n---\n\n') : '(aucun)'
  return `# ${issue.title}\n\n${issue.body}\n\n## Commentaires\n\n${comments}\n`
}

/** Prompt système de l'orchestrateur ; le slug (et donc les chemins exacts) n'est connu qu'après classement. */
async function orchestratorPrompt(s: MissionState, d: Demande, hasNote: boolean): Promise<string> {
  // Valeur placée entre accents graves par le gabarit : aucun accent grave ici.
  const pattern = (dir: 'specs' | 'plans'): string =>
    `${(dir === 'specs' ? specPath : planPath)({ ...s, slug: '<slug>' })} — chemin déterminé après classement : ` +
    `dossier docs/superpowers/${dir}/, nom <AAAA-MM-JJ>-<id>-<slug>.md, où <slug> est celui que tu donnes à mission_identifiee`
  return render('orchestrator', {
    id: s.id,
    demande: d.kind === 'text' ? 'une demande écrite (texte libre)' : d.ref,
    demandeFile: join(missionDir(s.id), 'demande.md'),
    note: hasNote
      ? ` Lis aussi la note de l'utilisateur, \`${join(missionDir(s.id), 'note.md')}\` : elle complète la demande et l'emporte en cas de contradiction.`
      : '',
    specPath: pattern('specs'),
    planPath: pattern('plans'),
    missionDir: missionDir(s.id),
  })
}

/** Le panneau n'a que son shell au premier plan (aucun processus lancé dedans). */
async function paneIdle(e: Effects, pane: string): Promise<boolean> {
  return paneIsIdle(await e.herdr.paneProcessInfo(pane))
}

async function startOrchestrator(s: MissionState, e: Effects, cfg: ProjectConfig, pane: string, resume: boolean): Promise<void> {
  const dir = missionDir(s.id)
  const launch = agentArgs('orchestrator', {
    model: cfg.models.orchestrator,
    permissionMode: cfg.orchestratorPermissionMode,
    worktree: s.worktree as string,
    missionDir: dir,
    mcpConfigPath: await missionMcpConfig(s.id),
    systemPromptPath: join(dir, 'orchestrator.md'),
    ...(s.orchestrator.sessionId ? { sessionId: s.orchestrator.sessionId } : {}),
    resume,
  })
  await e.agents.start(s.orchestrator.agent ?? orchestratorName(s.id), 'orchestrator', pane, launch)
}

const OPENING = (id: string): string => `Commence la mission ${id}. Lis ton prompt système.`

/** Prompt d'ouverture de l'orchestrateur ; le moteur (seul écrivain de l'état) enregistre qu'il est parti. */
async function openOrchestrator(id: string, e: Effects, agent: string): Promise<void> {
  await e.herdr.agentPrompt(agent, OPENING(id), { wait: false })
  await postInbox(id, { type: 'orchestrator-started' })
}

function applySpace(s: MissionState, space: MissionSpace): void {
  s.worktree = space.worktree
  s.herdr = { workspace: space.workspace, tabs: { ...space.tabs }, panes: { ...space.panes } }
}

/**
 * `herness dev <demande> [--note]` : crée la mission (espace herdr, worktree, état) et lance moteur, tableau et
 * orchestrateur. La note complète la demande (précisions en plus d'un lien Wrike, par exemple).
 */
export async function startMission(input: string, cwd: string, deps: LifecycleDeps, opts: { note?: string } = {}): Promise<string> {
  const { e } = deps
  const out = deps.out ?? console.log
  const cfg = await (deps.loadConfig ?? loadProjectConfig)(cwd)
  const d = parseDemande(input)
  const id = d.kind === 'text' ? await nextFreeTextId(e.now()) : d.id
  if (await exists(missionDir(id))) throw new Error(`mission ${id} déjà existante : utilise herness reprendre ${id}`)
  const s = newState({ id, source: { kind: d.kind, ref: d.ref }, project: cfg.name, repoPath: cfg.repoPath })
  s.createdAt = e.now().toISOString()

  const env = await checkEnv(cfg.repoPath, e)
  for (const r of env) out(`${r.status} ${r.label} : ${r.detail}`)
  if (env.some((r) => r.status === 'KO')) throw new Error('environnement incomplet : corrige les KO ci-dessus puis relance herness dev')

  // Lue avant de rien créer : une issue illisible n'abandonne pas une mission à moitié lancée.
  const demande = await demandeText(d, e)
  await e.git.fetchMain(cfg.repoPath, cfg.mainBranch)
  const branch = `herness/${id}`
  const space = await createMissionSpace(e.herdr, {
    projectCwd: cfg.repoPath,
    id,
    branch,
    base: mainRef(cfg),
    worktreePath: worktreePath(cfg.repoPath, id),
  })
  applySpace(s, space)
  s.branch = branch
  s.orchestrator = { agent: orchestratorName(id), sessionId: randomUUID() }
  // Enregistré avant tout lancement : le moteur en est ensuite le seul écrivain.
  await saveState(s)

  const dir = missionDir(id)
  await writeFile(join(dir, 'demande.md'), demande)
  const note = opts.note?.trim() ?? ''
  if (note) await writeFile(join(dir, 'note.md'), `${note}\n`)
  await writeFile(join(dir, 'orchestrator.md'), await orchestratorPrompt(s, d, note !== ''))

  await e.herdr.paneRun(space.panes.engine, `node ${shq(BIN)} engine ${id}`)
  await e.herdr.paneRun(space.panes.tasks, `node ${shq(BIN)} tasks ${id}`)
  await e.herdr.paneRun(space.panes.spec, `node ${shq(BIN)} voir spec ${id}`)
  await e.herdr.paneRun(space.panes.plan, `node ${shq(BIN)} voir plan ${id}`)
  await startOrchestrator(s, e, cfg, space.panes.orchestrator, false)
  await openOrchestrator(id, e, orchestratorName(id))
  await e.herdr.tabFocus(space.tabs.master)
  out(`Mission ${id} lancée : espace herdr « ${id} », worktree ${space.worktree}`)
  return id
}

/**
 * `herness reprendre <id>` : rouvre l'espace, relance ce qui ne tourne plus ; une mission bloquée demande une porte
 * de reprise. `restart` (`--redemarrer`, après une mise à jour de herness) : moteur, tableau et visionneuses sont
 * arrêtés puis relancés même s'ils tournent, pour exécuter le nouveau code ; rien n'est envoyé aux agents.
 */
/** `focus` (vrai par défaut) : finit en focalisant l'onglet master ; le cockpit passe faux pour rester à l'écran. */
export async function resumeMission(id: string, deps: LifecycleDeps, opts: { restart?: boolean; focus?: boolean } = {}): Promise<void> {
  const { e } = deps
  const out = deps.out ?? console.log
  const s = await load(id)
  if (s.step === 'fermée' || s.step === 'pr-ouverte') {
    out(`Mission ${id} : ${s.step}${s.prUrl ? ` (PR ${s.prUrl})` : ''} ; rien à reprendre.`)
    return
  }
  if (opts.restart) {
    // Moteur d'abord : seul écrivain de l'état. S'il ne s'arrête pas, rien n'est relancé.
    await stopEngine(s, e, out, "rien n'a été relancé")
    for (const kind of ['tasks', 'spec', 'plan'] as const) {
      const pane = s.herdr.panes[kind]
      if (pane) await stopPane(e, pane, kind, out, `panneau ${kind} toujours actif (${pane})`)
    }
    out('moteur, tableau et visionneuses arrêtés pour être relancés')
  }
  const cfg = await (deps.loadConfig ?? loadProjectConfig)(s.repoPath)
  const space = await createMissionSpace(e.herdr, {
    projectCwd: s.repoPath,
    id,
    branch: s.branch ?? `herness/${id}`,
    base: mainRef(cfg),
    worktreePath: s.worktree ?? worktreePath(s.repoPath, id),
  })

  const engineStopped = await paneIdle(e, space.panes.engine)
  const same = s.herdr.workspace === space.workspace && Object.entries(space.panes).every(([k, v]) => s.herdr.panes[k] === v)
  if (!same) {
    if (engineStopped) {
      // Moteur arrêté : herness est seul à écrire l'état, les identifiants herdr recréés y sont enregistrés.
      applySpace(s, space)
      await saveState(s)
    } else {
      out(`attention : l'espace herdr de ${id} a changé alors que le moteur tourne ; arrête-le (ctrl+c dans le panneau engine) puis relance herness reprendre ${id}`)
    }
  }
  if (engineStopped) {
    await e.herdr.paneRun(space.panes.engine, `node ${shq(BIN)} engine ${id}`)
    out('moteur relancé')
  }
  if (await paneIdle(e, space.panes.tasks)) await e.herdr.paneRun(space.panes.tasks, `node ${shq(BIN)} tasks ${id}`)
  for (const kind of ['spec', 'plan'] as const) {
    if (await paneIdle(e, space.panes[kind])) await e.herdr.paneRun(space.panes[kind], `node ${shq(BIN)} voir ${kind} ${id}`)
  }
  const orchestrator = s.orchestrator.agent ?? orchestratorName(id)
  if (!(await e.herdr.agentGet(orchestrator))) {
    await startOrchestrator(s, e, cfg, space.panes.orchestrator, Boolean(s.orchestrator.sessionId))
    out(`orchestrateur relancé${s.orchestrator.sessionId ? ` (session ${s.orchestrator.sessionId} reprise)` : ''}`)
  }
  if (!s.orchestrator.started) {
    // `dev` interrompu entre le lancement de l'orchestrateur et son prompt d'ouverture.
    await openOrchestrator(id, e, orchestrator)
    out("prompt d'ouverture envoyé à l'orchestrateur")
  }
  if (s.step === 'bloquée') {
    // Seul le moteur ouvre les portes : la demande passe par l'inbox.
    await postInbox(id, { type: 'request-gate', kind: 'reprise-bloquee', summary: s.blockedReason ?? 'mission bloquée' })
    out(`Mission bloquée : ${s.blockedReason ?? '(raison inconnue)'}`)
    out(`Pour la reprendre à l'étape ${s.blockedFrom ?? '?'}, valide la porte de reprise : herness valider ${id}`)
  }
  if (opts.focus !== false) await e.herdr.tabFocus(space.tabs.master)
}

/**
 * Interrompt ce qui tourne dans un panneau (double ctrl+c) et attend qu'il revienne au shell. Rend faux si le
 * panneau est injoignable (herdr redémarré, espace déjà fermé : plus rien n'y tourne), lève s'il reste occupé.
 */
async function stopPane(e: Effects, pane: string, what: string, out: (l: string) => void, still: string): Promise<boolean> {
  const unreachable = (err: unknown): false => {
    out(`panneau ${what} ${pane} injoignable : ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  try {
    await e.herdr.paneSendKeys(pane, 'ctrl+c')
    await e.herdr.paneSendKeys(pane, 'ctrl+c')
  } catch (err) {
    return unreachable(err)
  }
  for (let i = 0; i < 20; i++) {
    let idle: boolean
    try {
      idle = await paneIdle(e, pane)
    } catch (err) {
      return unreachable(err)
    }
    if (idle) return true
    await e.sleep(250)
  }
  throw new Error(still)
}

/**
 * Arrête le moteur (double ctrl+c) et attend que son panneau revienne au shell. Un panneau injoignable (herdr
 * redémarré, espace déjà fermé) n'a plus de moteur. Un moteur toujours actif lève : deux écrivains de l'état sinon.
 */
async function stopEngine(s: MissionState, e: Effects, out: (l: string) => void, after = "rien n'a été fermé"): Promise<void> {
  const pane = s.herdr.panes['engine']
  if (!pane) return
  await stopPane(e, pane, 'du moteur', out, `moteur toujours actif, ${after} (panneau ${pane})`)
}

/**
 * Supprime la branche locale de la mission si tout son contenu est déjà sur `origin/<branche>` (jamais la branche
 * principale ni la branche extraite dans le dépôt ; jamais la branche distante ni la PR). Au moindre doute elle est
 * gardée ; une erreur n'empêche pas la fermeture. Rend vrai si la branche a été supprimée.
 */
async function cleanBranch(s: MissionState, e: Effects, cfg: ProjectConfig, out: (l: string) => void): Promise<boolean> {
  const b = s.branch
  if (!b || b === cfg.mainBranch) return false
  try {
    if ((await e.git.currentBranch(s.repoPath)) === b) return false
    try {
      await e.git.fetchBranch(s.repoPath, b)
    } catch {
      out(`branche ${b} gardée : origine injoignable`)
      return false
    }
    const n = await e.git.localOnlyCommits(s.repoPath, b)
    if (n === null) {
      out(`branche ${b} gardée : pas de branche distante`)
      return false
    }
    if (n > 0) {
      out(`branche ${b} gardée : ${n} commit(s) absent(s) de origin`)
      return false
    }
    await e.git.deleteBranch(s.repoPath, b)
    out(`branche locale ${b} supprimée (toujours sur origin)`)
    return true
  } catch (err) {
    out(`branche ${b} gardée : ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * `herness fermer <id>`. Commits non poussés ou worktree sale → confirmation dans un terminal interactif. Moteur
 * arrêté d'abord (seul écrivain de l'état ; s'il ne s'arrête pas, rien n'est fermé), puis bases de test supprimées
 * d'après l'état relu (un échec arrête tout), worktree supprimé, état `fermée` enregistré, et enfin l'espace herdr de
 * la mission fermé (jamais le groupe). Rend faux si l'utilisateur annule.
 */
export async function closeMission(id: string, deps: LifecycleDeps): Promise<boolean> {
  const { e } = deps
  const out = deps.out ?? console.log
  const first = await load(id)
  // Une mission fermée par un abandon validé garde son worktree et son espace : `fermer` nettoie ce qui reste.
  const closed = first.step === 'fermée'
  const wtLeft = !!first.worktree && (await exists(first.worktree))
  if (closed) {
    const wsLeft = !!first.herdr.workspace && (await e.herdr.workspaceList()).some((w) => w.workspaceId === first.herdr.workspace)
    if (!wtLeft && !wsLeft && !first.testDbUp && !first.proofDbUp) {
      out(`Mission ${id} déjà fermée : rien à fermer.`)
      return true
    }
  }
  const cfg = await (deps.loadConfig ?? loadProjectConfig)(first.repoPath)
  const risks: string[] = []
  if (first.worktree && (!closed || wtLeft)) {
    try {
      const n = await e.git.unpushedCount(first.worktree, mainRef(cfg))
      if (n > 0) risks.push(`${n} commit(s) non poussé(s) sur ${first.branch ?? first.worktree}`)
      if (!(await e.git.isClean(first.worktree, '.'))) risks.push(`modifications non commitées dans ${first.worktree}`)
    } catch (err) {
      out(`worktree non inspecté (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (risks.length > 0) {
    const what = risks.join(' ; ')
    if (!deps.isTTY || !deps.confirm) throw new Error(`${what} : la fermeture demande une confirmation dans un terminal interactif`)
    if (!(await deps.confirm(`${what} : le worktree sera supprimé (la branche locale n'est supprimée que si tout est déjà sur origin). Fermer quand même ?`))) {
      out('fermeture annulée')
      return false
    }
  }

  await stopEngine(first, e, out)
  // Moteur arrêté : herness est seul écrivain, et l'état relu dit quelles bases le moteur a lancées.
  const s = await loadState(id)
  const errors = [await testDbDown(s, e, cfg), await proofDbDown(s, e, cfg)].filter((x): x is string => x !== null)
  if (errors.length > 0) {
    await saveState(s)
    throw new Error(`base de test non supprimée, rien n'a été fermé : ${errors.join(' ; ')}`)
  }
  if (s.worktree && (!closed || wtLeft)) {
    // Lancé depuis un panneau du worktree (panneau `tasks`, terminal de la mission) : sans dossier courant,
    // plus aucun git ni herdr ne pourrait être lancé ensuite.
    const rel = relative(s.worktree, process.cwd())
    if (!rel.startsWith('..') && !isAbsolute(rel)) process.chdir(s.repoPath)
    await e.git.worktreeRemove(s.repoPath, s.worktree)
  }
  const branchDeleted = await cleanBranch(s, e, cfg, out)
  s.step = 'fermée'
  s.log.push({ at: e.now().toISOString(), msg: 'mission fermée (herness fermer)' })
  await saveState(s)
  // En dernier : `fermer` peut être lancé depuis un panneau de cet espace.
  if (s.herdr.workspace && (!closed || (await e.herdr.workspaceList()).some((w) => w.workspaceId === s.herdr.workspace))) {
    await e.herdr.workspaceClose(s.herdr.workspace)
  }
  out(`Mission ${id} fermée (branche ${s.branch ?? '?'} ${branchDeleted ? 'supprimée localement' : 'conservée'}).`)
  return true
}

/**
 * `herness supprimer` : efface le dossier d'une mission complètement fermée (état, spec, plan, journaux).
 * Refuse tant qu'il reste quelque chose à fermer : `fermer` est le seul à arrêter moteur, bases et espace.
 */
export async function deleteMission(id: string, deps: LifecycleDeps, opts: { force?: boolean } = {}): Promise<boolean> {
  const out = deps.out ?? console.log
  const s = await load(id)
  if (s.step !== 'fermée') throw new Error(`mission ${id} pas fermée : herness fermer ${id} d'abord`)
  const left: string[] = []
  if (s.worktree && (await exists(s.worktree))) left.push(`le worktree ${s.worktree}`)
  if (s.herdr.workspace && (await deps.e.herdr.workspaceList()).some((w) => w.workspaceId === s.herdr.workspace)) left.push("l'espace herdr")
  if (s.testDbUp || s.proofDbUp) left.push('une base de test')
  if (left.length > 0) throw new Error(`il reste ${left.join(', ')} : relance herness fermer ${id}`)
  if (!opts.force) {
    if (!deps.isTTY || !deps.confirm) throw new Error('la suppression demande une confirmation dans un terminal interactif (ou --oui)')
    if (!(await deps.confirm(`Supprimer définitivement la mission ${id} (état, spec, plan, journaux) ?`))) {
      out('suppression annulée')
      return false
    }
  }
  await rm(missionDir(id), { recursive: true, force: true })
  out(`Mission ${id} supprimée.`)
  return true
}

function taskSummary(s: MissionState): string {
  const t = s.tasks.find((x) => x.phase !== 'done') ?? s.tasks.at(-1)
  return t ? `${t.n}/${s.tasks.length} ${t.phase}` : '-'
}

/** `herness statut [<id>]` : une ligne par mission, ou le détail d'une mission. */
export async function missionStatus(id?: string): Promise<string[]> {
  if (id === undefined) {
    const names = (await readdir(missionsRoot()).catch(() => [] as string[])).sort()
    const lines: string[] = []
    for (const name of names) {
      let s: MissionState
      try {
        s = await loadState(name)
      } catch {
        continue
      }
      const pending = s.gates.filter((g) => g.status === 'pending').map((g) => g.id)
      lines.push(
        [s.id, s.step, `tâche ${taskSummary(s)}`, `portes ${pending.join(',') || '-'}`, s.prUrl ?? ''].join('  ').trimEnd(),
      )
    }
    return lines.length ? lines : ['aucune mission']
  }
  const s = await load(id)
  const lines = [
    `Mission ${s.id} (${s.source.kind} : ${s.source.ref})`,
    `Étape : ${s.step}${s.paused ? ' (en pause)' : ''}`,
  ]
  if (s.step === 'bloquée') lines.push(`Bloquée depuis ${s.blockedFrom ?? '?'} : ${s.blockedReason ?? '?'}`)
  if (s.branch) lines.push(`Branche : ${s.branch}`)
  if (s.worktree) lines.push(`Worktree : ${s.worktree}`)
  if (s.prUrl) lines.push(`PR : ${s.prUrl}`)
  for (const t of s.tasks) lines.push(`Tâche ${t.n} : ${t.title} — ${t.phase}${t.round ? ` (tour ${t.round})` : ''}`)
  const pending = s.gates.filter((g) => g.status === 'pending')
  lines.push(pending.length ? 'Portes en attente :' : 'Aucune porte en attente')
  for (const g of pending) lines.push(`- ${g.id} (${g.kind}) : ${g.summary}`)
  const r = s.loops.preflight.results
  if (r.length) lines.push(`Preflight : ${r.map((x) => `${x.label} ${x.exitCode === 0 ? '✓' : '✗'}`).join(', ')}`)
  lines.push('Journal :', ...s.log.slice(-10).map((l) => `  ${l.at} ${l.msg}`))
  return lines
}
