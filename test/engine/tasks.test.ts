import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import demo from '../fixtures/demo/config.ts'
import { Engine } from '../../src/engine/engine.ts'
import { postInbox } from '../../src/mission/inbox.ts'
import { loadState, newState, saveState, type Gate, type MissionState, type TaskState } from '../../src/mission/state.ts'
import { missionDir, planPath, specPath } from '../../src/paths.ts'
import { proposalHash } from '../../src/mission/amendment.ts'
import { fakeEffects, seq, type FakeEffects, type FakeOverrides } from '../fakes.ts'
import type { ControlResult } from '../../src/git/git.ts'

let home: string
let wt: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-tasks-'))
  process.env.HERNESS_HOME = home
  wt = join(home, 'wt')
  await mkdir(wt, { recursive: true })
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const T1 = '### Tâche 1 : Modèle\n\n**Test :** `pnpm test a`\n\nfaire a\n'
const T2 = '### Tâche 2 : Export\n\n**Test :** `pnpm test b`\n\nfaire b\n'
const PLAN1 = `# Plan\n\n${T1}`
const PLAN2 = `# Plan\n\n${T1}\n${T2}`

const task = (patch: Partial<TaskState> = {}): TaskState => ({ n: 1, title: 'Modèle', testCommand: 'pnpm test a', phase: 'pending', round: 0, ...patch })
const gate = (patch: Partial<Gate>): Gate => ({ id: 'g1', kind: 'amendement', status: 'approved', summary: 's', createdAt: '2026-10-29T10:00:00.000Z', ...patch })
const taskDir = (n = 1) => join(missionDir('T-1'), 'taches', String(n))

/** Le relecteur factice écrit son rapport à côté de sa consigne : `consigne-revue.md` → `revue.md`. */
function scriptedAsk(verdicts: string[], impl: () => 'done' | 'blocked' | 'timeout' = () => 'done') {
  let i = 0
  return async (name: string, file: string) => {
    if (!name.startsWith('r')) return impl()
    const out = join(dirname(file), basename(file).replace(/^consigne-/, ''))
    const v = verdicts[Math.min(i++, verdicts.length - 1)]!
    await writeFile(out, `${v}\n\n## Remarques\n- src/a.ts:3 remarque ${i}\n`)
    return 'done' as const
  }
}

async function setup(opts: { over?: FakeOverrides; patch?: Partial<MissionState>; plan?: string; approved?: string; proposed?: string } = {}) {
  const fx: FakeEffects = fakeEffects(opts.over)
  const { ws, tab } = fx.herdr.seedWorkspace('T-1', 'agents')
  const s: MissionState = {
    ...newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'demo', repoPath: wt }),
    createdAt: '2026-10-29T10:00:00.000Z',
    worktree: wt,
    branch: 'feature/T-1-export-csv',
    type: 'feat',
    slug: 'export-csv',
    step: 'tasks',
    tasks: [task()],
    herdr: { workspace: ws, tabs: { agents: tab, checks: `${ws}:tc`, process: `${ws}:tp` }, panes: {} },
    orchestrator: { agent: 'o-T-1' },
    ...opts.patch,
  }
  await saveState(s)
  const file = join(wt, planPath(s))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, opts.plan ?? PLAN1)
  await writeFile(join(missionDir('T-1'), 'plan.approved.md'), opts.approved ?? opts.plan ?? PLAN1)
  if (opts.proposed !== undefined) await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), opts.proposed)
  return { fx, eng: new Engine('T-1', fx, demo) }
}

async function until(eng: Engine, pred: (s: MissionState) => boolean, max = 40): Promise<MissionState> {
  for (let i = 0; i < max; i++) {
    await eng.tick()
    const s = await loadState('T-1')
    if (pred(s)) return s
  }
  throw new Error('condition jamais atteinte')
}

const red = { exitCode: 1, logPath: '/l/t.log', tail: 'AssertionError: attendu 2', durationMs: 1 }
const green = { exitCode: 0, logPath: '/l/t.log', tail: 'ok', durationMs: 1 }

test('une tâche verte et approuvée passe par implement, control, test, review puis done', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: APPROUVÉ']) } } })
  const s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.step).toBe('global-review')
  expect(s.tasks[0]).toMatchObject({ phase: 'done', round: 0, baseSha: 'sha-head', reviewedSha: 'sha-head', implementer: 'ct-1-t1', reviewer: 'rt-1-t1' })

  const order = fx.calls.map((c) => c.fn).filter((f) => ['agents.start', 'agents.ask', 'git.controlCommits', 'runInPane', 'git.diffPackage'].includes(f))
  expect(order).toEqual(['agents.start', 'agents.ask', 'git.controlCommits', 'runInPane', 'git.diffPackage', 'agents.start', 'agents.ask'])

  const [name, role, , launch] = fx.callsOf('agents.start')[0]!
  expect([name, role]).toEqual(['ct-1-t1', 'implementer'])
  expect((launch as { args: string[] }).args).toContain('grok-4.7-medium')
  expect(fx.callsOf('agents.ask')[0]!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'brief.md')])
  const brief = await readFile(join(taskDir(), 'brief.md'), 'utf8')
  expect(brief).toContain('faire a')
  expect(brief).toContain('pnpm test a')
  expect(brief).toContain('[T-1]')
  expect(brief).toContain('git push')
  expect(brief).toContain('git stash')
  expect(brief).toContain(join(taskDir(), 'rapport.md'))

  expect(fx.callsOf('git.controlCommits')[0]).toEqual([wt, 'sha-head', demo.forbiddenPaths])
  const [, tab, cwd, label, cmd] = fx.callsOf('runInPane')[0]!
  expect([tab, cwd, label]).toEqual([s.herdr.tabs['checks'], wt, 'T1 · tests'])
  expect(cmd).toEqual(['bash', '-c', 'pnpm test a'])
  expect(fx.callsOf('git.diffPackage')[0]).toEqual([wt, 'sha-head', join(taskDir(), 'tache.diff')])
  expect(fx.callsOf('agents.start')[1]!.slice(0, 2)).toEqual(['rt-1-t1', 'reviewer'])

  const labels = fx.herdr.panes.map((p) => p.label)
  expect(labels).toContain('T1 · grok-4.7-medium ✓')
  expect(labels).toContain('T1 · claude-opus-5-5 ✓')
  expect(s.herdr.panes['ct-1-t1']).toBeDefined()
  expect(s.herdr.panes['rt-1-t1']).toBeDefined()
})

