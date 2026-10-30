import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadProjectConfig } from '../config/project.ts'
import { proposedPlanPath, proposedSpecPath, readProposal } from '../mission/amendment.ts'
import { postInbox } from '../mission/inbox.ts'
import { checkAmendment, parsePlan } from '../mission/plan.ts'
import { loadState, type MissionState } from '../mission/state.ts'
import { missionDir, planPath, specPath } from '../paths.ts'

const SLUG = /^[a-z0-9]+(-[a-z0-9]+){1,5}$/

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

async function readPlan(s: MissionState): Promise<{ md: string } | { error: string }> {
  if (!s.worktree) return { error: 'Worktree non encore créé.' }
  const abs = join(s.worktree, planPath(s))
  try {
    return { md: await readFile(abs, 'utf8') }
  } catch {
    return { error: `Plan introuvable : écris-le dans ${abs} avant de demander sa validation.` }
  }
}

/** Chemin absolu d'un document dans le worktree (relatif si le worktree n'est pas encore créé). */
const inWorktree = (s: MissionState, rel: string): string => (s.worktree ? join(s.worktree, rel) : rel)

function summarize(s: MissionState): string {
  const current = s.tasks.find((t) => t.phase !== 'done')
  const pending = s.gates.filter((g) => g.status === 'pending')
  return [
    `Étape : ${s.step}${s.blockedReason ? ` (bloquée : ${s.blockedReason})` : ''}`,
    `Tâche courante : ${current ? `${current.n} « ${current.title} » (phase ${current.phase}, tour ${current.round})` : 'aucune'}`,
    `Tours : revue globale ${s.loops.globalReview.round}, preflight ${s.loops.preflight.round}`,
    `Portes en attente : ${pending.length === 0 ? 'aucune' : pending.map((g) => `${g.kind} (${g.summary})`).join(' ; ')}`,
    `PR : ${s.prUrl ?? 'aucune'}`,
  ].join('\n')
}

