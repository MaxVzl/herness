import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkEnv } from '../../src/engine/envcheck.ts'
import type { RunResult } from '../../src/exec.ts'
import { fakeEffects } from '../fakes.ts'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'herness-env-'))
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const r = (exitCode: number, stdout = ''): RunResult => ({ stdout, stderr: '', exitCode })
function runner(fail: Record<string, RunResult> = {}) {
  return async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`
    if (key in fail) return fail[key]!
    if (cmd === 'cursor-agent') return r(0, 'Logged in as moi@example.com')
    if (cmd === 'node') return r(0, 'v24.1.0')
    if (cmd === 'pnpm') return r(0, '12.16.1')
    return r(0)
  }
}

test('everything is OK; node is checked only when the repo has a package.json', async () => {
  let res = await checkEnv(repo, fakeEffects({ run: runner() }))
  expect(res.map((x) => x.label)).toEqual(['git', 'docker', 'cursor', 'herdr', 'gh'])
  expect(res.every((x) => x.status === 'OK')).toBe(true)
  expect(res.find((x) => x.label === 'git')?.detail).toMatch(/^identity: /)
  expect(res.find((x) => x.label === 'docker')?.detail).toBe('reachable')
  expect(res.find((x) => x.label === 'cursor')?.detail).toBe('signed in')
  expect(res.find((x) => x.label === 'herdr')?.detail).toBe('server reachable')
  expect(res.find((x) => x.label === 'gh')?.detail).toBe('authenticated')
  await writeFile(join(repo, 'package.json'), '{}')
  res = await checkEnv(repo, fakeEffects({ run: runner() }))
  expect(res.at(-1)).toEqual({ label: 'node', status: 'OK', detail: 'node v24.1.0, pnpm 12.16.1' })
})

test('each KO includes the command to run', async () => {
  const fx = fakeEffects({
    git: { identity: async () => null },
    run: runner({
      'docker info': r(1),
      'sg docker -c docker info': r(1),
      'cursor-agent status': r(1, 'Not logged in'),
      'herdr workspace list': r(1),
      'gh auth status': r(1),
    }),
  })
  const res = await checkEnv(repo, fx)
  expect(res.every((x) => x.status === 'KO')).toBe(true)
  const by = Object.fromEntries(res.map((x) => [x.label, x.detail]))
  expect(by.git).toMatch(/no complete git identity — the user runs: ! git config --global user.name .*git config --global user.email/)
  expect(by.docker).toContain('unreachable — the user runs: ! sudo systemctl start docker')
  expect(by.cursor).toContain('not signed in — the user runs: ! cursor-agent login')
  expect(by.herdr).toContain('server unreachable — the user starts herdr')
  expect(by.gh).toContain('gh missing or not authenticated — the user runs: ! gh auth login')
})

test('docker reachable via sg docker is OK', async () => {
  const res = await checkEnv(repo, fakeEffects({ run: runner({ 'docker info': r(1) }) }))
  expect(res.find((x) => x.label === 'docker')).toMatchObject({ status: 'OK', detail: "reachable via 'sg docker'" })
})

test('a missing command (exception) is a KO, not a crash', async () => {
  const run = async (cmd: string, args: string[]) => {
    if (cmd === 'gh') throw new Error('spawn gh ENOENT')
    return runner()(cmd, args)
  }
  const res = await checkEnv(repo, fakeEffects({ run }))
  expect(res.find((x) => x.label === 'gh')).toMatchObject({ status: 'KO' })
  expect(res.find((x) => x.label === 'gh')?.detail).toContain('gh missing or not authenticated')
})
