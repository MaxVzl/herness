import { Command } from 'commander'

const program = new Command()
program.name('herness').version('0.1.0')

// Sans argument : ouvre (ou crée) l'onglet cockpit du projet dans herdr.
program.action(async () => {
  const { Herdr } = await import('./herdr/client.ts')
  const h = new Herdr()
  const inHerdr = process.env.HERDR_ENV === '1' && (await h.paneCurrent().then(() => true, () => false))
  if (!inHerdr) {
    console.log('hors herdr : lance « herness cockpit » dans un terminal')
    return
  }
  try {
    const { openCockpit } = await import('./ui/location.ts')
    await openCockpit(process.cwd(), h)
  } catch (e) {
    console.error(`herness : ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
})

// Écran du cockpit (Tâche 7).
program
  .command('cockpit')
  .description('Cockpit des missions du projet')
  .action(() => {
    console.log('à venir')
  })

// Serveur MCP de l'orchestrateur : rien d'autre que le protocole ne doit écrire sur stdout.
program
  .command('mcp <id>', { hidden: true })
  .action(async (id: string) => {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    const { buildServer } = await import('./mcp/server.ts')
    await buildServer(id).connect(new StdioServerTransport())
  })

// Moteur de la mission : lancé par herness dans le panneau `engine`, seul écrivain de state.json.
program
  .command('engine <id>', { hidden: true })
  .action(async (id: string) => {
    const { loadState } = await import('./mission/state.ts')
    const { loadProjectConfig } = await import('./config/project.ts')
    const { Engine } = await import('./engine/engine.ts')
    const { realEffects } = await import('./engine/effects.ts')
    const s = await loadState(id)
    const cfg = await loadProjectConfig(s.repoPath)
    await new Engine(id, realEffects(), cfg).run()
  })

async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} (o/N) `)).trim().toLowerCase()
    return answer === 'o' || answer === 'oui'
  } finally {
    rl.close()
  }
}

async function runDecision(
  id: string,
  decision: 'approved' | 'refused',
  opts: { porte?: string; note?: string },
): Promise<void> {
  try {
    const { decide } = await import('./engine/gates.ts')
    await decide(id, decision, {
      ...(opts.porte !== undefined ? { gateId: opts.porte } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: () => askYesNo(decision === 'approved' ? 'Valider cette porte ?' : 'Refuser cette porte ?'),
    })
  } catch (e) {
    console.error(`herness : ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}

program
  .command('valider <id>')
  .description('Valider une porte en attente (terminal interactif uniquement)')
  .option('--porte <gateId>', 'identifiant de la porte (défaut : la plus ancienne en attente)')
  .option('--note <texte>', 'commentaire')
  .action((id: string, opts: { porte?: string; note?: string }) => runDecision(id, 'approved', opts))

program
  .command('refuser <id>')
  .description('Refuser une porte en attente (terminal interactif uniquement)')
  .option('--porte <gateId>', 'identifiant de la porte (défaut : la plus ancienne en attente)')
  .option('--note <texte>', 'motif du refus (obligatoire)')
  .action(async (id: string, opts: { porte?: string; note?: string }) => {
    if (!opts.note) {
      console.error('herness : option requise : --note <texte> (motif du refus)')
      process.exitCode = 1
      return
    }
    await runDecision(id, 'refused', opts)
  })

async function lifecycle(fn: (deps: import('./lifecycle.ts').LifecycleDeps) => Promise<unknown>): Promise<void> {
  try {
    const { realEffects } = await import('./engine/effects.ts')
    await fn({
      e: realEffects(),
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: askYesNo,
    })
  } catch (e) {
    console.error(`herness : ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}

program
  .command('dev <demande...>')
  .description('Démarrer une mission : lien Wrike, issue GitHub ou texte libre')
  .action((demande: string[]) =>
    lifecycle(async (deps) => {
      const { startMission } = await import('./lifecycle.ts')
      await startMission(demande.join(' '), process.cwd(), deps)
    }),
  )

program
  .command('reprendre <id>')
  .description("Rouvrir l'espace d'une mission et relancer ce qui ne tourne plus")
  .option('--redemarrer', 'arrêter puis relancer moteur, tableau et visionneuses même en cours (après une mise à jour de herness)')
  .action((id: string, opts: { redemarrer?: boolean }) =>
    lifecycle(async (deps) => {
      const { resumeMission } = await import('./lifecycle.ts')
      await resumeMission(id, deps, { restart: opts.redemarrer === true })
    }),
  )

program
  .command('fermer <id>')
  .description('Fermer une mission : base de test, moteur, worktree et espace herdr')
  .action((id: string) =>
    lifecycle(async (deps) => {
      const { closeMission } = await import('./lifecycle.ts')
      await closeMission(id, deps)
    }),
  )

program
  .command('statut [id]')
  .description("État des missions, ou détail d'une mission")
  .action(async (id?: string) => {
    try {
      const { missionStatus } = await import('./lifecycle.ts')
      for (const line of await missionStatus(id)) console.log(line)
    } catch (e) {
      console.error(`herness : ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('tasks <id>')
  .description("Tableau de bord d'une mission (v valider, r refuser, q quitter)")
  .action(async (id: string) => {
    try {
      const { default: React } = await import('react')
      const { render } = await import('ink')
      const { loadState } = await import('./mission/state.ts')
      const { TasksDashboard, TasksView } = await import('./ui/tasks.tsx')
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        render(React.createElement(TasksView, { state: await loadState(id) })).unmount()
        return
      }
      await render(React.createElement(TasksDashboard, { id })).waitUntilExit()
    } catch (e) {
      console.error(`herness : ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('voir <doc> <id>')
  .description('Afficher la spec ou le plan de la mission, rechargé à chaque modification (panneaux spec et plan)')
  .action(async (doc: string, id: string) => {
    try {
      if (doc !== 'spec' && doc !== 'plan') throw new Error(`document inconnu : « ${doc} » (spec ou plan)`)
      const { runViewer } = await import('./ui/voir.ts')
      await runViewer(doc, id)
    } catch (e) {
      console.error(`herness : ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

await program.parseAsync(process.argv)
