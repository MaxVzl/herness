import { useEffect, useState } from 'react'
import type { CheckView } from '../protocol.ts'
import { ago } from './ago.ts'
import { FileViewer } from './FileViewer.tsx'

export function checkRecentRouge(checks: CheckView[]): boolean {
  let recent: CheckView | undefined
  for (const item of checks) {
    if (!recent || item.startedAt > recent.startedAt) recent = item
  }
  return recent?.status === 'rouge'
}

function secondes(ms: number): string {
  const valeur = ms / 1000
  const texte = Number.isInteger(valeur) ? String(valeur) : valeur.toFixed(1).replace('.', ',')
  return `${texte} s`
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function ChecksTab({ missionId, checks, preflight, results }: {
  missionId: string
  checks: CheckView[]
  preflight: string[]
  results: { label: string; exitCode: number; durationMs: number }[]
}) {
  const now = useNow()
  const [journal, setJournal] = useState<string | null>(null)

  return (
    <div>
      {checks.map((item) => (
        <article key={item.file} aria-label={item.label} className="check">
          <p>{item.label}</p>
          <p>{item.status}</p>
          <p>{secondes(item.durationMs)}</p>
          {item.status === 'en-cours' ? <p>{`dernière sortie ${ago(item.lastOutputAt, now)}`}</p> : null}
          {item.status === 'rouge' && item.errorTail ? <pre>{item.errorTail}</pre> : null}
          <button type="button" onClick={() => setJournal(`logs/${item.file}`)}>Voir tout le journal</button>
        </article>
      ))}
      <section aria-label="Preflight">
        <ul>
          {preflight.map((label) => {
            const resultat = results.find((item) => item.label === label)
            if (!resultat) return <li key={label} className="gris">{`${label} pas lancé`}</li>
            const marque = resultat.exitCode === 0 ? '✓' : '✗'
            return <li key={label}>{`${marque} ${label} ${secondes(resultat.durationMs)}`}</li>
          })}
        </ul>
      </section>
      {journal ? <FileViewer missionId={missionId} path={journal} /> : null}
    </div>
  )
}
