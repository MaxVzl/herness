import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import type { ProjectConfig } from '../../src/config/project.ts'
import { Engine } from '../../src/engine/engine.ts'
import { triage } from '../../src/engine/finish.ts'
import { postInbox } from '../../src/mission/inbox.ts'
import { loadState, newState, saveState, type Gate, type MissionState, type TaskState } from '../../src/mission/state.ts'
import { proposalHash } from '../../src/mission/amendment.ts'
import { missionDir, planPath } from '../../src/paths.ts'
import { fakeEffects, type FakeEffects, type FakeOverrides } from '../fakes.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-finish-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const PLAN1 = '# Plan\n\n### Tâche 1 : Modèle\n\n**Test :** `pnpm test a`\n\nfaire a\n'
const PLAN2 = `${PLAN1}\n### Tâche 2 : Export\n\n**Test :** \`pnpm test b\`\n\nfaire b\n`
const cfg: ProjectConfig = {
  ...demo,
  preflight: [
    { label: 'lint', command: ['pnpm', 'lint'] },
    { label: 'test', command: ['pnpm', 'test'] },
  ],
}
const task = (patch: Partial<TaskState> = {}): TaskState => ({ n: 1, title: 'Modèle', testCommand: 'pnpm test a', phase: 'done', round: 0, ...patch })
const gdir = () => join(missionDir('T-1'), 'global')
const pdir = () => join(missionDir('T-1'), 'preflight')
const down = () => [demo.testDb!.down[0], ['down', 'T-1', wt], { cwd: wt, reject: false }]

/** Agents factices : un relecteur écrit le rapport à côté de sa consigne (`consigne-revue.md` → `revue.md`). */
function agentsAsk(answer: (name: string) => string | undefined) {
  return async (name: string, file: string) => {
    const v = answer(name)
    if (v !== undefined) {
      const out = join(dirname(file), basename(file).replace(/^consigne-/, ''))
      await writeFile(out, `${v}\n\n## Remarques\n- src/a.ts:3 remarque de ${name}\n`)
    }
    return 'done' as const
  }
}
const verdicts = (byPrefix: Record<string, string[]>) => {
  const n: Record<string, number> = {}
  return agentsAsk((name) => {
    const k = Object.keys(byPrefix).find((p) => name.startsWith(p))
    if (!k) return undefined
    const list = byPrefix[k]!
    const i = (n[k] = (n[k] ?? 0) + 1)
    return list[Math.min(i - 1, list.length - 1)]
  })
}

type Res = { exitCode: number; logPath: string; tail: string; durationMs: number }
const ok: Res = { exitCode: 0, logPath: '/l/ok.log', tail: 'ok', durationMs: 7 }
const ko = (tail: string): Res => ({ exitCode: 1, logPath: '/l/ko.log', tail, durationMs: 9 })
/** `runInPane` scripté par libellé ; chaque libellé consomme sa liste dans l'ordre (dernière valeur répétée). */
function panes(script: Record<string, (Res | 'throw')[]> = {}) {
  const n: Record<string, number> = {}
  return (async (_h: unknown, _tab: string, _cwd: string, label: string) => {
    const list = script[label]
    if (!list) return ok
    const i = (n[label] = (n[label] ?? 0) + 1)
    const r = list[Math.min(i - 1, list.length - 1)]!
    if (r === 'throw') throw new Error(`panneau ${label} perdu`)
    return r
  }) as never
}

async function setup(opts: { over?: FakeOverrides; patch?: Partial<MissionState>; config?: ProjectConfig; plan?: string } = {}) {
  const fx: FakeEffects = fakeEffects(opts.over)
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: join(home, 'repo') }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'feature/T-1-export-csv',
    type: 'feat',
    slug: 'export-csv',
    step: 'global-review',
    tasks: [task({ baseSha: 'b1', reviewedSha: 'h1' })],
    herdr: { workspace: ws, tabs: { agents: tab, checks: `${ws}:tc`, process: `${ws}:tp` }, panes: {} },
    orchestrator: { agent: 'o-T-1' },
    ...opts.patch,
  }
  await saveState(s)
  const file = join(wt, planPath(s))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, opts.plan ?? PLAN1)
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), PLAN1)
  // Un amendement est proposé hors du worktree (`plan.proposed.md`), lié à son contenu par un hachage.
  if (opts.plan !== undefined && opts.plan !== PLAN1) await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), opts.plan)
  return { fx, eng: new Engine('T-1', fx, opts.config ?? cfg) }
}

async function until(eng: Engine, pred: (s: MissionState) => boolean, max = 60): Promise<MissionState> {
  for (let i = 0; i < max; i++) {
    await eng.tick()
    const s = await loadState('T-1')
    if (pred(s)) return s
  }
  throw new Error(`condition jamais atteinte (étape ${(await loadState('T-1')).step})`)
}

const labels = (fx: FakeEffects) => fx.callsOf('runInPane').map((c) => c[3])

// ---------- revue globale ----------

