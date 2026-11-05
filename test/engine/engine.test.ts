import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { Engine } from '../../src/engine/engine.ts'
import { postInbox } from '../../src/mission/inbox.ts'
import { loadState, newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir, planPath, specPath } from '../../src/paths.ts'
import { fakeEffects, type FakeOverrides } from '../fakes.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-engine-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

async function mission(patch: Partial<MissionState> = {}): Promise<MissionState> {
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: wt }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'herness/T-1',
    herdr: { workspace: 'w1', tabs: { process: 'w1:t4', checks: 'w1:t3', agents: 'w1:t2' }, panes: {} },
    orchestrator: { agent: 'o-T-1' },
    ...patch,
  }
  await saveState(s)
  return s
}

function engine(over: FakeOverrides = {}) {
  const fx = fakeEffects(over)
  return { fx, eng: new Engine('T-1', fx, demo) }
}

const notCursor = async (cmd: string, args: string[]) =>
  cmd === 'cursor-agent' ? { stdout: 'Not logged in', stderr: '', exitCode: 1 } : { stdout: `${cmd} ${args.join(' ')}`, stderr: '', exitCode: 0 }

test('env avec un KO passe la mission en bloquée avec la commande à lancer', async () => {
  await mission()
  const { fx, eng } = engine({ run: notCursor })
  expect(await eng.tick()).toBe('continue')
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toContain('cursor')
  expect(s.blockedReason).toContain('! cursor-agent login')
  const prompts = fx.callsOf('herdr.agentPrompt')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]![0]).toBe('o-T-1')
  expect(String(prompts[0]![1])).toMatch(/^\[herness\] .*cursor-agent login/s)
  expect(prompts[0]![2]).toEqual({ wait: false })
  expect(await eng.tick()).toBe('wait')
})

test('env tout OK passe à prepare', async () => {
  await mission()
  const { eng } = engine()
  await eng.tick()
  expect((await loadState('T-1')).step).toBe('prepare')
})

test("prepare lance la préparation du projet dans l'onglet process, puis classify ; un échec bloque", async () => {
  await mission({ step: 'prepare' })
  const { fx, eng } = engine()
  await eng.tick()
  const [h, tab, cwd, label, cmd, logDir] = fx.callsOf('runInPane')[0]!
  expect(h).toBe(fx.herdr)
  expect([tab, cwd, label, logDir]).toEqual(['w1:t4', wt, 'préparation', join(missionDir('T-1'), 'logs')])
  expect(cmd).toEqual([demo.prepare[0], wt])
  expect((await loadState('T-1')).step).toBe('classify')

  await mission({ step: 'prepare' })
  const ko = engine({ runInPane: async () => ({ exitCode: 2, logPath: '/l.log', tail: 'erreur', durationMs: 1 }) })
  await ko.eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toContain('/l.log')
})

test('classify renomme la branche en feature/<id>-<slug> pour le type feat sur le projet démo', async () => {
  await mission({ step: 'classify' })
  const { fx, eng } = engine()
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('git.renameBranch')).toEqual([])

  await postInbox('T-1', { type: 'classified', workType: 'feat', slug: 'export-csv' })
  expect(await eng.tick()).toBe('continue')
  expect(fx.callsOf('git.renameBranch')).toEqual([[wt, 'herness/T-1', 'feature/T-1-export-csv']])
  const s = await loadState('T-1')
  expect(s).toMatchObject({ step: 'brainstorm', type: 'feat', slug: 'export-csv', branch: 'feature/T-1-export-csv' })
})

test('classified avec un type inconnu est journalisé et ignoré', async () => {
  await mission({ step: 'classify' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'classified', workType: 'bidule', slug: 'export-csv' })
  expect(await eng.tick()).toBe('wait')
  const s = await loadState('T-1')
  expect(s.type).toBeUndefined()
  expect(s.log.map((l) => l.msg).join('\n')).toContain('bidule')
})

