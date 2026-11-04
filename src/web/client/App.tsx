import { useEffect, useState } from 'react'
import { ConnectionBanner } from './ConnectionBanner.tsx'
import { MissionList } from './MissionList.tsx'
import { useServerEvents } from './store.ts'

function browser() {
  return globalThis as unknown as {
    location: { hash: string }
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  }
}

function missionFromHash(): string | undefined {
  let hash = ''
  try {
    hash = browser().location.hash
  } catch {
    return undefined
  }
  if (!hash.startsWith('#/')) return undefined
  try {
    const id = decodeURIComponent(hash.slice(2))
    return id || undefined
  } catch {
    return undefined
  }
}

export function App({ source }: { source?: (url: string) => EventSource } = {}) {
  const [selected, setSelected] = useState(missionFromHash)
  useEffect(() => {
    const onHash = () => setSelected(missionFromHash())
    const root = browser()
    root.addEventListener('hashchange', onHash)
    return () => root.removeEventListener('hashchange', onHash)
  }, [])

  const select = (id: string) => {
    setSelected(id)
    const next = `#/${encodeURIComponent(id)}`
    try {
      if (browser().location.hash !== next) browser().location.hash = next
    } catch {
      // l'adresse ne peut pas être écrite : la sélection reste en mémoire
    }
  }

  const state = useServerEvents({ mission: selected, agents: false }, source)

  return (
    <div className="shell">
      <section className="missions">
        <ConnectionBanner connected={state.connected} />
        <MissionList state={state} selected={selected} onSelect={select} onNew={() => {}} />
      </section>
      <section className="conversation" />
      <section className="contexte" />
    </div>
  )
}
