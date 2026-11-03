import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import type { ProjectConfig } from '../../src/config/project.ts'
import { closeMission, deleteMission, missionStatus, resumeMission, startMission, type LifecycleDeps } from '../../src/lifecycle.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { loadState, newState, saveState, type MissionState } from '../../src/mission/state.ts'
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
  // Worktree propre par défaut (la doublure générique rend `isClean` faux).
  const fx: FakeEffects = fakeEffects({ ...over, git: { isClean: async () => true, ...over.git } })
  const out: string[] = []
  const d: LifecycleDeps = { e: fx, loadConfig: async () => cfg, out: (l: string) => void out.push(l), ...extra }
  return { fx, out, d }
}

// ---------- dev ----------

test('dev crée l\'espace, enregistre l\'état puis lance moteur, tableau et orchestrateur', async () => {
  const { fx, d } = deps({
    forge: { readIssue: async () => ({ title: 'Export CSV', body: 'Il faut exporter.', comments: ['c1', 'c2'] }) },
    agents: {
      start: async () => {
        // L'état est enregistré avant le lancement des processus.
        expect((await loadState('gh12')).herdr.workspace).toBeTruthy()
      },
    },
  })
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

  const demande = await readFile(join(missionDir('gh12'), 'demande.md'), 'utf8')
  expect(demande).toMatch(/^# Export CSV\n\nIl faut exporter\.\n\n## Commentaires\n/)
  expect(demande).toContain('c1')
  expect(demande).toContain('c2')
  expect(await exists(join(missionDir('gh12'), 'mcp.json'))).toBe(true)
  const prompt = await readFile(join(missionDir('gh12'), 'orchestrator.md'), 'utf8')
  expect(prompt).toContain('déterminé après classement')
  expect(prompt).toContain('docs/superpowers/specs/')
  expect(prompt).toContain('docs/superpowers/plans/')
  expect(prompt).toContain('<AAAA-MM-JJ>-<id>-<slug>.md')
  expect(prompt).toContain(join(missionDir('gh12'), 'demande.md'))

  const runs = fx.herdr.runs.filter((r) => !r.cmd.startsWith('lazygit'))
  expect(runs).toEqual([
    { pane: s.herdr.panes['engine'], cmd: `node '${BIN}' engine gh12` },
    { pane: s.herdr.panes['tasks'], cmd: `node '${BIN}' tasks gh12` },
    { pane: s.herdr.panes['spec'], cmd: `node '${BIN}' voir spec gh12` },
    { pane: s.herdr.panes['plan'], cmd: `node '${BIN}' voir plan gh12` },
  ])
  const [name, role, pane, launch] = fx.callsOf('agents.start')[0]!
  expect([name, role, pane]).toEqual(['ogh12', 'orchestrator', s.herdr.panes['orchestrator']])
  const args = (launch as { args: string[] }).args
  expect(s.orchestrator.agent).toBe('ogh12')
  expect(s.orchestrator.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(args).toEqual(expect.arrayContaining(['--session-id', s.orchestrator.sessionId!, '--mcp-config', join(missionDir('gh12'), 'mcp.json')]))
  expect(args).toEqual(expect.arrayContaining(['--append-system-prompt-file', join(missionDir('gh12'), 'orchestrator.md'), 'claude-opus-5-5']))
  expect(args[args.indexOf('--permission-mode') + 1]).toBe(cfg.orchestratorPermissionMode)
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([['ogh12', 'Commence la mission gh12. Lis ton prompt système.', { wait: false }]])
  // Le moteur, seul écrivain de l'état, enregistrera que le prompt d'ouverture est parti.
  expect(await drainInbox('gh12')).toEqual([{ type: 'orchestrator-started' }])
  expect(fx.herdr.calls.at(-1)).toBe(`tabFocus ${s.herdr.tabs['master']}`)
})

test('dev avec un texte libre : id du jour et demande écrite telle quelle', async () => {
  const { d } = deps({ now: () => new Date(2026, 9, 30, 9) })
  const id = await startMission('  ajoute un export CSV  ', repo, d)
  expect(id).toBe('20261030-1')
  expect(await readFile(join(missionDir(id), 'demande.md'), 'utf8')).toBe('ajoute un export CSV\n')
  expect((await loadState(id)).source).toEqual({ kind: 'text', ref: 'ajoute un export CSV' })
})

test('dev avec une note : note.md écrite et signalée à l\'orchestrateur', async () => {
  const { d } = deps()
  await startMission('https://github.com/o/r/issues/12', repo, d, { note: '  ne touche pas à l\'export PDF\n' })
  const note = join(missionDir('gh12'), 'note.md')
  expect(await readFile(note, 'utf8')).toBe("ne touche pas à l'export PDF\n")
  const prompt = await readFile(join(missionDir('gh12'), 'orchestrator.md'), 'utf8')
  expect(prompt).toContain(`Lis aussi la note de l'utilisateur, \`${note}\``)
})

test('dev sans note (ou note vide) : ni note.md ni mention dans le prompt', async () => {
  const { d } = deps()
  await startMission('https://github.com/o/r/issues/12', repo, d, { note: '   ' })
  expect(await exists(join(missionDir('gh12'), 'note.md'))).toBe(false)
  expect(await readFile(join(missionDir('gh12'), 'orchestrator.md'), 'utf8')).not.toContain('note de l\'utilisateur')
})

test('dev refuse un id de mission déjà existant', async () => {
  await mkdir(missionDir('gh12'), { recursive: true })
  const { fx, d } = deps()
  await expect(startMission('https://github.com/o/r/issues/12', repo, d)).rejects.toThrow(
    'mission gh12 déjà existante : utilise herness reprendre gh12',
  )
  expect(fx.calls).toEqual([])
  expect(fx.herdr.calls).toEqual([])
})

test('dev s\'arrête sur un KO d\'environnement sans rien créer', async () => {
  const { fx, out, d } = deps({
    run: async (cmd: string) =>
      cmd === 'herdr' ? { stdout: '', stderr: 'down', exitCode: 1 } : { stdout: cmd === 'cursor-agent' ? 'Logged in' : '', stderr: '', exitCode: 0 },
  })
  await expect(startMission('https://github.com/o/r/issues/12', repo, d)).rejects.toThrow(/environnement/)
  expect(out.some((l) => /KO/.test(l) && /herdr/.test(l))).toBe(true)
  expect(await exists(missionDir('gh12'))).toBe(false)
  expect(fx.callsOf('git.fetchMain')).toEqual([])
  expect(fx.herdr.calls).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
})

// ---------- missions existantes ----------

/** Mission créée par `dev` avec la doublure herdr (espace, onglets, panneaux réels de la doublure). */
async function started(over: FakeOverrides = {}, extra: Extra = {}) {
  const r = deps(over, extra)
  await startMission('https://github.com/o/r/issues/12', repo, r.d)
  // Le moteur a traité le message `orchestrator-started`.
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

test('fermer demande confirmation quand des commits ne sont pas poussés', async () => {
  const asked: string[] = []
  let answer = false
  const r = await started(
    { git: { unpushedCount: async () => 2 } },
    { isTTY: false, confirm: async (q?: string) => (asked.push(q ?? ''), answer) },
  )
  // Hors terminal : refus, rien n'est fermé.
  await expect(closeMission('gh12', r.d)).rejects.toThrow(/2 commit\(s\) non poussé\(s\)/)
  expect(asked).toEqual([])
  expect(r.fx.herdr.calls).toEqual([])
  expect(r.fx.callsOf('git.worktreeRemove')).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')

  // Terminal, réponse non : rien n'est fermé.
  r.d.isTTY = true
  expect(await closeMission('gh12', r.d)).toBe(false)
  expect(asked[0]).toMatch(/2 commit/)
  expect(r.fx.herdr.calls).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')

  // Terminal, réponse oui : fermeture.
  answer = true
  expect(await closeMission('gh12', r.d)).toBe(true)
  expect((await loadState('gh12')).step).toBe('fermée')
})

test('fermer sans commit non poussé ne demande rien et ferme tout', async () => {
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: false })
  await patch({ testDbUp: true })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(fx.callsOf('run')).toContainEqual([demo.testDb!.down[0], ['down', 'gh12', s.worktree], { cwd: s.worktree, reject: false }])
  expect(fx.herdr.calls.filter((c) => c.startsWith('paneSendKeys'))).toEqual(['paneSendKeys ctrl+c', 'paneSendKeys ctrl+c'])
  expect(fx.callsOf('herdr.paneSendKeys').map((c) => c[0])).toEqual([s.herdr.panes['engine'], s.herdr.panes['engine']])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([[repo, s.worktree]])
  const after = await loadState('gh12')
  expect(after).toMatchObject({ step: 'fermée', testDbUp: false })
})

test('fermer depuis un panneau du worktree quitte le worktree avant de le supprimer', async () => {
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

test('fermer ne change pas le dossier courant hors du worktree', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } })
  const before = process.cwd()
  await closeMission('gh12', d)
  expect(process.cwd()).toBe(before)
})