async function writeSpec(s0: MissionState): Promise<void> {
  const file = join(wt, specPath(s0))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '# Spec\n')
}

test('une porte spec approuvée commite la spec et passe à plan', async () => {
  await writeSpec(await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' }))
  const { fx, eng } = engine()
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec prête', path: 'docs/x.md' })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('spec')
  expect(s.gates).toMatchObject([{ id: 'g1', kind: 'spec', status: 'pending' }])
  expect(fx.callsOf('herdr.notify')[0]![2]).toBe('request')
  expect(String(fx.callsOf('herdr.agentPrompt')[0]![1])).toMatch(/^\[herness\] .*g1/)
  expect(await eng.tick()).toBe('wait')

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [specPath(s)], 'docs(T-1): spec export-csv']])
  expect(s.step).toBe('plan')
})

test("une porte spec refusée renvoie la note à l'orchestrateur et revient à brainstorm", async () => {
  await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec prête' })
  await eng.tick()
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'refused', note: 'trop vague sur les droits' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('brainstorm')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  const last = fx.callsOf('herdr.agentPrompt').at(-1)!
  expect(last[0]).toBe('o-T-1')
  expect(String(last[1])).toMatch(/^\[herness\] .*trop vague sur les droits/s)
  expect(last[2]).toEqual({ wait: false })
  // la porte refusée ne fait pas repartir en spec ; une nouvelle demande, si
  expect(await eng.tick()).toBe('wait')
  expect((await loadState('T-1')).step).toBe('brainstorm')
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec v2' })
  await eng.tick()
  expect((await loadState('T-1')).step).toBe('spec')
})

const PLAN = '# Plan\n\n### Tâche 1 : Modèle\n\n**Test :** `pnpm test a`\n\nfaire a\n\n### Tâche 2 : Export\n\n**Test :** `pnpm test b`\n\nfaire b\n'

test('une porte plan approuvée remplit state.tasks depuis le plan', async () => {
  const s0 = await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const file = join(wt, planPath(s0))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, PLAN)
  const { fx, eng } = engine()
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'Plan prêt', path: planPath(s0) })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks).toEqual([
    { n: 1, title: 'Modèle', testCommand: 'pnpm test a', phase: 'pending', round: 0 },
    { n: 2, title: 'Export', testCommand: 'pnpm test b', phase: 'pending', round: 0 },
  ])
  expect(await readFile(join(missionDir('T-1'), 'plan.approved.md'), 'utf8')).toBe(PLAN)
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s)], 'docs(T-1): plan export-csv']])
})

test('une porte plan refusée reste en plan et attend une nouvelle porte plan', async () => {
  await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'Plan prêt' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'refused', note: 'découpe trop grosse' })
  expect(await eng.tick()).toBe('wait')
  expect((await loadState('T-1')).step).toBe('plan')
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain('découpe trop grosse')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
})

test('une décision venue d\'un message sans source user est rejetée', async () => {
  await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'Spec prête' })
  await eng.tick()
  const inbox = join(missionDir('T-1'), 'inbox')
  await writeFile(join(inbox, '999999999999999-000001-1-forge.json'), JSON.stringify({ type: 'decision', gateId: 'g1', decision: 'approved' }))
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.gates[0]!.status).toBe('pending')
  expect(s.step).toBe('spec')
  expect(await readdir(join(inbox, 'rejected'))).toEqual(['999999999999999-000001-1-forge.json'])
})

