import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import type { ProjectConfig } from '../../src/config/project.ts'
import { logHernessError } from '../../src/errlog.ts'
import { closeMission, deleteMission, missionStatus, reportMissionErrors, resumeMission, startMission, type LifecycleDeps } from '../../src/lifecycle.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { LegacyMissionError, loadState, newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir } from '../../src/paths.ts'
import { fakeEffects, type FakeEffects, type FakeOverrides } from '../fakes.ts'

let home: string
let repo: string
let cfg: ProjectConfig
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-life-'))
  process.env.HERNESS_HOME = home
  repo = join(home, 'projet-demo')
  await mkdir(repo, { recursive: true })
  cfg = { ...demo, repoPath: repo }
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const exists = (p: string) => access(p).then(() => true, () => false)
const BIN = resolve('bin/herness.js')

type Extra = { isTTY?: boolean; confirm?: (question: string) => Promise<boolean> }

function deps(over: FakeOverrides = {}, extra: Extra = {}) {
  // Clean worktree by default (the generic fake makes `isClean` false).
  const fx: FakeEffects = fakeEffects({ ...over, git: { isClean: async () => true, ...over.git } })
  const out: string[] = []
  const d: LifecycleDeps = { e: fx, loadConfig: async () => cfg, out: (l: string) => void out.push(l), ...extra }
  return { fx, out, d }
}

// ---------- dev ----------