test('revue globale approuvée passe au preflight', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: verdicts({ rg: ['VERDICT: APPROUVÉ'] }) } } })
  const s = await until(eng, (x) => x.step !== 'global-review')
  expect(s.step).toBe('preflight')
  expect(fx.callsOf('git.mergeBase')[0]).toEqual([wt, 'origin/main'])
  expect(fx.callsOf('git.diffPackage')[0]).toEqual([wt, 'sha-base', join(gdir(), 'branche.diff')])
  const [name, role, , launch] = fx.callsOf('agents.start')[0]!
  expect([name, role]).toEqual(['rgt-1', 'reviewer'])
  expect((launch as { args: string[] }).args).toContain('claude-opus-5-5')
  expect(fx.callsOf('agents.ask')[0]!.slice(0, 2)).toEqual(['rgt-1', join(gdir(), 'consigne-revue.md')])
  const consigne = await readFile(join(gdir(), 'consigne-revue.md'), 'utf8')
  expect(consigne).toContain('sha-base..sha-head')
  expect(consigne).toContain(join(gdir(), 'revue.md'))
  expect(consigne).toContain('git push')
  expect(s.loops.globalReview).toMatchObject({ round: 0, reviewedSha: 'sha-head', lastReview: join(gdir(), 'revue.md') })
  expect(s.loops.globalReview.pendingAsk).toBeUndefined()
})

test('revue globale en corrections démarre un implémenteur neuf puis re-revue par le même relecteur', async () => {
  const { fx, eng } = await setup({
    patch: { tasks: [task({ baseSha: 'b1', reviewedSha: 'h1' }), task({ n: 2, title: 'Export', testCommand: 'pnpm test b', baseSha: 'b2', reviewedSha: 'h2' })] },
    over: {
      agents: { ask: verdicts({ rg: ['VERDICT: CORRECTIONS', 'VERDICT: APPROUVÉ'] }) },
      // La correction touche src/a.ts, touché aussi par la tâche 1 seulement.
      git: { changedFiles: async (_wt: string, base: string, head?: string) => (head === undefined ? ['src/a.ts'] : base === 'b1' ? ['src/a.ts'] : ['src/b.ts']) },
    },
  })
  let s = await until(eng, (x) => x.loops.globalReview.phase === 'fix')
  expect(s.loops.globalReview).toMatchObject({ round: 1, fixer: 'new' })
  s = await until(eng, (x) => x.step !== 'global-review')
  expect(s.step).toBe('preflight')

  expect(fx.callsOf('agents.start').map((c) => [c[0], c[1]])).toEqual([['rgt-1', 'reviewer'], ['cgt-1-1', 'implementer']])
  expect((fx.callsOf('agents.start')[1]![3] as { args: string[] }).args).toContain('grok-4.7-medium')
  const asks = fx.callsOf('agents.ask').map((c) => c.slice(0, 2))
  expect(asks).toEqual([
    ['rgt-1', join(gdir(), 'consigne-revue.md')],
    ['cgt-1-1', join(gdir(), 'correctifs-1.md')],
    ['rgt-1', join(gdir(), 'consigne-rerevue-1.md')],
  ])
  const fix = await readFile(join(gdir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain('src/a.ts:3 remarque de rgt-1')
  expect(fix).toContain(join(gdir(), 'rapport.md'))
  expect(fx.callsOf('git.controlCommits')[0]).toEqual([wt, 'sha-head', demo.forbiddenPaths])
  // Tests des tâches touchées seulement, dans l'onglet checks.
  const tests = fx.callsOf('runInPane')
  expect(tests.map((c) => [c[1], c[4]])).toEqual([[s.herdr.tabs['checks'], ['bash', '-c', 'pnpm test a']]])
  // Re-revue : diff depuis la tête relue, remarques précédentes.
  expect(fx.callsOf('git.diffPackage')[1]).toEqual([wt, 'sha-head', join(gdir(), 'correction-1.diff')])
  const rr = await readFile(join(gdir(), 'consigne-rerevue-1.md'), 'utf8')
  expect(rr).toContain('src/a.ts:3 remarque de rgt-1')
  expect(s.loops.globalReview.round).toBe(0)
  expect(fx.herdr.panes.map((p) => p.label)).toContain('CG1 · grok-4.7-medium ✓')
})

test('revue globale : des tests rouges après correction lancent un nouveau tour avec la sortie rouge', async () => {
  const { fx, eng } = await setup({
    over: {
      agents: { ask: verdicts({ rg: ['VERDICT: CORRECTIONS', 'VERDICT: APPROUVÉ'] }) },
      runInPane: panes({ 'RG · tests T1': [ko('AssertionError: attendu 2'), ok] }),
    },
  })
  const s = await until(eng, (x) => x.step !== 'global-review')
  expect(s.step).toBe('preflight')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rgt-1', 'cgt-1-1', 'cgt-1-2'])
  const fix2 = await readFile(join(gdir(), 'correctifs-2.md'), 'utf8')
  expect(fix2).toContain('AssertionError: attendu 2')
})

test('revue globale : au 3e tour un implémenteur fort, au-delà la mission est bloquée', async () => {
  const { fx, eng } = await setup({
    patch: { loops: { ...newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops, globalReview: { round: 2, reviewedSha: 'sha-r', lastReview: '/nulle/part.md', phase: 'rereview' } } },
    over: { agents: { ask: verdicts({ rg: ['VERDICT: CORRECTIONS'] }) } },
  })
  let s = await until(eng, (x) => x.loops.globalReview.phase === 'control')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rgt-1', 'cgt-1-3'])
  expect((fx.callsOf('agents.start')[1]![3] as { args: string[] }).args).toContain('grok-4.7-high')
  s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedReason).toContain('3 tours de correction épuisés')
})

// ---------- preflight ----------

test('preflight tout vert crée puis supprime la base et passe à pr', async () => {
  const { fx, eng } = await setup({ patch: { step: 'preflight' }, over: { runInPane: panes() } })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  expect(s.testDbUp).toBe(false)
  // Tête validée par ce preflight complet : la PR ne part que de celle-ci.
  expect(s.loops.preflight.validatedSha).toBe('sha-head')
  const rip = fx.callsOf('runInPane')
  expect(rip.map((c) => [c[1], c[2], c[3], c[4]])).toEqual([
    [s.herdr.tabs['process'], wt, 'base de test', [demo.testDb!.up[0], 'up', 'T-1', wt]],
    [s.herdr.tabs['checks'], wt, 'preflight · lint', ['pnpm', 'lint']],
    [s.herdr.tabs['checks'], wt, 'preflight · test', ['pnpm', 'test']],
  ])
  expect(fx.callsOf('run')).toEqual([down()])
  // origin/main récupéré une fois, juste avant le premier check.
  const order = fx.calls.map((c) => (c.fn === 'runInPane' ? `rip ${c.args[3]}` : c.fn)).filter((f) => f.startsWith('rip') || f === 'git.fetchMain')
  expect(order).toEqual(['rip base de test', 'git.fetchMain', 'rip preflight · lint', 'rip preflight · test'])
  expect(fx.callsOf('git.fetchMain')).toEqual([[wt, 'main']])
  expect(s.loops.preflight.results).toEqual([
    { label: 'lint', exitCode: 0, durationMs: 7, logPath: '/l/ok.log' },
    { label: 'test', exitCode: 0, durationMs: 7, logPath: '/l/ok.log' },
  ])
})

test('un check rouge correspondant au faux positif Roboto est relancé une fois', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight' },
    over: { runInPane: panes({ 'preflight · lint': [ko("Module not found: Can't resolve 'Roboto'"), ok] }) },
  })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  expect(labels(fx)).toEqual(['base de test', 'preflight · lint', 'preflight · lint', 'preflight · test'])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(s.log.map((l) => l.msg).join('\n')).toContain('Roboto')
})

