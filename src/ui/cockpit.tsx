import { basename } from 'node:path'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { MissionState } from '../mission/state.ts'
import * as act from './actions.ts'
import type { ActionResult } from './actions.ts'
import { HelpLine, MissionDetail, missionActions, useMissionKeys, type HelpItem, type MissionActions, type Timer } from './detail.tsx'
import { LineInput } from './inputs.tsx'
import { bucketOf, isHidden, projectMissions, shortId, sortMissions, statusLabel, type Bucket, type PrInfo } from './model.ts'
import { PrCache } from './pr-cache.ts'

/** Gestes du cockpit : ceux d'une mission, plus le démarrage d'une nouvelle mission. */
export interface CockpitActions extends MissionActions {
  startNew(input: string): Promise<ActionResult>
}

/** Ce que le cockpit utilise du cache des PR (injectable pour les tests). */
export interface PrLookup {
  get(url: string): PrInfo | undefined
  refresh(urls: string[]): Promise<void>
}

const NARROW_COLUMNS = 100
const NEW_MISSION_LABEL = 'Lien Wrike, issue GitHub ou texte :'

const BUCKET_COLOR: Record<Bucket, string | undefined> = {
  decision: 'yellow',
  bloquee: 'red',
  active: undefined,
  terminee: 'gray',
}