test('des tests rouges renvoient au même implémenteur sans démarrer de relecteur', async () => {
  const { fx, eng } = await setup({ over: { runInPane: seq(red, green) as never, agents: { ask: scriptedAsk(['VERDICT: APPROUVÉ']) } } })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  expect(s.tasks[0]).toMatchObject({ round: 1, fixer: 'same' })
  expect(s.tasks[0]!.lastFailure).toContain('AssertionError: attendu 2')
  expect(fx.callsOf('git.diffPackage')).toEqual([])

  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  const asks = fx.callsOf('agents.ask')
  expect(asks.at(-1)!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'correctifs-1.md')])
  const fix = await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain('AssertionError: attendu 2')
  expect(fix).toContain('/l/t.log')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['ct-1-t1'])
})

test('au 3e tour, un nouvel implémenteur grok-4.7-high est démarré', async () => {
  const { fx, eng } = await setup({ over: { runInPane: seq(red, red, red, green) as never, agents: { ask: scriptedAsk(['VERDICT: APPROUVÉ']) } } })
  const s = await until(eng, (x) => x.tasks[0]!.round === 3 && x.tasks[0]!.phase === 'control')
  const starts = fx.callsOf('agents.start')
  expect(starts.map((c) => c[0])).toEqual(['ct-1-t1', 'ct-1-t1b'])
  expect((starts[1]![3] as { args: string[] }).args).toContain('grok-4.7-high')
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['ct-1-t1b', join(taskDir(), 'correctifs-3.md')])
  const fix3 = await readFile(join(taskDir(), 'correctifs-3.md'), 'utf8')
  expect(fix3).toContain(join(taskDir(), 'brief.md'))
  expect(s.tasks[0]!.implementer).toBe('ct-1-t1b')
  // les tours 1 et 2 sont allés au même implémenteur
  expect(fx.callsOf('agents.ask').map((c) => c[0])).toEqual(['ct-1-t1', 'ct-1-t1', 'ct-1-t1', 'ct-1-t1b'])
})

test('au 4e tour, la mission est bloquée et une notification est envoyée', async () => {
  const { fx, eng } = await setup({ over: { runInPane: async () => red } })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedFrom).toBe('tasks')
  expect(s.blockedReason).toContain('3 tours de correction épuisés')
  expect(s.tasks[0]!.round).toBe(4)
  expect(String(fx.callsOf('herdr.notify').at(-1)![1])).toContain('3 tours de correction épuisés')
  expect(fx.callsOf('agents.ask')).toHaveLength(4)
})

test('une re-revue utilise le même relecteur et le diff depuis reviewedSha', async () => {
  const heads = seq('h1', 'h2')
  const { fx, eng } = await setup({
    over: {
      agents: { ask: scriptedAsk(['VERDICT: CORRECTIONS', 'VERDICT: APPROUVÉ']) },
      git: { diffPackage: async (_wt: string, base: string) => ({ base, head: heads(), commits: 1 }) },
    },
  })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  expect(s.tasks[0]).toMatchObject({ round: 1, fixer: 'same', reviewedSha: 'h1' })
  s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.tasks[0]).toMatchObject({ phase: 'done', reviewedSha: 'h2' })

  const fix = await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain('src/a.ts:3 remarque 1')
  const diffs = fx.callsOf('git.diffPackage')
  expect(diffs[1]![1]).toBe('h1')
  expect(diffs[1]![2]).not.toBe(join(taskDir(), 'tache.diff'))
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['ct-1-t1', 'rt-1-t1'])
  const reviewerAsks = fx.callsOf('agents.ask').filter((c) => c[0] === 'rt-1-t1')
  expect(reviewerAsks.map((c) => basename(String(c[1])))).toEqual(['consigne-revue.md', 'consigne-rerevue-1.md'])
  const prompt = await readFile(String(reviewerAsks[1]![1]), 'utf8')
  expect(prompt).toContain('h1')
  expect(prompt).toContain('h2')
  expect(prompt).toContain('src/a.ts:3 remarque 1')
  expect(prompt).toContain(join(taskDir(), 'rerevue-1.md'))
})

test('un verdict illisible bloque la mission', async () => {
  const { eng } = await setup({ over: { agents: { ask: scriptedAsk(['Je pense que ça va']) } } })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedReason).toContain('verdict de revue illisible')
})

