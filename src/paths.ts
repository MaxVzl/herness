import { homedir } from 'node:os'
import { join } from 'node:path'

export function missionsRoot(): string {
  const home = process.env.HERNESS_HOME ?? join(homedir(), '.local', 'state', 'herness')
  return join(home, 'missions')
}

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function missionDir(id: string): string {
  if (!MISSION_ID.test(id)) throw new Error(`identifiant de mission invalide : « ${id} »`)
  return join(missionsRoot(), id)
}

function docPath(dir: string, s: { id: string; slug?: string; createdAt: string }): string {
  if (!s.slug) throw new Error(`mission ${s.id} : slug non défini`)
  const d = new Date(s.createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `docs/superpowers/${dir}/${date}-${s.id}-${s.slug}.md`
}

// Chemins relatifs au worktree.
export function specPath(s: { id: string; slug?: string; createdAt: string }): string {
  return docPath('specs', s)
}

export function planPath(s: { id: string; slug?: string; createdAt: string }): string {
  return docPath('plans', s)
}
