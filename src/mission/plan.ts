export type PlanTask = { n: number; title: string; testCommand: string; body: string }
export type ParsedPlan = { ok: true; tasks: PlanTask[] } | { ok: false; errors: string[] }

const TITLE = /^### (?:Tâche|Task) (\d+)\s*[:：]\s*(.+)$/gm
const TEST_LINE = /^\*\*Test :\*\*\s*`([^`\n]+)`/m

function normalize(body: string): string {
  return body.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '')
}

export function parsePlan(markdown: string): ParsedPlan {
  const heads = [...markdown.matchAll(TITLE)]
  if (heads.length === 0) return { ok: false, errors: ['Plan sans tâche : aucun titre « ### Tâche <n> : <titre> »'] }
  const errors: string[] = []
  const tasks: PlanTask[] = []
  heads.forEach((m, i) => {
    const n = Number(m[1])
    const expected = i + 1
    if (n !== expected) errors.push(`Tâche ${n} : numéro inattendu, ${expected} attendu`)
    const start = m.index! + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : markdown.length
    const body = normalize(markdown.slice(start, end))
    const test = TEST_LINE.exec(body)
    if (!test) {
      errors.push(`Tâche ${n} : ligne **Test :** absente`)
      return
    }
    tasks.push({ n, title: m[2]!.trim(), testCommand: test[1]!.trim(), body })
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, tasks }
}

/**
 * Un plan amendé garde les tâches déjà validées (`done`) à l'identique, et la tâche en cours (`current`) sous son
 * numéro : son texte peut changer, mais elle ne peut ni disparaître ni changer de numéro.
 */
export function checkAmendment(
  done: { n: number; body: string }[],
  next: ParsedPlan,
  current?: { n: number; body: string },
): { ok: true } | { ok: false; reason: string } {
  if (!next.ok) return { ok: false, reason: `plan amendé invalide : ${next.errors.join(' ; ')}` }
  for (const d of done) {
    const t = next.tasks.find((x) => x.n === d.n)
    if (!t) {
      return { ok: false, reason: `la tâche ${d.n} déjà validée a disparu : ajoute une tâche de reprise au lieu de modifier la tâche ${d.n} déjà validée` }
    }
    if (normalize(t.body) !== normalize(d.body)) {
      return { ok: false, reason: `la tâche ${d.n} déjà validée a changé : ajoute une tâche de reprise au lieu de modifier la tâche ${d.n} déjà validée` }
    }
  }
  if (current) {
    const keep = `garde-la sous le numéro ${current.n} (en modifiant son texte si besoin) et ajoute plutôt des tâches`
    const same = next.tasks.find((x) => x.n === current.n)
    const moved = next.tasks.find((x) => x.n !== current.n && normalize(x.body) === normalize(current.body))
    if (moved && (!same || normalize(same.body) !== normalize(current.body))) {
      return { ok: false, reason: `la tâche ${current.n} en cours a changé de numéro (${moved.n}) : ${keep}` }
    }
    if (!same) return { ok: false, reason: `la tâche ${current.n} en cours a disparu : ${keep}` }
  }
  return { ok: true }
}