test('dev creates the workspace, saves the state, then starts the engine, dashboard and orchestrator', async () => {
  const { fx, d } = deps({
    forge: { readIssue: async () => ({ title: 'Export CSV', body: 'Il faut exporter.', comments: ['c1', 'c2'] }) },
    agents: {
      start: async () => {
        // The state is saved before processes are started.
        expect((await loadState('gh12')).herdr.workspace).toBeTruthy()
      },
    },
  })
  cfg = { ...cfg, language: 'fr' }
  const id = await startMission('https://github.com/o/r/issues/12', repo, d)
  expect(id).toBe('gh12')
  const s = await loadState('gh12')
  const wt = join(home, 'projet-demo-worktrees', 'gh12')
  expect(s).toMatchObject({ id: 'gh12', step: 'env', worktree: wt, branch: 'herness/gh12', repoPath: repo, project: 'demo' })
  expect(s.source).toEqual({ kind: 'github', ref: 'https://github.com/o/r/issues/12' })
  expect(fx.callsOf('git.fetchMain')[0]).toEqual([repo, 'main'])
  expect(fx.herdr.calls).toContain(`worktreeCreate gh12 herness/gh12 origin/main ${wt} ${repo}`)
  expect(s.herdr.tabs).toMatchObject({ master: expect.any(String), docs: expect.any(String), agents: expect.any(String), checks: expect.any(String), process: expect.any(String) })
  expect(s.herdr.panes).toMatchObject({ spec: expect.any(String), plan: expect.any(String), orchestrator: expect.any(String), tasks: expect.any(String), engine: expect.any(String) })

  const request = await readFile(join(missionDir('gh12'), 'request.md'), 'utf8')
  expect(request).toMatch(/^# Export CSV\n\nIl faut exporter\.\n\n## Comments\n/)
  expect(request).toContain('c1')
  expect(request).toContain('c2')
  expect(await exists(join(missionDir('gh12'), 'mcp.json'))).toBe(true)
  const prompt = await readFile(join(missionDir('gh12'), 'orchestrator.md'), 'utf8')
  expect(prompt).toContain('path determined after classification')
  expect(prompt).toContain('docs/superpowers/specs/')
  expect(prompt).toContain('docs/superpowers/plans/')
  expect(prompt).toContain('<YYYY-MM-DD>-<id>-<slug>.md')
  expect(prompt).toContain('mission_classified')
  expect(prompt).toContain('### Task <n>: <title>')
  expect(prompt).toContain('**Test:**')
  expect(prompt).toMatch(/\bfr\b/)
  expect(prompt).not.toContain('Tu r\u00e9ponds en fran\u00e7ais')
  expect(prompt).toContain(join(missionDir('gh12'), 'request.md'))
  // After the PR: the mission branch read from the worktree (renamed at classification), the project main and
  // the project preflight, spelled out.
  expect(prompt).toContain('git push --force-with-lease origin HEAD')
  expect(prompt).toContain('git branch --show-current')
  expect(prompt).not.toContain('herness/gh12')
  expect(prompt).toContain(`git rebase origin/${cfg.mainBranch}`)
  for (const p of cfg.preflight) expect(prompt).toContain(`  - ${p.label}: \`${p.command.join(' ')}\``)

  const runs = fx.herdr.runs.filter((r) => !r.cmd.startsWith('lazygit'))
  expect(runs).toEqual([
    { pane: s.herdr.panes['engine'], cmd: `node '${BIN}' engine gh12` },
    { pane: s.herdr.panes['tasks'], cmd: `node '${BIN}' tasks gh12` },
    { pane: s.herdr.panes['spec'], cmd: `node '${BIN}' show spec gh12` },
    { pane: s.herdr.panes['plan'], cmd: `node '${BIN}' show plan gh12` },
  ])
  const [name, role, pane, launch] = fx.callsOf('agents.start')[0]!
  expect([name, role, pane]).toEqual(['ogh12', 'orchestrator', s.herdr.panes['orchestrator']])
  const args = (launch as { args: string[] }).args
  expect(s.orchestrator.agent).toBe('ogh12')
  expect(s.orchestrator.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(args).toEqual(expect.arrayContaining(['--session-id', s.orchestrator.sessionId!, '--mcp-config', join(missionDir('gh12'), 'mcp.json')]))
  expect(args).toEqual(expect.arrayContaining(['--append-system-prompt-file', join(missionDir('gh12'), 'orchestrator.md'), 'claude-opus-5-5']))
  expect(args[args.indexOf('--permission-mode') + 1]).toBe(cfg.orchestratorPermissionMode)
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([['ogh12', 'Start mission gh12. Read your system prompt.', { wait: false }]])
  // The engine, sole writer of the state, will record that the opening prompt was sent.
  expect(await drainInbox('gh12')).toEqual([{ type: 'orchestrator-started' }])
  expect(fx.herdr.calls.at(-1)).toBe(`tabFocus ${s.herdr.tabs['master']}`)
})

test('startMission writes request.md', async () => {
  const { d } = deps({ now: () => new Date(2026, 9, 30, 9) })
  const id = await startMission('  add a CSV export  ', repo, d)
  expect(await readFile(join(missionDir(id), 'request.md'), 'utf8')).toBe('add a CSV export\n')
})

test('dev with free text: today\'s id and the request written as given', async () => {
  const { d } = deps({ now: () => new Date(2026, 9, 30, 9) })
  const id = await startMission('  add a CSV export  ', repo, d)
  expect(id).toBe('20261030-1')
  expect(await readFile(join(missionDir(id), 'request.md'), 'utf8')).toBe('add a CSV export\n')
  expect(await readFile(join(missionDir(id), 'orchestrator.md'), 'utf8')).toContain('a written request (free text)')
  expect((await loadState(id)).source).toEqual({ kind: 'text', ref: 'add a CSV export' })
})

test('dev with a note: note.md is written and mentioned to the orchestrator', async () => {
  const { d } = deps()
  await startMission('https://github.com/o/r/issues/12', repo, d, { note: '  do not touch the PDF export\n' })
  const note = join(missionDir('gh12'), 'note.md')
  expect(await readFile(note, 'utf8')).toBe("do not touch the PDF export\n")
  const prompt = await readFile(join(missionDir('gh12'), 'orchestrator.md'), 'utf8')
  expect(prompt).toContain(`Also read the user's note, \`${note}\``)
})

test('dev without a note (or an empty note): no note.md and no mention in the prompt', async () => {
  const { d } = deps()
  await startMission('https://github.com/o/r/issues/12', repo, d, { note: '   ' })
  expect(await exists(join(missionDir('gh12'), 'note.md'))).toBe(false)
  expect(await readFile(join(missionDir('gh12'), 'orchestrator.md'), 'utf8')).not.toContain("user's note")
})

test('dev refuses a mission id that already exists', async () => {
  await mkdir(missionDir('gh12'), { recursive: true })
  const { fx, d } = deps()
  await expect(startMission('https://github.com/o/r/issues/12', repo, d)).rejects.toThrow(
    'mission gh12 already exists: use herness resume gh12',
  )
  expect(fx.calls).toEqual([])
  expect(fx.herdr.calls).toEqual([])
})

test('dev stops on an environment KO without creating anything', async () => {
  const { fx, out, d } = deps({
    run: async (cmd: string) =>
      cmd === 'herdr' ? { stdout: '', stderr: 'down', exitCode: 1 } : { stdout: cmd === 'cursor-agent' ? 'Logged in' : '', stderr: '', exitCode: 0 },
  })
  await expect(startMission('https://github.com/o/r/issues/12', repo, d)).rejects.toThrow(/environment/)
  expect(out.some((l) => /KO/.test(l) && /herdr/.test(l))).toBe(true)
  expect(await exists(missionDir('gh12'))).toBe(false)
  expect(fx.callsOf('git.fetchMain')).toEqual([])
  expect(fx.herdr.calls).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
})

// ---------- existing missions ----------

/** Mission created by `dev` with the herdr fake (workspace, tabs, real panes of the fake). */
async function started(over: FakeOverrides = {}, extra: Extra = {}) {
  const r = deps(over, extra)
  await startMission('https://github.com/o/r/issues/12', repo, r.d)
  // The engine has handled the `orchestrator-started` message.
  await drainInbox('gh12')
  await patch({ orchestrator: { ...(await loadState('gh12')).orchestrator, started: true } })
  r.fx.calls.length = 0
  r.fx.herdr.calls.length = 0
  r.fx.herdr.runs.length = 0
  return { ...r, s: await loadState('gh12') }
}

async function patch(p: Partial<MissionState>): Promise<void> {
  await saveState({ ...(await loadState('gh12')), ...p })
}

async function dropFormat(id: string): Promise<void> {
  const file = join(missionDir(id), 'state.json')
  const raw = JSON.parse(await readFile(file, 'utf8')) as { format?: number }
  delete raw.format
  await writeFile(file, JSON.stringify(raw))
}

test('close asks for confirmation when commits are unpushed', async () => {
  const asked: string[] = []
  let answer = false
  const r = await started(
    { git: { unpushedCount: async () => 2 } },
    { isTTY: false, confirm: async (q?: string) => (asked.push(q ?? ''), answer) },
  )
  // Outside a terminal: refused, nothing is closed.
  await expect(closeMission('gh12', r.d)).rejects.toThrow(/2 unpushed commit/)
  expect(asked).toEqual([])
  expect(r.fx.herdr.calls).toEqual([])
  expect(r.fx.callsOf('git.worktreeRemove')).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')

  // Terminal, answer no: nothing is closed.
  r.d.isTTY = true
  expect(await closeMission('gh12', r.d)).toBe(false)
  expect(asked[0]).toMatch(/2 unpushed commit/)
  expect(r.fx.herdr.calls).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')

  // Terminal, answer yes: closed.
  answer = true
  expect(await closeMission('gh12', r.d)).toBe(true)
  expect((await loadState('gh12')).step).toBe('closed')
})

test('close with no unpushed commit asks nothing and closes everything', async () => {
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: false })
  await patch({ testDbUp: true })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(fx.callsOf('run')).toContainEqual([demo.testDb!.down[0], ['down', 'gh12', s.worktree], { cwd: s.worktree, reject: false }])
  expect(fx.herdr.calls.filter((c) => c.startsWith('paneSendKeys'))).toEqual(['paneSendKeys ctrl+c', 'paneSendKeys ctrl+c'])
  expect(fx.callsOf('herdr.paneSendKeys').map((c) => c[0])).toEqual([s.herdr.panes['engine'], s.herdr.panes['engine']])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([[repo, s.worktree]])
  const after = await loadState('gh12')
  expect(after).toMatchObject({ step: 'closed', testDbUp: false })
})