test('un agent blocked ouvre une porte agent-bloque sans rien lui envoyer', async () => {
  const outcomes = seq<'blocked' | 'done'>('blocked', 'done')
  const { fx, eng } = await setup({
    over: { agents: { ask: async () => outcomes() }, herdr: { agentRead: async () => 'Autoriser la commande rm ? (o/n)' } },
  })
  let s = await until(eng, (x) => x.gates.length > 0)
  expect(s.gates[0]).toMatchObject({ kind: 'agent-bloque', status: 'pending' })
  expect(s.gates[0]!.summary).toContain('Autoriser la commande rm')
  expect(fx.callsOf('herdr.agentRead')[0]).toEqual(['ct-1-t1', 40])
  expect(fx.callsOf('herdr.notify')).toHaveLength(1)
  expect(fx.callsOf('herdr.agentPrompt').map((c) => c[0])).toEqual(['o-T-1'])
  expect(fx.callsOf('herdr.paneSendKeys')).toEqual([])

  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.ask')).toHaveLength(1)

  expect(s.tasks[0]!.pendingAsk).toMatchObject({ agent: 'ct-1-t1', file: join(taskDir(), 'brief.md') })

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  // débloqué dans son panneau : on attend l'agent, sans renvoyer la consigne
  expect(fx.callsOf('agents.ask')).toHaveLength(1)
  expect(fx.callsOf('agents.wait').map((c) => c[0])).toEqual(['ct-1-t1'])
  expect(fx.callsOf('herdr.agentPrompt').every((c) => c[0] === 'o-T-1')).toBe(true)
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
})

test('un second blocked pendant l\'attente après déblocage ouvre une nouvelle porte', async () => {
  const waits = seq<'blocked' | 'done'>('blocked', 'done')
  const { fx, eng } = await setup({
    over: { agents: { ask: async () => 'blocked' as const, wait: async () => waits() } },
  })
  await until(eng, (x) => x.gates.length === 1)
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  let s = await until(eng, (x) => x.gates.length === 2)
  expect(s.gates[1]).toMatchObject({ id: 'g2', kind: 'agent-bloque', status: 'pending' })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g2', decision: 'approved' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  expect(fx.callsOf('agents.ask')).toHaveLength(1)
  expect(fx.callsOf('agents.wait')).toHaveLength(2)
})

test("un agent sans réponse bloque la mission", async () => {
  const { eng } = await setup({ over: { agents: { ask: async () => 'timeout' as const } } })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedReason).toContain('agent ct-1-t1 sans réponse')
})

test('une porte arbitrage en attente suspend la correction, sa note entre dans les correctifs', async () => {
  const { fx, eng } = await setup({
    patch: {
      tasks: [task({ phase: 'fix', round: 1, fixer: 'same', baseSha: 'b0', reviewedSha: 'h1', implementer: 'ct-1-t1', lastReview: join(taskDir(), 'revue.md') })],
      gates: [gate({ id: 'g1', kind: 'arbitrage', status: 'pending', summary: 'colonne à garder ?' })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'revue.md'), 'VERDICT: CORRECTIONS\n\n- src/b.ts:9 colonne en trop\n')
  fx.herdr.started.add('ct-1-t1')

  expect(await eng.tick()).toBe('wait')
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.ask')).toEqual([])

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'garder la colonne' })
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  expect(fx.callsOf('agents.ask')[0]!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'correctifs-1.md')])
  const fix = await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain('src/b.ts:9 colonne en trop')
  expect(fix).toContain("Décision de l'utilisateur")
  expect(fix).toContain('garder la colonne')
  expect(s.consumedArbitrages).toEqual(['g1'])
})

test("un amendement approuvé pendant une tâche en cours, sans consigne chez un agent, s'applique aussitôt ; la tâche inchangée continue", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2,
    over: { agents: { ask: scriptedAsk(['VERDICT: APPROUVÉ']) } },
    patch: {
      tasks: [task({ phase: 'review', baseSha: 'b0', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN2) })],
    },
  })
  await eng.tick()
  let s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks.map((t) => [t.n, t.phase])).toEqual([[1, 'review'], [2, 'pending']])
  expect(await readFile(join(missionDir('T-1'), 'plan.approved.md'), 'utf8')).toBe(PLAN2)
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s)], 'docs(T-1): amende le plan']])
  s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  // Tâche 1 inchangée : pas de nouveau brief, pas de nouvel envoi à l'implémenteur.
  expect(fx.callsOf('agents.ask').map((c) => c[0])).toEqual(['rt-1-t1'])
})

test("un amendement attend qu'aucune consigne ne soit en cours chez un agent", async () => {
  const { eng } = await setup({
    proposed: PLAN2,
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1', pendingAsk: { agent: 'ct-1-t1', file: '/x/brief.md', fromSha: 'b0' } })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN2) })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual([])
  expect(s.tasks).toHaveLength(1)
})

test('un amendement attend la décision sur une porte agent-bloque', async () => {
  const { eng } = await setup({
    proposed: PLAN2,
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1', blockedGate: 'g2' })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN2) }), gate({ id: 'g2', kind: 'agent-bloque', status: 'pending' })],
    },
  })
  expect(await eng.tick()).toBe('wait')
  expect((await loadState('T-1')).appliedAmendments).toEqual([])
})

test('un amendement approuvé en global-review ajoute la tâche et revient à tasks', async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks.map((t) => [t.n, t.phase])).toEqual([[1, 'done'], [2, 'pending']])
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s)], 'docs(T-1): amende le plan']])
})

test("un amendement qui modifie une tâche validée est écarté et l'orchestrateur prévenu", async () => {
  const changed = PLAN2.replace('faire a', 'faire autre chose')
  const { fx, eng } = await setup({
    proposed: changed,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(changed) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.tasks).toHaveLength(1)
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] .*tâche 1 déjà validée a changé/s)
})

test('reprise : implement sans agent mais avec commits passe directement au contrôle', async () => {
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => 'h1' } },
    patch: { tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.tasks[0]!.phase).toBe('control')
  expect(fx.callsOf('herdr.agentGet')).toEqual([['ct-1-t1']])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('agents.ask')).toEqual([])
})

