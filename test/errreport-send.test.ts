import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { RunOptions, RunResult } from '../src/exec.ts'
import { logHernessError } from '../src/errlog.ts'
import {
  confirmQuestion,
  errorSignature,
  issuesFilePath,
  pendingEntries,
  planReport,
  previewLines,
  sendReport,
  type PlannedSend,
} from '../src/errreport.ts'
import type { Runner } from '../src/forge/github.ts'
import { missionDir } from '../src/paths.ts'

const CREATE_URL = 'https://github.com/MaxVzl/herness/issues/7'
const COMMENT_URL = 'https://github.com/MaxVzl/herness/issues/42#issuecomment-1'
const LIST_ARGS = ['issue', 'list', '--repo', 'MaxVzl/herness', '--state', 'open', '--limit', '500', '--json', 'number,title,body,url']

type Call = { args: string[]; input?: string }

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

function fakeRunner(open: unknown[] = [], failOn?: string): { runner: Runner; calls: Call[] } {
  const calls: Call[] = []
  const runner: Runner = async (_cmd, args, opts?: RunOptions): Promise<RunResult> => {
    calls.push({ args, input: opts?.input })
    if (args[1] === failOn) throw new Error(`gh ${args[1]} a échoué`)
    if (args[1] === 'list') return { stdout: JSON.stringify(open), stderr: '', exitCode: 0 }
    if (args[1] === 'create') return { stdout: `${CREATE_URL}\n`, stderr: '', exitCode: 0 }
    if (args[1] === 'comment') return { stdout: `${COMMENT_URL}\n`, stderr: '', exitCode: 0 }
    throw new Error(`commande inattendue : ${args.join(' ')}`)
  }
  return { runner, calls }
}

async function deuxErreurs(): Promise<{ runner: Runner; calls: Call[] }> {
  await logHernessError({ mission: 'm1', origin: 'moteur', step: 'un' }, new Error('répétée'))
  await logHernessError({ mission: 'm1', origin: 'moteur', step: 'deux' }, new Error('connue'))
  await logHernessError({ mission: 'm1', origin: 'moteur', step: 'trois' }, new Error('répétée'))
  const pending = await pendingEntries('m1')
  const connue = pending.find((entry) => entry.body.includes('connue'))
  if (!connue) throw new Error('entrée connue absente')
  return fakeRunner([{ number: 42, title: 'T', url: 'u42', body: `… ${errorSignature(connue)} …` }])
}

test('pendingEntries reads entries from legacy erreurs.log and errors.log', async () => {
  await writeFile(
    join(home, 'erreurs.log'),
    '=== 2026-01-01T00:00:00.000Z · mission m1 · herness 1.0.0 · moteur (étape tasks)\nancien\n\n',
  )
  await writeFile(
    join(home, 'errors.log'),
    '=== 2026-01-02T00:00:00.000Z · mission m1 · herness 1.0.0 · moteur (step preflight)\nnouveau\n\n',
  )
  const pending = await pendingEntries('m1')
  expect(pending.map((entry) => entry.body)).toEqual(['ancien', 'nouveau'])
  expect(pending.map((entry) => entry.step)).toEqual(['tasks', 'preflight'])
})

test("sans journal, rien à préparer et gh n'est pas appelé", async () => {
  const { runner, calls } = fakeRunner()
  expect(await planReport('m1', runner)).toEqual([])
  expect(calls).toEqual([])
})

test('seules les entrées de la mission exacte sont prises', async () => {
  await logHernessError({ mission: 'gh1', origin: 'moteur' }, new Error('un'))
  await logHernessError({ mission: 'gh12', origin: 'moteur' }, new Error('deux'))
  const pending = await pendingEntries('gh1')
  expect(pending).toHaveLength(1)
  expect(pending[0]?.mission).toBe('gh1')
  expect(pending[0]?.body).toContain('Error: un')
})

test('une erreur nouvelle donne une issue, une connue un commentaire', async () => {
  await logHernessError({ mission: 'm1', origin: 'moteur' }, new Error('nouvelle'))
  await logHernessError({ mission: 'm1', origin: 'autre' }, new Error('connue'))
  const pending = await pendingEntries('m1')
  const seconde = pending[1]
  if (!seconde) throw new Error('seconde entrée absente')
  const { runner, calls } = fakeRunner([{ number: 42, title: 'T', url: 'u42', body: `… ${errorSignature(seconde)} …` }])
  const plan = await planReport('m1', runner)
  expect(plan.map((item) => item.kind)).toEqual(['issue', 'comment'])
  expect(plan[1]).toMatchObject({ kind: 'comment', issue: { number: 42, title: 'T', url: 'u42' } })
  expect(calls.map((call) => call.args)).toEqual([LIST_ARGS])
})

