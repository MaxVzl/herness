import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')

test('upgrading from 0.8 refuses the old restart offer', () => {
  expect(readme).toContain('herness mise-a-jour')
  expect(readme).toMatch(/answer no/i)
  expect(readme).toMatch(/no mission in progress/i)
})

test('language covers agent commits, not the engine commits', () => {
  expect(readme).toMatch(/engine's own commits stay in English/)
  expect(readme).toMatch(/commit messages written by agents/)
})
