import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, expect, test } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', '..', '.github', 'scripts', 'authors-notes.sh')
const DEPOT = 'MaxVzl/herness'
const SHA = '745ceb2b84b78eb8d9ced3e13f7fa3ed137be0b0'
const SHA_E7 = 'e7bb10ba84b78eb8d9ced3e13f7fa3ed137be0b0'

const line14 = `* feat: x ([#14](https://github.com/MaxVzl/herness/issues/14)) ([e7bb10b](https://github.com/MaxVzl/herness/commit/${SHA_E7}))`

const prView = (n: number) =>
  `pr view ${n} --repo ${DEPOT} --json author --jq .author.login`

const apiCommit = (sha: string) =>
  `api repos/${DEPOT}/commits/${sha}/pulls --jq .[0].user.login // empty`

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Fake `gh` answer: a login (exit 0), or a body written to stdout then exit 1. */
type GhReply = string | { stdout: string, code: 1 }

/** Fake `gh`: logs `"$*"`, answers from the table, exit 1 when the key is missing. */
async function fakeGh(table: Record<string, GhReply>): Promise<{ dir: string, journal: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'authors-notes-'))
  dirs.push(dir)
  const journal = join(dir, 'journal')
  const tablePath = join(dir, 'table')
  const rows = Object.entries(table).map(([key, value]) => (
    typeof value === 'string' ? `${key}\t${value}` : `${key}\t${value.stdout}\t${value.code}`
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

async function run(input: string, table: Record<string, GhReply>) {
  const { dir, journal } = await fakeGh(table)
  const result = await execa('sh', [SCRIPT, DEPOT], {
    input,
    reject: false,
    stripFinalNewline: false,
    env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
  })
  return { ...result, journal: await readFile(journal, 'utf8') }
}

test('author found from the PR number', async () => {
  const r = await run(`${line14}\n`, { [prView(14)]: 'alice' })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe(`${line14} by @alice\n`)
  expect(r.journal).not.toContain('api')
})

test('author found from the commit when the line has no number', async () => {
  const line = `* **x:** y ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const r = await run(`${line}\n`, { [apiCommit(SHA)]: 'bob' })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe(`${line} by @bob\n`)
})

test('falls back to the commit when the number yields no author', async () => {
  const line = `* fix: z ([#9](https://github.com/MaxVzl/herness/issues/9)) ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const r = await run(`${line}\n`, { [apiCommit(SHA)]: 'carol' })
  expect(r.stdout.trimEnd().endsWith(' by @carol')).toBe(true)
  expect(r.journal.trim().split('\n')).toEqual([prView(9), apiCommit(SHA)])
})

test('only the first number counts', async () => {
  const line = '* a ([#27](https://github.com/MaxVzl/herness/issues/27)) ([#28](https://github.com/MaxVzl/herness/issues/28))'
  const r = await run(`${line}\n`, {
    [prView(27)]: 'dave',
    [prView(28)]: 'erin',
  })
  expect(r.stdout.trimEnd().endsWith(' by @dave')).toBe(true)
  expect(r.stdout).not.toContain('erin')
})

test('a line already annotated is left as it is', async () => {
  const input = `${line14} by @alice\n`
  const r = await run(input, { [prView(14)]: 'alice' })
  expect(r.stdout).toBe(input)
  expect(r.journal).toBe('')
})

test('bots are ignored', async () => {
  const linePr = '* bot: pr ([#3](https://github.com/MaxVzl/herness/issues/3))'
  const lineCommit = `* bot: commit ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const input = `${linePr}\n${lineCommit}\n`
  const r = await run(input, {
    [prView(3)]: 'app/github-actions',
    [apiCommit(SHA)]: 'github-actions[bot]',
  })
  expect(r.stdout).toBe(input)
})

test('gh error body is ignored: the line stays unchanged', async () => {
  const body = '{"message":"No commit found for SHA: 0000","status":"422"}'
  const linePr = '* pr ([#5](https://github.com/MaxVzl/herness/issues/5))'
  const lineApi = `* sha ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))`
  const input = `${linePr}\n${lineApi}\n`
  const r = await run(input, {
    [prView(5)]: { stdout: body, code: 1 },
    [apiCommit(SHA)]: { stdout: body, code: 1 },
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe(input)
})

test('a CRLF line already annotated is left as it is', async () => {
  const input = `${line14} by @alice\r\n`
  const r = await run(input, { [prView(14)]: 'zoe' })
  expect(r.stdout).toBe(input)
  expect(r.journal).toBe('')
})

test('the annotation is placed before the carriage return', async () => {
  const line = '* a ([#14](https://github.com/MaxVzl/herness/issues/14))\r'
  const r = await run(`${line}\n`, { [prView(14)]: 'alice' })
  expect(r.stdout).toBe('* a ([#14](https://github.com/MaxVzl/herness/issues/14)) by @alice\r\n')
})

test('gh failure: line unchanged and exit code 0', async () => {
  const input = `* c ([#5](https://github.com/MaxVzl/herness/issues/5)) ([745ceb2](https://github.com/MaxVzl/herness/commit/${SHA}))\n`
  const r = await run(input, {})
  expect(r.stdout).toBe(input)
  expect(r.exitCode).toBe(0)
})

test('surrounding text is copied unchanged', async () => {
  const entry = '* feat: keep ([#14](https://github.com/MaxVzl/herness/issues/14))'
  const lines = [
    ':robot: I have created a release *beep* *boop*',
    '---',
    '',
    '## [0.8.0](https://github.com/MaxVzl/herness/compare/v0.7.0...v0.8.0) (2026-11-20)',
    '',
    '### Features',
    '',
    entry,
    '  indented \\ with a bar',
    '',
    'This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).',
  ]
  const input = `${lines.join('\n')}\n`
  const r = await run(input, { [prView(14)]: 'alice' })
  expect(r.exitCode).toBe(0)
  const got = r.stdout.split('\n')
  input.split('\n').forEach((line, i) => {
    if (line === entry) expect(got[i]).toBe(`${entry} by @alice`)
    else expect(got[i]).toBe(line)
  })
  expect(r.journal.trim().split('\n')).toEqual([prView(14)])
})

test('a last line without a final newline is still handled', async () => {
  const input = '* a ([#14](https://github.com/MaxVzl/herness/issues/14))'
  const r = await run(input, { [prView(14)]: 'alice' })
  // read + printf add the final newline: gh --jq .body already provides one.
  expect(r.stdout).toBe(`${input} by @alice\n`)
})

test('script is executable', async () => {
  expect((await stat(SCRIPT)).mode & 0o111).not.toBe(0)
})