test('supprimer refuse une mission qui n\'est pas fermée', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async () => true })
  await expect(deleteMission('gh12', d)).rejects.toThrow('mission gh12 pas fermée : herness fermer gh12 d\'abord')
  expect(await exists(missionDir('gh12'))).toBe(true)
})

test('supprimer refuse une mission fermée dont l\'espace herdr existe encore', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async () => true })
  await patch({ step: 'fermée' })
  await expect(deleteMission('gh12', d)).rejects.toThrow(/il reste l'espace herdr : relance herness fermer gh12/)
  expect(await exists(missionDir('gh12'))).toBe(true)
})

test('supprimer efface le dossier d\'une mission fermée après confirmation', async () => {
  const asked: string[] = []
  let answer = false
  const r = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: true, confirm: async (q?: string) => (asked.push(q ?? ''), answer) })
  await closeMission('gh12', r.d)
  expect(await deleteMission('gh12', r.d)).toBe(false)
  expect(asked.at(-1)).toBe('Supprimer définitivement la mission gh12 (état, spec, plan, journaux) ?')
  expect(await exists(missionDir('gh12'))).toBe(true)
  answer = true
  expect(await deleteMission('gh12', r.d)).toBe(true)
  expect(await exists(missionDir('gh12'))).toBe(false)
  expect(r.out).toContain('Mission gh12 supprimée.')
})

