import { Command } from 'commander'
import { VERSION } from './version.ts'

const program = new Command()
program.name('herness').version(VERSION)

// No arguments: open (or create) the project's cockpit tab in herdr.
program.action(async () => {
  const { Herdr } = await import('./herdr/client.ts')
  const h = new Herdr()
  const inHerdr = process.env.HERDR_ENV === '1' && (await h.paneCurrent().then(() => true, () => false))
  if (!inHerdr) {
    console.log('outside herdr: run "herness cockpit" in a terminal')
    return
  }
  try {
    const { openCockpit } = await import('./ui/location.ts')
    await openCockpit(process.cwd(), h)
  } catch (e) {
    console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
})

// Cockpit screen: missions of the project in the current directory; outside a TTY, a single frame.
program
  .command('cockpit')
  .description('Project mission cockpit (↑/↓ mission, v/r/n gate, p/R/f/o, + new mission, a finished, q quit)')
  .action(async () => {
    try {
      // No git/ssh prompt while ink is drawing.
      const { prepareTuiEnv } = await import('./ui/tui-env.ts')
      prepareTuiEnv(process.env)
      const { default: React } = await import('react')
      const { render } = await import('ink')
      const { loadProjectConfig } = await import('./config/project.ts')
      const cfg = await loadProjectConfig(process.cwd())
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        const { CockpitSnapshot } = await import('./ui/cockpit.tsx')
        const { projectMissions } = await import('./ui/model.ts')
        const { PrCache } = await import('./ui/pr-cache.ts')
        const missions = await projectMissions(cfg.repoPath)
        render(React.createElement(CockpitSnapshot, {
          name: cfg.name,
          missions,
          prCache: new PrCache(),
          ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
        })).unmount()
        return
      }
      const { Cockpit } = await import('./ui/cockpit.tsx')
      await render(React.createElement(Cockpit, { repoPath: cfg.repoPath, name: cfg.name })).waitUntilExit()
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

// Orchestrator MCP server: nothing but the protocol may write to stdout.
program
  .command('mcp <id>', { hidden: true })
  .action(async (id: string) => {
    const { installProcessErrorLog, withErrorLog } = await import('./errlog.ts')
    installProcessErrorLog({ mission: id, origin: 'MCP server: uncaught error' })
    await withErrorLog({ mission: id, origin: 'MCP server startup' }, async () => {
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const { buildServer } = await import('./mcp/server.ts')
      await buildServer(id).connect(new StdioServerTransport())
    })
  })

// Mission engine: started by herness in the `engine` pane, sole writer of state.json.
program
  .command('engine <id>', { hidden: true })
  .action(async (id: string) => {
    const { installProcessErrorLog, withErrorLog } = await import('./errlog.ts')
    installProcessErrorLog({ mission: id, origin: 'engine: uncaught error' })
    const engine = await withErrorLog({ mission: id, origin: 'engine startup' }, async () => {
      const { assertResumable, loadState } = await import('./mission/state.ts')
      const { loadProjectConfig } = await import('./config/project.ts')
      const { Engine } = await import('./engine/engine.ts')
      const { realEffects } = await import('./engine/effects.ts')
      const s = await loadState(id)
      assertResumable(s)
      const cfg = await loadProjectConfig(s.repoPath)
      return new Engine(id, realEffects(), cfg)
    })
    await engine.run()
  })

async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} (y/N) `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function runDecision(
  id: string,
  decision: 'approved' | 'refused',
  opts: { gate?: string; note?: string },
): Promise<void> {
  try {
    const { decide } = await import('./engine/gates.ts')
    await decide(id, decision, {
      ...(opts.gate !== undefined ? { gateId: opts.gate } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: () => askYesNo(decision === 'approved' ? 'Approve this gate?' : 'Reject this gate?'),
    })
  } catch (e) {
    console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}

program
  .command('approve <id>')
  .description('Approve a pending gate (interactive terminal only)')
  .option('--gate <gateId>', 'gate id (default: the oldest pending one)')
  .option('--note <text>', 'comment')
  .action((id: string, opts: { gate?: string; note?: string }) => runDecision(id, 'approved', opts))

program
  .command('reject <id>')
  .description('Reject a pending gate (interactive terminal only)')
  .option('--gate <gateId>', 'gate id (default: the oldest pending one)')
  .option('--note <text>', 'reason for rejecting (required)')
  .action(async (id: string, opts: { gate?: string; note?: string }) => {
    if (!opts.note) {
      console.error('herness: required option: --note <text> (reason for rejecting)')
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
    console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}

program
  .command('dev <request...>')
  .description('Start a mission: Wrike link, GitHub issue, or free text')
  .option('--note <text>', 'details that complement the request')
  .action((request: string[], opts: { note?: string }) =>
    lifecycle(async (deps) => {
      const { startMission } = await import('./lifecycle.ts')
      await startMission(request.join(' '), process.cwd(), deps, opts.note !== undefined ? { note: opts.note } : {})
    }),
  )

program
  .command('resume <id>')
  .description('Reopen a mission workspace and restart whatever is no longer running')
  .option('--restart', 'stop then restart the engine, dashboard and viewers even if they are running (after a herness update)')
  .action((id: string, opts: { restart?: boolean }) =>
    lifecycle(async (deps) => {
      const { resumeMission } = await import('./lifecycle.ts')
      await resumeMission(id, deps, { restart: opts.restart === true })
    }),
  )

program
  .command('close <id>')
  .description('Close a mission: test database, engine, worktree and herdr workspace')
  .action((id: string) =>
    lifecycle(async (deps) => {
      const { closeMission } = await import('./lifecycle.ts')
      await closeMission(id, deps, { report: true })
    }),
  )

program
  .command('report <id>')
  .description("File GitHub issues (MaxVzl/herness) for a mission's herness errors")
  .option('--yes', 'skip confirmation')
  .action((id: string, opts: { yes?: boolean }) =>
    lifecycle(async (deps) => {
      const { reportMissionErrors } = await import('./lifecycle.ts')
      await reportMissionErrors(id, deps, { force: opts.yes === true })
    }),
  )

program
  .command('delete <id>')
  .description('Delete a closed mission folder (state, spec, plan, logs)')
  .option('--yes', 'skip confirmation')
  .action((id: string, opts: { yes?: boolean }) =>
    lifecycle(async (deps) => {
      const { deleteMission } = await import('./lifecycle.ts')
      await deleteMission(id, deps, { force: opts.yes === true })
    }),
  )

program
  .command('init')
  .description('Create the herness config for the current repository, then offer to refine it with Claude')
  .action(async () => {
    try {
      const { initProject } = await import('./config/init.ts')
      const { execa } = await import('execa')
      await initProject(process.cwd(), {
        isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        confirm: askYesNo,
        claude: async (args, cwd) => {
          await execa('claude', args, { cwd, stdio: 'inherit', reject: false })
        },
        log: (line) => console.log(line),
      })
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('project')
  .description('herness config for the current repository: file, repository, validity')
  .action(async () => {
    try {
      const { findProjectConfig } = await import('./config/project.ts')
      const { config, file } = await findProjectConfig(process.cwd())
      console.log(`project ${config.name}`)
      console.log(`config: ${file}`)
      console.log(`repo: ${config.repoPath}`)
      console.log('config valid')
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('update')
  .description('Install the latest herness version (or --version), then offer to restart running missions')
  .option('--version <x.y.z>', 'version to install (including a downgrade)')
  .action(async (opts: { version?: string }) => {
    try {
      const { update, restartInstalled, INSTALL_SCRIPT_URL } = await import('./update.ts')
      const { execa } = await import('execa')
      await update(opts, {
        install: async (args) => {
          const script = (await execa('curl', ['-fsSL', INSTALL_SCRIPT_URL])).stdout
          await execa('sh', ['-s', '--', ...args], { input: script, stdout: 'inherit', stderr: 'inherit' })
        },
        restart: (id) => restartInstalled(id),
        isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        confirm: askYesNo,
        out: (line) => console.log(line),
      })
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('status [id]')
  .description('State of the missions, or the detail of one mission')
  .action(async (id?: string) => {
    try {
      const { missionStatus } = await import('./lifecycle.ts')
      for (const line of await missionStatus(id)) console.log(line)
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('tasks <id>')
  .description('Mission dashboard: the cockpit actions for this mission (c back to the cockpit, q quit)')
  .action(async (id: string) => {
    try {
      // No git/ssh prompt while ink is drawing.
      const { prepareTuiEnv } = await import('./ui/tui-env.ts')
      prepareTuiEnv(process.env)
      const { default: React } = await import('react')
      const { render } = await import('ink')
      const { loadState } = await import('./mission/state.ts')
      const { TasksDashboard } = await import('./ui/tasks.tsx')
      const { MissionDetail } = await import('./ui/detail.tsx')
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        render(React.createElement(MissionDetail, { state: await loadState(id) })).unmount()
        return
      }
      await render(React.createElement(TasksDashboard, { id })).waitUntilExit()
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

program
  .command('show <doc> <id>')
  .description('Show the mission spec or plan, reloaded on every change (spec and plan panes)')
  .action(async (doc: string, id: string) => {
    try {
      if (doc !== 'spec' && doc !== 'plan') throw new Error(`unknown document: "${doc}" (spec or plan)`)
      const { runViewer } = await import('./ui/show.ts')
      await runViewer(doc, id)
    } catch (e) {
      console.error(`herness: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    }
  })

await program.parseAsync(process.argv)