test('close from a worktree pane leaves the worktree before removing it', async () => {
  let cwdAtRemove = ''
  const { d, s } = await started({
    git: { unpushedCount: async () => 0, worktreeRemove: async () => void (cwdAtRemove = process.cwd()) },
  })
  await mkdir(join(s.worktree!, 'src'), { recursive: true })
  const before = process.cwd()
  process.chdir(join(s.worktree!, 'src'))
  try {
    expect(await closeMission('gh12', d)).toBe(true)
    expect(cwdAtRemove).toBe(repo)
    expect(process.cwd()).toBe(repo)
  } finally {
    process.chdir(before)
  }
})

test('close does not change the current directory outside the worktree', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } })
  const before = process.cwd()
  await closeMission('gh12', d)
  expect(process.cwd()).toBe(before)
})

test('delete refuses a mission that is not closed', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async () => true })
  await expect(deleteMission('gh12', d)).rejects.toThrow('mission gh12 is not closed: herness close gh12 first')
  expect(await exists(missionDir('gh12'))).toBe(true)
})

test('delete refuses a closed mission whose herdr workspace still exists', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async () => true })
  await patch({ step: 'closed' })
  await expect(deleteMission('gh12', d)).rejects.toThrow(/the herdr workspace is still there: run herness close gh12/)
  expect(await exists(missionDir('gh12'))).toBe(true)
})

test('delete names every leftover and agrees in the plural', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async () => true })
  await patch({ step: 'closed', testDbUp: true })
  await expect(deleteMission('gh12', d)).rejects.toThrow('the herdr workspace, a test database are still there: run herness close gh12 again')
})

test('delete removes a closed mission folder after confirmation', async () => {
  const asked: string[] = []
  let answer = false
  const r = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async (q?: string) => (asked.push(q ?? ''), answer) })
  await closeMission('gh12', r.d)
  expect(await deleteMission('gh12', r.d)).toBe(false)
  expect(asked.at(-1)).toBe('Permanently delete mission gh12 (state, spec, plan, logs)?')
  expect(await exists(missionDir('gh12'))).toBe(true)
  answer = true
  expect(await deleteMission('gh12', r.d)).toBe(true)
  expect(await exists(missionDir('gh12'))).toBe(false)
  expect(r.out).toContain('Mission gh12 deleted.')
})

test('delete outside a terminal requires --yes', async () => {
  const r = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: false })
  await closeMission('gh12', r.d)
  await expect(deleteMission('gh12', r.d)).rejects.toThrow(/confirmation in an interactive terminal \(or --yes\)/)
  expect(await deleteMission('gh12', r.d, { force: true })).toBe(true)
  expect(await exists(missionDir('gh12'))).toBe(false)
})

test('close never closes the workspace with --group', async () => {
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 } })
  fx.herdr.seedWorkspace('Projet')
  await closeMission('gh12', d)
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([[s.herdr.workspace]])
  expect(JSON.stringify(fx.calls)).not.toContain('--group')
})

