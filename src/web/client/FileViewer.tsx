import { useEffect, useState } from 'react'
import { getText } from './api.ts'
import { DiffView } from './DiffView.tsx'
import { Markdown } from './Markdown.tsx'

export function FileViewer({ missionId, path }: { missionId: string; path: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let cancel = false
    setText(null)
    const params = new URLSearchParams({ chemin: path })
    void getText(`/api/missions/${encodeURIComponent(missionId)}/fichier?${params}`).then(
      (body) => {
        if (!cancel) setText(body)
      },
      () => {
        if (!cancel) setText('')
      },
    )
    return () => {
      cancel = true
    }
  }, [missionId, path])
  if (text === null) return null
  if (path.endsWith('.md')) return <Markdown text={text} />
  if (path.endsWith('.diff')) return <DiffView diff={text} />
  return <pre>{text}</pre>
}
