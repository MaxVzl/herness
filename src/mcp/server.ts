import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadProjectConfig } from '../config/project.ts'
import { errorLogPath, logHernessError } from '../errlog.ts'
import { proposedPlanPath, proposedSpecPath, readProposal } from '../mission/amendment.ts'
import { postInbox } from '../mission/inbox.ts'
import { checkAmendment, parsePlan } from '../mission/plan.ts'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'
import { hernessCommand } from '../update.ts'
import { VERSION } from '../version.ts'

const SLUG = /^[a-z0-9]+(-[a-z0-9]+){1,5}$/

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

async function readPlan(s: MissionState): Promise<{ md: string } | { error: string }> {
  if (!s.worktree) return { error: 'Worktree not created yet.' }
  const abs = join(s.worktree, planPath(s))
  try {
    return { md: await readFile(abs, 'utf8') }
  } catch {
    return { error: `Plan not found: write it at ${abs} before requesting approval.` }
  }
}

/** Absolute path of a document in the worktree (relative when the worktree does not exist yet). */
const inWorktree = (s: MissionState, rel: string): string => (s.worktree ? join(s.worktree, rel) : rel)

function summarize(s: MissionState): string {
  const current = s.tasks.find((t) => t.phase !== 'done')
  const pending = s.gates.filter((g) => g.status === 'pending')
  return [
    `Step: ${s.step}${s.blockedReason ? ` (blocked: ${s.blockedReason})` : ''}`,
    `Current task: ${current ? `${current.n} "${current.title}" (phase ${current.phase}, round ${current.round})` : 'none'}`,
    `Rounds: global review ${s.loops.globalReview.round}, preflight ${s.loops.preflight.round}`,
    `Pending gates: ${pending.length === 0 ? 'none' : pending.map((g) => `${g.kind} (${g.summary})`).join('; ')}`,
    `PR: ${s.prUrl ?? 'none'}`,
  ].join('\n')
}

