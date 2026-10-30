import { Box, Text, useApp, useInput } from 'ink'
import React, { useEffect, useRef, useState } from 'react'
import { decide as realDecide } from '../engine/gates.ts'
import { loadState, type Gate, type MissionState, type Step, type TaskState } from '../mission/state.ts'

const STEPS_AFTER_REVIEW: Step[] = ['global-review', 'preflight', 'pr', 'pr-ouverte', 'fermée']

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

function currentTask(s: MissionState): TaskState | undefined {
  return s.tasks.find((t) => t.phase !== 'done' && t.phase !== 'pending')
}

function agentsLine(s: MissionState): string | undefined {
  const t = currentTask(s)
  const parts: string[] = []
  if (t?.pendingAsk) parts.push(`en attente de ${t.pendingAsk.agent}`)
  if (t?.implementer) parts.push(`implémenteur ${t.implementer}`)
  if (t?.reviewer) parts.push(`relecteur ${t.reviewer}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function oldestPendingGate(s: MissionState, skip: ReadonlySet<string> = new Set()): Gate | undefined {
  return s.gates.find((g) => g.status === 'pending' && !skip.has(g.id))
}

export function TasksView({ state: s }: { state: MissionState }): React.ReactElement {
  const cur = currentTask(s)
  const agents = agentsLine(s)
  const pending = s.gates.filter((g) => g.status === 'pending')
  const showReview = s.step === 'bloquée' ? s.blockedFrom !== undefined && STEPS_AFTER_REVIEW.includes(s.blockedFrom) : STEPS_AFTER_REVIEW.includes(s.step)
  const gr = s.loops.globalReview
  const pf = s.loops.preflight
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{`${s.id} · ${s.branch ?? '(pas de branche)'} · ${s.step}`}</Text>
        {s.paused ? <Text color="yellow">{' · EN PAUSE'}</Text> : null}
        {s.step === 'bloquée' && s.blockedReason ? <Text color="red">{` · ${s.blockedReason}`}</Text> : null}
      </Text>
      {s.tasks.map((t) => (
        <Text key={t.n}>
          {t.phase === 'done' ? (
            <Text color="green">{`✓ ${t.n}. ${t.title}`}</Text>
          ) : t === cur ? (
            <Text color="cyan">{`▶ ${t.n}. ${t.title} — ${t.phase}, tour ${t.round}/3`}</Text>
          ) : (
            <Text dimColor>{`· ${t.n}. ${t.title}`}</Text>
          )}
        </Text>
      ))}
      {agents ? <Text>{`Agents : ${agents}`}</Text> : null}
      {pending.map((g) => (
        <Box key={g.id} flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>{`⚑ ${g.id} · ${g.kind} : ${g.summary}`}</Text>
          {g.path ? <Text color="yellow">{`  ${g.path}`}</Text> : null}
        </Box>
      ))}
      {pending.length > 0 ? <Text color="yellow">v valider · r refuser</Text> : null}
      {showReview ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{`Revue globale : tour ${gr.round}/3 · Preflight : tour ${pf.round}/3`}</Text>
          {pf.results.map((r) => (
            <Text key={r.label} color={r.exitCode === 0 ? 'green' : 'red'}>
              {`  ${r.label} ${r.exitCode === 0 ? '✓' : '✗'} (${duration(r.durationMs)})`}
            </Text>
          ))}
        </Box>
      ) : null}
      {s.prUrl ? <Text color="green">{`PR : ${s.prUrl}`}</Text> : null}
      {s.log.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {s.log.slice(-5).map((l, i) => (
            <Text key={i} dimColor>{l.msg}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

type DecideFn = typeof realDecide

export function TasksDashboard({
  id,
  decide = realDecide,
  load = loadState,
  intervalMs = 1000,
}: {
  id: string
  decide?: DecideFn
  load?: (id: string) => Promise<MissionState>
  intervalMs?: number
}): React.ReactElement {
  const { exit } = useApp()
  const [state, setState] = useState<MissionState | undefined>()
  const [unreadable, setUnreadable] = useState(false)
  const [note, setNote] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const stateRef = useRef<MissionState | undefined>(undefined)
  stateRef.current = state
  const busy = useRef(false)
  // Portes déjà décidées depuis ce tableau, tant que le moteur ne les a pas consommées.
  const decided = useRef(new Set<string>())

  useEffect(() => {
    if (!state) return
    const stillPending = new Set(state.gates.filter((g) => g.status === 'pending').map((g) => g.id))
    let gone = false
    for (const gid of [...decided.current]) {
      if (!stillPending.has(gid)) {
        decided.current.delete(gid)
        gone = true
      }
    }
    if (gone) setMessage(undefined)
  }, [state])

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(undefined), 5000)
    return () => clearTimeout(t)
  }, [message])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const s = await load(id)
        if (!alive) return
        setState(s)
        setUnreadable(false)
      } catch {
        if (alive) setUnreadable(true)
      }
    }
    void poll()
    const t = setInterval(() => void poll(), intervalMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [id, load, intervalMs])

  const post = async (decision: 'approved' | 'refused', gate: Gate, noteText?: string): Promise<void> => {
    busy.current = true
    try {
      await decide(id, decision, {
        gateId: gate.id,
        ...(noteText !== undefined ? { note: noteText } : {}),
        isTTY: true,
        confirm: async () => true,
      })
      decided.current.add(gate.id)
      setMessage(`décision envoyée : ${gate.id} ${decision === 'approved' ? 'validée' : 'refusée'}`)
    } catch (e) {
      setMessage(`échec : ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }

  useInput((input, key) => {
    const gate = stateRef.current ? oldestPendingGate(stateRef.current, decided.current) : undefined
    if (note !== undefined) {
      if (key.escape) {
        setNote(undefined)
      } else if (key.return) {
        const text = note.trim()
        if (!text) {
          setMessage('note obligatoire : refuser exige un motif')
        } else if (gate && !busy.current) {
          setNote(undefined)
          void post('refused', gate, text)
        } else {
          setNote(undefined)
          setMessage('aucune porte en attente')
        }
      } else if (key.backspace || key.delete) {
        setNote(note.slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setNote(note + input)
      }
      return
    }
    if (input === 'q') exit()
    else if ((input === 'v' || input === 'r') && busy.current) return
    else if (input === 'v') {
      if (gate) void post('approved', gate)
      else setMessage('aucune porte en attente')
    } else if (input === 'r') {
      if (gate) {
        setMessage(undefined)
        setNote('')
      } else setMessage('aucune porte en attente')
    }
  })

  return (
    <Box flexDirection="column">
      {state ? <TasksView state={state} /> : <Text>chargement…</Text>}
      {unreadable ? <Text color="red">état illisible, nouvel essai…</Text> : null}
      {note !== undefined ? <Text color="yellow">{`Note de refus (Entrée valide, Échap annule) : ${note}▌`}</Text> : null}
      {message ? <Text color="cyan">{message}</Text> : null}
    </Box>
  )
}
