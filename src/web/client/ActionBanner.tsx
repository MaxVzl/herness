import { useEffect, useState } from 'react'
import type { ActionResponse } from '../protocol.ts'

/** Les 8 dernières lignes : le motif d'échec est en queue, comme dans le cockpit. */
export function ActionBanner({ result }: { result: ActionResponse | null }) {
  const [hidden, setHidden] = useState<ActionResponse | null>(null)
  useEffect(() => {
    if (!result?.ok) return
    const timer = setTimeout(() => setHidden(result), 5000)
    return () => clearTimeout(timer)
  }, [result])
  if (!result || result.lines.length === 0 || hidden === result) return null
  const lines = result.lines.slice(-8)
  return (
    <div role="status">
      <ul>
        {lines.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
      </ul>
      {result.ok ? null : <button type="button" onClick={() => setHidden(result)}>✕</button>}
    </div>
  )
}