test('close stops when the test database cannot be removed', async () => {
  const { fx, d } = await started({
    git: { unpushedCount: async () => 0 },
    run: async (cmd: string) =>
      cmd === demo.testDb!.down[0] ? { stdout: '', stderr: 'docker absent', exitCode: 1 } : { stdout: 'Logged in', stderr: '', exitCode: 0 },
  })
  await patch({ testDbUp: true })
  await expect(closeMission('gh12', d)).rejects.toThrow(/docker absent/)
  // The engine is stopped first (sole writer), but neither the worktree nor the workspace is touched.
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')
})

test('close also removes the proof database on main', async () => {
  const { fx, d } = await started({ git: { unpushedCount: async () => 0 } })
  await patch({ proofDbUp: true })
  await closeMission('gh12', d)
  expect(fx.callsOf('run').map((c) => c[1])).toContainEqual(['down', 'gh12-main', join(missionDir('gh12'), 'preuve-main')])
  expect((await loadState('gh12')).proofDbUp).toBe(false)
})

test("close of an already closed mission cleans what remains (worktree, workspace, databases), otherwise \"nothing to close\"", async () => {
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 } })
  await mkdir(s.worktree!, { recursive: true })
  // Closed by an approved abandon: the engine removed the databases, worktree and workspace are still there.
  await patch({ step: 'closed', proofDbUp: true })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(fx.callsOf('run').map((c) => (c[1] as string[]).slice(0, 2))).toContainEqual(['down', 'gh12-main'])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([[repo, s.worktree]])
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([[s.herdr.workspace]])
  expect(await loadState('gh12')).toMatchObject({ step: 'closed', proofDbUp: false })
})

test("close of a closed mission with nothing left does nothing", async () => {
  const { fx, out, d, s } = await started({ git: { unpushedCount: async () => 0 } })
  fx.herdr.workspaces = fx.herdr.workspaces.filter((w) => w.workspaceId !== s.herdr.workspace)
  await rm(s.worktree!, { recursive: true, force: true })
  await patch({ step: 'closed' })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(out.join('\n')).toContain('nothing to close')
  expect(fx.callsOf('git.worktreeRemove')).toEqual([])
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([])
  expect(fx.callsOf('run')).toEqual([])
})

// ---------- resume ----------

test('resumeMission refuses a legacy running mission', async () => {
  const { fx, d } = await started()
  await dropFormat('gh12')
  await expect(resumeMission('gh12', d)).rejects.toThrow(LegacyMissionError)
  expect(fx.herdr.calls).toEqual([])
  expect(fx.calls).toEqual([])
})

test('resumeMission accepts a legacy closed mission', async () => {
  const { d } = await started()
  await patch({ step: 'closed' })
  await dropFormat('gh12')
  await expect(resumeMission('gh12', d)).resolves.toBeUndefined()
})

test('resume restarts a missing engine, dashboard and orchestrator', async () => {
  const { fx, d, s } = await started()
  fx.herdr.started.delete('ogh12')
  await resumeMission('gh12', d)
  const cmds = fx.herdr.runs.map((r) => r.cmd)
  expect(cmds).toContain(`node '${BIN}' engine gh12`)
  expect(cmds).toContain(`node '${BIN}' tasks gh12`)
  expect(fx.herdr.calls.some((c) => c.startsWith('worktreeCreate'))).toBe(false)
  const [name, , , launch] = fx.callsOf('agents.start')[0]!
  expect(name).toBe('ogh12')
  expect((launch as { args: string[] }).args).toEqual(expect.arrayContaining(['--resume', s.orchestrator.sessionId!]))
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([])
  expect(await drainInbox('gh12')).toEqual([])
})

test('resume focuses the master tab, except with focus:false', async () => {
  const { fx, d, s } = await started()
  await resumeMission('gh12', d)
  expect(fx.herdr.calls.at(-1)).toBe(`tabFocus ${s.herdr.tabs['master']}`)
  fx.herdr.calls.length = 0
  await resumeMission('gh12', d, { focus: false })
  expect(fx.herdr.calls.some((c) => c.startsWith('tabFocus'))).toBe(false)
})

test('resume does not restart what is still running', async () => {
  const { fx, d, s } = await started()
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  fx.herdr.pane(s.herdr.panes['tasks']!).busy = true
  fx.herdr.pane(s.herdr.panes['spec']!).busy = true
  fx.herdr.pane(s.herdr.panes['plan']!).busy = true
  fx.herdr.started.add('ogh12')
  await resumeMission('gh12', d)
  expect(fx.herdr.runs).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
})

test('resume restarts the spec and plan viewers whose pane is idle', async () => {
  const { fx, d, s } = await started()
  fx.herdr.started.add('ogh12')
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  fx.herdr.pane(s.herdr.panes['tasks']!).busy = true
  fx.herdr.pane(s.herdr.panes['plan']!).busy = true
  fx.herdr.runs.length = 0
  await resumeMission('gh12', d)
  expect(fx.herdr.runs).toEqual([{ pane: s.herdr.panes['spec'], cmd: `node '${BIN}' show spec gh12` }])
})