test('le même faux positif rouge deux fois part au diagnostic', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight' },
    over: {
      runInPane: panes({ 'preflight · lint': [ko("Module not found: Can't resolve 'Roboto'")] }),
      agents: { ask: verdicts({ rd: ['CAUSE: ENVIRONNEMENT'] }) },
    },
  })
  let s = await until(eng, (x) => x.loops.preflight.phase === 'diagnose')
  expect(labels(fx)).toEqual(['base de test', 'preflight · lint', 'preflight · lint'])
  expect(s.loops.preflight.failing).toMatchObject({ label: 'lint', exitCode: 1, logPath: '/l/ko.log' })
  s = await until(eng, (x) => x.step === 'bloquée')
  expect(fx.callsOf('agents.start').map((c) => [c[0], c[1]])).toEqual([['rdt-1-1', 'reviewer']])
  expect(fx.callsOf('agents.ask')[0]!.slice(0, 2)).toEqual(['rdt-1-1', join(pdir(), 'consigne-diagnostic-1.md')])
  const consigne = await readFile(join(pdir(), 'consigne-diagnostic-1.md'), 'utf8')
  expect(consigne).toContain('/l/ko.log')
  expect(s.blockedReason).toContain('ENVIRONNEMENT')
  expect(s.blockedReason).toContain('remarque de rdt-1-1')
  expect(s.testDbUp).toBe(false)
  expect(fx.callsOf('run')).toEqual([down()])
})

test("le faux positif format:check est ignoré si aucun fichier de la branche n'est dans le journal", async () => {
  const config: ProjectConfig = { ...cfg, preflight: [{ label: 'format:check', command: ['pnpm', 'format:check'] }] }
  const { fx, eng } = await setup({
    config,
    patch: { step: 'preflight' },
    over: {
      runInPane: panes({ 'preflight · format:check': [ko('[warn] apps/web/x.ts\n[warn] Code style issues found')] }),
      git: { changedFiles: async () => ['apps/api/y.ts'] },
    },
  })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  expect(fx.callsOf('git.mergeBase')).toContainEqual([wt, 'origin/main'])
  expect(s.loops.preflight.results).toEqual([
    { label: 'format:check', exitCode: 1, durationMs: 9, logPath: '/l/ko.log', note: expect.stringContaining('CRLF') },
  ])
})