test("reprise : implement sans agent ni commit redémarre l'agent avec le même brief", async () => {
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => 'b0' } },
    patch: { tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })] },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), 'BRIEF ORIGINAL')
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['ct-1-t1'])
  expect(fx.callsOf('agents.ask').map((c) => c.slice(0, 2))).toEqual([['ct-1-t1', join(taskDir(), 'brief.md')]])
  expect(await readFile(join(taskDir(), 'brief.md'), 'utf8')).toBe('BRIEF ORIGINAL')
  expect(s.tasks[0]!.phase).toBe('control')
  expect(s.tasks[0]!.baseSha).toBe('b0')
})

test("la consigne en cours est enregistrée dans l'état avant l'envoi, puis effacée", async () => {
  let seen: unknown
  const { eng } = await setup({
    patch: { tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })] },
    over: {
      herdr: { agentGet: async () => ({ state: 'idle' }) },
      agents: {
        ask: async () => {
          seen = (await loadState('T-1')).tasks[0]!.pendingAsk
          return 'done' as const
        },
      },
    },
  })
  await eng.tick()
  expect(seen).toMatchObject({ agent: 'ct-1-t1', file: join(taskDir(), 'brief.md') })
  const s = await loadState('T-1')
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
  expect(s.tasks[0]!.phase).toBe('control')
})

test("reprise : consigne en cours et agent vivant au travail, attente sans renvoi puis issue traitée", async () => {
  const { fx, eng } = await setup({
    over: { herdr: { agentGet: async () => ({ state: 'working' }) } },
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1', pendingAsk: { agent: 'ct-1-t1', file: join(taskDir(), 'brief.md') } })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('herdr.agentPrompt')).toEqual([])
  expect(fx.callsOf('agents.wait').map((c) => c[0])).toEqual(['ct-1-t1'])
  expect(s.tasks[0]).toMatchObject({ phase: 'control' })
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
})

test('reprise : revue en cours, relecteur disparu mais verdict déjà écrit, le verdict est utilisé sans renvoi', async () => {
  const out = join(taskDir(), 'revue.md')
  const { fx, eng } = await setup({
    patch: {
      tasks: [task({
        phase: 'review', baseSha: 'b0', implementer: 'ct-1-t1', reviewer: 'rt-1-t1',
        pendingAsk: { agent: 'rt-1-t1', file: join(taskDir(), 'consigne-revue.md'), out, head: 'h1' },
      })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(out, 'VERDICT: APPROUVÉ\n')
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(fx.callsOf('git.diffPackage')).toEqual([])
  expect(s.tasks[0]).toMatchObject({ phase: 'done', reviewedSha: 'h1', lastReview: out })
})

test('reprise : revue en cours, relecteur disparu sans verdict, relecteur redémarré et consigne renvoyée', async () => {
  const { fx, eng } = await setup({
    over: { agents: { ask: scriptedAsk(['VERDICT: APPROUVÉ']) } },
    patch: {
      tasks: [task({
        phase: 'review', baseSha: 'b0', implementer: 'ct-1-t1', reviewer: 'rt-1-t1',
        pendingAsk: { agent: 'rt-1-t1', file: join(taskDir(), 'consigne-revue.md'), out: join(taskDir(), 'revue.md'), head: 'h1' },
      })],
    },
  })
  await eng.tick()
  expect(fx.callsOf('agents.start').map((c) => c[0])).toEqual(['rt-1-t1'])
  expect(fx.callsOf('agents.ask').map((c) => basename(String(c[1])))).toEqual(['consigne-revue.md'])
  expect((await loadState('T-1')).tasks[0]!.phase).toBe('done')
})

test('reprise : correction en cours, implémenteur disparu avec un commit depuis la tête précédente, passage au contrôle', async () => {
  const { fx, eng } = await setup({
    over: { git: { headSha: async () => 'h2' } },
    patch: {
      tasks: [task({
        phase: 'fix', round: 1, fixer: 'same', baseSha: 'b0', implementer: 'ct-1-t1',
        pendingAsk: { agent: 'ct-1-t1', file: join(taskDir(), 'correctifs-1.md'), fromSha: 'h1' },
      })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.ask')).toEqual([])
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(s.tasks[0]).toMatchObject({ phase: 'control', round: 1 })
  expect(s.tasks[0]!.pendingAsk).toBeUndefined()
})

test('pending réutilise un implémenteur déjà démarré (arrêt entre le démarrage et l\'enregistrement)', async () => {
  const { fx, eng } = await setup()
  fx.herdr.started.add('ct-1-t1')
  await eng.tick()
  const s = await loadState('T-1')
  expect(fx.callsOf('agents.start')).toEqual([])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement', implementer: 'ct-1-t1' })
})

test('un amendement sans plan proposé est écarté proprement', async () => {
  const { fx, eng } = await setup({
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toMatch(/^\[herness\] Amendement g1 non appliqué/)
})

// ---------- amendements proposés hors du worktree (C2) ----------

test('amendement approuvé : la proposition est copiée dans le worktree, commitée (plan et spec), puis supprimée', async () => {
  const SPEC2 = '# Spec v2\n\ncontexte\n'
  const { fx, eng } = await setup({
    proposed: PLAN2,
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2, SPEC2) })] },
  })
  await writeFile(join(missionDir('T-1'), 'spec.proposed.md'), SPEC2)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.tasks.map((t) => t.n)).toEqual([1, 2])
  expect(await readFile(join(wt, planPath(s)), 'utf8')).toBe(PLAN2)
  expect(await readFile(join(wt, specPath(s)), 'utf8')).toBe(SPEC2)
  expect(fx.callsOf('git.commitFiles')).toEqual([[wt, [planPath(s), specPath(s)], 'docs(T-1): amende le plan']])
  expect(await readFile(join(missionDir('T-1'), 'plan.approved.md'), 'utf8')).toBe(PLAN2)
  await expect(readFile(join(missionDir('T-1'), 'plan.proposed.md'))).rejects.toThrow()
  await expect(readFile(join(missionDir('T-1'), 'spec.proposed.md'))).rejects.toThrow()
})

test('une proposition modifiée après la demande est rejetée, le worktree reste intact', async () => {
  const { fx, eng } = await setup({
    proposed: PLAN2.replace('faire b', 'faire b autrement'),
    patch: { step: 'global-review', tasks: [task({ phase: 'done' })], gates: [gate({ id: 'g1', hash: proposalHash(PLAN2) })] },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('global-review')
  expect(s.tasks).toHaveLength(1)
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(fx.callsOf('git.commitFiles')).toEqual([])
  expect(await readFile(join(wt, planPath(s)), 'utf8')).toBe(PLAN1)
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain('la proposition a changé après la demande ; redemande')
})

// ---------- arbitrage des remarques qui contredisent le plan (I4) ----------

test('une remarque « imposé par le plan » ouvre une porte arbitrage et suspend les correctifs ; chaque CORRECTIONS est signalé', async () => {
  const ask = async (name: string, file: string) => {
    if (name.startsWith('r')) {
      const out = join(dirname(file), basename(file).replace(/^consigne-/, ''))
      await writeFile(out, 'VERDICT: CORRECTIONS\n\n## Remarques\n- src/a.ts:3 nom de variable\n- src/b.ts:9 colonne supprimée alors que c\'est Imposé par le plan (tâche 1)\n')
    }
    return 'done' as const
  }
  const { fx, eng } = await setup({ over: { agents: { ask } } })
  let s = await until(eng, (x) => x.tasks[0]!.phase === 'fix')
  const g = s.gates.find((x) => x.kind === 'arbitrage')!
  expect(g).toMatchObject({ status: 'pending' })
  expect(g.summary).toContain('src/b.ts:9 colonne supprimée')
  expect(g.summary).not.toContain('nom de variable')
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.some((p) => /^\[herness\] tâche 1 : revue CORRECTIONS \(tour 1\)/.test(p))).toBe(true)
  expect(prompts.some((p) => p.includes(`Porte ${g.id} (arbitrage)`))).toBe(true)

  expect(await eng.tick()).toBe('wait')
  await expect(readFile(join(taskDir(), 'correctifs-1.md'))).rejects.toThrow()
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved', note: 'le plan prime, garder la colonne' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control')
  const fix = await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain('le plan prime, garder la colonne')
})

test('un verdict CORRECTIONS sans contradiction du plan informe l\'orchestrateur sans ouvrir de porte', async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: scriptedAsk(['VERDICT: CORRECTIONS', 'VERDICT: APPROUVÉ']) } } })
  const s = await until(eng, (x) => x.tasks[0]!.phase === 'done')
  expect(s.gates).toEqual([])
  const msgs = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).filter((p) => p.includes('revue CORRECTIONS'))
  expect(msgs).toHaveLength(1)
  expect(msgs[0]!.split('\n')).toHaveLength(1)
})

