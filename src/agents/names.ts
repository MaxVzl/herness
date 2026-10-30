import { createHash } from 'node:crypto'

/** Longueur maximale d'un nom d'agent herdr (`[a-z][a-z0-9_-]{0,31}`). */
const MAX = 32

/**
 * Nom d'agent accepté par herdr : minuscules, tout autre caractère que `[a-z0-9_-]` remplacé par `-`, une lettre en
 * tête, 32 caractères au plus. Un nom tronqué prend un suffixe de hachage du nom d'origine : il reste unique.
 */
export function agentName(raw: string): string {
  let n = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  if (!/^[a-z]/.test(n)) n = `a${n}`
  if (n.length > MAX) {
    const h = createHash('sha256').update(raw).digest('hex').slice(0, 8)
    n = `${n.slice(0, MAX - h.length - 1)}-${h}`
  }
  return n
}

/** Génération des boucles revue globale / preflight : `-g<n>` à partir de la deuxième. */
const gen = (name: string, generation: number): string => agentName(generation > 1 ? `${name}-g${generation}` : name)

export const orchestratorName = (id: string): string => agentName(`o${id}`)
export const implName = (id: string, n: number): string => agentName(`c${id}-t${n}`)
export const strongName = (id: string, n: number): string => agentName(`c${id}-t${n}b`)
export const reviewerName = (id: string, n: number): string => agentName(`r${id}-t${n}`)
export const globalReviewerName = (id: string, generation: number): string => gen(`rg${id}`, generation)
export const globalFixerName = (id: string, generation: number, round: number): string => gen(`cg${id}-${round}`, generation)
export const diagnosticName = (id: string, generation: number, n: number): string => gen(`rd${id}-${n}`, generation)
export const preflightFixerName = (id: string, generation: number, round: number): string => gen(`cp${id}-${round}`, generation)