test("abandon ouvre une porte abandon sans rien fermer ; l'utilisateur la valide, les bases sont supprimées et la mission fermée", async () => {
  await mission({ step: 'brainstorm', testDbUp: true })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  expect(await eng.tick()).toBe('wait')
  let s = await loadState('T-1')
  expect(s.step).toBe('brainstorm')
  expect(s.testDbUp).toBe(true)
  expect(s.gates).toMatchObject([{ id: 'g1', kind: 'abandon', status: 'pending', summary: 'spike' }])
  expect(fx.callsOf('run')).toEqual([])
  expect(fx.callsOf('herdr.notify')).toHaveLength(1)
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] .*g1 \(abandon\)/)
  // Une seconde demande ne rouvre pas de porte.
  await postInbox('T-1', { type: 'abandon', reason: 'spike encore' })
  await eng.tick()
  expect((await loadState('T-1')).gates).toHaveLength(1)

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(await eng.tick()).toBe('stop')
  s = await loadState('T-1')
  expect(s.step).toBe('fermée')
  expect(s.testDbUp).toBe(false)
  expect(fx.callsOf('run')).toEqual([[demo.testDb!.down[0], ['down', 'T-1', wt], { cwd: wt, reject: false }]])
})

test('abandon refusé : la mission continue', async () => {
  await mission({ step: 'brainstorm' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'refused', note: 'on continue' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('brainstorm')
  expect(s.gates[0]!.status).toBe('refused')
})

test("abandon validé avec une base impossible à supprimer : mission bloquée, pas fermée", async () => {
  await mission({ step: 'brainstorm', testDbUp: true })
  const { eng } = engine({ run: async () => ({ stdout: '', stderr: 'docker absent', exitCode: 1 }) })
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toContain('base de test T-1 non supprimée')
  expect(s.testDbUp).toBe(true)
})

test("pause empêche toute progression jusqu'à resume", async () => {
  await mission()
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'pause' })
  expect(await eng.tick()).toBe('wait')
  expect(await eng.tick()).toBe('wait')
  let s = await loadState('T-1')
  expect(s).toMatchObject({ step: 'env', paused: true })
  expect(fx.callsOf('run')).toEqual([])
  await postInbox('T-1', { type: 'resume' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s).toMatchObject({ step: 'prepare', paused: false })
})

test('run : une exception bloque la mission sans arrêter le moteur, qui continue jusqu\'à stop', async () => {
  await mission({ step: 'classify', type: 'feat', slug: 'export-csv', testDbUp: true })
  let sleeps = 0
  const { fx, eng } = engine({
    git: { renameBranch: async () => { throw new Error('branche verrouillée') } },
    sleep: async () => {
      if (++sleeps === 2) {
        await postInbox('T-1', { type: 'abandon', reason: 'fin du test' })
        await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
      }
    },
  })
  await eng.run()
  const s = await loadState('T-1')
  expect(s.step).toBe('fermée')
  expect(s.blockedReason).toContain('branche verrouillée')
  expect(s.log.map((l) => l.msg).join('\n')).toContain('branche verrouillée')
  // base de test arrêtée dès l'exception
  expect(fx.callsOf('run')[0]).toEqual([demo.testDb!.down[0], ['down', 'T-1', wt], { cwd: wt, reject: false }])
})

test('pr-ouverte et fermée arrêtent la boucle', async () => {
  await mission({ step: 'pr-ouverte' })
  expect(await engine().eng.tick()).toBe('stop')
})

test('reprise : branche déjà renommée, pas de nouveau renommage, branche enregistrée', async () => {
  await mission({ step: 'classify', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine({ git: { currentBranch: async () => 'feature/T-1-export-csv' } })
  await eng.tick()
  expect(fx.callsOf('git.renameBranch')).toEqual([])
  expect(await loadState('T-1')).toMatchObject({ step: 'brainstorm', branch: 'feature/T-1-export-csv' })
})

test('reprise : spec déjà commitée, pas de commit, passage à plan', async () => {
  await writeSpec(await mission({ step: 'spec', type: 'feat', slug: 'export-csv' }))
  const { fx, eng } = engine({ git: { isClean: async () => true } })
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 's' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(fx.callsOf('git.isClean')).toEqual([[wt, specPath(s)]])
  expect(s.step).toBe('plan')
  expect(s.log.map((l) => l.msg).join('\n')).toContain('déjà commitée')
})

test('reprise : plan déjà commité, pas de commit, tâches remplies et passage à tasks', async () => {
  const s0 = await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const file = join(wt, planPath(s0))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, PLAN)
  const { fx, eng } = engine({ git: { isClean: async () => true } })
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'p' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(s.step).toBe('tasks')
  expect(s.tasks).toHaveLength(2)
})

test('deux request-gate spec ne donnent qu\'une porte en attente, mise à jour', async () => {
  await mission({ step: 'brainstorm', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'v1', path: 'a.md' })
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 'v2', path: 'b.md' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.gates).toHaveLength(1)
  expect(s.gates[0]).toMatchObject({ id: 'g1', status: 'pending', summary: 'v2', path: 'b.md' })
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] .*g1.*déjà en attente/s)
  expect(fx.callsOf('herdr.notify')).toHaveLength(1)
})