test('supprimer hors terminal demande --oui', async () => {
  const r = await started({ git: { unpushedCount: async () => 0 } }, { isTTY: false })
  await closeMission('gh12', r.d)
  await expect(deleteMission('gh12', r.d)).rejects.toThrow(/confirmation dans un terminal interactif \(ou --oui\)/)
  expect(await deleteMission('gh12', r.d, { force: true })).toBe(true)
  expect(await exists(missionDir('gh12'))).toBe(false)
})

test('fermer ne ferme jamais l\'espace avec --group', async () => {
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 } })
  fx.herdr.seedWorkspace('Projet')
  await closeMission('gh12', d)
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([[s.herdr.workspace]])
  expect(JSON.stringify(fx.calls)).not.toContain('--group')
})

test('fermer s\'arrête si la base de test ne peut pas être supprimée', async () => {
  const { fx, d } = await started({
    git: { unpushedCount: async () => 0 },
    run: async (cmd: string) =>
      cmd === demo.testDb!.down[0] ? { stdout: '', stderr: 'docker absent', exitCode: 1 } : { stdout: 'Logged in', stderr: '', exitCode: 0 },
  })
  await patch({ testDbUp: true })
  await expect(closeMission('gh12', d)).rejects.toThrow(/docker absent/)
  // Le moteur est arrêté d'abord (seul écrivain), mais ni le worktree ni l'espace ne sont touchés.
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')
})

