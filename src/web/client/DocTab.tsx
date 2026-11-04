import { useState } from 'react'
import type { DocView } from '../protocol.ts'
import { DiffView } from './DiffView.tsx'
import { Markdown } from './Markdown.tsx'

export function DocTab({ doc }: { doc?: DocView }) {
  const [differences, setDifferences] = useState(false)
  if (!doc) return null
  if (doc.source === 'absent') return <p>{doc.reason}</p>
  const proposition = doc.source === 'proposition'
  return (
    <div>
      {proposition ? (
        <>
          <p>Proposition d'amendement en attente</p>
          <button type="button" aria-pressed={!differences} onClick={() => setDifferences(false)}>Proposition</button>
          <button type="button" aria-pressed={differences} onClick={() => setDifferences(true)}>Différences avec la version actuelle</button>
        </>
      ) : null}
      {doc.source === 'approuve' ? <p>plan validé (worktree supprimé)</p> : null}
      {proposition && differences
        ? <DiffView before={doc.current ?? ''} after={doc.text} />
        : <Markdown text={doc.text} />}
    </div>
  )
}
