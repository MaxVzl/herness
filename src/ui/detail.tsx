import { Box, Text, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Gate, MissionState, Step, TaskState } from '../mission/state.ts'
import * as act from './actions.ts'
import type { ActionDeps, ActionResult, Spawner } from './actions.ts'
import { Confirm, NoteInput } from './inputs.tsx'
import { shortId } from './model.ts'

const STEPS_AFTER_REVIEW: Step[] = ['global-review', 'preflight', 'pr', 'pr-ouverte', 'fermée']
const FINISHED: Step[] = ['pr-ouverte', 'fermée']
const MESSAGE_MS = 5000

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

/**
 * Détail d'une mission. `selectedGate` est mise en évidence (aucune marque sans sélection) ; `sentGates` sont les portes
 * encore en attente dont la décision est déjà partie depuis cette interface.
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
          <Text color="yellow" bold inverse={g.id === selected && pending.length > 1}>
            {`${g.id === selected ? '▸' : ' '} ⚑ ${g.id} · ${g.kind} : ${g.summary}`}
            {sentGates.includes(g.id) ? <Text color="cyan" bold={false}>{' · décision envoyée'}</Text> : null}
          </Text>
          {g.path ? <Text color="yellow">{`    ${g.path}`}</Text> : null}
        </Box>
      ))}
      {pending.length > 0 ? (
        <Text color="yellow">{`v valider · r refuser${pending.length > 1 ? ' · ←/→ choisir la porte' : ''}`}</Text>
      ) : null}
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

/** Gestes sur une mission ; `missionActions` les relie aux vraies dépendances, les tests injectent des faux. */
export interface MissionActions {
  validate(id: string, gateId: string, note: string | undefined): Promise<ActionResult>
  refuse(id: string, gateId: string, note: string): Promise<ActionResult>
  resume(id: string): Promise<ActionResult>
  /** `detached` : redémarrage lancé hors de ce processus (depuis le panneau `tasks` de la mission elle-même). */
  restart(id: string, opts?: { detached?: boolean }): Promise<ActionResult>
  close(id: string, confirm: (question: string) => Promise<boolean>): Promise<ActionResult>
  open(s: MissionState): Promise<ActionResult>
}

export function missionActions(d: ActionDeps, spawn?: Spawner, opts: act.ResumeOpts = {}): MissionActions {
  return {
    validate: (id, gateId, note) => act.validate(id, gateId, note, d),
    refuse: (id, gateId, note) => act.refuse(id, gateId, note, d),
    resume: (id) => act.resume(id, d, opts),
    restart: (id, o) => (o?.detached ? act.restartDetached(id, spawn) : act.restart(id, d, opts)),
    close: (id, confirm) => act.close(id, d, confirm),
    open: (s) => act.open(s, d),
  }
}

/** Programme `fn` après `ms` ; rend la fonction d'annulation. Injectable pour les tests. */
export type Timer = (fn: () => void, ms: number) => () => void
const realTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export interface HelpItem { key: string; label: string; enabled: boolean }

type Overlay =
  | { kind: 'confirm'; question: string; onYes: () => void; onNo: () => void }
  | { kind: 'note'; title: string; onSubmit: (note: string) => void }
  | { kind: 'choose'; note: string; gate: Gate }

function Chooser({ onPick, onCancel }: { onPick: (k: 'v' | 'r') => void; onCancel: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) onCancel()
    else if (input === 'v' || input === 'r') onPick(input)
  })
  return <Text color="yellow">v valider · r refuser · échap annuler</Text>
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
  /** Saisie en cours (Confirm, NoteInput, choix v/r) ; tant qu'elle est ouverte, les touches du hook sont inactives. */
  overlay: React.ReactElement | null
  help: string
  helpItems: HelpItem[]
  message?: string
  messageOk: boolean
  selectedGate?: string
  /** Portes de la mission encore en attente dont la décision est partie d'ici (à passer à `MissionDetail`). */
  sentGates: string[]
  /** Affiche un message dans la zone de retour (ex. journal de herdr). */
  say: (text: string, ok?: boolean) => void
}