test('le faux positif format:check ne s\'applique pas si un fichier touché par la branche est dans le journal', () => {
  const r = { label: 'format:check', log: '[warn] apps/web/x.ts\n[warn] Code style issues found' }
  expect(triage(r, demo, ['apps/web/x.ts'])).toBe('diagnose')
  expect(triage(r, demo, ['apps/api/y.ts'])).toBe('ignore')
  expect(triage({ label: 'lint', log: 'Code style issues found' }, demo, [])).toBe('diagnose')
  expect(triage({ label: 'test', log: 'FAIL apps/api/src/test/setup.ts' }, demo, [])).toEqual({ cleanup: ['pkill', '-f', '{worktree}/node_modules/.*vitest'] })
  expect(triage({ label: 'build', log: "x\nModule not found: Error: Roboto\n" }, demo, [])).toBe('retry')
  expect(triage({ label: 'build', log: 'Module not found: Error: Roboto' }, demo, [], [1])).toBe('diagnose')
})

test('un nettoyage prévu est lancé dans l\'onglet process avant de relancer le check', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight' },
    over: { runInPane: panes({ 'preflight · test': [ko('Error in apps/api/src/test/setup.ts'), ok] }) },
  })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  const rip = fx.callsOf('runInPane')
  expect(rip.map((c) => c[3])).toEqual(['base de test', 'preflight · lint', 'preflight · test', 'nettoyage', 'preflight · test'])
  expect(rip[3]!.slice(1, 3)).toEqual([s.herdr.tabs['process'], wt])
  // Limité aux vitest du worktree de la mission : jamais ceux d'un autre checkout.
  expect(rip[3]![4]).toEqual(['pkill', '-f', `${wt}/node_modules/.*vitest`])
})

const MAIN_WT = () => join(missionDir('T-1'), 'preuve-main')

test('CAUSE: MAIN prouvée ouvre la porte pr-malgre-main et supprime le worktree temporaire', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight' },
    over: {
      runInPane: panes({ 'preflight · lint': [ko('erreur de lint ancienne')], 'preuve main · lint': [ko('erreur de lint ancienne')] }),
      agents: { ask: verdicts({ rd: ['CAUSE: MAIN'] }) },
    },
  })
  let s = await until(eng, (x) => x.loops.preflight.phase === 'gate')
  const repo = join(home, 'repo')
  expect(fx.callsOf('git.worktreeAddDetached')).toEqual([[repo, MAIN_WT(), 'origin/main']])
  expect(fx.callsOf('git.worktreeRemove')).toEqual([[repo, MAIN_WT()]])
  const proof = fx.callsOf('runInPane').filter((c) => String(c[3]).startsWith('preuve main'))
  expect(proof.map((c) => [c[1], c[2], c[3], c[4]])).toEqual([
    [s.herdr.tabs['process'], MAIN_WT(), 'preuve main · préparation', [demo.prepare[0], MAIN_WT()]],
    [s.herdr.tabs['process'], MAIN_WT(), 'preuve main · base de test', [demo.testDb!.up[0], 'up', 'T-1-main', MAIN_WT()]],
    [s.herdr.tabs['process'], MAIN_WT(), 'preuve main · lint', ['pnpm', 'lint']],
    [s.herdr.tabs['process'], wt, 'preuve main · arrêt de la base', [demo.testDb!.down[0], 'down', 'T-1-main', MAIN_WT()]],
  ])
  // La base de la preuve est arrêtée avant la suppression du worktree.
  const order = fx.calls.map((c) => (c.fn === 'runInPane' ? String(c.args[3]) : c.fn)).filter((f) => f === 'preuve main · arrêt de la base' || f === 'git.worktreeRemove')
  expect(order).toEqual(['preuve main · arrêt de la base', 'git.worktreeRemove'])
  const g = s.gates.at(-1)!
  expect(g).toMatchObject({ kind: 'pr-malgre-main', status: 'pending' })
  expect(g.summary).toContain('lint')
  expect(s.testDbUp).toBe(true)

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  expect(s.loops.preflight.acceptedRed).toEqual(['lint'])
  expect(s.loops.preflight.results.map((r) => [r.label, r.exitCode])).toEqual([['lint', 1], ['test', 0]])
  expect(s.loops.preflight.results[0]!.note).toContain('main')
  expect(s.testDbUp).toBe(false)
})

test('pr-malgre-main refusée bloque la mission et supprime la base', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight' },
    over: {
      runInPane: panes({ 'preflight · lint': [ko('erreur')], 'preuve main · lint': [ko('erreur')] }),
      agents: { ask: verdicts({ rd: ['CAUSE: MAIN'] }) },
    },
  })
  const s0 = await until(eng, (x) => x.loops.preflight.phase === 'gate')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: s0.gates.at(-1)!.id, decision: 'refused', note: 'non' })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedFrom).toBe('preflight')
  expect(s.testDbUp).toBe(false)
  expect(fx.callsOf('run')).toEqual([down()])
})

