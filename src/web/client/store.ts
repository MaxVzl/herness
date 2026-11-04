import { useEffect, useRef, useState } from 'react'
import type { AgentView, ChatItem, CheckView, DocView, MissionDetail, MissionSummary, ProjectView, ServerEvent } from '../protocol.ts'
import { deliverNotification } from './notifications.ts'

export interface ClientState {
  missions: MissionSummary[]
  hiddenCount: number
  projects: ProjectView[]
  details: Record<string, MissionDetail>
  chats: Record<string, ChatItem[]>
  docs: Record<string, { spec?: DocView; plan?: DocView }>
  agents: Record<string, AgentView[]>
  checks: Record<string, CheckView[]>
  confirmations: { confirmId: string; missionId: string; question: string }[]
  connected: boolean
}

export const initialState: ClientState = {
  missions: [],
  hiddenCount: 0,
  projects: [],
  details: {},
  chats: {},
  docs: {},
  agents: {},
  checks: {},
  confirmations: [],
  connected: false,
}

type ClientEvent = ServerEvent | { type: 'connexion'; connected: boolean } | { type: 'confirmation-traitee'; confirmId: string }

export function reduce(s: ClientState, e: ClientEvent): ClientState {
  switch (e.type) {
    case 'missions':
      return { ...s, missions: e.missions, hiddenCount: e.hiddenCount, projects: e.projects }
    case 'mission':
      return { ...s, details: { ...s.details, [e.id]: e.detail } }
    case 'chat':
      return { ...s, chats: { ...s.chats, [e.id]: e.items } }
    case 'doc':
      return { ...s, docs: { ...s.docs, [e.id]: { ...s.docs[e.id], [e.kind]: e.doc } } }
    case 'agents':
      return { ...s, agents: { ...s.agents, [e.id]: e.agents } }
    case 'checks':
      return { ...s, checks: { ...s.checks, [e.id]: e.checks } }
    case 'confirmation':
      return {
        ...s,
        confirmations: [
          ...s.confirmations.filter((item) => item.confirmId !== e.confirmId),
          { confirmId: e.confirmId, missionId: e.missionId, question: e.question },
        ],
      }
    case 'confirmation-traitee':
      return { ...s, confirmations: s.confirmations.filter((item) => item.confirmId !== e.confirmId) }
    case 'connexion':
      return { ...s, connected: e.connected }
    case 'notification':
      return s
  }
}

function eventsUrl(mission: string | undefined, agents: boolean): string {
  const params = new URLSearchParams()
  if (mission) params.set('mission', mission)
  params.set('agents', agents ? '1' : '0')
  return `/api/evenements?${params.toString()}`
}

/** Rouvre le flux quand l'abonnement change. Chaque `open` remplace l'instantané, sauf les confirmations : le serveur ne les renvoie pas. */
export function useServerEvents(sub: { mission?: string; agents: boolean }, source?: (url: string) => EventSource): ClientState {
  const [state, setState] = useState(initialState)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const mission = sub.mission
  const agents = sub.agents

  useEffect(() => {
    const open = sourceRef.current ?? ((url: string) => new EventSource(url))
    const es = open(eventsUrl(mission, agents))
    es.onopen = () => {
      setState((current) => ({ ...initialState, confirmations: current.confirmations, connected: true }))
    }
    es.onerror = () => {
      setState((current) => reduce(current, { type: 'connexion', connected: false }))
    }
    es.onmessage = (ev) => {
      let event: ServerEvent
      try {
        event = JSON.parse(String(ev.data)) as ServerEvent
      } catch {
        return
      }
      if (event.type === 'notification') deliverNotification(event, mission)
      setState((current) => reduce(current, event))
    }
    return () => {
      es.close()
    }
  }, [mission, agents])

  return state
}
