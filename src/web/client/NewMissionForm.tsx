import { useId, useState } from 'react'
import type { ProjectView } from '../protocol.ts'
import { post } from './api.ts'

export function NewMissionForm({ projects, defaultProject, onStarted, onCancel }: {
  projects: ProjectView[]
  defaultProject: string
  onStarted: (id: string) => void
  onCancel: () => void
}) {
  const projetId = useId()
  const demandeId = useId()
  const noteId = useId()
  const [projet, setProjet] = useState(defaultProject)
  const [demande, setDemande] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const ready = projet.trim() !== '' && demande.trim() !== '' && !sending

  async function start() {
    if (!ready) return
    setSending(true)
    try {
      const result = await post('/api/missions', { projet, demande, note })
      if (result.ok && result.id) onStarted(result.id)
      else setLines(result.lines)
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={(ev) => { ev.preventDefault(); void start() }}>
      <label htmlFor={projetId}>Projet</label>
      <select id={projetId} aria-label="Projet" value={projet} onChange={(ev) => setProjet(ev.target.value)}>
        <option value="">—</option>
        {projects.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
      <label htmlFor={demandeId}>Demande</label>
      <textarea id={demandeId} aria-label="Demande" value={demande} onChange={(ev) => setDemande(ev.target.value)} />
      <label htmlFor={noteId}>Note</label>
      <textarea id={noteId} aria-label="Note" value={note} onChange={(ev) => setNote(ev.target.value)} />
      {lines.map((line, i) => <p key={i}>{line}</p>)}
      <button type="button" disabled={!ready} onClick={() => void start()}>Démarrer</button>
      <button type="button" onClick={onCancel}>Annuler</button>
    </form>
  )
}
