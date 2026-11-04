/** Durée écoulée, en français court : « il y a 4 s », « il y a 1 min 40 », « il y a 2 h ». */
export function ago(fromIso: string, now: Date): string {
  const parsed = Date.parse(fromIso)
  const delta = Number.isNaN(parsed) ? 0 : Math.max(0, Math.floor((now.getTime() - parsed) / 1000))
  if (delta < 60) return `il y a ${delta} s`
  if (delta < 3600) {
    const minutes = Math.floor(delta / 60)
    const secondes = delta % 60
    return secondes === 0 ? `il y a ${minutes} min` : `il y a ${minutes} min ${secondes}`
  }
  return `il y a ${Math.floor(delta / 3600)} h`
}
