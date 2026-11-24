import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { render } from '../../src/prompts/render.js'

const SETS: Record<string, string[]> = {
  orchestrator: ['id', 'request', 'requestFile', 'note', 'specPath', 'planPath', 'missionDir', 'mainBranch', 'preflight', 'language'],
  brief: ['taskBody', 'specPath', 'planPath', 'testCommand', 'commitFormat', 'forbidden', 'reportPath'],
  review: ['briefPath', 'reportPath', 'baseSha', 'headSha', 'diffPath', 'constraints', 'outPath'],
  rereview: ['briefPath', 'reportPath', 'baseSha', 'headSha', 'diffPath', 'constraints', 'findings', 'outPath'],
  correction: ['findings', 'failure', 'forbidden', 'reportPath'],
  'global-review': ['baseSha', 'headSha', 'diffPath', 'specPath', 'planPath', 'constraints', 'outPath'],
  diagnostic: ['logPath', 'outPath'],
  init: ['repoPath', 'configFile', 'configDir'],
  'pr-body': ['ticket', 'contexte', 'changements', 'tests', 'preflight', 'specFile', 'planFile'],
}

const full = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `<<${k}>>`]))

describe('render', () => {
  it('remplace toutes les clés', async () => {
    const out = await render('diagnostic', full(SETS.diagnostic!))
    expect(out).toContain('<<logPath>>')
    expect(out).toContain('<<outPath>>')
    expect(out).not.toMatch(/\{\{/)
  })

  it('lève en listant les clés manquantes', async () => {
    await expect(render('diagnostic', {})).rejects.toThrow(/logPath.*outPath|outPath.*logPath/)
    await expect(render('diagnostic', { logPath: 'x' })).rejects.toThrow(/outPath/)
  })

  for (const [name, keys] of Object.entries(SETS)) {
    it(`le gabarit ${name} se rend sans erreur avec un jeu complet`, async () => {
      const out = await render(name, full(keys))
      expect(out).not.toMatch(/\{\{/)
      for (const k of keys) expect(out).toContain(`<<${k}>>`)
    })
  }

  it('les gabarits d’implémentation se terminent par la consigne de compte rendu', async () => {
    for (const name of ['brief', 'correction']) {
      const out = await render(name, full(SETS[name]!))
      expect(out.trim()).toMatch(/<<reportPath>>[\s\S]*TERMINÉ`?\.?$/)
    }
  })

  it('les gabarits de revue imposent la première ligne du verdict', async () => {
    for (const name of ['review', 'rereview', 'global-review']) {
      const out = await render(name, full(SETS[name]!))
      expect(out).toContain('VERDICT: APPROUVÉ')
      expect(out).toContain('VERDICT: CORRECTIONS')
      expect(out.trim()).toMatch(/TERMINÉ`?\.?$/)
    }
  })

  it('diagnostic impose la première ligne CAUSE', async () => {
    const out = await render('diagnostic', full(SETS.diagnostic!))
    for (const c of ['BRANCHE', 'MAIN', 'ENVIRONNEMENT']) expect(out).toContain(`CAUSE: ${c}`)
  })

  it('orchestrator.md imposes English plan markers and forbids self-approval', async () => {
    const raw = await readFile(new URL('../../src/prompts/orchestrator.md', import.meta.url), 'utf8')
    expect(raw).toContain('**Test:**')
    expect(raw).toContain('### Task <n>: <title>')
    expect(raw).toMatch(/never by you/)
    expect(raw).toContain('herness approve')
    expect(raw).not.toContain('Tu réponds en français')
    for (const t of ['status', 'mission_classified', 'request_approval', 'propose_amendment', 'request_arbitration', 'pause', 'end_pause', 'abandon', 'report_anomaly']) {
      expect(raw).toContain(t)
    }
    for (const old of ['statut', 'mission_identifiee', 'demander_validation', 'proposer_amendement', 'demander_arbitrage', 'fin_de_pause', 'abandonner', 'signaler_anomalie']) {
      expect(raw).not.toContain(old)
    }
    expect(raw).toContain('[herness]')
  })

  it('correction demande d’ajouter le compte rendu à la fin du fichier, sans l’écraser', async () => {
    const out = await render('correction', full(SETS.correction!))
    expect(out).toContain('Ajoute ce compte rendu à la fin de `<<reportPath>>`')
    expect(out).not.toContain('Écris ce compte rendu dans')
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
    expect(out).not.toContain('Tu réponds en français')
    expect(out).not.toMatch(/\{\{/)
  })
})