// ---------- implémenteur arrêté sans commit (agent-arret) ----------

const noCommit: ControlResult = { ok: false, code: 'no-commit', reason: 'aucun commit depuis sha-head' }
/** Contrôle « aucun commit », puis contrôle vert. */
const stopThenOk = () => {
  const next = seq<ControlResult>(noCommit, { ok: true, commits: 1 })
  return async () => next()
}
const REPORT = 'Arrêt : le plan est impossible.\nLe composant de base impose placeholder=" ".\nJe ne commite rien.\n'

/** L'implémenteur écrit son compte rendu à la consigne initiale (brief), puis le relecteur approuve. */
function stoppingAsk(report = REPORT) {
  const review = scriptedAsk(['VERDICT: APPROUVÉ'])
  return async (name: string, file: string) => {
    if (basename(file) === 'brief.md' && report) await writeFile(join(dirname(file), 'rapport.md'), report)
    return review(name, file)
  }
}

test("arrêt sans commit avec compte rendu : porte agent-arret, l'orchestrateur explique ; validée, un tour de correction porte la décision", async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: stopThenOk() } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  expect(s.step).toBe('tasks')
  const g = s.gates.find((x) => x.kind === 'agent-arret')!
  expect(g).toMatchObject({ status: 'pending', path: join(taskDir(), 'rapport.md') })
  expect(g.summary).toMatch(/^tâche 1 : l'implémenteur s'est arrêté sans commit\n/)
  expect(g.summary).toContain('placeholder=" "')
  expect(s.tasks[0]).toMatchObject({ phase: 'control', round: 0, stopGate: g.id })
  expect(String(fx.callsOf('herdr.notify').at(-1)![1])).toContain("arrêté sans commit")
  const msg = String(fx.callsOf('herdr.agentPrompt').at(-1)![1])
  expect(msg).toContain(`Porte ${g.id} (agent-arret)`)
  expect(msg).toContain('proposer_amendement')

  expect(await eng.tick()).toBe('wait')
  expect(await eng.tick()).toBe('wait')
  expect(fx.callsOf('agents.ask')).toHaveLength(1)

  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved', note: 'garde le placeholder, documente-le' })
  s = await until(eng, (x) => x.tasks[0]!.phase === 'control' && x.tasks[0]!.round === 1)
  expect(s.tasks[0]!.stopGate).toBeUndefined()
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'correctifs-1.md')])
  const fix = await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain("Décision de l'utilisateur : garde le placeholder, documente-le")
  expect(fix).not.toContain('Consigne amendée')
  s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.step).toBe('global-review')
})