test("resume recreates a missing docs tab, saves it and restarts the viewers there", async () => {
  const { fx, d, s } = await started()
  fx.herdr.started.add('ogh12')
  fx.herdr.pane(s.herdr.panes['tasks']!).busy = true
  const docs = s.herdr.tabs['docs']!
  fx.herdr.panes = fx.herdr.panes.filter((p) => p.tabId !== docs)
  fx.herdr.tabs = fx.herdr.tabs.filter((t) => t.tabId !== docs)
  fx.herdr.runs.length = 0
  await resumeMission('gh12', d)
  const after = await loadState('gh12')
  expect(after.herdr.tabs['docs']).toBeTruthy()
  expect(after.herdr.tabs['docs']).not.toBe(docs)
  expect(fx.herdr.runs).toEqual(
    expect.arrayContaining([
      { pane: after.herdr.panes['spec'], cmd: `node '${BIN}' show spec gh12` },
      { pane: after.herdr.panes['plan'], cmd: `node '${BIN}' show plan gh12` },
    ]),
  )
})

test('resume of a blocked mission asks for the resume-blocked gate', async () => {
  const { out, d } = await started()
  await patch({ step: 'blocked', blockedFrom: 'tasks', blockedReason: 'task 2: 3 correction rounds exhausted' })
  await resumeMission('gh12', d)
  expect(await drainInbox('gh12')).toEqual([{ type: 'request-gate', kind: 'resume-blocked', summary: 'task 2: 3 correction rounds exhausted' }])
  expect(out.join('\n')).toContain('herness approve gh12')
})

test('resume of a pr-open or closed mission prints its state and restarts nothing', async () => {
  const { fx, out, d } = await started()
  for (const step of ['pr-open', 'closed'] as const) {
    await patch({ step, prUrl: 'https://github.com/o/r/pull/9' })
    out.length = 0
    await resumeMission('gh12', d)
    expect(out.join('\n')).toContain(step)
    expect(out.join('\n')).toContain('https://github.com/o/r/pull/9')
  }
  expect(fx.calls).toEqual([])
  expect(fx.herdr.runs).toEqual([])
  expect(await drainInbox('gh12')).toEqual([])
})

test("resume: orchestrator alive but never started on the mission, the opening prompt is sent", async () => {
  const { fx, d } = await started()
  fx.herdr.started.add('ogh12')
  await patch({ orchestrator: { ...(await loadState('gh12')).orchestrator, started: false } })
  await resumeMission('gh12', d)
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([['ogh12', 'Start mission gh12. Read your system prompt.', { wait: false }]])
  expect(await drainInbox('gh12')).toEqual([{ type: 'orchestrator-started' }])
  // Already started: nothing is sent again.
  await patch({ orchestrator: { ...(await loadState('gh12')).orchestrator, started: true } })
  await resumeMission('gh12', d)
  expect(fx.callsOf('herdr.agentPrompt')).toHaveLength(1)
})

// ---------- status and CLI ----------

test('status lists missions and details one mission', async () => {
  const a = { ...newState({ id: 'A-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: repo }), step: 'tasks' as const }
  a.tasks = [
    { n: 1, title: 'One', testCommand: 't1', phase: 'done', round: 0 },
    { n: 2, title: 'Two', testCommand: 't2', phase: 'review', round: 1 },
  ]
  a.gates = [{ id: 'g1', kind: 'amendment', status: 'pending', summary: 'add', createdAt: 'x' }]
  const b = { ...newState({ id: 'B-2', source: { kind: 'text', ref: 'y' }, project: 'demo', repoPath: repo }), step: 'pr-open' as const, prUrl: 'https://github.com/o/r/pull/3' }
  await saveState(a)
  await saveState(b)
  const lines = await missionStatus()
  const la = lines.find((l) => l.startsWith('A-1'))!
  expect(la).toContain('tasks')
  expect(la).toContain('2/2 review')
  expect(la).toContain('g1')
  expect(lines.find((l) => l.startsWith('B-2'))).toContain('https://github.com/o/r/pull/3')
  const detail = (await missionStatus('A-1')).join('\n')
  expect(detail).toContain('Task 2: Two')
  expect(detail).toContain('g1 (amendment): add')

  const r = await execa('node', ['bin/herness.js', 'status'], { reject: false, stdin: 'ignore', env: { HERNESS_HOME: home } })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('A-1')
  expect(r.stdout).toContain('B-2')
})

test('CLI close on an unknown mission fails with a clear message', async () => {
  const r = await execa('node', ['bin/herness.js', 'close', 'C-3'], { reject: false, stdin: 'ignore', env: { HERNESS_HOME: home } })
  expect(r.exitCode).toBe(1)
  expect(r.stderr).toMatch(/mission C-3 not found/)
})

test('CLI delete --yes removes a closed mission; without --yes outside a terminal, it refuses', async () => {
  await saveState({ ...newState({ id: 'D-4', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: repo }), step: 'closed' })
  const env = { HERNESS_HOME: home }
  const no = await execa('node', ['bin/herness.js', 'delete', 'D-4'], { reject: false, stdin: 'ignore', env })
  expect(no.exitCode).toBe(1)
  expect(no.stderr).toMatch(/--yes/)
  expect(await exists(missionDir('D-4'))).toBe(true)
  const yes = await execa('node', ['bin/herness.js', 'delete', 'D-4', '--yes'], { reject: false, stdin: 'ignore', env })
  expect(yes.exitCode).toBe(0)
  expect(yes.stdout).toContain('Mission D-4 deleted.')
  expect(await exists(missionDir('D-4'))).toBe(false)
})

test('close removes the database started by the engine just before it stops', async () => {
  const { fx, d } = await started({
    git: { unpushedCount: async () => 0 },
    herdr: {
      paneSendKeys: async () => {
        // The engine starts the database between the first state read and its stop.
        const cur = await loadState('gh12')
        if (!cur.testDbUp) await saveState({ ...cur, testDbUp: true })
      },
    },
  })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(fx.callsOf('run').map((c) => (c[1] as string[]).slice(0, 2))).toContainEqual(['down', 'gh12'])
  expect((await loadState('gh12')).testDbUp).toBe(false)
})

test('close does not proceed when the engine does not stop', async () => {
  // The ctrl+c have no effect: the pane stays busy.
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 }, herdr: { paneSendKeys: async () => {} } })
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  await patch({ testDbUp: true })
  await expect(closeMission('gh12', d)).rejects.toThrow('engine still running, nothing was closed')
  expect(fx.callsOf('run').map((c) => (c[1] as string[]).slice(0, 2))).not.toContainEqual(['down', 'gh12'])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([])
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')
})