/** Couleur du statut d'une ligne : décision ambre, bloquée rouge, active normale, terminée grisée. */
export function rowColor(s: MissionState): string | undefined {
  return BUCKET_COLOR[bucketOf(s)]
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

function visibleMissions(all: MissionState[], pr: Pick<PrLookup, 'get'>, now: Date, showAll: boolean): MissionState[] {
  if (showAll) return all
  return all.filter((s) => !isHidden(s, s.prUrl ? pr.get(s.prUrl) : undefined, now))
}

function Title({ name, all }: { name: string; all: MissionState[] }): React.ReactElement {
  const active = all.filter((s) => bucketOf(s) !== 'terminee').length
  const gates = all.reduce((n, s) => n + s.gates.filter((g) => g.status === 'pending').length, 0)
  return (
    <Text>
      <Text bold>{`herness · ${name} · ${plural(active, 'mission active', 'missions actives')}`}</Text>
      {gates > 0 ? <Text color="yellow">{` · ${plural(gates, 'porte en attente', 'portes en attente')}`}</Text> : null}
    </Text>
  )
}

function MissionRow({ s, selected }: { s: MissionState; selected: boolean }): React.ReactElement {
  const bucket = bucketOf(s)
  const color = rowColor(s)
  return (
    <Text wrap="truncate" bold={selected}>
      {`${selected ? '▸' : ' '} ${shortId(s.id)} ${s.slug ?? s.source.ref} `}
      <Text {...(color ? { color } : {})}>{statusLabel(s)}</Text>
      {bucket === 'terminee' && s.prUrl ? <Text color="gray">{` ${s.prUrl}`}</Text> : null}
    </Text>
  )
}

/** Mise en page du cockpit : titre, liste à gauche (au-dessus si étroit), détail à droite, puis bas d'écran. */
function CockpitLayout({ name, all, visible, selected, columns, hiddenCount, detail, footer }: {
  name: string
  all: MissionState[]
  visible: MissionState[]
  selected: MissionState | undefined
  columns: number
  hiddenCount: number
  detail: React.ReactNode
  footer?: React.ReactNode
}): React.ReactElement {
  const narrow = columns < NARROW_COLUMNS
  const list = (
    <Box flexDirection="column" {...(narrow ? {} : { width: '40%', paddingRight: 1 })}>
      {visible.length === 0 ? <Text dimColor>aucune mission</Text> : null}
      {visible.map((s) => <MissionRow key={s.id} s={s} selected={s === selected} />)}
      {hiddenCount > 0 ? <Text dimColor>{`${plural(hiddenCount, 'mission terminée masquée', 'missions terminées masquées')} (a)`}</Text> : null}
    </Box>
  )
  return (
    <Box flexDirection="column" width={columns}>
      <Title name={name} all={all} />
      <Box flexDirection={narrow ? 'column' : 'row'} marginTop={1}>
        {list}
        <Box flexDirection="column" {...(narrow ? { marginTop: 1 } : { width: '60%' })}>{detail}</Box>
      </Box>
      {footer}
    </Box>
  )
}

/** Une seule image du cockpit (hors TTY) : missions masquées filtrées, première mission détaillée. */
export function CockpitSnapshot({ name, missions, prCache, now = new Date(), columns = 80 }: {
  name: string
  missions: MissionState[]
  prCache: Pick<PrLookup, 'get'>
  now?: Date
  columns?: number
}): React.ReactElement {
  const all = sortMissions(missions)
  const visible = visibleMissions(all, prCache, now, false)
  const selected = visible[0]
  return (
    <CockpitLayout
      name={name}
      all={all}
      visible={visible}
      selected={selected}
      columns={columns}
      hiddenCount={all.length - visible.length}
      detail={selected ? <MissionDetail state={selected} /> : null}
    />
  )
}

export function Cockpit({
  repoPath,
  name = basename(repoPath),
  load,
  prCache,
  actions,
  now = () => new Date(),
  intervalMs = 1000,
  timer,
  columns,
}: {
  repoPath: string
  name?: string
  load?: () => Promise<MissionState[]>
  prCache?: PrLookup
  actions?: CockpitActions
  now?: () => Date
  intervalMs?: number
  timer?: Timer
  columns?: number
}): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [all, setAll] = useState<MissionState[]>([])
  const [loaded, setLoaded] = useState(false)
  const [unreadable, setUnreadable] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [showAll, setShowAll] = useState(false)
  const [adding, setAdding] = useState(false)
  const starting = useRef(false)
  const [, bump] = useState(0)

  // Journaux de herdr et du cycle de vie : dans la zone de message, jamais directement dans le terminal.
  const sayRef = useRef<(text: string, ok?: boolean) => void>(() => {})
  const log = useMemo(() => (m: string): void => sayRef.current(m, false), [])
  const acts = useMemo<CockpitActions>(() => {
    if (actions) return actions
    const deps = act.realActionDeps(repoPath, log)
    return { ...missionActions(deps), startNew: (input) => act.startNew(input, deps) }
  }, [actions, repoPath, log])
  const prs = useMemo<PrLookup>(() => prCache ?? new PrCache(), [prCache])
  const read = useMemo(() => load ?? (() => projectMissions(repoPath)), [load, repoPath])

  // Relectures : une seule à la fois, et seul le résultat le plus récent est appliqué (numéro de séquence).
  const polling = useRef(false)
  const seq = useRef(0)
  const applied = useRef(0)
  // Rafraîchissement des PR : jamais relancé tant que le précédent tourne.
  const refreshing = useRef(false)
  const showAllRef = useRef(showAll)
  showAllRef.current = showAll

  useEffect(() => {
    let alive = true
    const refreshPrs = (list: MissionState[]): void => {
      if (refreshing.current) return
      const urls = [...new Set(visibleMissions(list, prs, now(), showAllRef.current).flatMap((s) =>
        (s.prUrl && prs.get(s.prUrl)?.state !== 'MERGED' ? [s.prUrl] : [])))]
      if (urls.length === 0) return
      refreshing.current = true
      const done = (): void => {
        refreshing.current = false
        if (alive) bump((n) => n + 1)
      }
      try {
        // Sans attendre : le cache limite les appels à gh ; on redessine quand il a répondu.
        void Promise.resolve(prs.refresh(urls)).then(done, done)
      } catch {
        // échec du rafraîchissement des PR : sans rapport avec la lecture des missions
        done()
      }
    }
    const poll = async (): Promise<void> => {
      if (polling.current) return
      polling.current = true
      const mine = ++seq.current
      try {
        const list = sortMissions(await read())
        if (!alive || mine <= applied.current) return
        applied.current = mine
        setAll(list)
        setLoaded(true)
        setUnreadable(false)
        refreshPrs(list)
      } catch {
        if (alive) setUnreadable(true)
      } finally {
        polling.current = false
      }
    }
    void poll()
    const t = setInterval(() => void poll(), intervalMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [read, prs, intervalMs])

  const visible = visibleMissions(all, prs, now(), showAll)
  const selected = visible.find((s) => s.id === selectedId) ?? visible[0]
  // La sélection est épinglée à un identifiant dès qu'une ligne existe : un réordonnancement ne change jamais la cible.
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected?.id, selectedId])

  const keys = useMissionKeys({
    state: selected,
    actions: acts,
    isActive: !adding,
    ...(timer ? { timer } : {}),
  })
  sayRef.current = keys.say

  const startNew = (raw: string): void => {
    setAdding(false)
    const input = raw.trim()
    if (input === '') return keys.say('demande vide : rien à démarrer', false)
    if (starting.current) return keys.say('démarrage déjà en cours', false)
    starting.current = true
    keys.say('démarrage de la mission…')
    void acts
      .startNew(input)
      .then(
        (r) => keys.say((r.lines.length > 0 ? r.lines : [r.ok ? 'mission lancée' : 'échec']).slice(-5).join('\n'), r.ok),
        (e: unknown) => keys.say(e instanceof Error ? e.message : String(e), false),
      )
      .finally(() => { starting.current = false })
  }

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      if (visible.length === 0) return
      const i = selected ? visible.indexOf(selected) : 0
      const next = key.upArrow ? Math.max(0, i - 1) : Math.min(visible.length - 1, i + 1)
      setSelectedId(visible[next]!.id)
      return
    }
    if (input === '+') return setAdding(true)
    if (input === 'a') return setShowAll((v) => !v)
    if (input === 'q') exit()
  }, { isActive: !adding && keys.overlay === null })

  const helpItems: HelpItem[] = [
    { key: '↑/↓', label: 'mission', enabled: visible.length > 1 },
    ...(selected ? keys.helpItems : []),
    { key: '+', label: 'nouvelle mission', enabled: true },
    { key: 'a', label: showAll ? 'masquer les terminées' : 'tout afficher', enabled: true },
    { key: 'q', label: 'quitter', enabled: true },
  ]

  const footer = (
    <Box flexDirection="column">
      {unreadable ? <Text color="red">lecture des missions impossible, nouvel essai…</Text> : null}
      {adding ? (
        <Box marginTop={1}>
          <LineInput label={NEW_MISSION_LABEL} onSubmit={startNew} onCancel={() => setAdding(false)} />
        </Box>
      ) : null}
      {keys.overlay ? <Box marginTop={1}>{keys.overlay}</Box> : null}
      {keys.message ? <Text color={keys.messageOk ? 'cyan' : 'red'}>{keys.message}</Text> : null}
      <Box marginTop={1}>
        <HelpLine items={helpItems} />
      </Box>
    </Box>
  )

  return (
    <CockpitLayout
      name={name}
      all={all}
      visible={visible}
      selected={selected}
      columns={columns ?? (stdout as NodeJS.WriteStream).columns ?? 80}
      hiddenCount={all.length - visible.length}
      detail={
        selected ? (
          <MissionDetail state={selected} sentGates={keys.sentGates} {...(keys.selectedGate ? { selectedGate: keys.selectedGate } : {})} />
        ) : loaded ? null : <Text>chargement…</Text>
      }
      footer={footer}
    />
  )
}
