import { diffLines } from 'diff'

type Ligne = { kind: 'ajout' | 'retrait' | 'contexte'; text: string }

function unifie(diff: string): Ligne[] {
  const rows = diff.split('\n')
  return rows.map((line, index) => {
    const text = index < rows.length - 1 ? `${line}\n` : line
    if (line.startsWith('+') && !line.startsWith('+++')) return { kind: 'ajout', text }
    if (line.startsWith('-') && !line.startsWith('---')) return { kind: 'retrait', text }
    return { kind: 'contexte', text }
  })
}

export function DiffView({ diff, before, after }: { diff?: string; before?: string; after?: string }) {
  const rows: Ligne[] = diff !== undefined
    ? unifie(diff)
    : before !== undefined || after !== undefined
      ? diffLines(before ?? '', after ?? '').map((part) => ({
          kind: part.added ? 'ajout' : part.removed ? 'retrait' : 'contexte',
          text: part.value,
        }))
      : []
  return (
    <pre className="diff">
      {rows.map((row, index) => (
        <span key={index} className={`diff-${row.kind}`}>{row.text}</span>
      ))}
    </pre>
  )
}
