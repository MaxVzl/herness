import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { render } from '../../src/prompts/render.js'

const SETS: Record<string, string[]> = {
  orchestrator: ['id', 'demande', 'demandeFile', 'note', 'specPath', 'planPath', 'missionDir'],
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

  it('orchestrator.md mentionne le format « **Test :** » et interdit de valider soi-même', async () => {
    const raw = await readFile(new URL('../../src/prompts/orchestrator.md', import.meta.url), 'utf8')
    expect(raw).toContain('**Test :**')
    expect(raw).toContain('### Tâche <n> : <titre>')
    expect(raw).toMatch(/jamais par toi/)
    expect(raw).toContain('herness valider')
    for (const t of ['statut', 'mission_identifiee', 'demander_validation', 'proposer_amendement', 'demander_arbitrage', 'pause', 'fin_de_pause', 'abandonner']) {
      expect(raw).toContain(t)
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
  it("décrit l'implémenteur comme brief.md : il peut lire la spec et le plan", async () => {
    const out = await render('orchestrator', full(SETS.orchestrator!))
    expect(out).not.toContain('ne voit ni la conversation ni la spec')
    expect(out).toContain("L'implémenteur ne voit pas la conversation")
    expect(out).toContain('peut lire la spec et le plan')
  })
})
