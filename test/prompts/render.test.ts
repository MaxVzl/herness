import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { render } from '../../src/prompts/render.js'

const SETS: Record<string, string[]> = {
  orchestrator: ['id', 'request', 'requestFile', 'note', 'specPath', 'planPath', 'missionDir', 'mainBranch', 'preflight', 'language'],
  brief: ['taskBody', 'specPath', 'planPath', 'testCommand', 'commitFormat', 'forbidden', 'reportPath', 'language'],
  review: ['briefPath', 'reportPath', 'baseSha', 'headSha', 'diffPath', 'constraints', 'outPath'],
  rereview: ['briefPath', 'reportPath', 'baseSha', 'headSha', 'diffPath', 'constraints', 'findings', 'outPath'],
  correction: ['findings', 'failure', 'forbidden', 'reportPath', 'language'],
  'global-review': ['baseSha', 'headSha', 'diffPath', 'specPath', 'planPath', 'constraints', 'outPath'],
  diagnostic: ['logPath', 'outPath'],
  init: ['repoPath', 'configFile', 'configDir'],
  'pr-body': ['ticket', 'context', 'changes', 'tests', 'preflight', 'specFile', 'planFile'],
}

const full = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `<<${k}>>`]))

describe('render', () => {
  it('replaces every key', async () => {
    const out = await render('diagnostic', full(SETS.diagnostic!))
    expect(out).toContain('<<logPath>>')
    expect(out).toContain('<<outPath>>')
    expect(out).not.toMatch(/\{\{/)
  })

  it('throws listing the missing keys', async () => {
    await expect(render('diagnostic', {})).rejects.toThrow(/logPath.*outPath|outPath.*logPath/)
    await expect(render('diagnostic', { logPath: 'x' })).rejects.toThrow(/outPath/)
  })

  for (const [name, keys] of Object.entries(SETS)) {
    it(`template ${name} renders without error with a complete set`, async () => {
      const out = await render(name, full(keys))
      expect(out).not.toMatch(/\{\{/)
      for (const k of keys) expect(out).toContain(`<<${k}>>`)
    })
  }

  it('implementation templates end with the report instruction', async () => {
    for (const name of ['brief', 'correction']) {
      const out = await render(name, full(SETS[name]!))
      expect(out.trim()).toMatch(/<<reportPath>>[\s\S]*DONE`?\.?$/)
    }
  })

  it('review templates require the verdict on the first line', async () => {
    for (const name of ['review', 'rereview', 'global-review']) {
      const out = await render(name, full(SETS[name]!))
      expect(out).toContain('VERDICT: APPROVED')
      expect(out).toContain('VERDICT: CORRECTIONS')
      expect(out).toMatch(/in English/)
      expect(out.trim()).toMatch(/DONE`?\.?$/)
    }
  })

  it('diagnostic requires CAUSE on the first line', async () => {
    const out = await render('diagnostic', full(SETS.diagnostic!))
    for (const c of ['BRANCH', 'MAIN', 'ENVIRONMENT']) expect(out).toContain(`CAUSE: ${c}`)
    expect(out).toMatch(/in English/)
  })

  it('orchestrator.md imposes English plan markers and forbids self-approval', async () => {
    const raw = await readFile(new URL('../../src/prompts/orchestrator.md', import.meta.url), 'utf8')
    expect(raw).toContain('**Test:**')
    expect(raw).toContain('### Task <n>: <title>')
    expect(raw).toMatch(/never by you/)
    expect(raw).toContain('herness approve')
    expect(raw).not.toContain('Tu r\u00e9ponds en fran\u00e7ais')
    for (const t of ['status', 'mission_classified', 'request_approval', 'propose_amendment', 'request_arbitration', 'pause', 'end_pause', 'abandon', 'report_anomaly']) {
      expect(raw).toContain(t)
    }
    for (const old of ['statut', 'mission_identifiee', 'demander_validation', 'proposer_amendement', 'demander_arbitrage', 'fin_de_pause', 'abandonner', 'signaler_anomalie']) {
      expect(raw).not.toContain(old)
    }
    expect(raw).toContain('[herness]')
  })

  it('correction asks to append the report at the end of the file, without overwriting it', async () => {
    const out = await render('correction', full(SETS.correction!))
    expect(out).toContain('Append this report to the end of `<<reportPath>>`')
    expect(out).not.toContain('Write this report in')
  })
})

describe('orchestrator.md', () => {
  it('lifts the ban on changing the repo only once the PR is open, on request', async () => {
    const out = await render('orchestrator', full(SETS.orchestrator!))
    expect(out).toContain('except once the PR is open')
    const after = out.slice(out.indexOf('## After the PR is open'))
    expect(after).toContain('pr-open')
    expect(after).toContain('explicit request')
    expect(after).toContain('git push --force-with-lease origin HEAD')
    expect(after).toContain('git branch --show-current')
    expect(after).toContain('<<preflight>>')
    expect(after).toMatch(/Still forbidden.*git stash.*--no-verify/s)
  })

  it('describes the implementer as brief.md does: they can read the spec and the plan', async () => {
    const out = await render('orchestrator', full(SETS.orchestrator!))
    expect(out).not.toContain('ne voit ni la conversation ni la spec')
    expect(out).toContain('The implementer does not see the conversation')
    expect(out).toContain('can read the spec and the plan')
  })

  it('renders the project language, mission_classified and the English plan markers', async () => {
    const out = await render('orchestrator', { ...full(SETS.orchestrator!), language: 'fr' })
    expect(out).toMatch(/\bfr\b/)
    expect(out).toContain('mission_classified')
    expect(out).toContain('### Task <n>: <title>')
    expect(out).toContain('**Test:**')
    expect(out).not.toContain('Tu r\u00e9ponds en fran\u00e7ais')
    expect(out).not.toMatch(/\{\{/)
  })
})

describe('agent prompts', () => {
  it('renders the brief for language fr with the commit-message rule', async () => {
    const out = await render('brief', { ...full(SETS.brief!), language: 'fr' })
    expect(out).toMatch(/\bfr\b/)
    expect(out).toMatch(/commit messages/i)
    expect(out).toMatch(/report in English/i)
    expect(out).not.toMatch(/\{\{/)
  })

  it('renders the PR body with English sections and a task line', async () => {
    const out = await render('pr-body', {
      ...full(SETS['pr-body']!),
      changes: '- Task 1: Export',
    })
    expect(out).toContain('## Context')
    expect(out).toContain('## Changes')
    expect(out).toContain('- Task 1: Export')
    expect(out).toContain('Spec:')
    expect(out).toContain('Plan:')
    expect(out).not.toMatch(/\{\{/)
  })
})
