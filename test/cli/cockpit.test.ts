import { execa } from 'execa'
import { expect, test } from 'vitest'

const run = (env: Record<string, string>, ...args: string[]) =>
  execa('node', ['bin/herness.js', ...args], { reject: false, stdin: 'ignore', env, extendEnv: false })

test('herness with no argument outside herdr: message and code 0', async () => {
  const r = await run({ PATH: process.env.PATH ?? '' })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('outside herdr: run "herness cockpit" in a terminal')
})

test('unknown command: non-zero code', async () => {
  const r = await run({ PATH: process.env.PATH ?? '' }, 'statu')
  expect(r.exitCode).not.toBe(0)
})
