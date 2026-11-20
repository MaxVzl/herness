import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, expect, test } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', '..', '.github', 'scripts', 'auteurs-notes.sh')
const DEPOT = 'MaxVzl/herness'
const SHA = '745ceb2b84b78eb8d9ced3e13f7fa3ed137be0b0'
const SHA_E7 = 'e7bb10ba84b78eb8d9ced3e13f7fa3ed137be0b0'

const ligne14 = `* feat: x ([#14](https://github.com/MaxVzl/herness/issues/14)) ([e7bb10b](https://github.com/MaxVzl/herness/commit/${SHA_E7}))`

const prView = (n: number) =>
  `pr view ${n} --repo ${DEPOT} --json author --jq .author.login`

const apiCommit = (sha: string) =>
  `api repos/${DEPOT}/commits/${sha}/pulls --jq .[0].user.login // empty`

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Réponse du faux `gh` : login (code 0), ou corps écrit sur stdout puis code 1. */
type ReponseGh = string | { stdout: string, code: 1 }

/** Faux `gh` : journalise `"$*"`, répond selon la table, code 1 si la clé est absente. */
async function fauxGh(table: Record<string, ReponseGh>): Promise<{ dir: string, journal: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'auteurs-notes-'))
  dirs.push(dir)
  const journal = join(dir, 'journal')
  const tablePath = join(dir, 'table')
  const rows = Object.entries(table).map(([cle, valeur]) => (
    typeof valeur === 'string' ? `${cle}\t${valeur}` : `${cle}\t${valeur.stdout}\t${valeur.code}`
  )).join('\n')
  await writeFile(tablePath, rows === '' ? '' : `${rows}\n`)
  await writeFile(journal, '')
  const gh = join(dir, 'gh')
  await writeFile(gh, `#!/bin/sh
printf '%s\\n' "$*" >> '${journal}'
while IFS= read -r row || [ -n "$row" ]; do
  key=\${row%%\t*}
  rest=\${row#*\t}
  code=\${rest##*\t}
  if [ "$code" = "$rest" ]; then
    val=$rest
    code=0
  else
    val=\${rest%\t*}
  fi
  if [ "$key" = "$*" ]; then
    printf '%s\\n' "$val"
    exit "$code"
  fi
done < '${tablePath}'
exit 1
`)
  await chmod(gh, 0o755)
  return { dir, journal }
}

async function lancer(input: string, table: Record<string, ReponseGh>) {
  const { dir, journal } = await fauxGh(table)
  const resultat = await execa('sh', [SCRIPT, DEPOT], {
    input,
    reject: false,
    stripFinalNewline: false,
    env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
  })
  return { ...resultat, journal: await readFile(journal, 'utf8') }
}

test('auteur trouvé par le numéro de PR', async () => {
  const r = await lancer(`${ligne14}\n`, { [prView(14)]: 'alice' })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe(`${ligne14} by @alice\n`)
  expect(r.journal).not.toContain('api')
})

