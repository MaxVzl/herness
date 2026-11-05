import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  diagnosticName,
  globalFixerName,
  globalReviewerName,
  implName,
  preflightFixerName,
  reviewerName,
  strongName,
} from '../../src/agents/names.ts'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir, planPath, specPath } from '../../src/paths.ts'
import type { ChatItem, MissionSummary } from '../../src/web/protocol.ts'
import { agentRefs, badgeOf, checksOf, missionFiles, readDoc, sortSummaries, summarize } from '../../src/web/views.ts'

let home: string
const extra: string[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-views-'))
  process.env.HERNESS_HOME = home
})

afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
  await Promise.all(extra.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function mk(over: Partial<MissionState> = {}): MissionState {
  const { id, source, project, repoPath, ...rest } = over
  return {
    ...newState({
      id: id ?? 'm1',
      source: source ?? { kind: 'text', ref: 'une demande' },
      project: project ?? 'demo',
      repoPath: repoPath ?? '/repo',
    }),
    ...rest,
  }
}

const assistant: ChatItem = { kind: 'assistant', uuid: 'a', at: '2026-11-04T10:00:00.000Z', text: 'Voilà.' }
const now = new Date('2026-11-10T12:00:00.000Z')

test('badgeOf : bloqué, en attente de réponse, au travail, mission terminée', () => {
  const active = mk({ step: 'tasks' })
  expect(badgeOf(active, 'blocked', [])).toBe('attend-herdr')
  expect(badgeOf(active, 'idle', [assistant])).toBe('attend-reponse')
  expect(badgeOf(active, 'working', [assistant])).toBeUndefined()
  expect(badgeOf(mk({ step: 'pr-ouverte' }), 'blocked', [assistant])).toBeUndefined()
  expect(badgeOf(mk({ step: 'fermée' }), 'idle', [assistant])).toBeUndefined()
})

test('summarize : titre, statut, badge qui remonte en décision, masquage', () => {
  const longue = 'x'.repeat(80)
  const sansSlug = summarize(
    mk({ source: { kind: 'text', ref: longue }, step: 'tasks' }),
    undefined,
    undefined,
    now,
  )
  expect(sansSlug.title).toBe('x'.repeat(60))
  expect(sansSlug.status).toBe('tasks')
  expect(sansSlug.bucket).toBe('active')
  expect(sansSlug.hidden).toBe(false)

  const avecBadge = summarize(mk({ step: 'tasks', slug: 'mon-slug' }), undefined, 'attend-reponse', now)
  expect(avecBadge.title).toBe('mon-slug')
  expect(avecBadge.bucket).toBe('decision')
  expect(avecBadge.badge).toBe('attend-reponse')
  expect(avecBadge.status).toBe('tasks')

  const url = 'https://github.com/o/r/pull/1'
  const mergée = summarize(
    mk({ step: 'pr-ouverte', prUrl: url, slug: 'faite' }),
    { state: 'MERGED', checkedAt: now.toISOString() },
    undefined,
    now,
  )
  expect(mergée.hidden).toBe(true)
  const ouverte = summarize(
    mk({ step: 'pr-ouverte', prUrl: url, slug: 'faite' }),
    { state: 'OPEN', checkedAt: now.toISOString() },
    undefined,
    now,
  )
  expect(ouverte.hidden).toBe(false)
})

test('sortSummaries : décision, bloquée, active, terminée, puis création décroissante', () => {
  const ligne = (bucket: MissionSummary['bucket'], createdAt: string, id: string): MissionSummary => ({
    id,
    project: 'demo',
    title: id,
    status: bucket,
    bucket,
    hidden: false,
    createdAt,
    step: 'tasks',
  })
  const list = [
    ligne('active', '2026-11-02T00:00:00.000Z', 'a-ancienne'),
    ligne('terminee', '2026-11-05T00:00:00.000Z', 't-recente'),
    ligne('decision', '2026-11-01T00:00:00.000Z', 'd-ancienne'),
    ligne('bloquee', '2026-11-04T00:00:00.000Z', 'b-recente'),
    ligne('active', '2026-11-03T00:00:00.000Z', 'a-recente'),
    ligne('decision', '2026-11-06T00:00:00.000Z', 'd-recente'),
    ligne('bloquee', '2026-11-01T00:00:00.000Z', 'b-ancienne'),
    ligne('terminee', '2026-11-02T00:00:00.000Z', 't-ancienne'),
  ]
  expect(sortSummaries(list).map((m) => m.id)).toEqual([
    'd-recente',
    'd-ancienne',
    'b-recente',
    'b-ancienne',
    'a-recente',
    'a-ancienne',
    't-recente',
    't-ancienne',
  ])
})

test('readDoc : proposition, worktree, absent, worktree supprimé', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'herness-wt-'))
  extra.push(worktree)
  const base = mk({
    id: 'm-doc',
    slug: 'interface',
    worktree,
    createdAt: '2026-11-03T08:00:00.000Z',
  })
  await saveState(base)

  expect(await readDoc(base, 'spec')).toEqual({ source: 'absent', reason: 'pas encore écrit' })
  expect(await readDoc(mk({ id: 'm-doc', worktree }), 'plan')).toEqual({ source: 'absent', reason: 'pas encore écrit' })

  const specFile = join(worktree, specPath(base))
  const planFile = join(worktree, planPath(base))
  await mkdir(dirname(specFile), { recursive: true })
  await mkdir(dirname(planFile), { recursive: true })
  await writeFile(specFile, 'spec actuelle\n')
  await writeFile(planFile, 'plan actuel\n')
  expect(await readDoc(base, 'spec')).toEqual({ source: 'worktree', text: 'spec actuelle\n' })

  const proposed = join(missionDir(base.id), 'spec.proposed.md')
  await writeFile(proposed, 'spec proposée\n')
  expect(await readDoc(base, 'spec')).toEqual({
    source: 'proposition',
    text: 'spec proposée\n',
    current: 'spec actuelle\n',
  })

  const sansFichier = mk({ ...base, worktree: join(worktree, 'autre') })
  await mkdir(sansFichier.worktree as string, { recursive: true })
  const proposedPlan = join(missionDir(base.id), 'plan.proposed.md')
  await writeFile(proposedPlan, 'plan proposé\n')
  expect(await readDoc(sansFichier, 'plan')).toEqual({
    source: 'proposition',
    text: 'plan proposé\n',
    current: null,
  })

  const disparu = mk({ ...base, worktree: join(worktree, 'disparu') })
  await rm(proposed, { force: true })
  await rm(proposedPlan, { force: true })
  await writeFile(join(missionDir(base.id), 'plan.approved.md'), 'plan approuvé\n')
  expect(await readDoc(disparu, 'plan')).toEqual({ source: 'approuve', text: 'plan approuvé\n' })
  expect(await readDoc(disparu, 'spec')).toEqual({
    source: 'absent',
    reason: 'worktree supprimé : spec plus disponible ici',
  })
})

