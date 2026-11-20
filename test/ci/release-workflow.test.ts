import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const workflow = await readFile(
  join(import.meta.dirname, '..', '..', '.github', 'workflows', 'release-please.yml'),
  'utf8',
)

test('le script annote la release et la PR de release', () => {
  const marque = '.github/scripts/auteurs-notes.sh "$GITHUB_REPOSITORY"'
  const occurrences = workflow.split(marque).length - 1
  expect(occurrences).toBeGreaterThanOrEqual(2)
  expect(workflow).toContain('autorelease: pending')
  expect(workflow).toContain('gh pr edit')
  expect(workflow).toContain('cmp -s')
})

test("l'ancienne boucle en ligne a disparu", () => {
  expect(workflow).not.toContain('while IFS= read -r line')
})

test('le checkout tourne à chaque passage', () => {
  const lignes = workflow.split('\n')
  const index = lignes.findIndex((ligne) => ligne.includes('- uses: actions/checkout@v4'))
  expect(index).toBeGreaterThanOrEqual(0)
  expect(lignes[index + 1]).not.toContain('if:')
})

test("l'annotation de la PR vient après release-please", () => {
  const annotation = workflow.indexOf('name: Auteurs des PR dans la PR de release')
  const releasePlease = workflow.indexOf('googleapis/release-please-action')
  expect(annotation).toBeGreaterThan(releasePlease)
})
