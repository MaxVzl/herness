import { useEffect, useState } from 'react'
import { getText } from './api.ts'
import { DiffView } from './DiffView.tsx'
import { Markdown } from './Markdown.tsx'

export function FileViewer({ missionId, path }: { missionId: string; path: string }) {
  const [text, setText] = useState<string | null>(null)
  const [erreur, setErreur] = useState(false)
  useEffect(() => {
    let cancel = false
    setText(null)
    setErreur(false)
    const params = new URLSearchParams({ chemin: path })
    void getText(`/api/missions/${encodeURIComponent(missionId)}/fichier?${params}`).then(
      (body) => {
        if (!cancel) setText(body)
      },
      () => {
        if (!cancel) setErreur(true)
      },
    )
    return () => {
      cancel = true
    }
  }, [missionId, path])
  if (erreur) return <p>fichier illisible : serveur injoignable</p>
  if (text === null) return null
  if (path.endsWith('.md')) return <Markdown text={text} />
  if (path.endsWith('.diff')) return <DiffView diff={text} />
  return <pre>{text}</pre>
}
