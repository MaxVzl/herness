import { Box, Text, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Gate, MissionState, Step, TaskState } from '../mission/state.ts'
import * as act from './actions.ts'
import type { ActionDeps, ActionResult, Spawner } from './actions.ts'
import { Confirm, NoteInput } from './inputs.tsx'
import { shortId } from './model.ts'

const STEPS_AFTER_REVIEW: Step[] = ['global-review', 'preflight', 'pr', 'pr-open', 'closed']
const FINISHED: Step[] = ['pr-open', 'closed']
const MESSAGE_MS = 5000
const SUCCESS_LINES = 5
const FAILURE_LINES = 8

/**
 * Lines shown for an action result. Success: the last 5 (plus `success`). Failure: the
 * "KO …" lines and the final error (otherwise the last lines), 8 at most.
 */
export function resultLines(r: ActionResult, success?: string): string[] {
  const lines = r.ok && success ? [...r.lines, success] : r.lines
  if (lines.length === 0) return [r.ok ? 'done' : 'failed']
  if (r.ok) return lines.slice(-SUCCESS_LINES)
  const last = lines[lines.length - 1]!
  const kos = lines.slice(0, -1).filter((l) => /^KO\b/.test(l))
  return kos.length > 0 ? [...kos.slice(-(FAILURE_LINES - 1)), last] : lines.slice(-FAILURE_LINES)
}

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
  if (t?.pendingAsk) parts.push(`waiting for ${t.pendingAsk.agent}`)
  if (t?.implementer) parts.push(`implementer ${t.implementer}`)
  if (t?.reviewer) parts.push(`reviewer ${t.reviewer}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Mission detail. `selectedGate` is highlighted (no mark without a selection); `sentGates` are the gates
 * still pending whose decision has already been sent from this interface.
 */
export function MissionDetail({ state: s, selectedGate, sentGates = [] }: {
  state: MissionState
  selectedGate?: string
  sentGates?: readonly string[]
}): React.ReactElement {
  const cur = currentTask(s)
  const agents = agentsLine(s)
  const pending = s.gates.filter((g) => g.status === 'pending')
  const selected = pending.some((g) => g.id === selectedGate) ? selectedGate : undefined
  const showReview = s.step === 'blocked' ? s.blockedFrom !== undefined && STEPS_AFTER_REVIEW.includes(s.blockedFrom) : STEPS_AFTER_REVIEW.includes(s.step)
  const gr = s.loops.globalReview
  const pf = s.loops.preflight
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{`${s.id} · ${s.branch ?? '(no branch)'} · ${s.step}`}</Text>
        {s.paused ? <Text color="yellow">{' · PAUSED'}</Text> : null}
        {s.step === 'blocked' && s.blockedReason ? <Text color="red">{` · ${s.blockedReason}`}</Text> : null}
      </Text>
      {s.tasks.map((t) => (
        <Text key={t.n}>
          {t.phase === 'done' ? (
            <Text color="green">{`✓ ${t.n}. ${t.title}`}</Text>
          ) : t === cur ? (
            <Text color="cyan">{`▶ ${t.n}. ${t.title} — ${t.phase}, round ${t.round}/3`}</Text>
          ) : (
            <Text dimColor>{`· ${t.n}. ${t.title}`}</Text>
          )}
        </Text>
      ))}
      {agents ? <Text>{`Agents: ${agents}`}</Text> : null}
      {pending.map((g) => (
        <Box key={g.id} flexDirection="column" marginTop={1}>
          <Text color="yellow" bold inverse={g.id === selected && pending.length > 1}>
            {`${g.id === selected ? '▸' : ' '} ⚑ ${g.id} · ${g.kind}: ${g.summary}`}
            {sentGates.includes(g.id) ? <Text color="cyan" bold={false}>{' · decision sent'}</Text> : null}
          </Text>
          {g.path ? <Text color="yellow">{`    ${g.path}`}</Text> : null}
        </Box>
      ))}
      {pending.length > 0 ? (
        <Text color="yellow">{`a approve · r reject${pending.length > 1 ? ' · ←/→ choose gate' : ''}`}</Text>
      ) : null}
      {showReview ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{`Global review: round ${gr.round}/3 · Preflight: round ${pf.round}/3`}</Text>
          {pf.results.map((r) => (
            <Text key={r.label} color={r.exitCode === 0 ? 'green' : 'red'}>
              {`  ${r.label} ${r.exitCode === 0 ? '✓' : '✗'} (${duration(r.durationMs)})`}
            </Text>
          ))}
        </Box>
      ) : null}
      {s.prUrl ? <Text color="green">{`PR: ${s.prUrl}`}</Text> : null}
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

/** Gestures on a mission; `missionActions` wires them to the real dependencies, tests inject fakes. */
export interface MissionActions {
  validate(id: string, gateId: string, note: string | undefined): Promise<ActionResult>
  refuse(id: string, gateId: string, note: string): Promise<ActionResult>
  resume(id: string): Promise<ActionResult>
  /** `detached`: restart launched outside this process (from the mission's own `tasks` panel). */
  restart(id: string, opts?: { detached?: boolean }): Promise<ActionResult>
  close(id: string, confirm: (question: string) => Promise<boolean>): Promise<ActionResult>
  open(s: MissionState): Promise<ActionResult>
  /** Deletes a closed mission's directory (confirmation already done). */
  remove(id: string): Promise<ActionResult>
}

export function missionActions(d: ActionDeps, spawn?: Spawner, opts: act.ResumeOpts = {}): MissionActions {
  return {
    validate: (id, gateId, note) => act.validate(id, gateId, note, d),
    refuse: (id, gateId, note) => act.refuse(id, gateId, note, d),
    resume: (id) => act.resume(id, d, opts),
    restart: (id, o) => (o?.detached ? act.restartDetached(id, spawn) : act.restart(id, d, opts)),
    close: (id, confirm) => act.close(id, d, confirm),
    open: (s) => act.open(s, d),
    remove: (id) => act.remove(id, d),
  }
}

/** Schedules `fn` after `ms`; returns the cancel function. Injectable for tests. */
export type Timer = (fn: () => void, ms: number) => () => void
const realTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export interface HelpItem { key: string; label: string; enabled: boolean }

/** Gestures refused during a close: they open an input or start an action. */
const GESTURES = new Set(['a', 'r', 'n', 'u', 'R', 'c', 'o', 'D'])

type Overlay =
  | { kind: 'confirm'; question: string; onYes: () => void; onNo: () => void }
  | { kind: 'note'; title: string; onSubmit: (note: string) => void }
  // Mission captured when opened: the choice always targets this one, even if the selection changed since.
  | { kind: 'choose'; note: string; gate: Gate; mission: MissionState }

function Chooser({ onPick, onCancel }: { onPick: (k: 'a' | 'r') => void; onCancel: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) onCancel()
    else if (input === 'a' || input === 'r') onPick(input)
  })
  return <Text color="yellow">a approve · r reject · esc cancel</Text>
}

export function HelpLine({ items }: { items: HelpItem[] }): React.ReactElement {
  return (
    <Box flexWrap="wrap">
      {items.map((it, i) => (
        <Text key={it.key} wrap="truncate" dimColor={!it.enabled}>{`${i > 0 ? ' · ' : ''}${it.key} ${it.label}`}</Text>
      ))}
    </Box>
  )
}

export interface MissionKeys {
  /** Input in progress (Confirm, NoteInput, a/r choice); while it is open, the hook keys are inactive. */
  overlay: React.ReactElement | null
  help: string
  helpItems: HelpItem[]
  message?: string
  messageOk: boolean
  selectedGate?: string
  /** Gates of the mission still pending whose decision was sent from here (pass them to `MissionDetail`). */
  sentGates: string[]
  /** Shows a message in the result area (for example a herdr log). */
  say: (text: string, ok?: boolean) => void
  /** A close is in progress and may ask for confirmation: no other input should open. */
  busy: boolean
}

/**
 * Keys shared by the cockpit and the `tasks` panel: ←/→/tab gate, a, r, n, u, R, c, o, D (not on the `tasks` panel),
 * and b if `onBack`.
 * Dedup guard per (mission, gate): nothing is sent again while a decision is in flight, and a gate decided
 * here is ignored while the state still shows it pending.
 */
export function useMissionKeys({
  state,
  actions,
  onMessage,
  onBack,
  isActive = true,
  timer = realTimer,
  ownPanel = false,
}: {
  state: MissionState | undefined
  actions: MissionActions
  onMessage?: (text: string) => void
  onBack?: () => Promise<void> | void
  isActive?: boolean
  timer?: Timer
  /** True in the mission's `tasks` panel: `R` restarts detached there so it does not interrupt itself. */
  ownPanel?: boolean
}): MissionKeys {
  const [overlay, setOverlayState] = useState<Overlay | null>(null)
  // `gate`: (mission/gate) key of the "gN approved/rejected" message, cleared when that gate is released.
  const [message, setMessage] = useState<{ text: string; ok: boolean; gate?: string } | undefined>()
  const [selection, setSelection] = useState<{ mission: string; gate: string } | undefined>()
  const selected = selection && selection.mission === state?.id ? selection.gate : undefined
  // Pending resolution of a confirmation asked by an action (for example closeMission): resolved `false` if the
  // input is replaced or unmounted before the answer.
  const pendingAnswer = useRef<((yes: boolean) => void) | null>(null)
  const abandonAnswer = (): void => {
    const resolve = pendingAnswer.current
    pendingAnswer.current = null
    resolve?.(false)
  }
  const setOverlay = (o: Overlay | null): void => {
    abandonAnswer()
    setOverlayState(o)
  }
  useEffect(() => abandonAnswer, [])
  const [, bump] = useState(0)
  const inflight = useRef(new Set<string>())
  const decided = useRef(new Set<string>())
  const running = useRef(new Set<string>())
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const say = useCallback((text: string, ok = true, gate?: string): void => {
    setMessage({ text, ok, ...(gate ? { gate } : {}) })
    onMessageRef.current?.(text)
  }, [])

  const show = (r: ActionResult, success?: string, gate?: string): void => {
    say(resultLines(r, success).join('\n'), r.ok, gate)
  }
  const failed = (e: unknown): void => say(e instanceof Error ? e.message : String(e), false)

  // A success clears after 5 s; an error stays until the next action or key.
  useEffect(() => {
    if (!message?.ok) return
    return timer(() => setMessage(undefined), MESSAGE_MS)
  }, [message, timer])
  // Declared before the gestures: a key clears the shown error, then its gesture may show another.
  useInput(() => {
    setMessage((m) => (m && !m.ok ? undefined : m))
  })

  // A gate decided here becomes visible again as soon as the state no longer shows it pending.
  useEffect(() => {
    if (!state) return
    const stillPending = new Set(state.gates.filter((g) => g.status === 'pending').map((g) => `${state.id}/${g.id}`))
    const released = new Set<string>()
    for (const k of [...decided.current]) {
      if (k.startsWith(`${state.id}/`) && !stillPending.has(k)) {
        decided.current.delete(k)
        released.add(k)
      }
    }
    if (released.size > 0) setMessage((m) => (m?.gate && released.has(m.gate) ? undefined : m))
  }, [state])

  // Close in progress (whichever mission): it may open a confirmation at any time.
  const busy = [...running.current].some((k) => k.endsWith('/close'))
  const keyOf = (g: Gate): string => `${state?.id}/${g.id}`
  const gates = state
    ? state.gates.filter((g) => g.status === 'pending' && !inflight.current.has(keyOf(g)) && !decided.current.has(keyOf(g)))
    : []
  const gate = gates.find((g) => g.id === selected) ?? gates[0]
  const sentGates = state
    ? state.gates.filter((g) => g.status === 'pending' && (inflight.current.has(keyOf(g)) || decided.current.has(keyOf(g)))).map((g) => g.id)
    : []
  const finished = state ? FINISHED.includes(state.step) : false

  const send = async (decision: 'approved' | 'refused', id: string, g: Gate, note: string | undefined): Promise<void> => {
    const k = `${id}/${g.id}`
    if (inflight.current.has(k) || decided.current.has(k)) return say(`decision already sent for ${g.id}`, false)
    inflight.current.add(k)
    bump((n) => n + 1)
    try {
      const r = decision === 'approved' ? await actions.validate(id, g.id, note) : await actions.refuse(id, g.id, note ?? '')
      if (r.ok) decided.current.add(k)
      show(r, `${g.id} ${decision === 'approved' ? 'approved' : 'rejected'}`, k)
    } catch (e) {
      failed(e)
    } finally {
      inflight.current.delete(k)
      bump((n) => n + 1)
    }
  }

  const confirmThen = (question: string, onYes: () => void, onNo: () => void = () => {}): void => {
    const answered = (fn: () => void) => (): void => {
      pendingAnswer.current = null
      setOverlay(null)
      fn()
    }
    setOverlay({ kind: 'confirm', question, onYes: answered(onYes), onNo: answered(onNo) })
  }

  const askDecision = (decision: 'approved' | 'refused', s: MissionState, g: Gate, note: string | undefined): void => {
    const verb = decision === 'approved' ? 'Approve' : 'Reject'
    confirmThen(`${verb} ${g.id} (${g.kind}) of ${shortId(s.id)}?`, () => void send(decision, s.id, g, note))
  }

  const runOnce = async (name: string, fn: () => Promise<ActionResult>, success?: string): Promise<void> => {
    if (!state) return
    const k = `${state.id}/${name}`
    if (running.current.has(k)) return say('action already running', false)
    running.current.add(k)
    bump((n) => n + 1)
    try {
      show(await fn(), success)
    } catch (e) {
      failed(e)
    } finally {
      running.current.delete(k)
      bump((n) => n + 1)
    }
  }

  const askClose = (s: MissionState): void => {
    confirmThen(`Close ${s.id}?`, () => {
      const confirm = (q: string): Promise<boolean> =>
        new Promise((resolve) => {
          confirmThen(q, () => resolve(true), () => resolve(false))
          pendingAnswer.current = resolve
        })
      void runOnce('close', async () => {
        const r = await actions.close(s.id, confirm)
        return r.ok || r.lines.length > 0 ? r : { ok: false, lines: ['close cancelled'] }
      })
    }, () => say('close cancelled'))
  }

  useInput((input, key) => {
    if (!state) return
    // A close may still ask for confirmation: no other input may cross it.
    if (busy && GESTURES.has(input)) return say('action in progress', false)
    if (key.tab || key.leftArrow || key.rightArrow) {
      if (gates.length < 2 || !gate) return
      const i = gates.indexOf(gate)
      const step = key.leftArrow || (key.tab && key.shift) ? -1 : 1
      setSelection({ mission: state.id, gate: gates[(i + step + gates.length) % gates.length]!.id })
      return
    }
    switch (input) {
      case 'a':
        if (!gate) return say('no pending gate', false)
        return askDecision('approved', state, gate, undefined)
      case 'r': {
        if (!gate) return say('no pending gate', false)
        const g = gate
        const s = state
        return setOverlay({
          kind: 'note',
          title: `Rejection note for ${g.id}`,
          onSubmit: (raw) => {
            const note = raw.trim()
            if (note === '') return say('a note is required to reject', false)
            askDecision('refused', s, g, note)
          },
        })
      }
      case 'n': {
        if (!gate) return say('no pending gate', false)
        const g = gate
        const s = state
        return setOverlay({ kind: 'note', title: `Note for ${g.id}`, onSubmit: (note) => setOverlay({ kind: 'choose', note: note.trim(), gate: g, mission: s }) })
      }
      case 'u':
        if (finished) return say('resume unavailable: mission finished', false)
        return void runOnce('resume', () => actions.resume(state.id), 'resume requested')
      case 'R':
        return ownPanel
          ? void runOnce('restart', () => actions.restart(state.id, { detached: true }))
          : void runOnce('restart', () => actions.restart(state.id), 'restart requested')
      case 'c':
        return askClose(state)
      case 'o':
        return void runOnce('open', () => actions.open(state))
      case 'D': {
        // The `tasks` panel disappears with its closed mission: delete is done from the cockpit.
        if (ownPanel) return
        if (state.step !== 'closed') return say('delete unavailable: close the mission first (c)', false)
        const id = state.id
        return confirmThen(
          `Permanently delete ${id} (state, spec, plan, logs)?`,
          () => void runOnce('remove', () => actions.remove(id)),
          () => say('delete cancelled'),
        )
      }
      case 'b':
        if (!onBack) return
        return void Promise.resolve()
          .then(() => onBack())
          .catch(failed)
    }
  }, { isActive: isActive && overlay === null })

  let element: React.ReactElement | null = null
  if (overlay?.kind === 'confirm') {
    element = <Confirm key={`c:${overlay.question}`} question={overlay.question} onYes={overlay.onYes} onNo={overlay.onNo} />
  } else if (overlay?.kind === 'note') {
    element = (
      <Box key={`n:${overlay.title}`} flexDirection="column">
        <Text color="yellow">{overlay.title}</Text>
        <NoteInput onSubmit={overlay.onSubmit} onCancel={() => setOverlay(null)} />
      </Box>
    )
  } else if (overlay?.kind === 'choose') {
    const o = overlay
    element = (
      <Chooser
        key="choose"
        onCancel={() => setOverlay(null)}
        onPick={(k) => {
          if (k === 'r' && o.note === '') return say('a note is required to reject', false)
          askDecision(k === 'a' ? 'approved' : 'refused', o.mission, o.gate, o.note === '' ? undefined : o.note)
        }}
      />
    )
  }

  const helpItems: HelpItem[] = [
    { key: '←/→', label: 'gate', enabled: gates.length > 1 },
    { key: 'a', label: 'approve', enabled: gate !== undefined },
    { key: 'r', label: 'reject', enabled: gate !== undefined },
    { key: 'n', label: 'note', enabled: gate !== undefined },
    { key: 'u', label: 'resume', enabled: !finished },
    { key: 'R', label: 'restart', enabled: true },
    { key: 'c', label: 'close', enabled: true },
    { key: 'o', label: 'open', enabled: true },
    ...(ownPanel ? [] : [{ key: 'D', label: 'delete', enabled: state?.step === 'closed' }]),
    ...(onBack ? [{ key: 'b', label: 'cockpit', enabled: true }] : []),
  ]
  const help = helpItems.map((it) => (it.enabled ? `${it.key} ${it.label}` : `(${it.key} ${it.label})`)).join(' · ')

  return {
    overlay: element,
    help,
    helpItems,
    ...(message ? { message: message.text } : {}),
    messageOk: message?.ok ?? true,
    ...(gate ? { selectedGate: gate.id } : {}),
    sentGates,
    say: (text, ok) => say(text, ok),
    busy,
  }
}
