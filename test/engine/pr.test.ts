import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { Engine } from '../../src/engine/engine.ts'
import { openGate } from '../../src/engine/gates.ts'
import { drainInbox, postInbox } from '../../src/mission/inbox.ts'
import { freshLoops, loadState, newState, saveState, type MissionState, type TaskState } from '../../src/mission/state.ts'
import { missionDir, specPath } from '../../src/paths.ts'
import { fakeEffects, type FakeEffects, type FakeOverrides } from '../fakes.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-pr-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const SPEC = '# Export CSV des dossiers\n\n## Intention\n\nPermettre l\'export CSV\ndes dossiers du mois.\n\nSecond paragraphe.\n'
const task = (patch: Partial<TaskState>): TaskState => ({ n: 1, title: 'Modèle', testCommand: 'pnpm test a', phase: 'done', round: 0, ...patch })

async function setup(opts: { over?: FakeOverrides; patch?: Partial<MissionState> } = {}) {
  const over = opts.over ?? {}
  const fx: FakeEffects = fakeEffects({ ...over, git: { currentBranch: async () => 'feature/T-1-export-csv', ...over.git } })
  const loops = freshLoops()
  // Tête validée par le dernier preflight complet (= `headSha` de la doublure).
  loops.preflight.validatedSha = 'sha-head'
  loops.preflight.results = [
    { label: 'lint', exitCode: 0, durationMs: 4200, logPath: '/l/lint.log' },
    { label: 'test', exitCode: 1, durationMs: 125000, logPath: '/l/test.log', note: 'rouge aussi sur origin/main' },
  ]
  loops.preflight.acceptedRed = ['test']
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'github', ref: 'https://github.com/o/r/issues/12' }, project: 'demo', repoPath: join(home, 'repo') }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'feature/T-1-export-csv',
    type: 'feat',
    slug: 'export-csv',
    step: 'pr',
    tasks: [task({ n: 1, title: 'Modèle', testCommand: 'pnpm test a' }), task({ n: 2, title: 'Export', testCommand: 'pnpm test b' })],
    loops,
    herdr: { workspace: 'w1', tabs: { agents: 'w1:t2', checks: 'w1:t3', process: 'w1:t4' }, panes: {} },
    orchestrator: { agent: 'oT-1' },
    ...opts.patch,
  }
  await saveState(s)
  const file = join(wt, specPath(s))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, SPEC)
  return { fx, eng: new Engine('T-1', fx, demo) }
}

const prompts = (fx: FakeEffects) => fx.callsOf('herdr.agentPrompt').map((c) => c[1] as string)
const notes = (fx: FakeEffects) => fx.callsOf('herdr.notify').map((c) => c[1] as string)