// Une exception interne devient un résultat d'erreur en français, jamais un message technique brut.
function guard<A extends unknown[]>(fn: (...a: A) => Promise<ToolResult>): (...a: A) => Promise<ToolResult> {
  return async (...a) => {
    try {
      return await fn(...a)
    } catch (e) {
      return fail(`Erreur : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// Aucun outil ici ne décide une porte : seul l'utilisateur approuve ou refuse.
export function buildServer(id: string): McpServer {
  const server = new McpServer({ name: 'herness', version: '0.1.0' })

  server.registerTool('statut', { description: 'Résumé de la mission : étape, tâche courante, tours, portes en attente, PR.' }, guard(async () =>
    ok(summarize(await loadState(id)))))

  server.registerTool(
    'mission_identifiee',
    {
      description: 'Déclare le type de travail et le slug de la mission une fois la demande comprise.',
      inputSchema: { type: z.string(), slug: z.string() },
    },
    guard(async ({ type, slug }) => {
      const s = await loadState(id)
      const config = await loadProjectConfig(s.repoPath)
      const types = Object.keys(config.branchPrefixes)
      if (!types.includes(type)) return fail(`Type « ${type} » inconnu : choisis parmi ${types.join(', ')}.`)
      if (!SLUG.test(slug)) return fail(`Slug « ${slug} » invalide : 2 à 6 mots en minuscules/chiffres séparés par des tirets (ex. ajout-export-csv).`)
      await postInbox(id, { type: 'classified', workType: type, slug })
      const named = { ...s, slug }
      return ok(`Mission identifiée : ${type} / ${slug}.\nSpec : ${inWorktree(s, specPath(named))}\nPlan : ${inWorktree(s, planPath(named))}`)
    }),
  )

  server.registerTool(
    'demander_validation',
    {
      description: "Demande à l'utilisateur de valider la spec ou le plan (une fois écrit dans le worktree ; le moteur le commitera après validation).",
      inputSchema: { kind: z.enum(['spec', 'plan']), summary: z.string() },
    },
    guard(async ({ kind, summary }) => {
      const s = await loadState(id)
      if (kind === 'spec') {
        const rel = specPath(s)
        if (!s.worktree) return fail('Worktree non encore créé.')
        try {
          await access(join(s.worktree, rel))
        } catch {
          return fail(`Spec introuvable : écris-la dans ${join(s.worktree, rel)} avant de demander sa validation.`)
        }
        await postInbox(id, { type: 'request-gate', kind, summary, path: rel })
        return ok("Validation de la spec demandée à l'utilisateur.")
      }
      const plan = await readPlan(s)
      if ('error' in plan) return fail(plan.error)
      const parsed = parsePlan(plan.md)
      if (!parsed.ok) return fail(`Plan invalide, corrige puis redemande :\n- ${parsed.errors.join('\n- ')}`)
      await postInbox(id, { type: 'request-gate', kind, summary, path: planPath(s) })
      return ok("Validation du plan demandée à l'utilisateur.")
    }),
  )

  server.registerTool(
    'proposer_amendement',
    {
      description:
        "Propose à l'utilisateur un amendement : plan amendé complet écrit dans plan.proposed.md du dossier de mission (et spec amendée dans spec.proposed.md si besoin), jamais dans le worktree. Les tâches déjà validées ne doivent pas changer.",
      inputSchema: { summary: z.string() },
    },
    guard(async ({ summary }) => {
      const s = await loadState(id)
      const proposal = await readProposal(id)
      if (!proposal) return fail(`Plan proposé introuvable : écris le plan amendé complet dans ${proposedPlanPath(id)}.`)
      let approved: ReturnType<typeof parsePlan>
      try {
        approved = parsePlan(await readFile(join(missionDir(id), 'plan.approved.md'), 'utf8'))
      } catch {
        return fail('Plan approuvé introuvable : impossible de vérifier les tâches déjà validées.')
      }
      if (!approved.ok) return fail(`Plan approuvé invalide, impossible de vérifier les tâches déjà validées : ${approved.errors.join(' ; ')}`)
      const done = approved.tasks.filter((t) => s.tasks.some((x) => x.n === t.n && x.phase === 'done')).map((t) => ({ n: t.n, body: t.body }))
      const cur = s.tasks.find((t) => t.phase !== 'done' && t.phase !== 'pending')
      const curBody = cur && approved.tasks.find((t) => t.n === cur.n)
      const check = checkAmendment(done, parsePlan(proposal.plan), curBody ? { n: curBody.n, body: curBody.body } : undefined)
      if (!check.ok) return fail(`Amendement refusé : ${check.reason}`)
      const full = proposal.spec !== undefined ? `${summary}\nSpec proposée : ${proposedSpecPath(id)}` : summary
      await postInbox(id, { type: 'request-gate', kind: 'amendement', summary: full, path: proposedPlanPath(id), hash: proposal.hash })
      return ok("Amendement soumis à l'utilisateur. Ne modifie plus la proposition : toute modification après la demande la fait rejeter.")
    }),
  )

  server.registerTool(
    'demander_arbitrage',
    {
      description: "Demande un arbitrage à l'utilisateur : remarque de revue contredisant le plan, ou toute décision qu'il doit trancher.",
      inputSchema: { summary: z.string() },
    },
    guard(async ({ summary }) => {
      await postInbox(id, { type: 'request-gate', kind: 'arbitrage', summary })
      return ok("Arbitrage demandé à l'utilisateur.")
    }),
  )

  server.registerTool('pause', { description: "Met le moteur en pause (sur demande de l'utilisateur). Ne débloque ni ne bloque rien." }, guard(async () => {
    await postInbox(id, { type: 'pause' })
    return ok('Pause demandée.')
  }))
  server.registerTool(
    'fin_de_pause',
    {
      description:
        "Lève une pause demandée avec `pause`, rien d'autre. Ne reprend PAS une mission bloquée : seul l'utilisateur la reprend (herness reprendre <id> puis validation), ou la débloque en validant un amendement.",
    },
    guard(async () => {
      const s = await loadState(id)
      await postInbox(id, { type: 'resume' })
      const note =
        s.step === 'bloquée'
          ? ` La mission reste bloquée : seul l'utilisateur la reprend (herness reprendre ${id} puis validation), ou la débloque en validant un amendement.`
          : ''
      return ok(`Fin de pause demandée.${note}`)
    }),
  )
  server.registerTool(
    'abandonner',
    { description: "Demande l'abandon de la mission : ouvre une porte que seul l'utilisateur valide.", inputSchema: { reason: z.string() } },
    guard(async ({ reason }) => {
      await postInbox(id, { type: 'abandon', reason })
      return ok("Abandon demandé : porte soumise à l'utilisateur, rien n'est fermé tant qu'il ne l'a pas validée.")
    }),
  )

  return server
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function missionMcpConfig(id: string): Promise<string> {
  const file = join(missionDir(id), 'mcp.json')
  const config = {
    mcpServers: { herness: { command: join(packageRoot, 'bin', 'herness.js'), args: ['mcp', id] } },
  }
  await mkdir(missionDir(id), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2) + '\n')
  return file
}
