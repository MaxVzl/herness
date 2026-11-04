function heure(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

export function JournalTab({ log }: { log: { at: string; msg: string }[] }) {
  const entrees = [...log].reverse()
  return (
    <ol className="journal">
      {entrees.map((entree, index) => (
        <li key={index}>
          <time dateTime={entree.at}>{heure(entree.at)}</time>
          {' '}
          {entree.msg}
        </li>
      ))}
    </ol>
  )
}
