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

test('accepte un plan au format anglais', () => {
  const r = parsePlan('# P\n\n' + '### Task 1: Do it\n' + '**Test:** `pnpm test a`\n')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.tasks[0]).toMatchObject({ n: 1, title: 'Do it', testCommand: 'pnpm test a' })
})

test('refuse une tâche sans ligne **Test :**', () => {
  const r = parsePlan('### Tâche 1 : A\n\n**Test :** `x`\n\n### Tâche 2 : B\n\nrien\n')
  expect(r).toEqual({ ok: false, errors: expect.arrayContaining(['Task 2: missing **Test:** line']) })
})

test('refuse une numérotation non consécutive', () => {
  const r = parsePlan('### Tâche 1 : A\n**Test :** `x`\n\n### Tâche 2 : B\n**Test :** `y`\n\n### Tâche 4 : D\n**Test :** `z`\n')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.errors).toEqual(['Task 4: unexpected number, 3 expected'])
})

test('refuse un plan sans tâche', () => {
  const r = parsePlan('# Plan vide\n')
  expect(r).toEqual({ ok: false, errors: ['Plan has no task: no "### Task <n>: <title>" heading'] })
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
  if (!r.ok) expect(r.reason).toBe('Task 2 already validated has changed: add a resumption task instead of modifying task 2 already validated')
})

test('checkAmendment refuse la disparition d\'une tâche done', () => {
  const prev = parsePlan(plan(3))
  const next = parsePlan(plan(1))
  if (!prev.ok) throw new Error('prev')
  expect(checkAmendment([{ n: 3, body: prev.tasks[2]!.body }], next)).toEqual({
    ok: false,
    reason: 'Task 3 already validated has disappeared: add a resumption task instead of modifying task 3 already validated',
  })
})

test('checkAmendment refuse la disparition de la tâche en cours, accepte la modification de son texte', () => {
  const prev = parsePlan(plan(3))
  if (!prev.ok) throw new Error('prev')
  const done = [{ n: 1, body: prev.tasks[0]!.body }]
  const current = { n: 2, body: prev.tasks[1]!.body }
  // Le plan amendé s'arrête à la tâche 1 : la tâche 2 en cours a disparu.
  const gone = parsePlan(plan(1))
  const r = checkAmendment(done, gone, current)
  expect(r).toEqual({
    ok: false,
    reason: 'Task 2 in progress has disappeared: keep it under number 2 (changing its text if needed) and add tasks instead',
  })
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
  if (!r.ok) {
    expect(r.reason).toBe(
      'Task 2 in progress has changed number (3): keep it under number 2 (changing its text if needed) and add tasks instead',
    )
  }
})

test('checkAmendment signale un plan amendé invalide en anglais', () => {
  const r = checkAmendment([], parsePlan('# no task\n'))
  expect(r).toEqual({
    ok: false,
    reason: 'Invalid amended plan: Plan has no task: no "### Task <n>: <title>" heading',
  })
})