// An internal exception becomes an error result, never a raw technical message.
function guard<A extends unknown[]>(id: string, tool: string, fn: (...a: A) => Promise<ToolResult>): (...a: A) => Promise<ToolResult> {
  return async (...a) => {
    try {
      return await fn(...a)
    } catch (e) {
      await logHernessError({ mission: id, origin: `MCP tool ${tool}` }, e)
      return fail(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// No tool here decides a gate: only the user approves or rejects.
export function buildServer(id: string): McpServer {
  const server = new McpServer({ name: 'herness', version: VERSION })

  server.registerTool('status', { description: 'Mission summary: step, current task, rounds, pending gates, PR.' }, guard(id, 'status', async () =>
    ok(summarize(await loadState(id)))))

  server.registerTool(
    'mission_classified',
    {
      description: 'Declares the work type and the mission slug once the request is understood.',
      inputSchema: { type: z.string(), slug: z.string() },
    },
    guard(id, 'mission_classified', async ({ type, slug }) => {
      const s = await loadState(id)
      const config = await loadProjectConfig(s.repoPath)
      const types = Object.keys(config.branchPrefixes)
      if (!types.includes(type)) return fail(`Unknown type "${type}": choose one of ${types.join(', ')}.`)
      if (!SLUG.test(slug)) return fail(`Invalid slug "${slug}": 2 to 6 lowercase words or digits separated by hyphens (e.g. add-csv-export).`)
      await postInbox(id, { type: 'classified', workType: type, slug })
      const named = { ...s, slug }
      return ok(`Mission classified: ${type} / ${slug}.\nSpec: ${inWorktree(s, specPath(named))}\nPlan: ${inWorktree(s, planPath(named))}`)
    }),
  )

  server.registerTool(
    'request_approval',
    {
      description: 'Asks the user to approve the spec or the plan (once written in the worktree; the engine commits it after approval).',
      inputSchema: { kind: z.enum(['spec', 'plan']), summary: z.string() },
    },
    guard(id, 'request_approval', async ({ kind, summary }) => {
      const s = await loadState(id)
      if (kind === 'spec') {
        const rel = specPath(s)
        if (!s.worktree) return fail('Worktree not created yet.')
        try {
          await access(join(s.worktree, rel))
        } catch {
          return fail(`Spec not found: write it at ${join(s.worktree, rel)} before requesting approval.`)
        }
        await postInbox(id, { type: 'request-gate', kind, summary, path: rel })
        return ok('Spec approval requested from the user.')
      }
      const plan = await readPlan(s)
      if ('error' in plan) return fail(plan.error)
      const parsed = parsePlan(plan.md)
      if (!parsed.ok) return fail(`Invalid plan, fix it and ask again:\n- ${parsed.errors.join('\n- ')}`)
      await postInbox(id, { type: 'request-gate', kind, summary, path: planPath(s) })
      return ok('Plan approval requested from the user.')
    }),
  )

  server.registerTool(
    'propose_amendment',
    {
      description:
        'Proposes an amendment to the user: the full amended plan written to plan.proposed.md in the mission folder (and the amended spec in spec.proposed.md if needed), never in the worktree. Tasks already approved must not change.',
      inputSchema: { summary: z.string() },
    },
    guard(id, 'propose_amendment', async ({ summary }) => {
      const s = await loadState(id)
      const proposal = await readProposal(id)
      if (!proposal) return fail(`Proposed plan not found: write the full amended plan at ${proposedPlanPath(id)}.`)
      let approved: ReturnType<typeof parsePlan>
      try {
        approved = parsePlan(await readFile(join(missionDir(id), 'plan.approved.md'), 'utf8'))
      } catch {
        return fail('Approved plan not found: cannot check tasks already approved.')
      }
      if (!approved.ok) return fail(`Approved plan is invalid, cannot check tasks already approved: ${approved.errors.join('; ')}`)
      const done = approved.tasks.filter((t) => s.tasks.some((x) => x.n === t.n && x.phase === 'done')).map((t) => ({ n: t.n, body: t.body }))
      const cur = s.tasks.find((t) => t.phase !== 'done' && t.phase !== 'pending')
      const curBody = cur && approved.tasks.find((t) => t.n === cur.n)
      const check = checkAmendment(done, parsePlan(proposal.plan), curBody ? { n: curBody.n, body: curBody.body } : undefined)
      if (!check.ok) return fail(`Amendment refused: ${check.reason}`)
      const full = proposal.spec !== undefined ? `${summary}\nProposed spec: ${proposedSpecPath(id)}` : summary
      await postInbox(id, { type: 'request-gate', kind: 'amendment', summary: full, path: proposedPlanPath(id), hash: proposal.hash })
      return ok('Amendment submitted to the user. Do not change the proposal: any change after the request gets it rejected.')
    }),
  )

  server.registerTool(
    'request_arbitration',
    {
      description: 'Asks the user to arbitrate: a review remark that contradicts the plan, or any decision they must make.',
      inputSchema: { summary: z.string() },
    },
    guard(id, 'request_arbitration', async ({ summary }) => {
      await postInbox(id, { type: 'request-gate', kind: 'arbitration', summary })
      return ok('Arbitration requested from the user.')
    }),
  )

  server.registerTool('pause', { description: "Pauses the engine (at the user's request). Does not block or unblock anything." }, guard(id, 'pause', async () => {
    await postInbox(id, { type: 'pause' })
    return ok('Pause requested.')
  }))
  server.registerTool(
    'end_pause',
    {
      description:
        'Ends a pause requested with `pause`, and nothing else. Does NOT resume a blocked mission: only the user resumes it (herness resume <id> then approval), or unblocks it by approving an amendment.',
    },
    guard(id, 'end_pause', async () => {
      const s = await loadState(id)
      await postInbox(id, { type: 'resume' })
      const note =
        s.step === 'blocked'
          ? ` The mission stays blocked: only the user resumes it (herness resume ${id} then approval), or unblocks it by approving an amendment.`
          : ''
      return ok(`End of pause requested.${note}`)
    }),
  )
  server.registerTool(
    'abandon',
    { description: 'Requests abandoning the mission: opens a gate that only the user approves.', inputSchema: { reason: z.string() } },
    guard(id, 'abandon', async ({ reason }) => {
      await postInbox(id, { type: 'abandon', reason })
      return ok('Abandon requested: gate submitted to the user, nothing is closed until they approve it.')
    }),
  )

  server.registerTool(
    'report_anomaly',
    {
      description:
        'Reports a herness anomaly observed without an error (inconsistent engine, message that contradicts status, tool that does not do what it claims). Never for a normal mission failure.',
      inputSchema: { description: z.string() },
    },
    guard(id, 'report_anomaly', async ({ description }) => {
      if (!description.trim()) {
        return fail('Empty description: describe what you observed, what you expected, and useful identifiers (gate, task).')
      }
      let step: string | undefined
      try {
        step = (await loadState(id)).step
      } catch {
        // step omitted when the state cannot be read
      }
      await logHernessError({ mission: id, origin: 'orchestrator anomaly report', step }, description.trim())
      return ok(`Anomaly reported in ${errorLogPath()}.`)
    }),
  )

  return server
}

export async function missionMcpConfig(id: string): Promise<string> {
  const file = join(missionDir(id), 'mcp.json')
  const c = hernessCommand()
  const config = {
    mcpServers: { herness: { command: c.cmd, args: [...c.args, 'mcp', id] } },
  }
  await mkdir(missionDir(id), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2) + '\n')
  return file
}