test('stepPr pousse, crée la PR et passe en pr-ouverte', async () => {
  const { fx, eng } = await setup({ over: { git: { unpushedCount: async () => 3 } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('pr-ouverte')
  expect(s.prUrl).toBe('https://github.com/o/r/pull/1')
  expect(fx.callsOf('git.fetchMain')[0]).toEqual([wt, 'main'])
  expect(fx.callsOf('git.isAncestor')[0]).toEqual([wt, 'origin/main', 'HEAD'])
  expect(fx.callsOf('git.rebaseOnto')).toEqual([])
  expect(fx.callsOf('git.push')).toEqual([[wt, 'feature/T-1-export-csv']])
  const bodyFile = join(missionDir('T-1'), 'pr-body.md')
  expect(fx.callsOf('forge.createPr')).toEqual([[wt, { base: 'main', title: 'feat(export-csv): Export CSV des dossiers', bodyFile }]])
  const body = await readFile(bodyFile, 'utf8')
  expect(body).toContain('https://github.com/o/r/issues/12')
  expect(body).toContain("Permettre l'export CSV\ndes dossiers du mois.")
  expect(body).not.toContain('Second paragraphe')
  expect(body).toContain('- Tâche 1 : Modèle')
  expect(body).toContain('- Tâche 2 : Export')
  expect(body).toContain('`pnpm test a`')
  expect(body).toContain('`pnpm test b`')
  expect(body).toMatch(/lint ✓ \(4 s\)/)
  expect(body).toMatch(/test ✗ \(2 min 05 s\)/)
  expect(body).toContain('rouge déjà sur main, accepté')
  expect(body).toContain(specPath(s))
  expect(body).toContain('docs/superpowers/plans/2026-10-29-T-1-export-csv.md')
  expect(notes(fx).some((n) => n.includes('https://github.com/o/r/pull/1'))).toBe(true)
  expect(prompts(fx).some((p) => p.includes('https://github.com/o/r/pull/1'))).toBe(true)
  expect(await eng.tick()).toBe('stop')
})

test('stepPr : demande écrite citée telle quelle dans le corps', async () => {
  const { fx, eng } = await setup({ patch: { source: { kind: 'text', ref: 'ajoute un export' } } })
  await eng.tick()
  const body = await readFile(join(missionDir('T-1'), 'pr-body.md'), 'utf8')
  expect(body).toContain('demande écrite')
  expect(fx.callsOf('forge.createPr')).toHaveLength(1)
})

test('stepPr bloque la mission sur un conflit de rebase et l\'annule', async () => {
  const { fx, eng } = await setup({ over: { git: { isAncestor: async () => false, rebaseOnto: async () => ({ ok: false }) } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedFrom).toBe('pr')
  expect(s.blockedReason).toMatch(/conflit/)
  expect(fx.callsOf('git.rebaseOnto')).toEqual([[wt, 'origin/main']])
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr revient au preflight quand le rebase a changé du code', async () => {
  let head = 'sha-head'
  const rebaseOnto = async () => {
    head = 'sha-rebasee'
    return { ok: true as const, changedCode: true }
  }
  const { fx, eng } = await setup({ over: { git: { isAncestor: async () => false, rebaseOnto, headSha: async () => head } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.results).toEqual([])
  expect(s.loops.preflight.acceptedRed).toEqual([])
  expect(s.prUrl).toBeUndefined()
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr idempotent : branche déjà poussée et PR existante réutilisée', async () => {
  const { fx, eng } = await setup({
    over: { git: { unpushedCount: async () => 0 }, forge: { findPr: async () => 'https://github.com/o/r/pull/7' } },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('pr-ouverte')
  expect(s.prUrl).toBe('https://github.com/o/r/pull/7')
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.findPr')).toEqual([[wt, 'feature/T-1-export-csv']])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr avec prUrl déjà enregistrée passe directement en pr-ouverte', async () => {
  const { fx, eng } = await setup({ patch: { prUrl: 'https://github.com/o/r/pull/9' } })
  await eng.tick()
  expect((await loadState('T-1')).step).toBe('pr-ouverte')
  expect(fx.callsOf('git.fetchMain')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr revient au preflight si HEAD n\'est pas la tête validée par le preflight', async () => {
  const { fx, eng } = await setup({ over: { git: { headSha: async () => 'sha-autre' } } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.results).toEqual([])
  expect(s.loops.preflight.acceptedRed).toEqual([])
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

test('stepPr refuse de pousser la branche principale ou une autre branche que celle de la mission', async () => {
  let r = await setup({ patch: { branch: 'main' }, over: { git: { currentBranch: async () => 'main' } } })
  await r.eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toMatch(/branche principale/)
  expect(r.fx.callsOf('git.push')).toEqual([])

  r = await setup({ over: { git: { currentBranch: async () => 'feature/autre' } } })
  await r.eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toMatch(/feature\/autre/)
  expect(r.fx.callsOf('git.push')).toEqual([])
  expect(r.fx.callsOf('git.rebaseOnto')).toEqual([])
})

test('conflit résolu à la main puis reprise validée : retour au preflight, aucun push', async () => {
  let head = 'sha-head'
  let ancestor = false
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => head, isAncestor: async () => ancestor, rebaseOnto: async () => ({ ok: false }) } },
  })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  // L'utilisateur rebase et résout le conflit : la tête change, main est désormais ancêtre.
  head = 'sha-resolue'
  ancestor = true
  const g = openGate(s, 'reprise-bloquee', s.blockedReason!)
  await saveState(s)
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.validatedSha).toBeUndefined()
  expect(fx.callsOf('git.push')).toEqual([])
  expect(fx.callsOf('forge.createPr')).toEqual([])
})

// ---------- reprise d'une mission bloquée (R12/R13) ----------

async function blocked(blockedFrom: MissionState['step'], patch: Partial<MissionState> = {}) {
  // En pause : le moteur traite la décision sans exécuter l'étape reprise.
  const r = await setup({ patch: { step: 'bloquée', blockedFrom, blockedReason: '3 tours de correction épuisés', paused: true, ...patch } })
  const s = await loadState('T-1')
  const g = openGate(s, 'reprise-bloquee', s.blockedReason!)
  await saveState(s)
  return { ...r, gate: g.id }
}

test('reprise-bloquee validée : retour à l\'étape bloquée, tours de la tâche en cours remis à zéro', async () => {
  const tasks = [task({ n: 1, round: 2 }), task({ n: 2, title: 'Export', phase: 'test', round: 4 })]
  const { eng, gate } = await blocked('tasks', { tasks })
  await mkdir(join(missionDir('T-1'), 'taches', '2'), { recursive: true })
  await writeFile(join(missionDir('T-1'), 'taches', '2', 'correctifs-1.md'), 'ancien')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.blockedReason).toBeUndefined()
  expect(s.blockedFrom).toBeUndefined()
  expect(s.tasks.map((t) => t.round)).toEqual([2, 0])
  expect(s.step).toBe('tasks')
  expect(s.log.some((l) => /reprise/.test(l.msg))).toBe(true)
  // L'ancien fichier de correction n'est jamais renvoyé au nouveau tour 1 : il est archivé.
  const dir = join(missionDir('T-1'), 'taches', '2')
  expect(await readdir(dir)).toEqual([`correctifs-1.avant-${gate}.md`])
})

test("reprise-bloquee validée sur une tâche bloquée au contrôle sans commit : l'implémenteur est relancé avec son brief", async () => {
  const pa = { agent: 'ct-1-t2', file: '/x/brief.md', fromSha: 'sha-head' }
  const tasks = [task({ n: 1 }), task({ n: 2, title: 'Export', phase: 'control', round: 1, baseSha: 'sha-head', pendingAsk: pa })]
  const { eng, gate } = await blocked('tasks', { tasks })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks[1]).toMatchObject({ phase: 'implement', round: 0 })
  expect(s.tasks[1]!.pendingAsk).toBeUndefined()
})

test('reprise-bloquee validée sur une tâche au contrôle avec des commits : le contrôle est rejoué', async () => {
  const tasks = [task({ n: 1 }), task({ n: 2, title: 'Export', phase: 'control', round: 1, baseSha: 'b-avant' })]
  const { eng, gate } = await blocked('tasks', { tasks })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  expect((await loadState('T-1')).tasks[1]).toMatchObject({ phase: 'control', round: 0 })
})

test('reprise-bloquee validée depuis la revue globale ou le preflight : tours de la boucle remis à zéro', async () => {
  const loops = freshLoops()
  loops.globalReview.round = 4
  loops.preflight.round = 4
  const { eng, gate } = await blocked('global-review', { loops })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'approved' })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.loops.globalReview.round).toBe(0)
  expect(s.loops.preflight.round).toBe(4)
  expect(s.blockedReason).toBeUndefined()

  const r2 = await blocked('preflight', { loops })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: r2.gate, decision: 'approved' })
  await r2.eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.preflight.round).toBe(0)
  expect(s.loops.globalReview.round).toBe(4)
})

test('reprise-bloquee refusée : la mission reste bloquée', async () => {
  const { eng, gate } = await blocked('tasks', { tasks: [task({ phase: 'test', round: 4 })] })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: gate, decision: 'refused', note: 'pas encore' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedFrom).toBe('tasks')
  expect(s.blockedReason).toBe('3 tours de correction épuisés')
  expect(s.tasks[0]!.round).toBe(4)
})

test('une demande de porte reprise-bloquee est ignorée si la mission n\'est pas bloquée', async () => {
  const { fx, eng } = await setup({ patch: { step: 'pr-ouverte' } })
  await postInbox('T-1', { type: 'request-gate', kind: 'reprise-bloquee', summary: 'x' })
  await eng.tick()
  expect((await loadState('T-1')).gates).toEqual([])
  expect(fx.callsOf('herdr.notify')).toEqual([])
  expect(await drainInbox('T-1')).toEqual([])
})

test('main bouge encore après un rebase automatique et son preflight : mission bloquée, la reprise remet le compteur à zéro', async () => {
  let head = 'sha-head'
  let n = 0
  const rebaseOnto = async () => {
    head = `sha-rebasee-${++n}`
    return { ok: true as const, changedCode: true }
  }
  const { fx, eng } = await setup({ over: { git: { isAncestor: async () => false, rebaseOnto, headSha: async () => head } } })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(s.loops.prRebases).toBe(1)
  // Le preflight rejoué valide la tête rebasée ; main a encore bougé entre-temps.
  s.step = 'pr'
  s.loops.preflight.validatedSha = head
  await saveState(s)
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedFrom).toBe('pr')
  expect(s.blockedReason).toContain('main a encore bougé pendant le preflight ; reprends la mission pour relancer')
  expect(fx.callsOf('git.rebaseOnto')).toHaveLength(1)
  expect(fx.callsOf('git.push')).toEqual([])

  await postInbox('T-1', { type: 'request-gate', kind: 'reprise-bloquee', summary: 'r' })
  await eng.tick()
  const g = (await loadState('T-1')).gates.at(-1)!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  // Compteur remis à zéro par la reprise : un nouveau rebase automatique est permis.
  expect(s.step).toBe('preflight')
  expect(s.loops.prRebases).toBe(1)
  expect(fx.callsOf('git.rebaseOnto')).toHaveLength(2)
})