test('CAUSE: MAIN non reproduite sur main est corrigée comme BRANCHE', async () => {
  const { fx, eng } = await setup({
    patch: {
      step: 'preflight',
      loops: { ...newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops, globalReview: { round: 0, reviewedSha: 'sha-rev', lastReview: '/x/revue.md' } },
    },
    over: {
      runInPane: panes({ 'preflight · lint': [ko('erreur de lint'), ok] }),
      agents: { ask: verdicts({ rd: ['CAUSE: MAIN'], rg: ['VERDICT: APPROUVÉ'] }) },
    },
  })
  let s = await until(eng, (x) => x.loops.preflight.phase === 'fix')
  expect(s.loops.preflight).toMatchObject({ round: 1, fixer: 'new' })
  expect(fx.callsOf('git.worktreeRemove')).toHaveLength(1)
  expect(s.gates).toEqual([])

  s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rdt-1-1', 'cpt-1-1', 'rgt-1'])
  const fix = await readFile(join(pdir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain('remarque de rdt-1-1')
  expect(fix).toContain('vert sur origin/main')
  expect(fx.callsOf('git.controlCommits')[0]).toEqual([wt, 'sha-head', demo.forbiddenPaths])
  // Re-revue par le relecteur global sur le diff depuis sa dernière tête relue.
  expect(fx.callsOf('git.diffPackage')[0]).toEqual([wt, 'sha-rev', join(pdir(), 'correction-1.diff')])
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['rgt-1', join(pdir(), 'consigne-rerevue-1.md')])
  // Preflight rejoué en entier : lint (rouge), puis lint, test.
  expect(labels(fx).filter((l) => String(l).startsWith('preflight'))).toEqual(['preflight · lint', 'preflight · lint', 'preflight · test'])
  expect(fx.callsOf('git.fetchMain')).toHaveLength(2)
  expect(s.loops.preflight.results.map((r) => r.label)).toEqual(['lint', 'test'])
  expect(s.loops.globalReview.reviewedSha).toBe('sha-head')
  expect(s.testDbUp).toBe(false)
})

test('une exception pendant un check supprime quand même la base de test', async () => {
  const { fx, eng } = await setup({ patch: { step: 'preflight' }, over: { runInPane: panes({ 'preflight · lint': ['throw'] }) } })
  await eng.tick()
  expect((await loadState('T-1')).testDbUp).toBe(true)
  await expect(eng.tick()).rejects.toThrow('panneau preflight · lint perdu')
  expect(fx.callsOf('run')).toContainEqual(down())
})

test('une exception pendant la preuve sur main supprime le worktree temporaire et sa base', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight' },
    over: {
      runInPane: panes({ 'preflight · lint': [ko('erreur')], 'preuve main · lint': ['throw'] }),
      agents: { ask: verdicts({ rd: ['CAUSE: MAIN'] }) },
    },
  })
  await until(eng, (x) => x.loops.preflight.phase === 'proof')
  await expect(eng.tick()).rejects.toThrow('perdu')
  expect(labels(fx)).toContain('preuve main · arrêt de la base')
  expect(fx.callsOf('git.worktreeRemove')).toEqual([[join(home, 'repo'), MAIN_WT()]])
  expect(fx.callsOf('run')).toContainEqual(down())
})

// ---------- amendements (R14) ----------

const amend = (patch: Partial<Gate> = {}): Gate => ({ id: 'g1', kind: 'amendement', status: 'approved', summary: 's', createdAt: '2026-10-29T10:00:00.000Z', hash: proposalHash(PLAN2), ...patch })

test('un amendement approuvé pendant une boucle de correction du preflight attend sa résolution', async () => {
  const { eng } = await setup({
    plan: PLAN2,
    patch: {
      step: 'preflight',
      testDbUp: true,
      gates: [amend()],
      loops: { ...newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops, preflight: { round: 1, results: [], acceptedRed: [], used: [], diag: 1 } },
    },
  })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('pr')
  expect(s.appliedAmendments).toEqual([])
})

test('un amendement approuvé au preflight hors boucle ramène à tasks et supprime la base', async () => {
  const { fx, eng } = await setup({ plan: PLAN2, patch: { step: 'preflight', testDbUp: true, gates: [amend()] } })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.testDbUp).toBe(false)
  expect(fx.callsOf('run')).toEqual([down()])
  expect(s.tasks.map((t) => [t.n, t.phase])).toEqual([[1, 'done'], [2, 'pending']])
})

test('un amendement approuvé pendant une boucle de la revue globale attend sa résolution', async () => {
  const { eng } = await setup({
    plan: PLAN2,
    patch: {
      gates: [amend()],
      loops: { ...newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops, globalReview: { round: 1, phase: 'control', fixBase: 'sha-head' } },
    },
    over: { agents: { ask: verdicts({ rg: ['VERDICT: APPROUVÉ'] }) } },
  })
  const s = await until(eng, (x) => x.step !== 'global-review')
  // Revue globale résolue → l'amendement s'applique au preflight, avant tout check.
  expect(s.step).toBe('preflight')
  expect(s.appliedAmendments).toEqual([])
  await eng.tick()
  const s2 = await loadState('T-1')
  expect(s2.step).toBe('tasks')
  expect(s2.appliedAmendments).toEqual(['g1'])
})

