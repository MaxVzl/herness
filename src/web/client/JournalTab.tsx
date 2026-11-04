function heure(at: string): string {
  const match = /(\d{2}):(\d{2})/.exec(at)
  return match ? `${match[1]}:${match[2]}` : at
}

export function JournalTab({ log }: { log: { at: string; msg: string }[] }) {
  const entrees = [...log].reverse()
  return (
    <ol className="journal">
      {entrees.map((entree) => (
        <li key={`${entree.at}\u0000${entree.msg}`}>
          <time dateTime={entree.at}>{heure(entree.at)}</time>
          {' '}
          {entree.msg}
        </li>
      ))}
    </ol>
  )
}