test('fermer supprime aussi la base de la preuve sur main', async () => {
  const { fx, d } = await started({ git: { unpushedCount: async () => 0 } })
  await patch({ proofDbUp: true })
  await closeMission('gh12', d)
  expect(fx.callsOf('run').map((c) => c[1])).toContainEqual(['down', 'gh12-main', join(missionDir('gh12'), 'preuve-main')])
  expect((await loadState('gh12')).proofDbUp).toBe(false)
})

test("fermer une mission déjà fermée nettoie ce qui reste (worktree, espace, bases), sinon « rien à fermer »", async () => {
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 } })
  await mkdir(s.worktree!, { recursive: true })
  // Fermée par un abandon validé : le moteur a supprimé les bases, worktree et espace sont encore là.
  await patch({ step: 'fermée', proofDbUp: true })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(fx.callsOf('run').map((c) => (c[1] as string[]).slice(0, 2))).toContainEqual(['down', 'gh12-main'])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([[repo, s.worktree]])
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([[s.herdr.workspace]])
  expect(await loadState('gh12')).toMatchObject({ step: 'fermée', proofDbUp: false })
})

test("fermer une mission fermée sans reste ne fait rien", async () => {
  const { fx, out, d, s } = await started({ git: { unpushedCount: async () => 0 } })
  fx.herdr.workspaces = fx.herdr.workspaces.filter((w) => w.workspaceId !== s.herdr.workspace)
  await rm(s.worktree!, { recursive: true, force: true })
  await patch({ step: 'fermée' })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(out.join('\n')).toContain('rien à fermer')
  expect(fx.callsOf('git.worktreeRemove')).toEqual([])
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([])
  expect(fx.callsOf('run')).toEqual([])
})

// ---------- reprendre ----------

