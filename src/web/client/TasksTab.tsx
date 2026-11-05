import { useState } from 'react'
import type { MissionState, TaskState } from '../../mission/state.ts'
import { FileViewer } from './FileViewer.tsx'

function secondes(ms: number): string {
  const valeur = ms / 1000
  const texte = Number.isInteger(valeur) ? String(valeur) : valeur.toFixed(1).replace('.', ',')
  return `${texte} s`
}

function pastille(task: TaskState, courante: number | undefined, step: string | undefined): string {
  if (task.phase === 'done') return 'faite'
  if (task.phase === 'pending') return 'a-faire'
  if (courante === task.n && step === 'bloquée') return 'echec'
  return 'en-cours'
}

export function TasksTab({ missionId, mission, files }: {
  missionId: string
  mission: MissionState
  files: Record<string, string[]>
}) {
  const [ouverte, setOuverte] = useState<number | null>(null)
  const [chemin, setChemin] = useState<string | null>(null)
  const tasks = mission.tasks
  const courante = tasks.find((task) => task.phase !== 'done' && task.phase !== 'pending')?.n
  const globale = files.global ?? []
  const preflight = files.preflight ?? []
  const resultats = mission.loops.preflight.results

  return (
    <div>
      <ul>
        {tasks.map((task) => {
          const noms = files[`taches/${task.n}`] ?? []
          return (
            <li key={task.n}>
              <button type="button" onClick={() => setOuverte((n) => n === task.n ? null : task.n)}>
                <span className={`pastille ${pastille(task, courante, mission.step)}`} />
                {` ${task.n} · ${task.title} ${task.phase} tour ${task.round}/3`}
              </button>
              {ouverte === task.n ? (
                <ul>
                  {noms.map((nom) => (
                    <li key={nom}>
                      <button type="button" onClick={() => setChemin(`taches/${task.n}/${nom}`)}>{nom}</button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>
      <section aria-label="Revue globale">
        <p>{`tour ${mission.loops.globalReview.round}`}</p>
        <ul>
          {globale.map((nom) => (
            <li key={nom}>
              <button type="button" onClick={() => setChemin(`global/${nom}`)}>{nom}</button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Preflight">
        <p>{`tour ${mission.loops.preflight.round}`}</p>
        <ul>
          {resultats.map((resultat) => (
            <li key={resultat.label}>
              {`${resultat.exitCode === 0 ? '✓' : '✗'} ${resultat.label} ${secondes(resultat.durationMs)}`}
            </li>
          ))}
        </ul>
        <ul>
          {preflight.map((nom) => (
            <li key={nom}>
              <button type="button" onClick={() => setChemin(`preflight/${nom}`)}>{nom}</button>
            </li>
          ))}
        </ul>
      </section>
      {chemin ? <FileViewer missionId={missionId} path={chemin} /> : null}
    </div>
  )
}
