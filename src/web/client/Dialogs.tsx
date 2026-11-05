import { useEffect, useRef, useState } from 'react'

function editableTarget(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: string } | null)?.tagName
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function ConfirmDialog({ question, onYes, onNo }: {
  question: string
  onYes: () => void
  onNo: () => void
}) {
  const done = useRef(false)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (done.current) return
      if (ev.key !== 'Enter' && ev.key !== 'Escape') return
      // Le bouton ou le champ qui a le focus gère déjà Entrée (activation, retour à la ligne).
      if (ev.key === 'Enter' && editableTarget(ev.target)) return
      done.current = true
      if (ev.key === 'Enter') onYes()
      else onNo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onYes, onNo])
  return (
    <div role="dialog" aria-label={question}>
      <p>{question}</p>
      <button type="button" onClick={onYes}>Oui</button>
      <button type="button" onClick={onNo}>Non</button>
    </div>
  )
}

export function NoteDialog({ title, required, onSubmit, onCancel }: {
  title: string
  required: boolean
  onSubmit: (note: string) => void
  onCancel: () => void
}) {
  const [note, setNote] = useState('')
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const blocked = required && note.trim() === ''
  return (
    <div role="dialog" aria-label={title}>
      <p>{title}</p>
      <textarea aria-label={title} value={note} onChange={(ev) => setNote(ev.target.value)} />
      <button type="button" disabled={blocked} onClick={() => { if (!blocked) onSubmit(note) }}>Valider</button>
      <button type="button" onClick={onCancel}>Annuler</button>
    </div>
  )
}
