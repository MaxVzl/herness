import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { missionDir } from '../paths.ts'

/**
 * Un amendement est proposé HORS du worktree : l'orchestrateur écrit le plan amendé complet dans
 * `<missionDir>/plan.proposed.md` (et, s'il amende la spec, `<missionDir>/spec.proposed.md`). Le worktree n'est
 * modifié que par le moteur, quand aucun agent n'a de consigne en cours, après validation par l'utilisateur.
 */
export const proposedPlanPath = (id: string): string => join(missionDir(id), 'plan.proposed.md')
export const proposedSpecPath = (id: string): string => join(missionDir(id), 'spec.proposed.md')

/** Hachage qui lie la validation au contenu proposé (plan, et spec s'il y en a une). */
export function proposalHash(plan: string, spec?: string): string {
  const h = createHash('sha256').update(plan)
  if (spec !== undefined) h.update('\0spec\0').update(spec)
  return h.digest('hex')
}

export type Proposal = { plan: string; spec?: string; hash: string }

/** La proposition en cours, ou `null` sans `plan.proposed.md`. */
export async function readProposal(id: string): Promise<Proposal | null> {
  let plan: string
  try {
    plan = await readFile(proposedPlanPath(id), 'utf8')
  } catch {
    return null
  }
  const spec = await readFile(proposedSpecPath(id), 'utf8').catch(() => undefined)
  return { plan, ...(spec !== undefined ? { spec } : {}), hash: proposalHash(plan, spec) }
}
