import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openGate } from '../../src/engine/gates.ts'
import { drainInbox } from '../../src/mission/inbox.ts'
import { newState, saveState } from '../../src/mission/state.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  delete process.env.HERNESS_HOME
  await rm(home, { recursive: true, force: true })
})

const run = (...args: string[]) =>
  execa('node', ['bin/herness.js', ...args], {
    reject: false, stdin: 'ignore', env: { HERNESS_HOME: home },
  })

test('reject sans --note est rejeté par la CLI', async () => {
  const r = await run('reject', 'X')
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('herness: required option: --note <text> (reason for rejecting)')
})

test('approve hors terminal interactif échoue et ne poste rien', async () => {
  const s = newState({ id: 'T-1', source: { kind: 'text', ref: 'x' }, project: 'p', repoPath: '/r' })
  openGate(s, 'spec', 'Spec')
  await saveState(s)
  const r = await run('approve', 'T-1')
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('approval requires an interactive terminal')
  expect(await drainInbox('T-1')).toEqual([])
})
