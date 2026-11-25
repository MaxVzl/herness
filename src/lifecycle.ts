import { randomUUID } from 'node:crypto'
import { access, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { agentArgs } from './agents/adapters.ts'
import { orchestratorName } from './agents/names.ts'
import { loadProjectConfig, mainRef, type ProjectConfig } from './config/project.ts'
import type { Effects } from './engine/effects.ts'
import { proofDbDown, testDbDown } from './engine/engine.ts'
import { checkEnv } from './engine/envcheck.ts'
import { confirmQuestion, pendingEntries, planReport, previewLines, sendReport } from './errreport.ts'
import { createMissionSpace, paneIsIdle, type MissionSpace } from './herdr/layout.ts'
import { missionMcpConfig } from './mcp/server.ts'
import { nextFreeTextId, parseRequest, type Request } from './mission/ids.ts'
import { postInbox } from './mission/inbox.ts'
import { assertResumable, loadState, newState, saveState, type MissionState } from './mission/state.ts'
import { missionDir, missionsRoot, planPath, specPath } from './paths.ts'
import { render } from './prompts/render.ts'
import { hernessCommand, shellLine } from './update.ts'

/** Dependencies of the lifecycle commands; tests inject fakes. */
export interface LifecycleDeps {
  e: Effects
  /** Default: `loadProjectConfig`. */
  loadConfig?: (cwd: string) => Promise<ProjectConfig>
  /** Output for the user; default: `console.log`. */
  out?: (line: string) => void
  /** Interactive terminal (`close` confirmation). */
  isTTY?: boolean
  confirm?: (question: string) => Promise<boolean>
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

/** State of an existing mission, with a clear message when it does not exist. */
async function load(id: string): Promise<MissionState> {
  if (!(await exists(join(missionDir(id), 'state.json')))) throw new Error(`mission ${id} not found (${missionDir(id)})`)
  return loadState(id)
}

function worktreePath(repoPath: string, id: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}-worktrees`, id)
}

async function requestText(d: Request, e: Effects): Promise<string> {
  if (d.kind === 'text') return `${d.ref}\n`
  if (d.kind === 'wrike') return `${d.ref}\n`
  const issue = await e.forge.readIssue(d.ref)
  const comments = issue.comments.length ? issue.comments.join('\n\n---\n\n') : '(none)'
  return `# ${issue.title}\n\n${issue.body}\n\n## Comments\n\n${comments}\n`
}

/** Orchestrator system prompt; the slug (and therefore the exact paths) is known only after classification. */
async function orchestratorPrompt(s: MissionState, d: Request, hasNote: boolean, cfg: ProjectConfig): Promise<string> {
  // The template places this value between backticks: no backtick here.
  const pattern = (dir: 'specs' | 'plans'): string =>
    `${(dir === 'specs' ? specPath : planPath)({ ...s, slug: '<slug>' })} — path determined after classification: ` +
    `folder docs/superpowers/${dir}/, name <YYYY-MM-DD>-<id>-<slug>.md, where <slug> is the one you give mission_classified`
  return render('orchestrator', {
    id: s.id,
    request: d.kind === 'text' ? 'a written request (free text)' : d.ref,
    requestFile: join(missionDir(s.id), 'request.md'),
    note: hasNote
      ? ` Also read the user's note, \`${join(missionDir(s.id), 'note.md')}\`: it complements the request and wins if they contradict.`
      : '',
    specPath: pattern('specs'),
    planPath: pattern('plans'),
    missionDir: missionDir(s.id),
    mainBranch: cfg.mainBranch,
    preflight: cfg.preflight.length
      ? cfg.preflight.map((p) => `  - ${p.label}: \`${p.command.join(' ')}\``).join('\n')
      : '  - (no preflight step in the project config)',
    language: cfg.language,
  })
}

/** The pane has only its shell in the foreground (nothing else was started in it). */
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

const OPENING = (id: string): string => `Start mission ${id}. Read your system prompt.`

/** Opening prompt of the orchestrator; the engine (sole writer of the state) records that it has started. */
async function openOrchestrator(id: string, e: Effects, agent: string): Promise<void> {
  await e.herdr.agentPrompt(agent, OPENING(id), { wait: false })
  await postInbox(id, { type: 'orchestrator-started' })
}

function applySpace(s: MissionState, space: MissionSpace): void {
  s.worktree = space.worktree
  s.herdr = { workspace: space.workspace, tabs: { ...space.tabs }, panes: { ...space.panes } }
}

/**
 * `herness dev <request> [--note]`: creates the mission (herdr workspace, worktree, state) and starts the engine,
 * dashboard and orchestrator. The note complements the request (extra detail on top of a Wrike link, for example).
 */
export async function startMission(input: string, cwd: string, deps: LifecycleDeps, opts: { note?: string } = {}): Promise<string> {
  const { e } = deps
  const out = deps.out ?? console.log
  const cfg = await (deps.loadConfig ?? loadProjectConfig)(cwd)
  const d = parseRequest(input)
  const id = d.kind === 'text' ? await nextFreeTextId(e.now()) : d.id
  if (await exists(missionDir(id))) throw new Error(`mission ${id} already exists: use herness resume ${id}`)
  const s = newState({ id, source: { kind: d.kind, ref: d.ref }, project: cfg.name, repoPath: cfg.repoPath })
  s.createdAt = e.now().toISOString()

  const env = await checkEnv(cfg.repoPath, e)
  for (const r of env) out(`${r.status} ${r.label}: ${r.detail}`)
  if (env.some((r) => r.status === 'KO')) throw new Error('incomplete environment: fix the KO lines above, then run herness dev again')

  // Read before creating anything: an unreadable issue must not leave a half-started mission behind.
  const request = await requestText(d, e)
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
  // Saved before any launch: the engine is the sole writer afterwards.
  await saveState(s)

  const dir = missionDir(id)
  await writeFile(join(dir, 'request.md'), request)
  const note = opts.note?.trim() ?? ''
  if (note) await writeFile(join(dir, 'note.md'), `${note}\n`)
  await writeFile(join(dir, 'orchestrator.md'), await orchestratorPrompt(s, d, note !== '', cfg))

  await e.herdr.paneRun(space.panes.engine, shellLine(hernessCommand(), `engine ${id}`))
  await e.herdr.paneRun(space.panes.tasks, shellLine(hernessCommand(), `tasks ${id}`))
  await e.herdr.paneRun(space.panes.spec, shellLine(hernessCommand(), `show spec ${id}`))
  await e.herdr.paneRun(space.panes.plan, shellLine(hernessCommand(), `show plan ${id}`))
  await startOrchestrator(s, e, cfg, space.panes.orchestrator, false)
  await openOrchestrator(id, e, orchestratorName(id))
  await e.herdr.tabFocus(space.tabs.master)
  out(`Mission ${id} started: herdr workspace "${id}", worktree ${space.worktree}`)
  return id
}

/**
 * `herness resume <id>`: reopens the workspace and restarts whatever is no longer running; a blocked mission asks
 * for a resume gate. `restart` (`--restart`, after a herness update): engine, dashboard and viewers are stopped
 * then started again even if they are running, so they execute the new code; nothing is sent to the agents.
 */
/** `focus` (true by default): ends by focusing the master tab; the cockpit passes false to stay on screen. */
export async function resumeMission(id: string, deps: LifecycleDeps, opts: { restart?: boolean; focus?: boolean } = {}): Promise<void> {
  const { e } = deps
  const out = deps.out ?? console.log
  const s = await load(id)
  assertResumable(s)
  if (s.step === 'closed' || s.step === 'pr-open') {
    out(`Mission ${id}: ${s.step}${s.prUrl ? ` (PR ${s.prUrl})` : ''}; nothing to resume.`)
    return
  }
  if (opts.restart) {
    // Engine first: sole writer of the state. If it does not stop, nothing is restarted.
    await stopEngine(s, e, out, 'nothing was restarted')
    for (const kind of ['tasks', 'spec', 'plan'] as const) {
      const pane = s.herdr.panes[kind]
      if (pane) await stopPane(e, pane, kind, out, `pane ${kind} still busy (${pane})`)
    }
    out('engine, dashboard and viewers stopped so they can be restarted')
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
      // Engine stopped: herness is the only writer of the state, and the recreated herdr ids are saved there.
      applySpace(s, space)
      await saveState(s)
    } else {
      out(`warning: the herdr workspace of ${id} changed while the engine is running; stop it (ctrl+c in the engine pane), then run herness resume ${id} again`)
    }
  }
  if (engineStopped) {
    await e.herdr.paneRun(space.panes.engine, shellLine(hernessCommand(), `engine ${id}`))
    out('engine restarted')
  }
  if (await paneIdle(e, space.panes.tasks)) await e.herdr.paneRun(space.panes.tasks, shellLine(hernessCommand(), `tasks ${id}`))
  for (const kind of ['spec', 'plan'] as const) {
    if (await paneIdle(e, space.panes[kind])) await e.herdr.paneRun(space.panes[kind], shellLine(hernessCommand(), `show ${kind} ${id}`))
  }
  const orchestrator = s.orchestrator.agent ?? orchestratorName(id)
  if (!(await e.herdr.agentGet(orchestrator))) {
    await startOrchestrator(s, e, cfg, space.panes.orchestrator, Boolean(s.orchestrator.sessionId))
    out(`orchestrator restarted${s.orchestrator.sessionId ? ` (session ${s.orchestrator.sessionId} resumed)` : ''}`)
  }
  if (!s.orchestrator.started) {
    // `dev` interrupted between launching the orchestrator and its opening prompt.
    await openOrchestrator(id, e, orchestrator)
    out('opening prompt sent to the orchestrator')
  }
  if (s.step === 'blocked') {
    // Only the engine opens gates: the request goes through the inbox.
    await postInbox(id, { type: 'request-gate', kind: 'resume-blocked', summary: s.blockedReason ?? 'mission blocked' })
    out(`Mission blocked: ${s.blockedReason ?? '(unknown reason)'}`)
    out(`To resume it from step ${s.blockedFrom ?? '?'}, approve the resume gate: herness approve ${id}`)
  }
  if (opts.focus !== false) await e.herdr.tabFocus(space.tabs.master)
}

