import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { missionDir } from '../paths.ts'

/**
 * An amendment is proposed OUTSIDE the worktree: the orchestrator writes the full amended plan to
 * `<missionDir>/plan.proposed.md` (and, when it amends the spec, `<missionDir>/spec.proposed.md`). The worktree
 * is modified only by the engine, when no agent has a brief in progress, after the user approves.
 */
export const proposedPlanPath = (id: string): string => join(missionDir(id), 'plan.proposed.md')
export const proposedSpecPath = (id: string): string => join(missionDir(id), 'spec.proposed.md')

/** Hash that binds the approval to the proposed content (plan, and spec when there is one). */
export function proposalHash(plan: string, spec?: string): string {
  const h = createHash('sha256').update(plan)
  if (spec !== undefined) h.update('\0spec\0').update(spec)
  return h.digest('hex')
}

export type Proposal = { plan: string; spec?: string; hash: string }

/** The current proposal, or `null` when there is no `plan.proposed.md`. */
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