test('reprendre relance moteur, tableau et orchestrateur absents', async () => {
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

test('reprendre focalise l’onglet master, sauf avec focus:false', async () => {
  const { fx, d, s } = await started()
  await resumeMission('gh12', d)
  expect(fx.herdr.calls.at(-1)).toBe(`tabFocus ${s.herdr.tabs['master']}`)
  fx.herdr.calls.length = 0
  await resumeMission('gh12', d, { focus: false })
  expect(fx.herdr.calls.some((c) => c.startsWith('tabFocus'))).toBe(false)
})

test('reprendre ne relance pas ce qui tourne encore', async () => {
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

test('reprendre relance les visionneuses spec et plan dont le panneau est au repos', async () => {
  const { fx, d, s } = await started()
  fx.herdr.started.add('ogh12')
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  fx.herdr.pane(s.herdr.panes['tasks']!).busy = true
  fx.herdr.pane(s.herdr.panes['plan']!).busy = true
  fx.herdr.runs.length = 0
  await resumeMission('gh12', d)
  expect(fx.herdr.runs).toEqual([{ pane: s.herdr.panes['spec'], cmd: `node '${BIN}' voir spec gh12` }])
})

test("reprendre recrée l'onglet docs manquant, l'enregistre et y relance les visionneuses", async () => {
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
      { pane: after.herdr.panes['spec'], cmd: `node '${BIN}' voir spec gh12` },
      { pane: after.herdr.panes['plan'], cmd: `node '${BIN}' voir plan gh12` },
    ]),
  )
})

test('reprendre une mission bloquée demande la porte reprise-bloquee', async () => {
  const { out, d } = await started()
  await patch({ step: 'bloquée', blockedFrom: 'tasks', blockedReason: 'tâche 2 : 3 tours de correction épuisés' })
  await resumeMission('gh12', d)
  expect(await drainInbox('gh12')).toEqual([{ type: 'request-gate', kind: 'reprise-bloquee', summary: 'tâche 2 : 3 tours de correction épuisés' }])
  expect(out.join('\n')).toContain('herness valider gh12')
})

test('reprendre une mission pr-ouverte ou fermée affiche son état et ne relance rien', async () => {
  const { fx, out, d } = await started()
  for (const step of ['pr-ouverte', 'fermée'] as const) {
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

test("reprendre : orchestrateur vivant mais jamais lancé sur la mission, le prompt d'ouverture est envoyé", async () => {
  const { fx, d } = await started()
  fx.herdr.started.add('ogh12')
  await patch({ orchestrator: { ...(await loadState('gh12')).orchestrator, started: false } })
  await resumeMission('gh12', d)
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([['ogh12', 'Commence la mission gh12. Lis ton prompt système.', { wait: false }]])
  expect(await drainInbox('gh12')).toEqual([{ type: 'orchestrator-started' }])
  // Déjà lancé : rien n'est renvoyé.
  await patch({ orchestrator: { ...(await loadState('gh12')).orchestrator, started: true } })
  await resumeMission('gh12', d)
  expect(fx.callsOf('herdr.agentPrompt')).toHaveLength(1)
})

// ---------- statut et CLI ----------

test('statut liste les missions et détaille une mission', async () => {
  const a = { ...newState({ id: 'A-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: repo }), step: 'tasks' as const }
  a.tasks = [
    { n: 1, title: 'Un', testCommand: 't1', phase: 'done', round: 0 },
    { n: 2, title: 'Deux', testCommand: 't2', phase: 'review', round: 1 },
  ]
  a.gates = [{ id: 'g1', kind: 'amendement', status: 'pending', summary: 'ajout', createdAt: 'x' }]
  const b = { ...newState({ id: 'B-2', source: { kind: 'text', ref: 'y' }, project: 'demo', repoPath: repo }), step: 'pr-ouverte' as const, prUrl: 'https://github.com/o/r/pull/3' }
  await saveState(a)
  await saveState(b)
  const lines = await missionStatus()
  const la = lines.find((l) => l.startsWith('A-1'))!
  expect(la).toContain('tasks')
  expect(la).toContain('2/2 review')
  expect(la).toContain('g1')
  expect(lines.find((l) => l.startsWith('B-2'))).toContain('https://github.com/o/r/pull/3')
  const detail = (await missionStatus('A-1')).join('\n')
  expect(detail).toContain('Tâche 2 : Deux')
  expect(detail).toContain('g1 (amendement) : ajout')

  const r = await execa('node', ['bin/herness.js', 'statut'], { reject: false, stdin: 'ignore', env: { HERNESS_HOME: home } })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('A-1')
  expect(r.stdout).toContain('B-2')
})

test('CLI fermer sur une mission inconnue échoue avec un message clair', async () => {
  const r = await execa('node', ['bin/herness.js', 'fermer', 'C-3'], { reject: false, stdin: 'ignore', env: { HERNESS_HOME: home } })
  expect(r.exitCode).toBe(1)
  expect(r.stderr).toMatch(/mission C-3 introuvable/)
})

test('CLI supprimer --oui efface une mission fermée ; sans --oui hors terminal, refuse', async () => {
  await saveState({ ...newState({ id: 'D-4', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: repo }), step: 'fermée' })
  const env = { HERNESS_HOME: home }
  const no = await execa('node', ['bin/herness.js', 'supprimer', 'D-4'], { reject: false, stdin: 'ignore', env })
  expect(no.exitCode).toBe(1)
  expect(no.stderr).toMatch(/--oui/)
  expect(await exists(missionDir('D-4'))).toBe(true)
  const yes = await execa('node', ['bin/herness.js', 'supprimer', 'D-4', '--oui'], { reject: false, stdin: 'ignore', env })
  expect(yes.exitCode).toBe(0)
  expect(yes.stdout).toContain('Mission D-4 supprimée.')
  expect(await exists(missionDir('D-4'))).toBe(false)
})

test('fermer supprime la base démarrée par le moteur juste avant son arrêt', async () => {
  const { fx, d } = await started({
    git: { unpushedCount: async () => 0 },
    herdr: {
      paneSendKeys: async () => {
        // Le moteur lance la base entre la première lecture de l'état et son arrêt.
        const cur = await loadState('gh12')
        if (!cur.testDbUp) await saveState({ ...cur, testDbUp: true })
      },
    },
  })
  expect(await closeMission('gh12', d)).toBe(true)
  expect(fx.callsOf('run').map((c) => (c[1] as string[]).slice(0, 2))).toContainEqual(['down', 'gh12'])
  expect((await loadState('gh12')).testDbUp).toBe(false)
})

test('fermer n\'avance pas si le moteur ne s\'arrête pas', async () => {
  // Les ctrl+c n'ont aucun effet : le panneau reste occupé.
  const { fx, d, s } = await started({ git: { unpushedCount: async () => 0 }, herdr: { paneSendKeys: async () => {} } })
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  await patch({ testDbUp: true })
  await expect(closeMission('gh12', d)).rejects.toThrow('moteur toujours actif, rien n\'a été fermé')
  expect(fx.callsOf('run').map((c) => (c[1] as string[]).slice(0, 2))).not.toContainEqual(['down', 'gh12'])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([])
  expect(fx.callsOf('herdr.workspaceClose')).toEqual([])
  expect((await loadState('gh12')).step).toBe('env')
})

test('fermer tolère un panneau moteur injoignable', async () => {
  const { d } = await started({ git: { unpushedCount: async () => 0 }, herdr: { paneSendKeys: async () => { throw new Error('pane_not_found') } } })
  expect(await closeMission('gh12', d)).toBe(true)
  expect((await loadState('gh12')).step).toBe('fermée')
})

test('fermer compte les commits par rapport à la branche principale du projet et confirme un worktree sale', async () => {
  cfg = { ...cfg, mainBranch: 'develop' }
  const asked: string[] = []
  const r = await started(
    { git: { unpushedCount: async () => 0, isClean: async () => false } },
    { isTTY: false, confirm: async (q: string) => (asked.push(q), false) },
  )
  await expect(closeMission('gh12', r.d)).rejects.toThrow(/modifications non commitées/)
  expect(r.fx.callsOf('git.unpushedCount')).toEqual([[r.s.worktree, 'origin/develop']])
  expect(r.fx.callsOf('git.isClean')).toEqual([[r.s.worktree, '.']])
  r.d.isTTY = true
  expect(await closeMission('gh12', r.d)).toBe(false)
  expect(asked[0]).toMatch(/modifications non commitées/)
  expect(r.fx.callsOf('git.worktreeRemove')).toEqual([])
})

// ---------- reprendre --redemarrer (mise à jour de herness) ----------

test('reprendre --redemarrer arrête le moteur puis relance moteur, tableau et visionneuses même occupés, sans rien envoyer aux agents', async () => {
  const { fx, d, s } = await started()
  fx.herdr.started.add('ogh12')
  for (const k of ['engine', 'tasks', 'spec', 'plan']) fx.herdr.pane(s.herdr.panes[k]!).busy = true
  await resumeMission('gh12', d, { restart: true })
  const keys = fx.herdr.calls.filter((c) => c.startsWith('paneSendKeys'))
  // Double ctrl+c pour chacun des quatre panneaux.
  expect(keys).toEqual(Array(8).fill('paneSendKeys ctrl+c'))
  expect(fx.herdr.runs).toEqual(
    expect.arrayContaining([
      { pane: s.herdr.panes['engine'], cmd: `node '${BIN}' engine gh12` },
      { pane: s.herdr.panes['tasks'], cmd: `node '${BIN}' tasks gh12` },
      { pane: s.herdr.panes['spec'], cmd: `node '${BIN}' voir spec gh12` },
      { pane: s.herdr.panes['plan'], cmd: `node '${BIN}' voir plan gh12` },
    ]),
  )
  expect(fx.herdr.runs).toHaveLength(4)
  // L'orchestrateur vivant n'est pas touché, aucun agent ne reçoit rien.
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([])
})

test("reprendre --redemarrer échoue sans rien relancer si le moteur ne s'arrête pas", async () => {
  const { fx, d, s } = await started({ herdr: { paneSendKeys: async () => {} } })
  fx.herdr.pane(s.herdr.panes['engine']!).busy = true
  await expect(resumeMission('gh12', d, { restart: true })).rejects.toThrow(/moteur toujours actif/)
  expect(fx.herdr.runs).toEqual([])
})

// ---------- fermer : branche locale ----------

const branchCalls = (fx: FakeEffects) => ({
  fetch: fx.callsOf('git.fetchBranch'),
  del: fx.callsOf('git.deleteBranch'),
})

test('fermer supprime la branche locale déjà entièrement sur origin', async () => {
  const { fx, out, d } = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 0 } })
  await closeMission('gh12', d)
  expect(branchCalls(fx)).toEqual({ fetch: [[repo, 'herness/gh12']], del: [[repo, 'herness/gh12']] })
  // Après la suppression du worktree.
  const order = fx.calls.map((c) => c.fn)
  expect(order.indexOf('git.worktreeRemove')).toBeLessThan(order.indexOf('git.deleteBranch'))
  expect(out).toContain('branche locale herness/gh12 supprimée (toujours sur origin)')
})

test('fermer garde la branche qui a des commits absents d\'origin', async () => {
  const { fx, out, d } = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 3 } })
  await closeMission('gh12', d)
  expect(branchCalls(fx).del).toEqual([])
  expect(out).toContain('branche herness/gh12 gardée : 3 commit(s) absent(s) de origin')
})

test('fermer garde la branche sans branche distante ou si le fetch échoue', async () => {
  const a = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => null } })
  await closeMission('gh12', a.d)
  expect(branchCalls(a.fx).del).toEqual([])
  expect(a.out).toContain('branche herness/gh12 gardée : pas de branche distante')
})

