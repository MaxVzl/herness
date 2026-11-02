import { Box, Text, useApp, useInput } from 'ink'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Herdr } from '../herdr/client.ts'
import { loadState, type MissionState } from '../mission/state.ts'
import { realActionDeps } from './actions.ts'
import { HelpLine, MissionDetail, missionActions, useMissionKeys, type MissionActions, type Timer } from './detail.tsx'
import { focusCockpit as realFocusCockpit } from './location.ts'

/** Alias de compatibilité : la vue d'une mission est `MissionDetail`. */
export const TasksView = MissionDetail

/** Panneau `tasks` : le cockpit limité à une mission (mêmes gestes, plus `c` pour revenir au cockpit du projet). */
export function TasksDashboard({
  id,
  load = loadState,
  intervalMs = 1000,
  actions,
  focusCockpit,
  timer,
}: {
  id: string
  load?: (id: string) => Promise<MissionState>
  intervalMs?: number
  actions?: MissionActions
  focusCockpit?: (repoPath: string) => Promise<void>
  timer?: Timer
}): React.ReactElement {
  const { exit } = useApp()
  const [state, setState] = useState<MissionState | undefined>()
  const [unreadable, setUnreadable] = useState(false)
  // Les journaux de herdr vont dans la zone de message : rien n'écrit dans le terminal pendant qu'ink dessine.
  const sayRef = useRef<(text: string, ok?: boolean) => void>(() => {})
  const log = useMemo(() => (m: string): void => sayRef.current(m, false), [])
  const acts = useMemo(() => actions ?? missionActions(realActionDeps(process.cwd(), log)), [actions, log])
  const back = useMemo(
    () => focusCockpit ?? ((repoPath: string) => realFocusCockpit(repoPath, new Herdr(log))),
    [focusCockpit, log],
  )

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

  const keys = useMissionKeys({
    state,
    actions: acts,
    ownPanel: true,
    ...(state ? { onBack: () => back(state.repoPath) } : {}),
    ...(timer ? { timer } : {}),
  })
  sayRef.current = keys.say

  useInput((input) => {
    if (input === 'q') exit()
  }, { isActive: keys.overlay === null })

  return (
    <Box flexDirection="column">
      {state ? <MissionDetail state={state} sentGates={keys.sentGates} {...(keys.selectedGate ? { selectedGate: keys.selectedGate } : {})} /> : <Text>chargement…</Text>}
      {unreadable ? <Text color="red">état illisible, nouvel essai…</Text> : null}
      {keys.overlay ? <Box marginTop={1}>{keys.overlay}</Box> : null}
      {keys.message ? <Text color={keys.messageOk ? 'cyan' : 'red'}>{keys.message}</Text> : null}
      <Box marginTop={1}>
        <HelpLine items={[...keys.helpItems, { key: 'q', label: 'quitter', enabled: true }]} />
      </Box>
    </Box>
  )
}