test('auteur trouvé par le commit quand la ligne n\'a pas de numéro', async () => {
  const ligne = `* **x:** y ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const r = await lancer(`${ligne}\n`, { [apiCommit(SHA)]: 'bob' })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe(`${ligne} by @bob\n`)
})

test('repli sur le commit quand le numéro ne donne pas d\'auteur', async () => {
  const ligne = `* fix: z ([#9](https://github.com/MaxVzl/herness/issues/9)) ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const r = await lancer(`${ligne}\n`, { [apiCommit(SHA)]: 'carol' })
  expect(r.stdout.trimEnd().endsWith(' by @carol')).toBe(true)
  expect(r.journal.trim().split('\n')).toEqual([prView(9), apiCommit(SHA)])
})

test('seul le premier numéro compte', async () => {
  const ligne = '* a ([#27](https://github.com/MaxVzl/herness/issues/27)) ([#28](https://github.com/MaxVzl/herness/issues/28))'
  const r = await lancer(`${ligne}\n`, {
    [prView(27)]: 'dave',
    [prView(28)]: 'erin',
  })
  expect(r.stdout.trimEnd().endsWith(' by @dave')).toBe(true)
  expect(r.stdout).not.toContain('erin')
})

test('ligne déjà annotée laissée telle quelle', async () => {
  const entree = `${ligne14} by @alice\n`
  const r = await lancer(entree, { [prView(14)]: 'alice' })
  expect(r.stdout).toBe(entree)
  expect(r.journal).toBe('')
})

test('bots ignorés', async () => {
  const lignePr = '* bot: pr ([#3](https://github.com/MaxVzl/herness/issues/3))'
  const ligneCommit = `* bot: commit ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const entree = `${lignePr}\n${ligneCommit}\n`
  const r = await lancer(entree, {
    [prView(3)]: 'app/github-actions',
    [apiCommit(SHA)]: 'github-actions[bot]',
  })
  expect(r.stdout).toBe(entree)
})

test('corps d\'erreur de gh ignoré : ligne inchangée', async () => {
  const corps = '{"message":"No commit found for SHA: 0000","status":"422"}'
  const lignePr = '* pr ([#5](https://github.com/MaxVzl/herness/issues/5))'
  const ligneApi = `* sha ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const entree = `${lignePr}\n${ligneApi}\n`
  const r = await lancer(entree, {
    [prView(5)]: { stdout: corps, code: 1 },
    [apiCommit(SHA)]: { stdout: corps, code: 1 },
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe(entree)
})

test('ligne en CRLF déjà annotée laissée telle quelle', async () => {
  const entree = `${ligne14} by @alice\r\n`
  const r = await lancer(entree, { [prView(14)]: 'zoe' })
  expect(r.stdout).toBe(entree)
  expect(r.journal).toBe('')
})

test('annotation placée avant le retour chariot', async () => {
  const ligne = '* a ([#14](https://github.com/MaxVzl/herness/issues/14))\r'
  const r = await lancer(`${ligne}\n`, { [prView(14)]: 'alice' })
  expect(r.stdout).toBe('* a ([#14](https://github.com/MaxVzl/herness/issues/14)) by @alice\r\n')
})

test('gh en échec : ligne inchangée et code 0', async () => {
  const entree = `* c ([#5](https://github.com/MaxVzl/herness/issues/5)) ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))\n`
  const r = await lancer(entree, {})
  expect(r.stdout).toBe(entree)
  expect(r.exitCode).toBe(0)
})

test('texte autour recopié à l\'identique', async () => {
  const entree = '* feat: garder ([#14](https://github.com/MaxVzl/herness/issues/14))'
  const lignes = [
    ':robot: I have created a release *beep* *boop*',
    '---',
    '',
    '## [0.8.0](https://github.com/MaxVzl/herness/compare/v0.7.0...v0.8.0) (2026-11-20)',
    '',
    '### Features',
    '',
    entree,
    '  indentée \\ avec barre',
    '',
    'This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).',
  ]
  const input = `${lignes.join('\n')}\n`
  const r = await lancer(input, { [prView(14)]: 'alice' })
  expect(r.exitCode).toBe(0)
  const obtenu = r.stdout.split('\n')
  input.split('\n').forEach((ligne, i) => {
    if (ligne === entree) expect(obtenu[i]).toBe(`${entree} by @alice`)
    else expect(obtenu[i]).toBe(ligne)
  })
  expect(r.journal.trim().split('\n')).toEqual([prView(14)])
})

test('dernière ligne sans retour à la ligne final traitée', async () => {
  const entree = '* a ([#14](https://github.com/MaxVzl/herness/issues/14))'
  const r = await lancer(entree, { [prView(14)]: 'alice' })
  expect(r.stdout).toContain(' by @alice')
})

test('script exécutable', async () => {
  expect((await stat(SCRIPT)).mode & 0o111).not.toBe(0)
})
