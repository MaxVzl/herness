import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const readme = await readFile(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')

test('README documents the English commands, MCP tools, example project and 0.8 upgrade', () => {
  expect(readme).toContain('## Upgrading from 0.8')
  expect(readme).toContain('herness update --version 0.8.1')
  expect(readme).toContain("language: 'fr'")
  expect(readme).toContain('projects/example')
  expect(readme).toContain('herness approve')
  expect(readme).toContain('herness reject')
  expect(readme).toContain('herness resume')
  expect(readme).toContain('herness close')
  expect(readme).toContain('request_approval')
  expect(readme).toContain('report_anomaly')
  expect(readme).not.toContain('mise-a-jour')
  expect(readme).not.toContain(['herness', 'vali' + 'der'].join(' '))
  expect(readme).not.toContain('projects/exemple')
})