test('close tolerates an unreachable engine pane', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 }, herdr: { paneSendKeys: async () => { throw new Error('pane_not_found') } } })
  expect(await closeMission('gh12', d)).toBe(true)
  expect((await loadState('gh12')).step).toBe('closed')
})

test('close counts commits against the project main branch and confirms a dirty worktree', async () => {
  cfg = { ...cfg, mainBranch: 'develop' }
  const asked: string[] = []
  const r = await started(
    { git: { unpushedCount: async () => 0, isClean: async () => false } },
    { isTTY: false, confirm: async (q: string) => (asked.push(q), false) },
  )
  await expect(closeMission('gh12', r.d)).rejects.toThrow(/uncommitted changes/)
  expect(r.fx.callsOf('git.unpushedCount')).toEqual([[r.s.worktree, 'origin/develop']])
  expect(r.fx.callsOf('git.isClean')).toEqual([[r.s.worktree, '.']])
  r.d.isTTY = true
  expect(await closeMission('gh12', r.d)).toBe(false)
  expect(asked[0]).toMatch(/uncommitted changes/)
  expect(r.fx.callsOf('git.worktreeRemove')).toEqual([])
})

// ---------- resume --restart (herness update) ----------

test('resume --restart stops the engine then restarts the engine, dashboard and viewers even when busy, without sending anything to the agents', async () => {
  const { fx, d, s } = await started()
  fx.herdr.started.add('ogh12')
  for (const k of ['engine', 'tasks', 'spec', 'plan']) fx.herdr.pane(s.herdr.panes[k]!).busy = true
  await resumeMission('gh12', d, { restart: true })
  const keys = fx.herdr.calls.filter((c) => c.startsWith('paneSendKeys'))
  // Two ctrl+c for each of the four panes.
  expect(keys).toEqual(Array(8).fill('paneSendKeys ctrl+c'))
  expect(fx.herdr.runs).toEqual(
    expect.arrayContaining([
      { pane: s.herdr.panes['engine'], cmd: `node '${BIN}' engine gh12` },
      { pane: s.herdr.panes['tasks'], cmd: `node '${BIN}' tasks gh12` },
      { pane: s.herdr.panes['spec'], cmd: `node '${BIN}' show spec gh12` },
      { pane: s.herdr.panes['plan'], cmd: `node '${BIN}' show plan gh12` },
    ]),
  )
  expect(fx.herdr.runs).toHaveLength(4)
  // The living orchestrator is not touched, no agent receives anything.
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([])
})

test("resume --restart fails without restarting anything when the engine does not stop", async () => {
  const { fx, d, s } = await started({ herdr: { paneSendKeys: async () => {} } })
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  await expect(resumeMission('gh12', d, { restart: true })).rejects.toThrow(/engine still running/)
  expect(fx.herdr.runs).toEqual([])
})

// ---------- close: local branch ----------

const branchCalls = (fx: FakeEffects) => ({
  fetch: fx.callsOf('git.fetchBranch'),
  del: fx.callsOf('git.deleteBranch'),
})

test('close deletes the local branch already fully on origin', async () => {
  const { fx, out, d } = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 0 } })
  await closeMission('gh12', d)
  expect(branchCalls(fx)).toEqual({ fetch: [[repo, 'herness/gh12']], del: [[repo, 'herness/gh12']] })
  // After the worktree is removed.
  const order = fx.calls.map((c) => c.fn)
  expect(order.indexOf('git.worktreeRemove')).toBeLessThan(order.indexOf('git.deleteBranch'))
  expect(out).toContain('local branch herness/gh12 deleted (still on origin)')
})