test('block enregistre l\'étape d\'où la mission a été bloquée', async () => {
  await mission({ step: 'prepare' })
  const { eng } = engine({ runInPane: async () => ({ exitCode: 1, logPath: '/l', tail: '', durationMs: 1 }) })
  await eng.tick()
  expect(await loadState('T-1')).toMatchObject({ step: 'bloquée', blockedFrom: 'prepare' })
})

test("request-gate amendement : le hachage de la proposition est enregistré dans la porte (mis à jour sur doublon)", async () => {
  await mission({ step: 'bloquée', slug: 'x' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'amendement', summary: 'a', path: '/m/plan.proposed.md', hash: 'h1' })
  await eng.tick()
  expect((await loadState('T-1')).gates[0]).toMatchObject({ kind: 'amendement', hash: 'h1', path: '/m/plan.proposed.md' })
  await postInbox('T-1', { type: 'request-gate', kind: 'amendement', summary: 'b', path: '/m/plan.proposed.md', hash: 'h2' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.gates).toHaveLength(1)
  // Mission bloquée : le résumé dit ce que changera la validation.
  expect(s.gates[0]).toMatchObject({ summary: "b (mission bloquée : valider n'enlève pas le blocage)", hash: 'h2' })
})

test("classified : l'orchestrateur reçoit les chemins exacts de la spec et du plan", async () => {
  await mission({ step: 'classify' })
  const { fx, eng } = engine()
  await postInbox('T-1', { type: 'classified', workType: 'feat', slug: 'export-csv' })
  await eng.tick()
  const s = await loadState('T-1')
  const msg = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).find((p) => p.includes('export-csv'))!
  expect(msg).toContain(join(wt, specPath(s)))
  expect(msg).toContain(join(wt, planPath(s)))
})