test("arrêt sans commit validé sans note : la décision transmise est « continue »", async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: stopThenOk() } } })
  const s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: s.gates[0]!.id, decision: 'approved' })
  await until(eng, (x) => x.tasks[0]!.round === 1 && x.tasks[0]!.phase === 'control')
  expect(await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')).toContain("Décision de l'utilisateur : continue")
})

test('arrêt sans commit, porte agent-arret refusée : la mission est bloquée', async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: async () => noCommit } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: s.gates[0]!.id, decision: 'refused', note: 'on arrête' })
  s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedFrom).toBe('tasks')
  expect(s.blockedReason).toContain("arrêté sans commit")
  expect(s.blockedReason).toContain('on arrête')
  expect(s.tasks[0]!.stopGate).toBeUndefined()
})

test('aucun commit sans compte rendu : la mission est bloquée comme avant, sans porte', async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk('') }, git: { controlCommits: async () => noCommit } } })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedReason).toContain('contrôle du commit en échec')
  expect(s.gates).toEqual([])
})

test('un autre échec de contrôle (arbre non propre) bloque même avec un compte rendu', async () => {
  const dirty = { ok: false as const, code: 'dirty' as const, reason: 'arbre non propre :\n?? x' }
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: async () => dirty } } })
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.blockedReason).toContain('arbre non propre')
  expect(s.gates).toEqual([])
})

test("arrêt sans commit validé après un amendement de la tâche : les correctifs portent le nouveau texte de la tâche", async () => {
  const AMENDED = PLAN1.replace('faire a', 'faire a, en gardant le placeholder')
  const { fx, eng } = await setup({
    approved: AMENDED,
    patch: {
      tasks: [task({ phase: 'control', baseSha: 'b0', implementer: 'ct-1-t1', stopGate: 'g1' })],
      gates: [gate({ id: 'g1', kind: 'agent-arret', status: 'pending', summary: "tâche 1 : l'implémenteur s'est arrêté sans commit" })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), '# Brief\n\n### Tâche 1 : Modèle\n\n**Test :** `pnpm test a`\n\nfaire a\n')
  fx.herdr.started.add('ct-1-t1')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'ok' })
  await until(eng, (x) => x.tasks[0]!.round === 1 && x.tasks[0]!.phase === 'control')
  const fix = await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')
  expect(fix).toContain("Décision de l'utilisateur : ok")
  expect(fix).toContain('## Consigne amendée de la tâche')
  expect(fix).toContain('faire a, en gardant le placeholder')
})

// ---------- amendement de la tâche en cours (scénario 20261030-5) ----------

const T1_FIXED = '### Tâche 1 : Modèle\n\n**Test :** `pnpm test a`\n\nfaire a, en gardant le placeholder imposé par le composant de base\n'
const PLAN1_FIXED = `# Plan\n\n${T1_FIXED}`

test("20261030-5 : arrêt sans commit, amendement de la tâche validé, brief réécrit avec une reprise, implémenteur relancé, aucun blocage", async () => {
  const { fx, eng } = await setup({ over: { agents: { ask: stoppingAsk() }, git: { controlCommits: stopThenOk() } } })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  const stop = s.gates.find((g) => g.kind === 'agent-arret')!
  expect(await eng.tick()).toBe('wait')

  // L'orchestrateur propose l'amendement (hors du worktree), l'utilisateur le valide.
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), PLAN1_FIXED)
  await postInbox('T-1', { type: 'request-gate', kind: 'amendement', summary: 'garder le placeholder', path: join(missionDir('T-1'), 'plan.proposed.md'), hash: proposalHash(PLAN1_FIXED) })
  await eng.tick()
  s = await loadState('T-1')
  const amend = s.gates.find((g) => g.kind === 'amendement')!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: amend.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).toBe('tasks')
  expect(s.appliedAmendments).toEqual([amend.id])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement', round: 0 })
  expect(s.tasks[0]!.stopGate).toBeUndefined()
  expect(s.gates.find((g) => g.id === stop.id)!.status).toBe('caduque')
  expect(fx.callsOf('herdr.agentPrompt').map((c) => String(c[1])).some((p) => p.includes(`porte ${stop.id} (agent-arret) est caduque`))).toBe(true)
  const brief = await readFile(join(taskDir(), 'brief.md'), 'utf8')
  expect(brief).toContain('## Reprise')
  expect(brief).toContain("Du travail est déjà présent dans l'arbre : garde-le, adapte-le à la nouvelle consigne, puis lance les tests et commite")
  expect(brief).toContain('en gardant le placeholder imposé')
  expect(await readFile(join(wt, planPath(s)), 'utf8')).toBe(PLAN1_FIXED)

  s = await until(eng, (x) => x.step !== 'tasks')
  expect(s.step).toBe('global-review')
  const implAsks = fx.callsOf('agents.ask').filter((c) => c[0] === 'ct-1-t1').map((c) => c[1])
  expect(implAsks).toEqual([join(taskDir(), 'brief.md'), join(taskDir(), 'brief.md')])
  expect(s.log.some((l) => l.msg.startsWith('mission bloquée'))).toBe(false)

  // La porte agent-arret, décidée plus tard (message déjà posté), est ignorée.
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: stop.id, decision: 'refused', note: 'trop tard' })
  await eng.tick()
  s = await loadState('T-1')
  expect(s.step).not.toBe('bloquée')
  expect(s.gates.find((g) => g.id === stop.id)!.status).toBe('caduque')
  expect(s.log.some((l) => l.msg === `décision ignorée : porte ${stop.id} caduque : plus rien ne l'attend, décision ignorée`)).toBe(true)
})