test('fermer garde la branche quand le fetch échoue', async () => {
  const { fx, d } = await started({
    git: {
      unpushedCount: async () => 0,
      currentBranch: async () => 'main',
      fetchBranch: async () => { throw new Error('réseau') },
      localOnlyCommits: async () => 0,
    },
  })
  await closeMission('gh12', d)
  expect(branchCalls(fx).del).toEqual([])
})

test('fermer ne supprime jamais la branche principale ni la branche courante du dépôt', async () => {
  const main = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 0 } })
  await patch({ branch: 'main' })
  await closeMission('gh12', main.d)
  expect(branchCalls(main.fx)).toEqual({ fetch: [], del: [] })
  await rm(missionDir('gh12'), { recursive: true, force: true })

  const cur = await started({ git: { unpushedCount: async () => 0, currentBranch: async () => 'herness/gh12', localOnlyCommits: async () => 0 } })
  await closeMission('gh12', cur.d)
  expect(branchCalls(cur.fx)).toEqual({ fetch: [], del: [] })
})

test('fermer ne touche pas à la branche si la fermeture est annulée ou échoue avant', async () => {
  const { fx, d } = await started({
    git: { unpushedCount: async () => 0, currentBranch: async () => 'main', localOnlyCommits: async () => 0 },
    run: async (cmd: string) =>
      cmd === demo.testDb!.down[0] ? { stdout: '', stderr: 'docker absent', exitCode: 1 } : { stdout: 'Logged in', stderr: '', exitCode: 0 },
  })
  await patch({ testDbUp: true })
  await expect(closeMission('gh12', d)).rejects.toThrow(/docker absent/)
  expect(branchCalls(fx)).toEqual({ fetch: [], del: [] })
})