test('reprise : un relecteur global vivant est attendu sans renvoi de la consigne', async () => {
  const out = join(gdir(), 'revue.md')
  const { fx, eng } = await setup({
    patch: { loops: { ...newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops, globalReview: { round: 0, pendingAsk: { agent: 'rgt-1', file: join(gdir(), 'consigne-revue.md'), out, head: 'sha-h0' } } } },
    over: {
      agents: {
        wait: async () => {
          await mkdir(gdir(), { recursive: true })
          await writeFile(out, 'VERDICT: APPROUVÉ\n')
          return 'done' as const
        },
      },
    },
  })
  fx.herdr.started.add('rgt-1')
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('preflight')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('agents.wait')).toHaveLength(1)
  expect(s.loops.globalReview.reviewedSha).toBe('sha-h0')
  await expect(access(join(gdir(), 'consigne-revue.md'))).rejects.toThrow()
})

// ---------- fix round 1 ----------

const loops0 = () => newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops

test('après un amendement, les dossiers des boucles sont archivés et la nouvelle revue globale repart avec des agents neufs', async () => {
  const { fx, eng } = await setup({
    plan: PLAN2,
    patch: { gates: [amend()] },
    over: { agents: { ask: verdicts({ rg: ['VERDICT: CORRECTIONS', 'VERDICT: APPROUVÉ'] }) } },
  })
  // Restes d'une revue globale et d'un preflight précédents.
  await mkdir(gdir(), { recursive: true })
  await writeFile(join(gdir(), 'correctifs-1.md'), 'ANCIEN correctif\n')
  await writeFile(join(gdir(), 'revue.md'), 'VERDICT: APPROUVÉ\n\nANCIENNE revue\n')
  await mkdir(pdir(), { recursive: true })
  await writeFile(join(pdir(), 'diagnostic-1.md'), 'CAUSE: MAIN\n')
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.loopGeneration).toBe(2)
  expect(await readFile(join(`${gdir()}.1`, 'correctifs-1.md'), 'utf8')).toContain('ANCIEN')
  expect(await readFile(join(`${pdir()}.1`, 'diagnostic-1.md'), 'utf8')).toContain('CAUSE: MAIN')
  await expect(access(gdir())).rejects.toThrow()
  await expect(access(pdir())).rejects.toThrow()

  // La nouvelle tâche est faite ; retour à la revue globale.
  s.tasks = s.tasks.map((t) => ({ ...t, phase: 'done' as const }))
  s.step = 'global-review'
  await saveState(s)
  fx.herdr.started.add('rgt-1') // ancien relecteur encore vivant : il ne doit pas être réutilisé
  s = await until(eng, (x) => x.step !== 'global-review')
  expect(s.step).toBe('preflight')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rgt-1-g2', 'cgt-1-1-g2'])
  const fix = await readFile(join(gdir(), 'correctifs-1.md'), 'utf8')
  expect(fix).not.toContain('ANCIEN')
  expect(fix).toContain('remarque de rgt-1-g2')
})

test("une base de test non supprimée après un preflight tout vert bloque la mission au lieu d'aller à pr", async () => {
  const { eng } = await setup({
    patch: { step: 'preflight' },
    over: { runInPane: panes(), run: async () => ({ stdout: '', stderr: 'conteneur occupé', exitCode: 1 }) },
  })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('bloquée')
  expect(s.blockedFrom).toBe('preflight')
  expect(s.blockedReason).toContain('base de test T-1 non supprimée : ')
  expect(s.blockedReason).toContain('conteneur occupé')
  expect(s.testDbUp).toBe(true)
})

test("un amendement au preflight avec une base impossible à supprimer bloque sans revenir à tasks", async () => {
  const { eng } = await setup({
    plan: PLAN2,
    patch: { step: 'preflight', testDbUp: true, gates: [amend()] },
    over: { run: async () => ({ stdout: '', stderr: 'docker absent', exitCode: 1 }) },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.blockedFrom).toBe('preflight')
  expect(s.blockedReason).toContain('base de test T-1 non supprimée')
  expect(s.appliedAmendments).toEqual([])
  expect(s.testDbUp).toBe(true)
})

test('une base de preuve impossible à supprimer bloque la mission et reste connue de l\'état', async () => {
  const { eng } = await setup({
    patch: { step: 'preflight' },
    over: {
      runInPane: panes({ 'preflight · lint': [ko('erreur')], 'preuve main · lint': [ko('erreur')], 'preuve main · arrêt de la base': [ko('refus')] }),
      agents: { ask: verdicts({ rd: ['CAUSE: MAIN'] }) },
    },
  })
  const s = await until(eng, (x) => x.step !== 'preflight')
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toContain('base de test T-1-main non supprimée')
  expect(s.proofDbUp).toBe(true)
  expect(s.gates.filter((g) => g.kind === 'pr-malgre-main')).toEqual([])
})

test('abandon pendant une preuve sur main supprime les deux bases', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'preflight', testDbUp: true, proofDbUp: true, loops: { ...loops0(), preflight: { ...loops0().preflight, phase: 'proof' } } },
  })
  await postInbox('T-1', { type: 'abandon', reason: 'stop' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  expect(await eng.tick()).toBe('stop')
  const s = await loadState('T-1')
  expect(s.step).toBe('fermée')
  expect(fx.callsOf('run')).toEqual([down(), [demo.testDb!.down[0], ['down', 'T-1-main', MAIN_WT()], { cwd: wt, reject: false }]])
  expect(s.testDbUp).toBe(false)
  expect(s.proofDbUp).toBe(false)
})

