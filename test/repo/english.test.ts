import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '..', '..')

const PREFIXES = ['src/', 'test/', 'bin/', 'projects/', '.github/']
const EXTRA = new Set(['README.md', 'install.sh', 'package.json'])
const SELF = 'test/repo/english.test.ts'

const ACCENTS = /[éèêëàâùûüçôîïœÉÈÊÀÇ]/
const WORDS = [
  'porte',
  'tâche',
  'étape',
  'valider',
  'refuser',
  'reprendre',
  'fermer',
  'supprimer',
  'signaler',
  'demande',
  'relecteur',
  'implémenteur',
  'avec',
  'pour',
  'dans',
  'sans',
  'une',
  'les',
  'des',
  'est',
]
const WORD_RE = new RegExp(`\\b(?:${WORDS.join('|')})\\b`, 'i')

/**
 * Lines kept on purpose. Each entry names the file, a line excerpt and why.
 * Only 0.8 compatibility (migrateLegacy tables, étape / Tâche recognition,
 * `herness reprendre … --redemarrer`) and fixtures of a legacy state, log or plan.
 */
const EXCEPTIONS: { file: string; excerpt: string; reason: string }[] = [
  { file: 'src/errreport.ts', excerpt: 'étape', reason: '0.8 error-log header "(étape …)" is still parsed' },
  { file: 'src/mission/plan.ts', excerpt: 'Tâche', reason: '0.8 plan heading "### Tâche <n>:" is still parsed' },
  { file: 'src/mission/state.ts', excerpt: 'fermée', reason: 'migrateLegacy table: 0.8 step fermée' },
  { file: 'src/mission/state.ts', excerpt: 'bloquée', reason: 'migrateLegacy table: 0.8 step bloquée' },
  { file: 'src/ui/model.ts', excerpt: 'mission fermée', reason: '0.8 close log line is still recognized' },
  { file: 'src/update.ts', excerpt: 'herness reprendre', reason: '0.8 command quoted when rolling back with --version' },
  { file: 'test/errreport-send.test.ts', excerpt: '(étape', reason: 'fixture of a legacy error log' },
  { file: 'test/errreport.test.ts', excerpt: '(étape', reason: 'fixture of a legacy error log' },
  { file: 'test/install/update.test.ts', excerpt: 'herness reprendre', reason: 'asserts the 0.8 rollback message' },
  { file: 'test/mcp/server.test.ts', excerpt: '### Tâche', reason: 'fixture of a legacy plan' },
  { file: 'test/mission/plan.test.ts', excerpt: '### Tâche', reason: 'fixture of a legacy plan' },
  { file: 'test/mission/state.test.ts', excerpt: 'bloquée', reason: 'fixture of a legacy state' },
  { file: 'test/mission/state.test.ts', excerpt: 'fermée', reason: 'fixture of a legacy state' },
  { file: 'test/ui/cockpit.test.tsx', excerpt: 'mission fermée', reason: 'fixture of a legacy close log' },
  { file: 'test/ui/model.test.ts', excerpt: 'mission fermée', reason: 'fixture of a legacy close log' },
]

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return out.split('\0').filter((path) => {
    if (!path || path === SELF) return false
    if (EXTRA.has(path)) return true
    return PREFIXES.some((prefix) => path.startsWith(prefix))
  })
}

function allowed(file: string, line: string): boolean {
  return EXCEPTIONS.some((entry) => entry.file === file && line.includes(entry.excerpt))
}

test('tracked sources, tests and docs stay in English', () => {
  const hits: string[] = []
  const used = new Set<number>()
  for (const file of trackedFiles()) {
    const text = readFileSync(join(root, file), 'utf8')
    text.split('\n').forEach((line, index) => {
      EXCEPTIONS.forEach((entry, i) => {
        if (entry.file === file && line.includes(entry.excerpt)) used.add(i)
      })
      if (allowed(file, line)) return
      if (ACCENTS.test(line) || WORD_RE.test(line)) {
        hits.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  const unused = EXCEPTIONS.filter((_, i) => !used.has(i)).map((entry) => `${entry.file}: ${entry.excerpt}`)
  expect(unused, unused.join('\n')).toEqual([])
  expect(hits, hits.join('\n')).toEqual([])
})