test('checksOf : en cours, vert, rouge, redémarrage ignoré, tri et libellé', async () => {
  const id = 'm-logs'
  await saveState(mk({ id }))
  const logs = join(missionDir(id), 'logs')
  await mkdir(logs, { recursive: true })

  const ancien = join(logs, '1700000000000-T3-tests.log')
  const ancienExit = join(logs, '1700000000000-T3-tests.exit')
  const recent = join(logs, '1700000005000-preflight-build.log')
  const recentExit = join(logs, '1700000005000-preflight-build.exit')
  const cours = join(logs, '1700000009000-T4-tests.log')
  await writeFile(ancien, ['l1', '', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n'))
  await writeFile(ancienExit, '1\n')
  await writeFile(recent, 'ok\n')
  await writeFile(recentExit, '0\n')
  await writeFile(cours, 'toujours là\n')
  await writeFile(join(logs, 'redemarrage-2026-11-04.log'), 'ignoré\n')

  const logAncien = new Date(1700000001000)
  const exitAncien = new Date(1700000003000)
  const logRecent = new Date(1700000006000)
  const exitRecent = new Date(1700000007000)
  const logCours = new Date(1700000009500)
  await utimes(ancien, logAncien, logAncien)
  await utimes(ancienExit, exitAncien, exitAncien)
  await utimes(recent, logRecent, logRecent)
  await utimes(recentExit, exitRecent, exitRecent)
  await utimes(cours, logCours, logCours)

  const moment = new Date(1700000010000)
  const checks = await checksOf(id, moment)
  expect(checks.map((c) => c.file)).toEqual([
    '1700000009000-T4-tests.log',
    '1700000005000-preflight-build.log',
    '1700000000000-T3-tests.log',
  ])
  const enCours = checks[0]
  const vert = checks[1]
  const rouge = checks[2]
  if (!enCours || !vert || !rouge) throw new Error('checks manquants')
  expect(enCours).toMatchObject({
    label: 'T4 tests',
    status: 'en-cours',
    startedAt: new Date(1700000009000).toISOString(),
    durationMs: 1000,
    lastOutputAt: logCours.toISOString(),
  })
  expect(enCours.errorTail).toBeUndefined()
  expect(vert).toMatchObject({
    label: 'preflight build',
    status: 'vert',
    startedAt: new Date(1700000005000).toISOString(),
    durationMs: 2000,
    lastOutputAt: logRecent.toISOString(),
  })
  expect(rouge).toMatchObject({
    label: 'T3 tests',
    status: 'rouge',
    startedAt: new Date(1700000000000).toISOString(),
    durationMs: 3000,
    lastOutputAt: logAncien.toISOString(),
    errorTail: ['l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n'),
  })
})

test('checksOf ignore un journal disparu entre la liste et la lecture', async () => {
  const id = 'm-disparu'
  await saveState(mk({ id }))
  const logs = join(missionDir(id), 'logs')
  await mkdir(logs, { recursive: true })
  await writeFile(join(logs, '1700000001000-T1-tests.log'), 'ok\n')
  await symlink(join(logs, 'plus-la.log'), join(logs, '1700000002000-T2-tests.log'))
  const checks = await checksOf(id, new Date(1700000003000))
  expect(checks.map((check) => check.file)).toEqual(['1700000001000-T1-tests.log'])
})

test('agentRefs : rôles reconnus, le plus récent en premier, panneaux fixes exclus', () => {
  const id = 'm1'
  const panes: Record<string, string> = {
    orchestrator: 'p-orch',
    [implName(id, 3)]: 'p-impl',
    tasks: 'p-tasks',
    [reviewerName(id, 3)]: 'p-rev',
    [strongName(id, 3)]: 'p-fort',
    [globalReviewerName(id, 2)]: 'p-rg',
    [globalFixerName(id, 2, 1)]: 'p-cg',
    [diagnosticName(id, 1, 4)]: 'p-diag',
    [preflightFixerName(id, 1, 0)]: 'p-pf',
    'agent-inconnu': 'p-x',
    lazygit: 'p-lg',
    engine: 'p-eng',
    spec: 'p-spec',
    plan: 'p-plan',
  }
  expect(agentRefs(mk({ id, herdr: { tabs: {}, panes } }))).toEqual([
    { name: 'agent-inconnu', role: 'agent-inconnu', tool: 'Claude' },
    { name: preflightFixerName(id, 1, 0), role: 'Correcteur preflight', tool: 'Cursor' },
    { name: diagnosticName(id, 1, 4), role: 'Diagnostic', tool: 'Claude' },
    { name: globalFixerName(id, 2, 1), role: 'Correcteur global', tool: 'Cursor' },
    { name: globalReviewerName(id, 2), role: 'Relecteur global', tool: 'Claude' },
    { name: strongName(id, 3), role: 'Implémenteur fort', tool: 'Cursor', task: 3 },
    { name: reviewerName(id, 3), role: 'Relecteur', tool: 'Claude', task: 3 },
    { name: implName(id, 3), role: 'Implémenteur', tool: 'Cursor', task: 3 },
  ])
})

test('missionFiles : fichiers de taches, global et preflight', async () => {
  const id = 'm-files'
  await saveState(mk({ id }))
  const root = missionDir(id)
  await mkdir(join(root, 'taches', '1'), { recursive: true })
  await mkdir(join(root, 'taches', '2'), { recursive: true })
  await mkdir(join(root, 'global'), { recursive: true })
  await writeFile(join(root, 'taches', '1', 'brief.md'), 'b')
  await writeFile(join(root, 'taches', '1', 'rapport.md'), 'r')
  await writeFile(join(root, 'taches', '2', 'revue.md'), 'v')
  await writeFile(join(root, 'global', 'rapport.md'), 'g')
  expect(await missionFiles(id)).toEqual({
    'taches/1': ['brief.md', 'rapport.md'],
    'taches/2': ['revue.md'],
    global: ['rapport.md'],
  })
})