test("une correction de branche efface les rouges acceptés : le check repasse par le diagnostic", async () => {
  const { eng } = await setup({
    patch: {
      step: 'preflight',
      testDbUp: true,
      loops: { ...loops0(), preflight: { ...loops0().preflight, round: 1, phase: 'fix', fixFindings: '', fixFailure: 'rouge', acceptedRed: ['lint'], diag: 1 } },
    },
    over: {
      runInPane: panes({ 'preflight · lint': [ko('erreur')] }),
      agents: { ask: verdicts({ rg: ['VERDICT: APPROUVÉ'], rd: ['CAUSE: ENVIRONNEMENT'] }) },
    },
  })
  const s = await until(eng, (x) => x.loops.preflight.phase === 'diagnose')
  expect(s.loops.preflight.acceptedRed).toEqual([])
  expect(s.loops.preflight.diag).toBe(2)
})

test('revue globale : une remarque « imposé par le plan » ouvre un arbitrage avant les correctifs, la note y entre', async () => {
  const ask = async (name: string, file: string) => {
    if (name.startsWith('rg')) {
      const out = join(dirname(file), basename(file).replace(/^consigne-/, ''))
      const first = !out.includes('rerevue')
      await writeFile(out, first ? 'VERDICT: CORRECTIONS\n\n- src/a.ts:3 imposé par le plan mais incohérent\n' : 'VERDICT: APPROUVÉ\n')
    }
    return 'done' as const
  }
  const { fx, eng } = await setup({ over: { agents: { ask } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'arbitrage'))
  const g = s.gates.find((x) => x.kind === 'arbitrage')!
  expect(g.summary).toContain('src/a.ts:3 imposé par le plan')
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rgt-1'])
  await expect(readFile(join(gdir(), 'correctifs-1.md'))).rejects.toThrow()
  expect(fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).some((p) => p.startsWith('[herness] revue globale : revue CORRECTIONS (tour 1)'))).toBe(true)
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'refused', note: 'suivre le plan' })
  s = await until(eng, (x) => x.step !== 'global-review')
  expect(s.step).toBe('preflight')
  expect(await readFile(join(gdir(), 'correctifs-1.md'), 'utf8')).toContain('suivre le plan')
  expect(s.consumedArbitrages).toEqual([g.id])
})

// ---------- correcteur arrêté sans commit (agent-arret) ----------

const noCommit = { ok: false as const, code: 'no-commit' as const, reason: 'aucun commit depuis f1' }
const baseLoops = () => newState({ id: 'x', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/' }).loops

test("revue globale : correcteur arrêté sans commit avec compte rendu, porte agent-arret ; validée, nouveau tour avec la décision", async () => {
  const { fx, eng } = await setup({
    patch: { loops: { ...baseLoops(), globalReview: { round: 1, phase: 'control', fixer: 'new', fixBase: 'f1', reviewedSha: 'h1', lastReview: join(gdir(), 'revue.md') } } },
    over: {
      agents: { ask: verdicts({ rg: ['VERDICT: APPROUVÉ'] }) },
      git: { controlCommits: (() => { let i = 0; return async () => (i++ === 0 ? noCommit : { ok: true as const, commits: 1 }) })() },
    },
  })
  await mkdir(gdir(), { recursive: true })
  await writeFile(join(gdir(), 'revue.md'), 'VERDICT: CORRECTIONS\n\n- src/a.ts:3 renommer\n')
  await writeFile(join(gdir(), 'rapport.md'), 'Je ne peux pas renommer : le nom est imposé par la spec.\n')
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  const g = s.gates.find((x) => x.kind === 'agent-arret')!
  expect(g.summary).toMatch(/^revue globale : l'implémenteur s'est arrêté sans commit\n/)
  expect(g.summary).toContain('imposé par la spec')
  expect(s.loops.globalReview).toMatchObject({ round: 1, phase: 'control', stopGate: g.id })
  expect(await eng.tick()).toBe('wait')

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved', note: 'ne renomme pas' })
  s = await until(eng, (x) => x.loops.globalReview.round === 2 && x.loops.globalReview.phase === 'control')
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['cgt-1-2', join(gdir(), 'correctifs-2.md')])
  const fix = await readFile(join(gdir(), 'correctifs-2.md'), 'utf8')
  expect(fix).toContain('src/a.ts:3 renommer')
  expect(fix).toContain("Décision de l'utilisateur : ne renomme pas")
  s = await until(eng, (x) => x.step !== 'global-review')
  expect(s.step).toBe('preflight')
})

test('revue globale : aucun commit sans compte rendu bloque comme avant', async () => {
  const { eng } = await setup({
    patch: { loops: { ...baseLoops(), globalReview: { round: 1, phase: 'control', fixer: 'new', fixBase: 'f1' } } },
    over: { git: { controlCommits: async () => noCommit } },
  })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedReason).toContain('contrôle du commit en échec')
  expect(s.gates).toEqual([])
})

