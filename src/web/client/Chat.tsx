import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatItem } from '../protocol.ts'
import type { ToolAction } from '../transcript.ts'
import { post } from './api.ts'
import { Markdown } from './Markdown.tsx'

const RESULT_LINES = 20

export function Chat({ missionId, items, orchestratorState, onOpenHerdr }: {
  missionId: string
  items: ChatItem[]
  orchestratorState: string | null
  onOpenHerdr: () => void
}) {
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<{ text: string; before: number } | null>(null)
  const [nouveaux, setNouveaux] = useState(false)
  const filRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    const el = areaRef.current
    const pos = caret.current
    if (!el || pos === null) return
    el.selectionStart = pos
    el.selectionEnd = pos
    caret.current = null
  }, [draft])

  useEffect(() => {
    if (!pending) return
    const now = items.filter((item) => item.kind === 'user' && item.text === pending.text).length
    if (now > pending.before) setPending(null)
  }, [items, pending])

  useLayoutEffect(() => {
    const el = filRef.current
    if (!el) return
    if (stick.current) {
      el.scrollTop = el.scrollHeight
      setNouveaux(false)
    } else {
      setNouveaux(true)
    }
  }, [items, pending])

  function onScroll() {
    const el = filRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8
    stick.current = atBottom
    if (atBottom) setNouveaux(false)
  }

  function descendre() {
    const el = filRef.current
    if (!el) return
    stick.current = true
    el.scrollTop = el.scrollHeight
    setNouveaux(false)
  }

  async function send() {
    const texte = draft
    if (texte.trim() === '') return
    const before = items.filter((item) => item.kind === 'user' && item.text === texte).length
    setDraft('')
    setPending({ text: texte, before })
    const res = await post(`/api/missions/${encodeURIComponent(missionId)}/message`, { texte })
    if (!res.ok) {
      setPending((current) => (current?.text === texte ? null : current))
      setDraft((current) => (current === '' ? texte : current))
    }
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (ev.key !== 'Enter') return
    if (ev.shiftKey) {
      ev.preventDefault()
      const el = ev.currentTarget
      const start = el.selectionStart ?? draft.length
      const end = el.selectionEnd ?? draft.length
      caret.current = start + 1
      setDraft(draft.slice(0, start) + '\n' + draft.slice(end))
      return
    }
    ev.preventDefault()
    void send()
  }

  return (
    <div className="chat">
      <div className="fil" ref={filRef} onScroll={onScroll}>
        {items.map((item, index) => (
          <Item key={`${item.kind}:${item.uuid}:${index}`} item={item} onOpenHerdr={onOpenHerdr} />
        ))}
        {pending ? (
          <div className="bulle droite">
            <p>{pending.text}</p>
            <p>en attente</p>
          </div>
        ) : null}
      </div>
      {nouveaux ? (
        <button type="button" className="nouveaux" onClick={descendre}>nouveaux messages ↓</button>
      ) : null}
      <div className="bas">
        {orchestratorState === 'working' ? <p>● l'orchestrateur travaille…</p> : null}
        {orchestratorState === 'blocked' ? (
          <div className="bandeau">
            <p>l'orchestrateur attend une intervention dans herdr</p>
            <button type="button" onClick={onOpenHerdr}>Ouvrir dans herdr</button>
          </div>
        ) : null}
        {orchestratorState === null ? <p>orchestrateur arrêté — Reprendre</p> : null}
        <div className="portes-slot" />
        <form className="saisie" onSubmit={(ev) => ev.preventDefault()}>
          <textarea
            ref={areaRef}
            aria-label="Message"
            value={draft}
            disabled={orchestratorState === null}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={onKeyDown}
          />
        </form>
      </div>
    </div>
  )
}

function Item({ item, onOpenHerdr }: { item: ChatItem; onOpenHerdr: () => void }) {
  if (item.kind === 'user') return <div className="bulle droite"><p>{item.text}</p></div>
  if (item.kind === 'assistant') return <div className="bulle gauche"><Markdown text={item.text} /></div>
  if (item.kind === 'engine') return <p className="moteur">{item.text}</p>
  if (item.kind === 'question') {
    return (
      <div className="question">
        <p>{item.question}</p>
        <ul>
          {item.options.map((option) => <li key={option}>{option}</li>)}
        </ul>
        <button type="button" onClick={onOpenHerdr}>Répondre dans herdr</button>
      </div>
    )
  }
  return <ActionsBlock item={item} />
}

function ActionsBlock({ item }: { item: Extract<ChatItem, { kind: 'actions' }> }) {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const n = item.actions.length
  const label = `▸ ${n} ${n > 1 ? 'actions' : 'action'} — ${item.actions.map((action) => action.summary).join(', ')}`
  return (
    <div className="actions">
      <button type="button" onClick={() => setOpen((value) => !value)}>{label}</button>
      {open ? (
        <ul>
          {item.actions.map((action) => (
            <li key={action.id}>
              <button type="button" onClick={() => setOpened(action.id)}>{action.summary}</button>
              {opened === action.id ? <ActionDetail action={action} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ActionDetail({ action }: { action: ToolAction }) {
  const [all, setAll] = useState(false)
  const result = action.result ?? ''
  const lines = result.split('\n')
  const truncated = !all && lines.length > RESULT_LINES
  const shown = truncated ? lines.slice(0, RESULT_LINES).join('\n') : result
  return (
    <div className="action-detail">
      <pre>{JSON.stringify(action.input, null, 2)}</pre>
      <pre>{shown}</pre>
      {truncated ? <button type="button" onClick={() => setAll(true)}>voir tout</button> : null}
    </div>
  )
}
