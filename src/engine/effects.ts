import { run } from '../exec.ts'
import { AgentRunner } from '../agents/adapters.ts'
import { Herdr, type HerdrApi } from '../herdr/client.ts'
import { runInPane } from '../herdr/layout.ts'
import * as git from '../git/git.ts'
import * as forge from '../forge/github.ts'
import type { AgentApi } from '../agents/adapters.ts'

/** Surface de herdr utilisée par le moteur : disposition, agents et notifications. `Herdr` la satisfait. */
export type EngineHerdr = HerdrApi & AgentApi & Pick<Herdr, 'notify'>

/** Surface d'`AgentRunner` utilisée par le moteur. */
export type Agents = Pick<AgentRunner, 'start' | 'ask' | 'wait'>

/** Tous les effets de bord du moteur passent par ici ; les tests injectent `fakeEffects`. */
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

export function realEffects(): Effects {
  const herdr = new Herdr()
  return {
    herdr,
    agents: new AgentRunner(herdr),
    git,
    forge,
    runInPane,
    run,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}