/**
 * Touches partagées par le cockpit et le panneau `tasks` : ←/→/tab porte, v, r, n, p, R, f, o, et c si `onBack`.
 * Garde anti-doublon par (mission, porte) : rien n'est renvoyé pendant qu'une décision part, et une porte décidée
 * ici est ignorée tant que l'état la montre encore en attente.
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
  /** Vrai dans le panneau `tasks` de la mission : `R` y redémarre en détaché pour ne pas s'interrompre lui-même. */
  ownPanel?: boolean
}): MissionKeys {
  const [overlay, setOverlayState] = useState<Overlay | null>(null)
  // `gate` : clé (mission/porte) du message « gN validée/refusée », effacé quand cette porte est libérée.
  const [message, setMessage] = useState<{ text: string; ok: boolean; gate?: string } | undefined>()
  const [selection, setSelection] = useState<{ mission: string; gate: string } | undefined>()
  const selected = selection && selection.mission === state?.id ? selection.gate : undefined
  // Résolution en attente d'une confirmation demandée par une action (ex. closeMission) : rendue `false` si la
  // saisie est remplacée ou démontée avant la réponse.
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
    const lines = r.ok && success ? [...r.lines, success] : r.lines
    say((lines.length > 0 ? lines : [r.ok ? 'fait' : 'échec']).slice(-5).join('\n'), r.ok, gate)
  }
  const failed = (e: unknown): void => say(e instanceof Error ? e.message : String(e), false)

  useEffect(() => {
    if (!message) return
    return timer(() => setMessage(undefined), MESSAGE_MS)
  }, [message, timer])

  // Une porte décidée ici redevient visible dès que l'état ne la montre plus en attente.
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

  const keyOf = (g: Gate): string => `${state?.id}/${g.id}`
  const gates = state
    ? state.gates.filter((g) => g.status === 'pending' && !inflight.current.has(keyOf(g)) && !decided.current.has(keyOf(g)))
    : []
  const gate = gates.find((g) => g.id === selected) ?? gates[0]
  const sentGates = state
    ? state.gates.filter((g) => g.status === 'pending' && (inflight.current.has(keyOf(g)) || decided.current.has(keyOf(g)))).map((g) => g.id)
    : []
  const finished = state ? FINISHED.includes(state.step) : false

  const send = async (decision: 'approved' | 'refused', g: Gate, note: string | undefined): Promise<void> => {
    if (!state) return
    const id = state.id
    const k = `${id}/${g.id}`
    if (inflight.current.has(k) || decided.current.has(k)) return say(`décision déjà envoyée pour ${g.id}`, false)
    inflight.current.add(k)
    bump((n) => n + 1)
    try {
      const r = decision === 'approved' ? await actions.validate(id, g.id, note) : await actions.refuse(id, g.id, note ?? '')
      if (r.ok) decided.current.add(k)
      show(r, `${g.id} ${decision === 'approved' ? 'validée' : 'refusée'}`, k)
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

  const askDecision = (decision: 'approved' | 'refused', g: Gate, note: string | undefined): void => {
    if (!state) return
    const verb = decision === 'approved' ? 'Valider' : 'Refuser'
    confirmThen(`${verb} ${g.id} (${g.kind}) de ${shortId(state.id)} ?`, () => void send(decision, g, note))
  }

  const runOnce = async (name: string, fn: () => Promise<ActionResult>, success?: string): Promise<void> => {
    if (!state) return
    const k = `${state.id}/${name}`
    if (running.current.has(k)) return say('action déjà en cours', false)
    running.current.add(k)
    try {
      show(await fn(), success)
    } catch (e) {
      failed(e)
    } finally {
      running.current.delete(k)
    }
  }

  const askClose = (s: MissionState): void => {
    confirmThen(`Fermer ${s.id} ?`, () => {
      const confirm = (q: string): Promise<boolean> =>
        new Promise((resolve) => {
          confirmThen(q, () => resolve(true), () => resolve(false))
          pendingAnswer.current = resolve
        })
      void runOnce('close', async () => {
        const r = await actions.close(s.id, confirm)
        return r.ok || r.lines.length > 0 ? r : { ok: false, lines: ['fermeture annulée'] }
      })
    }, () => say('fermeture annulée'))
  }

  useInput((input, key) => {
    if (!state) return
    if (key.tab || key.leftArrow || key.rightArrow) {
      if (gates.length < 2 || !gate) return
      const i = gates.indexOf(gate)
      const step = key.leftArrow || (key.tab && key.shift) ? -1 : 1
      setSelection({ mission: state.id, gate: gates[(i + step + gates.length) % gates.length]!.id })
      return
    }
    switch (input) {
      case 'v':
        if (!gate) return say('aucune porte en attente', false)
        return askDecision('approved', gate, undefined)
      case 'r': {
        if (!gate) return say('aucune porte en attente', false)
        const g = gate
        return setOverlay({
          kind: 'note',
          title: `Note de refus pour ${g.id}`,
          onSubmit: (raw) => {
            const note = raw.trim()
            if (note === '') return say('une note est obligatoire pour refuser', false)
            askDecision('refused', g, note)
          },
        })
      }
      case 'n': {
        if (!gate) return say('aucune porte en attente', false)
        const g = gate
        return setOverlay({ kind: 'note', title: `Note pour ${g.id}`, onSubmit: (note) => setOverlay({ kind: 'choose', note: note.trim(), gate: g }) })
      }
      case 'p':
        if (finished) return say('reprendre indisponible : mission terminée', false)
        return void runOnce('resume', () => actions.resume(state.id), 'reprise demandée')
      case 'R':
        return ownPanel
          ? void runOnce('restart', () => actions.restart(state.id, { detached: true }))
          : void runOnce('restart', () => actions.restart(state.id), 'redémarrage demandé')
      case 'f':
        return askClose(state)
      case 'o':
        return void runOnce('open', () => actions.open(state))
      case 'c':
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
          if (k === 'r' && o.note === '') return say('une note est obligatoire pour refuser', false)
          askDecision(k === 'v' ? 'approved' : 'refused', o.gate, o.note === '' ? undefined : o.note)
        }}
      />
    )
  }

  const helpItems: HelpItem[] = [
    { key: '←/→', label: 'porte', enabled: gates.length > 1 },
    { key: 'v', label: 'valider', enabled: gate !== undefined },
    { key: 'r', label: 'refuser', enabled: gate !== undefined },
    { key: 'n', label: 'note', enabled: gate !== undefined },
    { key: 'p', label: 'reprendre', enabled: !finished },
    { key: 'R', label: 'redémarrer', enabled: true },
    { key: 'f', label: 'fermer', enabled: true },
    { key: 'o', label: 'ouvrir', enabled: true },
    ...(onBack ? [{ key: 'c', label: 'cockpit', enabled: true }] : []),
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
  }
}
