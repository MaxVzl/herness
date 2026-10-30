import { expect, test } from 'vitest'
import { checkAmendment, parsePlan } from '../../src/mission/plan.ts'

const plan = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    `### Tâche ${i + 1} : Titre ${i + 1}\n\nCorps ${i + 1}\n\n**Test :** \`pnpm test t${i + 1}\`\n`).join('\n')

test('lit deux tâches avec titre, commande de test et corps', () => {
  const r = parsePlan(`# Plan\n\nintro\n\n${plan(2)}`)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.tasks).toHaveLength(2)
  expect(r.tasks[0]).toMatchObject({ n: 1, title: 'Titre 1', testCommand: 'pnpm test t1' })
  expect(r.tasks[0]!.body).toContain('Corps 1')
  expect(r.tasks[0]!.body).not.toContain('Corps 2')
})

test('accepte le titre anglais ### Task 1:', () => {
  const r = parsePlan('### Task 1: Hello\n\n**Test :** `pnpm test`\n')
  expect(r.ok && r.tasks[0]).toMatchObject({ n: 1, title: 'Hello', testCommand: 'pnpm test' })
})

test('refuse une tâche sans ligne **Test :**', () => {
  const r = parsePlan('### Tâche 1 : A\n\n**Test :** `x`\n\n### Tâche 2 : B\n\nrien\n')
  expect(r).toEqual({ ok: false, errors: expect.arrayContaining(['Tâche 2 : ligne **Test :** absente']) })
})

test('refuse une numérotation non consécutive', () => {
  const r = parsePlan('### Tâche 1 : A\n**Test :** `x`\n\n### Tâche 2 : B\n**Test :** `y`\n\n### Tâche 4 : D\n**Test :** `z`\n')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.errors.join('\n')).toMatch(/3 attendu/)
})

test('refuse un plan sans tâche', () => {
  const r = parsePlan('# Plan vide\n')
  expect(r.ok).toBe(false)
})

test('checkAmendment accepte l\'ajout d\'une tâche 4 quand 1-3 sont done et inchangées', () => {
  const prev = parsePlan(plan(3))
  const next = parsePlan(plan(4))
  if (!prev.ok) throw new Error('prev')
  expect(checkAmendment(prev.tasks.map((t) => ({ n: t.n, body: t.body })), next)).toEqual({ ok: true })
})

test('checkAmendment refuse la modification du corps de la tâche 2 done', () => {
  const prev = parsePlan(plan(3))
  const next = parsePlan(plan(3).replace('Corps 2', 'Corps modifié'))
  if (!prev.ok) throw new Error('prev')
  const r = checkAmendment(prev.tasks.slice(0, 2).map((t) => ({ n: t.n, body: t.body })), next)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('ajoute une tâche de reprise au lieu de modifier la tâche 2 déjà validée')
})

test('checkAmendment refuse la disparition d\'une tâche done', () => {
  const prev = parsePlan(plan(3))
  const next = parsePlan(plan(1))
  if (!prev.ok) throw new Error('prev')
  expect(checkAmendment([{ n: 3, body: prev.tasks[2]!.body }], next).ok).toBe(false)
})

test('checkAmendment refuse la disparition de la tâche en cours, accepte la modification de son texte', () => {
  const prev = parsePlan(plan(3))
  if (!prev.ok) throw new Error('prev')
  const done = [{ n: 1, body: prev.tasks[0]!.body }]
  const current = { n: 2, body: prev.tasks[1]!.body }
  // Le plan amendé s'arrête à la tâche 1 : la tâche 2 en cours a disparu.
  const gone = parsePlan(plan(1))
  const r = checkAmendment(done, gone, current)
  expect(r).toEqual({ ok: false, reason: 'la tâche 2 en cours a disparu : garde-la sous le numéro 2 (en modifiant son texte si besoin) et ajoute plutôt des tâches' })
  expect(checkAmendment(done, parsePlan(plan(3).replace('Corps 2', 'Corps 2 amendé')), current)).toEqual({ ok: true })
})

test('checkAmendment refuse la renumérotation de la tâche en cours', () => {
  const prev = parsePlan(plan(3))
  if (!prev.ok) throw new Error('prev')
  // Une tâche insérée avant : l'ancienne tâche 2 (en cours), texte inchangé, devient la 3.
  const old2 = plan(2).split('### Tâche 2')[1]!
  const shifted = parsePlan(`${plan(1)}\n### Tâche 2 : Insérée\n\nNouvelle\n\n**Test :** \`pnpm test n\`\n\n### Tâche 3${old2}`)
  const r = checkAmendment([{ n: 1, body: prev.tasks[0]!.body }], shifted, { n: 2, body: prev.tasks[1]!.body })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('la tâche 2 en cours a changé de numéro (3) : garde-la sous le numéro 2 (en modifiant son texte si besoin) et ajoute plutôt des tâches')
})