test('sendReport crée, commente et note chaque entrée', async () => {
  const { runner, calls } = await deuxErreurs()
  const plan = await planReport('m1', runner)
  const issue = plan.find((item) => item.kind === 'issue')
  const comment = plan.find((item) => item.kind === 'comment')
  if (!issue || issue.kind !== 'issue' || !comment || comment.kind !== 'comment') throw new Error('plan inattendu')
  const lines = await sendReport('m1', plan, runner)
  expect(lines).toEqual([`issue créée : ${CREATE_URL}`, `commentaire ajouté : ${COMMENT_URL}`])
  expect(calls.map((call) => call.args)).toEqual([
    LIST_ARGS,
    ['issue', 'create', '--repo', 'MaxVzl/herness', '--title', issue.title, '--body-file', '-'],
    ['issue', 'comment', '42', '--repo', 'MaxVzl/herness', '--body-file', '-'],
  ])
  expect(calls[1]?.input).toBe(issue.body)
  expect(calls[2]?.input).toBe(comment.body)
  const stored = JSON.parse(await readFile(issuesFilePath('m1'), 'utf8')) as { sent: { entry: string; url: string }[] }
  expect(stored.sent).toHaveLength(3)
  const issueRecords = stored.sent.filter((record) => record.url === CREATE_URL)
  expect(issueRecords).toHaveLength(2)
  expect(new Set(issueRecords.map((record) => record.entry)).size).toBe(2)
  expect(await pendingEntries('m1')).toEqual([])
})

test('un échec au deuxième envoi garde le premier', async () => {
  const { runner } = await deuxErreurs()
  const plan = await planReport('m1', runner)
  const failing = fakeRunner([{ number: 42, title: 'T', url: 'u42', body: 'ignoré' }], 'comment').runner
  await expect(sendReport('m1', plan, failing)).rejects.toThrow(/comment/)
  const stored = JSON.parse(await readFile(issuesFilePath('m1'), 'utf8')) as { sent: { url: string }[] }
  expect(stored.sent).toHaveLength(2)
  expect(stored.sent.every((record) => record.url === CREATE_URL)).toBe(true)
  const again = fakeRunner([{ number: 42, title: 'T', url: 'u42', body: plan.find((item) => item.kind === 'comment')?.group.signature ?? '' }])
  const next = await planReport('m1', again.runner)
  expect(next.map((item) => item.kind)).toEqual(['comment'])
})

test("issues.json illisible : rien n'est envoyé", async () => {
  await logHernessError({ mission: 'm1', origin: 'moteur' }, 'boum')
  await mkdir(missionDir('m1'), { recursive: true })
  await writeFile(issuesFilePath('m1'), '{')
  const { runner, calls } = fakeRunner()
  await expect(planReport('m1', runner)).rejects.toThrow(/issues.json illisible/)
  expect(calls.some((call) => call.args[1] === 'create')).toBe(false)
  expect(await readFile(issuesFilePath('m1'), 'utf8')).toBe('{')
})

test('previewLines et confirmQuestion', () => {
  const issue: PlannedSend = {
    kind: 'issue',
    title: '[erreur herness] moteur : boom',
    body: 'corps issue',
    group: { signature: 'herness-sig-aaaaaaaaaaaa', entries: [] },
  }
  const comment: PlannedSend = {
    kind: 'comment',
    issue: { number: 42, title: 'T', url: 'u42' },
    body: 'corps commentaire',
    group: { signature: 'herness-sig-bbbbbbbbbbbb', entries: [] },
  }
  const lines = previewLines('m1', [issue, comment])
  expect(lines[0]).toBe('Erreurs herness de la mission m1 à remonter sur MaxVzl/herness (dépôt public) :')
  expect(lines.join('\n')).toContain('── Nouvelle issue : [erreur herness]')
  expect(lines.join('\n')).toContain('── Commentaire sur #42 (T)')
  expect(lines.at(-1)).toBe('Relis : tout ce qui est affiché sera public.')
  expect(confirmQuestion([issue, comment])).toBe('Envoyer 1 issue et 1 commentaire sur MaxVzl/herness ?')
  const autre: PlannedSend = { ...issue, title: '[erreur herness] autre : boom' }
  expect(confirmQuestion([issue, autre])).toBe('Envoyer 2 issues sur MaxVzl/herness ?')
})