test('close keeps the branch that has commits missing from origin', async () => {
  const { fx, out, d } = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 3 } })
  await closeMission('gh12', d)
  expect(branchCalls(fx).del).toEqual([])
  expect(out).toContain('branch herness/gh12 kept: 3 commit(s) missing from origin')
})

test('close keeps the branch when there is no remote branch', async () => {
  const a = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => null } })
  await closeMission('gh12', a.d)
  expect(branchCalls(a.fx).del).toEqual([])
  expect(a.out).toContain('branch herness/gh12 kept: no remote branch')
})

test('close keeps the branch when fetch fails', async () => {
  const { fx, d } = await started({
    git: {
      unpushedCount: async () => 0,
      currentBranch: async () => 'main',
      fetchBranch: async () => { throw new Error('network') },
      localOnlyCommits: async () => 0,
    },
  })
  await closeMission('gh12', d)
  expect(branchCalls(fx).del).toEqual([])
})

test('close never deletes the main branch nor the repository\'s current branch', async () => {
  const main = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 0 } })
  await patch({ branch: 'main' })
  await closeMission('gh12', main.d)
  expect(branchCalls(main.fx)).toEqual({ fetch: [], del: [] })
  await rm(missionDir('gh12'), { recursive: true, force: true })

  const cur = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'herness/gh12', localOnlyCommits: async () => 0 } })
  await closeMission('gh12', cur.d)
  expect(branchCalls(cur.fx)).toEqual({ fetch: [], del: [] })
})

test('close does not touch the branch when closing is cancelled or fails earlier', async () => {
  const { fx, d } = await started({
    git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 0 },
    run: async (cmd: string) =>
      cmd === demo.testDb!.down[0] ? { stdout: '', stderr: 'docker absent', exitCode: 1 } : { stdout: 'Logged in', stderr: '', exitCode: 0 },
  })
  await patch({ testDbUp: true })
  await expect(closeMission('gh12', d)).rejects.toThrow(/docker absent/)
  expect(branchCalls(fx)).toEqual({ fetch: [], del: [] })
})

// ---------- report ----------

const ISSUE_URL = 'https://github.com/MaxVzl/herness/issues/7'

const ghRun: FakeOverrides['run'] = async (cmd, args = []) => {
  if (cmd === 'cursor-agent') return { stdout: 'Logged in', stderr: '', exitCode: 0 }
  if (cmd === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 }
  if (cmd === 'gh' && args[1] === 'create') return { stdout: `${ISSUE_URL}\n`, stderr: '', exitCode: 0 }
  return { stdout: '', stderr: '', exitCode: 0 }
}

function ghCreates(fx: FakeEffects): unknown[][] {
  return fx.callsOf('run').filter((call) => call[0] === 'gh' && (call[1] as string[])[1] === 'create')
}

async function missionGh12(): Promise<void> {
  await saveState({ ...newState({ id: 'gh12', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: repo }), step: 'tasks' })
}

test('report with no error does not contact GitHub', async () => {
  await missionGh12()
  const { fx, out, d } = deps({ run: ghRun })
  expect(await reportMissionErrors('gh12', d)).toBe(true)
  expect(out.join('\n')).toContain('No herness error to file for mission gh12.')
  expect(fx.callsOf('run').some((call) => call[0] === 'gh')).toBe(false)
})

test('report on an unknown mission fails', async () => {
  const { d } = deps({ run: ghRun })
  await expect(reportMissionErrors('gh12', d)).rejects.toThrow(/not found/)
})

test('report outside a terminal without --yes refuses without sending anything', async () => {
  await missionGh12()
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { fx, d } = deps({ run: ghRun }, { isTTY: false })
  await expect(reportMissionErrors('gh12', d)).rejects.toThrow(/interactive terminal/)
  expect(ghCreates(fx)).toEqual([])
})

test('report shows the preview, asks, then sends', async () => {
  await missionGh12()
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const statePath = join(missionDir('gh12'), 'state.json')
  const stateBefore = await readFile(statePath, 'utf8')
  const asked: string[] = []
  const { out, d } = deps({ run: ghRun }, { isTTY: true, confirm: async (q) => (asked.push(q), true) })
  expect(await reportMissionErrors('gh12', d)).toBe(true)
  const text = out.join('\n')
  const previewAt = text.indexOf('herness errors for mission gh12')
  const createdAt = text.indexOf('issue created:')
  expect(previewAt).toBeGreaterThanOrEqual(0)
  expect(createdAt).toBeGreaterThan(previewAt)
  expect(asked).toEqual(['Send 1 issue to MaxVzl/herness?'])
  expect(await exists(join(missionDir('gh12'), 'issues.json'))).toBe(true)
  expect(await readFile(statePath, 'utf8')).toBe(stateBefore)
  expect((await loadState('gh12')).step).toBe('tasks')
})