test("un amendement validé pendant que la mission est bloquée sur la boucle des tâches la débloque et l'applique", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN1_FIXED,
    patch: {
      step: 'bloquée',
      blockedFrom: 'tasks',
      blockedReason: 'tâche 1 : contrôle du commit en échec',
      tasks: [task({ phase: 'control', round: 2, baseSha: 'sha-head', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'pending', hash: proposalHash(PLAN1_FIXED) })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), '# Brief de tâche\n\nfaire a\n')
  fx.herdr.started.add('ct-1-t1')
  expect(await eng.tick()).toBe('wait')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.step).toBe('tasks')
  expect(s.blockedReason).toBeUndefined()
  expect(s.blockedFrom).toBeUndefined()
  expect(await readFile(join(taskDir(), 'brief.md'), 'utf8')).toContain('## Reprise')
  expect(fx.callsOf('agents.ask').at(-1)!.slice(0, 2)).toEqual(['ct-1-t1', join(taskDir(), 'brief.md')])
})

// ---------- arbitrage sans correction en attente ----------

test("un arbitrage décidé alors qu'aucune correction n'attend est sans effet, l'orchestrateur est prévenu", async () => {
  const { fx, eng } = await setup({
    patch: {
      step: 'bloquée',
      blockedFrom: 'tasks',
      blockedReason: 'tâche 1 : contrôle du commit en échec',
      tasks: [task({ phase: 'control', baseSha: 'b0' })],
      gates: [gate({ id: 'g1', kind: 'arbitrage', status: 'pending', summary: 'continuer ?' })],
    },
  })
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'continue' })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.step).toBe('bloquée')
  expect(s.consumedArbitrages).toEqual(['g1'])
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.at(-1)).toContain("arbitrage g1 sans effet : aucune correction n'attendait de décision")
})

test("un arbitrage décidé pendant qu'une correction l'attend n'est pas signalé sans effet", async () => {
  const { fx, eng } = await setup({
    patch: {
      tasks: [task({ phase: 'fix', round: 1, fixer: 'same', baseSha: 'b0', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'arbitrage', status: 'pending', summary: 'colonne ?' })],
    },
  })
  fx.herdr.started.add('ct-1-t1')
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: 'g1', decision: 'approved', note: 'garder' })
  await eng.tick()
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.some((p) => p.includes('sans effet'))).toBe(false)
  expect(await readFile(join(taskDir(), 'correctifs-1.md'), 'utf8')).toContain('garder')
})

// ---------- revue, tour 1 ----------

test("I1 : le commit de l'amendement déplace la base de la tâche en cours, le contrôle ne compte pas les documents", async () => {
  let head = 'sha-head'
  const controls: string[] = []
  const control = stopThenOk()
  const { fx, eng } = await setup({
    over: {
      agents: { ask: stoppingAsk() },
      git: {
        headSha: async () => head,
        commitFiles: async () => {
          head = 'sha-docs'
          return head
        },
        controlCommits: async (_wt: string, base: string) => {
          controls.push(base)
          return control()
        },
      },
    },
  })
  let s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), PLAN1_FIXED)
  await postInbox('T-1', { type: 'request-gate', kind: 'amendement', summary: 's', hash: proposalHash(PLAN1_FIXED) })
  await eng.tick()
  s = await loadState('T-1')
  const amend = s.gates.find((g) => g.kind === 'amendement')!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: amend.id, decision: 'approved' })
  await eng.tick()
  s = await loadState('T-1')
  expect(fx.callsOf('git.commitFiles')).toHaveLength(1)
  expect(s.tasks[0]!.baseSha).toBe('sha-docs')
  await until(eng, (x) => x.step !== 'tasks')
  expect(controls).toEqual(['sha-head', 'sha-docs'])
})

test("I2 : une porte agent-arret caduque ne retient pas un amendement suivant", async () => {
  const { eng } = await setup({
    proposed: PLAN2,
    patch: {
      tasks: [task({ phase: 'implement', baseSha: 'b0', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'agent-arret', status: 'caduque' }), gate({ id: 'g2', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN2) })],
    },
  })
  await eng.tick()
  expect((await loadState('T-1')).appliedAmendments).toEqual(['g2'])
})

// Comme `writeBrief` : titre, puis le corps tel que `parsePlan` le découpe (il commence par la fin de ligne du titre).
const BRIEF1 = '# Brief de tâche\n\n### Tâche 1 : Modèle\n\n\n\n**Test :** `pnpm test a`\n\nfaire a\n'
const blockedOn = (reason: string): Partial<MissionState> => ({
  step: 'bloquée',
  blockedFrom: 'tasks',
  blockedReason: reason,
  tasks: [task({ phase: 'control', round: 2, baseSha: 'sha-head', implementer: 'ct-1-t1' })],
})

/** L'orchestrateur propose l'amendement (porte ouverte par le moteur), l'utilisateur le valide. */
async function proposeAndApprove(eng: Engine, plan: string): Promise<MissionState> {
  await writeFile(join(missionDir('T-1'), 'plan.proposed.md'), plan)
  await postInbox('T-1', { type: 'request-gate', kind: 'amendement', summary: 'amende', hash: proposalHash(plan) })
  await eng.tick()
  const g = (await loadState('T-1')).gates.find((x) => x.kind === 'amendement')!
  await postInbox('T-1', { type: 'decision', source: 'user', gateId: g.id, decision: 'approved' })
  await eng.tick()
  return loadState('T-1')
}

test("I3 : mission bloquée par la tâche 1, amendement qui la change : la porte l'annonce, la validation débloque", async () => {
  const { eng } = await setup({ patch: blockedOn('tâche 1 : 3 tours de correction épuisés') })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  const s = await proposeAndApprove(eng, PLAN1_FIXED)
  expect(s.gates.find((g) => g.kind === 'amendement')!.summary).toBe('amende (mission bloquée : valider cet amendement relancera la tâche 1)')
  expect(s.step).toBe('tasks')
  expect(s.tasks[0]!.round).toBe(0)
})