test('preflight : correcteur arrêté sans commit avec compte rendu ; porte validée, nouveau tour ; refusée, mission bloquée', async () => {
  const P = { round: 1, results: [], acceptedRed: [], used: [], diag: 1, phase: 'control' as const, fixer: 'new' as const, fixBase: 'f1', fixFindings: '- src/x.ts:1 lint', fixFailure: '' }
  const { fx, eng } = await setup({
    patch: { step: 'preflight', loops: { ...baseLoops(), globalReview: { round: 0, reviewedSha: 'sha-rev' }, preflight: P } },
    over: {
      git: { controlCommits: async () => noCommit },
      // Le correcteur du tour 2 s'arrête aussi, en complétant le compte rendu.
      agents: { ask: async (_name: string, file: string) => (await appendFile(join(dirname(file), 'rapport.md'), 'Arrêt encore.\n'), 'done' as const) },
    },
  })
  await mkdir(pdir(), { recursive: true })
  await writeFile(join(pdir(), 'rapport.md'), 'Arrêt : la règle de lint contredit la spec.\n')
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  const g1 = s.gates.find((x) => x.kind === 'agent-arret')!
  expect(g1.summary).toMatch(/^preflight : l'implémenteur s'est arrêté sans commit\n/)
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g1.id, decision: 'approved', note: 'désactive la règle localement' })
  s = await until(eng, (x) => x.gates.filter((g) => g.kind === 'agent-arret').length === 2)
  expect(s.loops.preflight.round).toBe(2)
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['cpt-1-2', join(pdir(), 'correctifs-2.md')])
  const fix = await readFile(join(pdir(), 'correctifs-2.md'), 'utf8')
  expect(fix).toContain('src/x.ts:1 lint')
  expect(fix).toContain("Décision de l'utilisateur : désactive la règle localement")

  const g2 = s.gates.at(-1)!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g2.id, decision: 'refused', note: 'stop' })
  s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedFrom).toBe('preflight')
  expect(s.blockedReason).toContain("arrêté sans commit")
})

test("M1 : revue globale, compte rendu inchangé depuis l'envoi des correctifs : blocage, pas de porte", async () => {
  const { eng } = await setup({
    patch: { loops: { ...baseLoops(), globalReview: { round: 1, phase: 'fix', fixer: 'new', reviewedSha: 'h1', lastReview: join(gdir(), 'revue.md') } } },
    over: { git: { controlCommits: async () => noCommit } },
  })
  await mkdir(gdir(), { recursive: true })
  await writeFile(join(gdir(), 'revue.md'), 'VERDICT: CORRECTIONS\n\n- src/a.ts:3 renommer\n')
  await writeFile(join(gdir(), 'rapport.md'), 'compte rendu du tour précédent\n')
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.loops.globalReview.reportSize).toBe(Buffer.byteLength('compte rendu du tour précédent\n'))
  expect(s.gates).toEqual([])
})

test("M1 : preflight, compte rendu inchangé depuis l'envoi des correctifs : blocage, pas de porte", async () => {
  const P = { round: 1, results: [], acceptedRed: [], used: [], diag: 1, phase: 'fix' as const, fixer: 'new' as const, fixFindings: '- src/x.ts:1 lint', fixFailure: '' }
  const { eng } = await setup({
    patch: { step: 'preflight', loops: { ...baseLoops(), globalReview: { round: 0, reviewedSha: 'sha-rev' }, preflight: P } },
    over: { git: { controlCommits: async () => noCommit } },
  })
  await mkdir(pdir(), { recursive: true })
  await writeFile(join(pdir(), 'rapport.md'), 'ancien\n')
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.gates).toEqual([])
  expect(s.blockedReason).toContain('contrôle du commit en échec')
})

test("preflight : correcteur vu au repos sans compte rendu, le commit n'est contrôlé qu'après son compte rendu", async () => {
  let sleeps = 0
  const P = { round: 1, results: [], acceptedRed: [], used: [], diag: 1, phase: 'fix' as const, fixer: 'new' as const, fixFindings: '- src/x.ts:1 lint', fixFailure: '' }
  const { fx, eng } = await setup({
    patch: { step: 'preflight', loops: { ...baseLoops(), globalReview: { round: 0, reviewedSha: 'sha-rev' }, preflight: P } },
    over: {
      sleep: async () => {
        if (++sleeps === 2) await writeFile(join(pdir(), 'rapport.md'), 'ancien\ncorrigé, commit c1\n')
      },
      git: {
        controlCommits: async () => {
          expect(await readFile(join(pdir(), 'rapport.md'), 'utf8')).toContain('commit c1')
          return { ok: true, commits: 1 }
        },
      },
    },
  })
  await mkdir(pdir(), { recursive: true })
  await writeFile(join(pdir(), 'rapport.md'), 'ancien\n')
  const s = await until(eng, () => fx.callsOf('git.controlCommits').length > 0)
  expect(sleeps).toBe(2)
  expect(s.log.map((l) => l.msg)).toContain('preflight : cpt-1-1 vu au repos sans compte rendu, attente de la fin réelle')
})