test('a refused report sends nothing', async () => {
  await missionGh12()
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { fx, out, d } = deps({ run: ghRun }, { isTTY: true, confirm: async () => false })
  expect(await reportMissionErrors('gh12', d)).toBe(false)
  expect(out.join('\n')).toContain("nothing was sent")
  expect(ghCreates(fx)).toEqual([])
})

test('close in a terminal offers to send before stopping the engine', async () => {
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { fx, d } = await started(
    { git: { unpushedCount: async () => 0 }, run: ghRun },
    { isTTY: true, confirm: async () => true },
  )
  expect(await closeMission('gh12', d, { report: true })).toBe(true)
  const createAt = fx.calls.findIndex(
    (c) => c.fn === 'run' && c.args[0] === 'gh' && (c.args[1] as string[])[1] === 'create',
  )
  const stopAt = fx.calls.findIndex(
    (c) => c.fn === 'herdr.paneSendKeys' && (c.args as string[]).includes('ctrl+c'),
  )
  expect(createAt).toBeGreaterThanOrEqual(0)
  expect(stopAt).toBeGreaterThan(createAt)
  expect(await exists(join(missionDir('gh12'), 'issues.json'))).toBe(true)
  expect((await loadState('gh12')).step).toBe('closed')
})

test('close: a refused send does not prevent closing', async () => {
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { fx, d } = await started(
    { git: { unpushedCount: async () => 0 }, run: ghRun },
    { isTTY: true, confirm: async (q) => !q.startsWith('Send') },
  )
  expect(await closeMission('gh12', d, { report: true })).toBe(true)
  expect((await loadState('gh12')).step).toBe('closed')
  expect(ghCreates(fx)).toEqual([])
})

test('close: a gh failure does not prevent closing', async () => {
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { out, d } = await started(
    {
      git: { unpushedCount: async () => 0 },
      run: async (cmd, args = []) => {
        if (cmd === 'cursor-agent') return { stdout: 'Logged in', stderr: '', exitCode: 0 }
        if (cmd === 'gh' && args[1] === 'list') throw new Error('gh not connected')
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    },
    { isTTY: true, confirm: async () => true },
  )
  expect(await closeMission('gh12', d, { report: true })).toBe(true)
  expect(out.join('\n')).toContain('herness errors not filed (gh not connected): herness report gh12')
  expect((await loadState('gh12')).step).toBe('closed')
})

test('close with nothing to file says nothing more', async () => {
  const { fx, out, d } = await started(
    { git: { unpushedCount: async () => 0 }, run: ghRun },
    { isTTY: true, confirm: async () => true },
  )
  expect(await closeMission('gh12', d, { report: true })).toBe(true)
  expect(fx.callsOf('run').some((call) => call[0] === 'gh')).toBe(false)
  const text = out.join('\n')
  expect(text).not.toContain('No herness error')
  expect(text).not.toContain('herness report')
})

test('close without the option reminds the command without contacting GitHub', async () => {
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { fx, out, d } = await started({ git: { unpushedCount: async () => 0 }, run: ghRun })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(out.join('\n')).toContain('1 herness error(s) not filed: herness report gh12')
  expect(fx.callsOf('run').some((call) => call[0] === 'gh')).toBe(false)
})

test('a cancelled close offers nothing', async () => {
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const asked: string[] = []
  const { fx, d } = await started(
    { git: { unpushedCount: async () => 2 }, run: ghRun },
    { isTTY: true, confirm: async (q) => (asked.push(q), false) },
  )
  expect(await closeMission('gh12', d, { report: true })).toBe(false)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatch(/commit/)
  expect(fx.callsOf('run').some((call) => call[0] === 'gh')).toBe(false)
})

test('close on an already closed and cleaned mission only reminds the command', async () => {
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const { fx, out, d, s } = await started(
    { git: { unpushedCount: async () => 0 }, run: ghRun },
    { isTTY: true, confirm: async () => true },
  )
  fx.herdr.workspaces = fx.herdr.workspaces.filter((w) => w.workspaceId !== s.herdr.workspace)
  await rm(s.worktree!, { recursive: true, force: true })
  await patch({ step: 'closed' })
  expect(await closeMission('gh12', d, { report: true })).toBe(true)
  const text = out.join('\n')
  expect(text).toContain('already closed')
  expect(text).toContain('herness report gh12')
  expect(fx.callsOf('run').some((call) => call[0] === 'gh')).toBe(false)
})

test('report --yes sends without a question but with a preview', async () => {
  await missionGh12()
  await logHernessError({ mission: 'gh12', origin: 'engine' }, new Error('boom'))
  const asked: string[] = []
  const { fx, out, d } = deps(
    { run: ghRun },
    { isTTY: false, confirm: async (q) => (asked.push(q), true) },
  )
  expect(await reportMissionErrors('gh12', d, { force: true })).toBe(true)
  expect(asked).toEqual([])
  expect(out.join('\n')).toContain('herness errors for mission gh12')
  expect(out.join('\n')).toContain(`issue created: ${ISSUE_URL}`)
  expect(ghCreates(fx)).toHaveLength(1)
})