test("I3 : amendement qui ne change pas la tâche bloquée : appliqué, la mission reste bloquée et l'orchestrateur le sait", async () => {
  const { fx, eng } = await setup({ patch: blockedOn('tâche 1 : contrôle du commit en échec') })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  const s = await proposeAndApprove(eng, PLAN2)
  expect(s.gates.find((g) => g.kind === 'amendement')!.summary).toBe("amende (mission bloquée : valider n'enlève pas le blocage)")
  expect(s.appliedAmendments).toHaveLength(1)
  expect(s.tasks.map((t) => t.n)).toEqual([1, 2])
  expect(s.step).toBe('bloquée')
  expect(s.blockedReason).toBe('tâche 1 : contrôle du commit en échec')
  expect(s.tasks[0]).toMatchObject({ phase: 'control', round: 2 })
  const prompts = fx.callsOf('herdr.agentPrompt').map((c) => String(c[1]))
  expect(prompts.some((p) => p.includes('mission toujours bloquée : herness reprendre T-1 pour la relancer'))).toBe(true)
})

test("I3 : blocage venu d'ailleurs que la tâche (agent sans réponse), amendement de la tâche : appliqué, la mission reste bloquée", async () => {
  const { eng } = await setup({ patch: blockedOn('agent ct-1-t1 sans réponse (tâche 1)') })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  const s = await proposeAndApprove(eng, PLAN1_FIXED)
  expect(s.gates.find((g) => g.kind === 'amendement')!.summary).toContain("valider n'enlève pas le blocage")
  expect(s.step).toBe('bloquée')
  expect(s.appliedAmendments).toHaveLength(1)
})

test("M1 : un compte rendu qui n'a pas grandi depuis l'envoi de la consigne n'ouvre pas de porte agent-arret", async () => {
  const { eng } = await setup({ over: { agents: { ask: stoppingAsk('') }, git: { controlCommits: async () => noCommit } } })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'rapport.md'), 'ancien compte rendu\n')
  const s = await until(eng, (x) => x.step === 'bloquée')
  expect(s.tasks[0]!.reportSize).toBe(Buffer.byteLength('ancien compte rendu\n'))
  expect(s.blockedReason).toContain('contrôle du commit en échec')
  expect(s.gates).toEqual([])
})

test("M1 : la porte agent-arret ne montre que ce que l'implémenteur a ajouté au compte rendu", async () => {
  const ask = async (name: string, file: string) => {
    if (basename(file) === 'brief.md') await writeFile(join(dirname(file), 'rapport.md'), 'ancien\nNOUVEAU : arrêt\n')
    return 'done' as const
  }
  const { eng } = await setup({ over: { agents: { ask }, git: { controlCommits: async () => noCommit } } })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'rapport.md'), 'ancien\n')
  const s = await until(eng, (x) => x.gates.some((g) => g.kind === 'agent-arret'))
  expect(s.gates[0]!.summary).toBe("tâche 1 : l'implémenteur s'est arrêté sans commit\nNOUVEAU : arrêt")
})

test("M2 : arrêt du moteur après la suppression de la proposition (ancien ordre) : l'amendement est repris comme appliqué", async () => {
  const { eng } = await setup({
    approved: PLAN1_FIXED,
    patch: {
      tasks: [task({ phase: 'control', baseSha: 'sha-head', implementer: 'ct-1-t1' })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN1_FIXED) })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  await writeFile(join(taskDir(), 'brief.md'), BRIEF1)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement' })
  expect(await readFile(join(taskDir(), 'brief.md'), 'utf8')).toContain('## Reprise')
  expect(s.log.some((l) => l.msg.includes('non appliqué'))).toBe(false)
})

test("M2 : arrêt du moteur avant l'enregistrement de l'état (brief déjà réécrit) : la reprise refait l'application", async () => {
  const { eng } = await setup({
    proposed: PLAN1_FIXED,
    approved: PLAN1_FIXED,
    patch: {
      tasks: [task({ phase: 'control', baseSha: 'sha-head', implementer: 'ct-1-t1', stopGate: 'g2' })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN1_FIXED) }), gate({ id: 'g2', kind: 'agent-arret', status: 'pending' })],
    },
  })
  await mkdir(taskDir(), { recursive: true })
  // Brief réécrit par la tentative interrompue.
  await writeFile(join(taskDir(), 'brief.md'), `# Brief de tâche\n\n## Reprise\n\n<!-- amendement g1 -->\n\n### Tâche 1 : Modèle\n\n\n\n**Test :** \`pnpm test a\`\n\nfaire a, en gardant le placeholder imposé par le composant de base\n`)
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks[0]).toMatchObject({ phase: 'implement' })
  expect(s.gates[1]!.status).toBe('caduque')
  await expect(readFile(join(missionDir('T-1'), 'plan.proposed.md'))).rejects.toThrow()
})

test("M4 : un amendement qui retire la tâche en cours est écarté et l'orchestrateur prévenu", async () => {
  const { fx, eng } = await setup({
    proposed: PLAN1,
    plan: PLAN2,
    patch: {
      tasks: [task({ phase: 'done' }), task({ n: 2, title: 'Export', testCommand: 'pnpm test b', phase: 'control', baseSha: 'b0' })],
      gates: [gate({ id: 'g1', kind: 'amendement', status: 'approved', hash: proposalHash(PLAN1) })],
    },
  })
  await eng.tick()
  const s = await loadState('T-1')
  expect(s.appliedAmendments).toEqual(['g1'])
  expect(s.tasks).toHaveLength(2)
  expect(String(fx.callsOf('herdr.agentPrompt').at(-1)![1])).toContain('la tâche 2 en cours a disparu')
})
