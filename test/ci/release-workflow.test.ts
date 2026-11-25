import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const workflow = await readFile(join(root, '.github', 'workflows', 'release-please.yml'), 'utf8')

test('the script annotates the release and the release PR', () => {
  const mark = '.github/scripts/authors-notes.sh "$GITHUB_REPOSITORY"'
  const occurrences = workflow.split(mark).length - 1
  expect(occurrences).toBeGreaterThanOrEqual(2)
  expect(workflow).toContain('> notes-authors.md')
  expect(workflow).toContain('> body.md')
  expect(workflow).toContain('< body.md >')
  expect(workflow).toContain('body-authors.md')
  expect(workflow).not.toContain('auteurs-notes.sh')
  expect(workflow).not.toContain('notes-auteurs.md')
  expect(workflow).not.toContain('corps.md')
  expect(workflow).not.toContain('corps-auteurs.md')
  expect(workflow).toContain('autorelease: pending')
  expect(workflow).toContain('gh pr edit')
  expect(workflow).toContain('cmp -s')
})

test('the old inline loop is gone', () => {
  expect(workflow).not.toContain('while IFS= read -r line')
})

test('checkout runs on every pass', () => {
  const lines = workflow.split('\n')
  const index = lines.findIndex((line) => line.includes('- uses: actions/checkout@v4'))
  expect(index).toBeGreaterThanOrEqual(0)
  expect(lines[index + 1]).not.toContain('if:')
})

test('PR annotation comes after release-please', () => {
  const annotation = workflow.indexOf('name: PR authors in the release PR')
  const releasePlease = workflow.indexOf('googleapis/release-please-action')
  expect(annotation).toBeGreaterThan(releasePlease)
})

test('workflow runs are serialized', () => {
  expect(workflow).toContain('group: release-please')
  expect(workflow).toContain('cancel-in-progress: false')
})

test('PR annotation is the last step, with no condition', () => {
  const lines = workflow.split('\n')
  const index = lines.findIndex((line) => line.includes('name: PR authors in the release PR'))
  expect(index).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(index + 1)
  expect(rest.join('\n')).not.toMatch(/^\s*if:/m)
  expect(rest.some((line) => /^\s*- name:/.test(line) || /^\s*- uses:/.test(line))).toBe(false)
})

test('package description is the English one-liner', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { description: string }
  expect(pkg.description).toBe('Code agent orchestrator driven by code')
})