/**
 * Interrupts whatever is running in a pane (double ctrl+c) and waits for it to return to the shell. Returns false
 * when the pane is unreachable (herdr restarted, workspace already closed: nothing is running there anymore),
 * throws when it stays busy.
 */
async function stopPane(e: Effects, pane: string, what: string, out: (l: string) => void, still: string): Promise<boolean> {
  const unreachable = (err: unknown): false => {
    out(`pane ${what} ${pane} unreachable: ${err instanceof Error ? err.message : String(err)}`)
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
 * Stops the engine (double ctrl+c) and waits for its pane to return to the shell. An unreachable pane (herdr
 * restarted, workspace already closed) no longer has an engine. An engine that is still running throws: two
 * writers of the state otherwise.
 */
async function stopEngine(s: MissionState, e: Effects, out: (l: string) => void, after = 'nothing was closed'): Promise<void> {
  const pane = s.herdr.panes['engine']
  if (!pane) return
  await stopPane(e, pane, 'engine', out, `engine still running, ${after} (pane ${pane})`)
}

/**
 * Deletes the mission's local branch when all of its content is already on `origin/<branch>` (never the main
 * branch, nor the branch checked out in the repository; never the remote branch or the PR). On any doubt it is
 * kept; an error does not prevent closing. Returns true when the branch was deleted.
 */
async function cleanBranch(s: MissionState, e: Effects, cfg: ProjectConfig, out: (l: string) => void): Promise<boolean> {
  const b = s.branch
  if (!b || b === cfg.mainBranch) return false
  try {
    if ((await e.git.currentBranch(s.repoPath)) === b) return false
    try {
      await e.git.fetchBranch(s.repoPath, b)
    } catch {
      out(`branch ${b} kept: origin unreachable`)
      return false
    }
    const n = await e.git.localOnlyCommits(s.repoPath, b)
    if (n === null) {
      out(`branch ${b} kept: no remote branch`)
      return false
    }
    if (n > 0) {
      out(`branch ${b} kept: ${n} commit(s) missing from origin`)
      return false
    }
    await e.git.deleteBranch(s.repoPath, b)
    out(`local branch ${b} deleted (still on origin)`)
    return true
  } catch (err) {
    out(`branch ${b} kept: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** Reminder without contacting GitHub. A read error is ignored: closing continues. */
async function remindPendingErrors(id: string, out: (l: string) => void): Promise<void> {
  try {
    const n = (await pendingEntries(id)).length
    if (n > 0) out(`${n} herness error(s) not filed: herness report ${id}`)
  } catch {
    // Unreadable log: no reminder, closing continues.
  }
}

/**
 * `herness close <id>`. Unpushed commits or a dirty worktree require confirmation in an interactive terminal. With
 * `opts.report` (the command line), it then offers to file herness errors before stopping the engine (sole writer
 * of the state; if it does not stop, nothing is closed). Then the test databases named by the reloaded state are
 * removed (a failure stops everything), the worktree is removed, state `closed` is saved, and finally the mission's
 * herdr workspace is closed (never the group). Returns false when the user cancels.
 */
export async function closeMission(id: string, deps: LifecycleDeps, opts: { report?: boolean } = {}): Promise<boolean> {
  const { e } = deps
  const out = deps.out ?? console.log
  const first = await load(id)
  // A mission closed by an approved abandon keeps its worktree and workspace: `close` cleans up what remains.
  const closed = first.step === 'closed'
  const wtLeft = !!first.worktree && (await exists(first.worktree))
  if (closed) {
    const wsLeft = !!first.herdr.workspace && (await e.herdr.workspaceList()).some((w) => w.workspaceId === first.herdr.workspace)
    if (!wtLeft && !wsLeft && !first.testDbUp && !first.proofDbUp) {
      await remindPendingErrors(id, out)
      out(`Mission ${id} already closed: nothing to close.`)
      return true
    }
  }
  const cfg = await (deps.loadConfig ?? loadProjectConfig)(first.repoPath)
  const risks: string[] = []
  if (first.worktree && (!closed || wtLeft)) {
    try {
      const n = await e.git.unpushedCount(first.worktree, mainRef(cfg))
      if (n > 0) risks.push(`${n} unpushed commit(s) on ${first.branch ?? first.worktree}`)
      if (!(await e.git.isClean(first.worktree, '.'))) risks.push(`uncommitted changes in ${first.worktree}`)
    } catch (err) {
      out(`worktree not inspected (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (risks.length > 0) {
    const what = risks.join('; ')
    if (!deps.isTTY || !deps.confirm) throw new Error(`${what}: closing requires confirmation in an interactive terminal`)
    if (!(await deps.confirm(`${what}: the worktree will be deleted (the local branch is deleted only if everything is already on origin). Close anyway?`))) {
      out('close cancelled')
      return false
    }
  }

  if (opts.report && deps.isTTY && deps.confirm) {
    try {
      if ((await pendingEntries(id)).length > 0) await reportMissionErrors(id, deps)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      out(`herness errors not filed (${message}): herness report ${id}`)
    }
  } else {
    await remindPendingErrors(id, out)
  }

  await stopEngine(first, e, out)
  // Engine stopped: herness is the sole writer, and the reloaded state says which databases the engine started.
  const s = await loadState(id)
  const errors = [await testDbDown(s, e, cfg), await proofDbDown(s, e, cfg)].filter((x): x is string => x !== null)
  if (errors.length > 0) {
    await saveState(s)
    throw new Error(`test database not removed, nothing was closed: ${errors.join('; ')}`)
  }
  if (s.worktree && (!closed || wtLeft)) {
    // Started from a pane of the worktree (`tasks` pane, mission terminal): without a current directory,
    // no git or herdr command could be launched afterwards.
    const rel = relative(s.worktree, process.cwd())
    if (!rel.startsWith('..') && !isAbsolute(rel)) process.chdir(s.repoPath)
    await e.git.worktreeRemove(s.repoPath, s.worktree)
  }
  const branchDeleted = await cleanBranch(s, e, cfg, out)
  s.step = 'closed'
  s.log.push({ at: e.now().toISOString(), msg: 'mission closed (herness close)' })
  await saveState(s)
  // Last: `close` may be launched from a pane of this workspace.
  if (s.herdr.workspace && (!closed || (await e.herdr.workspaceList()).some((w) => w.workspaceId === s.herdr.workspace))) {
    await e.herdr.workspaceClose(s.herdr.workspace)
  }
  out(`Mission ${id} closed (branch ${s.branch ?? '?'} ${branchDeleted ? 'deleted locally' : 'kept'}).`)
  return true
}

/**
 * `herness delete`: removes the folder of a fully closed mission (state, spec, plan, logs).
 * Refuses while something is left to close: `close` is the only command that stops the engine, databases and workspace.
 */
export async function deleteMission(id: string, deps: LifecycleDeps, opts: { force?: boolean } = {}): Promise<boolean> {
  const out = deps.out ?? console.log
  const s = await load(id)
  if (s.step !== 'closed') throw new Error(`mission ${id} is not closed: herness close ${id} first`)
  const left: string[] = []
  if (s.worktree && (await exists(s.worktree))) left.push(`the worktree ${s.worktree}`)
  if (s.herdr.workspace && (await deps.e.herdr.workspaceList()).some((w) => w.workspaceId === s.herdr.workspace)) left.push('the herdr workspace')
  if (s.testDbUp || s.proofDbUp) left.push('a test database')
  if (left.length > 0) throw new Error(`${left.join(', ')} ${left.length > 1 ? 'are' : 'is'} still there: run herness close ${id} again`)
  if (!opts.force) {
    if (!deps.isTTY || !deps.confirm) throw new Error('deletion requires confirmation in an interactive terminal (or --yes)')
    if (!(await deps.confirm(`Permanently delete mission ${id} (state, spec, plan, logs)?`))) {
      out('deletion cancelled')
      return false
    }
  }
  await rm(missionDir(id), { recursive: true, force: true })
  out(`Mission ${id} deleted.`)
  return true
}

/**
 * `herness report`: files a mission's herness errors as GitHub issues.
 * Does not read or write `state.json` beyond the initial load.
 */
export async function reportMissionErrors(id: string, deps: LifecycleDeps, opts: { force?: boolean } = {}): Promise<boolean> {
  const out = deps.out ?? console.log
  await load(id)
  const plan = await planReport(id, deps.e.run)
  if (plan.length === 0) {
    out(`No herness error to file for mission ${id}.`)
    return true
  }
  if (!opts.force && !(deps.isTTY && deps.confirm)) {
    throw new Error('sending requires confirmation in an interactive terminal (or --yes)')
  }
  for (const line of previewLines(id, plan)) out(line)
  if (!opts.force && deps.confirm && !(await deps.confirm(confirmQuestion(plan)))) {
    out(`nothing was sent (herness report ${id} to try again)`)
    return false
  }
  for (const line of await sendReport(id, plan, deps.e.run, () => deps.e.now())) out(line)
  return true
}

function taskSummary(s: MissionState): string {
  const t = s.tasks.find((x) => x.phase !== 'done') ?? s.tasks.at(-1)
  return t ? `${t.n}/${s.tasks.length} ${t.phase}` : '-'
}

/** `herness status [<id>]`: one line per mission, or the detail of one mission. */
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
        [s.id, s.step, `task ${taskSummary(s)}`, `gates ${pending.join(',') || '-'}`, s.prUrl ?? ''].join('  ').trimEnd(),
      )
    }
    return lines.length ? lines : ['no missions']
  }
  const s = await load(id)
  const lines = [
    `Mission ${s.id} (${s.source.kind}: ${s.source.ref})`,
    `Step: ${s.step}${s.paused ? ' (paused)' : ''}`,
  ]
  if (s.step === 'blocked') lines.push(`Blocked since ${s.blockedFrom ?? '?'}: ${s.blockedReason ?? '?'}`)
  if (s.branch) lines.push(`Branch: ${s.branch}`)
  if (s.worktree) lines.push(`Worktree: ${s.worktree}`)
  if (s.prUrl) lines.push(`PR: ${s.prUrl}`)
  for (const t of s.tasks) lines.push(`Task ${t.n}: ${t.title} — ${t.phase}${t.round ? ` (round ${t.round})` : ''}`)
  const pending = s.gates.filter((g) => g.status === 'pending')
  lines.push(pending.length ? 'Pending gates:' : 'No pending gate')
  for (const g of pending) lines.push(`- ${g.id} (${g.kind}): ${g.summary}`)
  const r = s.loops.preflight.results
  if (r.length) lines.push(`Preflight: ${r.map((x) => `${x.label} ${x.exitCode === 0 ? '✓' : '✗'}`).join(', ')}`)
  lines.push('Log:', ...s.log.slice(-10).map((l) => `  ${l.at} ${l.msg}`))
  return lines
}
