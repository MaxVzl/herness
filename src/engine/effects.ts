import { run } from '../exec.ts'
import { AgentRunner } from '../agents/adapters.ts'
import { Herdr, type HerdrApi } from '../herdr/client.ts'
import { runInPane } from '../herdr/layout.ts'
import * as git from '../git/git.ts'
import * as forge from '../forge/github.ts'
import type { AgentApi } from '../agents/adapters.ts'

/** herdr surface used by the engine: layout, agents and notifications. `Herdr` satisfies it. */
export type EngineHerdr = HerdrApi & AgentApi & Pick<Herdr, 'notify'>

/** `AgentRunner` surface used by the engine. */
export type Agents = Pick<AgentRunner, 'start' | 'ask' | 'wait'>

/** Every engine side effect goes through here; tests inject `fakeEffects`. */
export interface Effects {
  herdr: EngineHerdr
  agents: Agents
  git: typeof git
  forge: typeof forge
  runInPane: typeof runInPane
  run: typeof run
  now(): Date
  sleep(ms: number): Promise<void>
}

/** `log` receives herdr and agent logs; default: `console.error` (the cockpit shows them in ink). */
export function realEffects(opts: { log?: (message: string) => void } = {}): Effects {
  const herdr = new Herdr(opts.log)
  return {
    herdr,
    agents: new AgentRunner(herdr, opts.log),
    git,
    forge,
    runInPane,
    run,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}
