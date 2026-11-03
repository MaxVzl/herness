import { readFile } from 'node:fs/promises'
import { execa } from 'execa'
import { expect, test } from 'vitest'
import { VERSION } from '../../src/version.ts'

test('herness --version affiche la version de package.json', async () => {
  const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
  expect(VERSION).toBe(version)
  const r = await execa('node', ['bin/herness.js', '--version'], { reject: false, stdin: 'ignore' })
  expect(r.stdout.trim()).toBe(version)
})
