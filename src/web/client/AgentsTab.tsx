import { useEffect, useState } from 'react'
import type { Gate } from '../../mission/state.ts'
import type { AgentView } from '../protocol.ts'
import { getText } from './api.ts'
import { ago } from './ago.ts'

/** Le moteur ouvre la porte avec `Agent <nom> (<rôle>) bloqué…` puis la sortie. Le nom n'est reconnu qu'à ce préfixe. */
export function agentAmbre(agent: AgentView, gates: Gate[]): boolean {
  if (agent.state === 'blocked') return true
  const prefixe = `Agent ${agent.name} (`
  return gates.some((gate) => gate.kind === 'agent-bloque' && gate.status === 'pending' && gate.summary.startsWith(prefixe))
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function AgentsTab({ missionId, agents, gates }: {
  missionId: string
  agents: AgentView[]
  gates: Gate[]
}) {
  const now = useNow()
  const [deplies, setDeplies] = useState<string[]>([])
  const [sortieDe, setSortieDe] = useState<string | null>(null)
  const [sortie, setSortie] = useState('')
  const [sortieIllisible, setSortieIllisible] = useState(false)

  useEffect(() => {
    if (!sortieDe) return
    let cancel = false
    const url = `/api/missions/${encodeURIComponent(missionId)}/agents/${encodeURIComponent(sortieDe)}/sortie?lignes=400`
    const load = () => {
      void getText(url).then(
        (text) => {
          if (!cancel) {
            setSortie(text)
            setSortieIllisible(false)
          }
        },
        () => {
          if (!cancel) setSortieIllisible(true)
        },
      )
    }
    load()
    const id = setInterval(load, 1000)
    return () => {
      cancel = true
      clearInterval(id)
    }
  }, [missionId, sortieDe])

  return (
    <div>
      {agents.map((agent) => {
        const replie = agent.state === 'done' && !deplies.includes(agent.name)
        const ambre = agentAmbre(agent, gates)
        const classes = ['agent']
        if (replie) classes.push('replie')
        if (ambre) classes.push('ambre')
        const ouverte = sortieDe === agent.name
        return (
          <article key={agent.name} aria-label={agent.name} className={classes.join(' ')}>
            <p>{agent.role}</p>
            {agent.task !== undefined ? <p>{`tâche ${agent.task}`}</p> : null}
            <p>{agent.tool}</p>
            <p>{agent.state ?? ''}</p>
            {replie ? (
              <button type="button" onClick={() => setDeplies((noms) => [...noms, agent.name])}>Déplier</button>
            ) : (
              <>
                {agent.lastActivityAt ? <p>{`dernière activité ${ago(agent.lastActivityAt, now)}`}</p> : null}
                <pre>{agent.tail}</pre>
                <button
                  type="button"
                  onClick={() => {
                    setSortie('')
                    setSortieIllisible(false)
                    setSortieDe(ouverte ? null : agent.name)
                  }}
                >
                  {ouverte ? 'Masquer la sortie' : 'Voir toute la sortie'}
                </button>
                {ouverte ? (
                  <>
                    {sortieIllisible ? <p>sortie illisible : serveur injoignable</p> : null}
                    <pre>{sortie}</pre>
                  </>
                ) : null}
              </>
            )}
          </article>
        )
      })}
    </div>
  )
}