test('spec validée mais absente du worktree : mission bloquée avec le chemin, jamais « déjà commitée »', async () => {
  const s0 = await mission({ step: 'spec', type: 'feat', slug: 'export-csv' })
  const { fx, eng } = engine({ git: { isClean: async () => true } })
  await postInbox('T-1', { type: 'request-gate', kind: 'spec', summary: 's' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toContain(join(wt, specPath(s0)))
  expect(s.log.map((l) => l.msg).join('\n')).not.toContain('déjà commitée')
  expect(fx.callsOf('git.commitFiles')).toEqual([])
})

test('plan validé mais absent du worktree : mission bloquée avec le chemin', async () => {
  const s0 = await mission({ step: 'plan', type: 'feat', slug: 'export-csv' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'request-gate', kind: 'plan', summary: 'p' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedFrom).toBe('plan')
  expect(s.blockedReason).toContain(join(wt, planPath(s0)))
  expect(s.blockedReason).not.toContain('erreur du moteur')
})

test('au démarrage du moteur, les commandes restées en cours dans checks et process sont interrompues et marquées ✗', async () => {
  const { fx, eng } = engine()
  const { ws, tab: checks, pane: c1 } = fx.herdr.seedWorkspace('T-1', 'checks')
  const proc = await fx.herdr.tabCreate({ workspace: ws, cwd: wt, label: 'process' })
  const agents = await fx.herdr.tabCreate({ workspace: ws, cwd: wt, label: 'agents' })
  await fx.herdr.paneRename(c1, 'preflight · lint …')
  const c2 = fx.herdr.addPane(checks, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · tests ✓')
  await fx.herdr.paneRename(proc.rootPaneId, 'engine')
  const p2 = fx.herdr.addPane(proc.tabId, { x: 0, y: 30, width: 200, height: 30 }, 'base de test …')
  const a1 = fx.herdr.addPane(agents.tabId, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · grok …')
  for (const p of [c1, p2, a1]) fx.herdr.pane(p).busy = true
  await mission({ step: 'pr-ouverte', herdr: { workspace: ws, tabs: { checks, process: proc.tabId, agents: agents.tabId }, panes: {} } })
  fx.calls.length = 0
  await eng.run()
  const keys = fx.callsOf('herdr.paneSendKeys')
  expect(keys).toEqual([[c1, 'ctrl+c'], [c1, 'ctrl+c'], [p2, 'ctrl+c'], [p2, 'ctrl+c'], [a1, 'ctrl+c'], [a1, 'ctrl+c']])
  expect(fx.herdr.pane(c1).label).toBe('preflight · lint ✗')
  expect(fx.herdr.pane(p2).label).toBe('base de test ✗')
  expect(fx.herdr.pane(c2).label).toBe('T1 · tests ✓')
  expect(fx.herdr.pane(proc.rootPaneId).label).toBe('engine')
  expect(fx.herdr.pane(a1).label).toBe('T1 · grok …')
  expect(fx.herdr.pane(a1).busy).toBe(false)
  // Une seule fois par démarrage du moteur.
  await eng.tick()
  expect(fx.callsOf('herdr.paneSendKeys')).toHaveLength(6)
})

test('au démarrage du moteur, une mission bloquée arrête les agents des panneaux ✓ et garde les autres', async () => {
  const { fx, eng } = engine({
    sleep: async () => {
      throw new Error('fin du test')
    },
  })
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const done = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · grok ✓')
  const live = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T2 · grok')
  for (const p of [done, live]) fx.herdr.pane(p).busy = true
  await mission({
    step: 'bloquée',
    blockedFrom: 'tasks',
    blockedReason: 'contrôle en échec',
    herdr: { workspace: ws, tabs: { agents: tab }, panes: {} },
  })
  await expect(eng.run()).rejects.toThrow('fin du test')
  expect(fx.herdr.pane(done).busy).toBe(false)
  expect(fx.herdr.pane(live).busy).toBe(true)
  const s = await loadState('T-1')
  expect(s.log.map((l) => l.msg).join('\n')).toContain('démarrage du moteur : agent(s) arrêté(s) dans T1 · grok ✓')
})

test("un abandon validé arrête tous les agents de l'onglet agents", async () => {
  const { fx, eng } = engine()
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const done = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T1 · grok ✓')
  const live = fx.herdr.addPane(tab, { x: 0, y: 30, width: 200, height: 30 }, 'T2 · grok')
  for (const p of [done, live]) fx.herdr.pane(p).busy = true
  await mission({
    step: 'brainstorm',
    testDbUp: true,
    herdr: { workspace: ws, tabs: { process: 'w1:t4', checks: 'w1:t3', agents: tab }, panes: {} },
  })
  await postInbox('T-1', { type: 'abandon', reason: 'spike' })
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(await eng.tick()).toBe('stop')
  const s = await loadState('T-1')
  expect(s.step).toBe('fermée')
  expect(fx.herdr.pane(done).busy).toBe(false)
  expect(fx.herdr.pane(live).busy).toBe(false)
  expect(s.log.some((l) => l.msg.startsWith('abandon validé : agent(s) arrêté(s) dans'))).toBe(true)
})

test("orchestrator-started : le moteur enregistre que le prompt d'ouverture est parti", async () => {
  await mission({ step: 'bloquée' })
  const { eng } = engine()
  await postInbox('T-1', { type: 'orchestrator-started' })
  await eng.tick()
  expect((await loadState('T-1')).orchestrator.started).toBe(true)
})
