export type PlanTask = { n: number; title: string; testCommand: string; body: string }
export type ParsedPlan = { ok: true; tasks: PlanTask[] } | { ok: false; errors: string[] }

const TITLE = /^### (?:Tâche|Task) (\d+)\s*[:：]\s*(.+)$/gm
const TEST_LINE = /^\*\*Test ?:\*\*\s*`([^`\n]+)`/m

function normalize(body: string): string {
  return body.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '')
}

export function parsePlan(markdown: string): ParsedPlan {
  const heads = [...markdown.matchAll(TITLE)]
  if (heads.length === 0) return { ok: false, errors: ['Plan has no task: no "### Task <n>: <title>" heading'] }
  const errors: string[] = []
  const tasks: PlanTask[] = []
  heads.forEach((m, i) => {
    const n = Number(m[1])
    const expected = i + 1
    if (n !== expected) errors.push(`Task ${n}: unexpected number, ${expected} expected`)
    const start = m.index! + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : markdown.length
    const body = normalize(markdown.slice(start, end))
    const test = TEST_LINE.exec(body)
    if (!test) {
      errors.push(`Task ${n}: missing **Test:** line`)
      return
    }
    tasks.push({ n, title: m[2]!.trim(), testCommand: test[1]!.trim(), body })
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, tasks }
}

/**
 * An amended plan keeps tasks already validated (`done`) unchanged, and the current task (`current`) under its
 * number: its text may change, but it can neither disappear nor change number.
 */
export function checkAmendment(
  done: { n: number; body: string }[],
  next: ParsedPlan,
  current?: { n: number; body: string },
): { ok: true } | { ok: false; reason: string } {
  if (!next.ok) return { ok: false, reason: `Invalid amended plan: ${next.errors.join('; ')}` }
  for (const d of done) {
    const t = next.tasks.find((x) => x.n === d.n)
    if (!t) {
      return { ok: false, reason: `Task ${d.n} already validated has disappeared: add a resumption task instead of modifying task ${d.n} already validated` }
    }
    if (normalize(t.body) !== normalize(d.body)) {
      return { ok: false, reason: `Task ${d.n} already validated has changed: add a resumption task instead of modifying task ${d.n} already validated` }
    }
  }
  if (current) {
    const keep = `keep it under number ${current.n} (changing its text if needed) and add tasks instead`
    const same = next.tasks.find((x) => x.n === current.n)
    const moved = next.tasks.find((x) => x.n !== current.n && normalize(x.body) === normalize(current.body))
    if (moved && (!same || normalize(same.body) !== normalize(current.body))) {
      return { ok: false, reason: `Task ${current.n} in progress has changed number (${moved.n}): ${keep}` }
    }
    if (!same) return { ok: false, reason: `Task ${current.n} in progress has disappeared: ${keep}` }
  }
  return { ok: true }
}
