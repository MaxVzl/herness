import { useEffect, useState } from 'react'

export function ConnectionBanner({ connected }: { connected: boolean }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (connected) {
      setShow(false)
      return
    }
    const timer = setTimeout(() => setShow(true), 2000)
    return () => clearTimeout(timer)
  }, [connected])
  if (!show) return null
  return <p className="connexion" role="status">connexion perdue, reconnexion…</p>
}
