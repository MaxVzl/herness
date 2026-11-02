import type { Effects, EngineHerdr, Agents } from '../src/engine/effects.ts'
import type * as gitModule from '../src/git/git.ts'
import type * as forgeModule from '../src/forge/github.ts'
import type { PromptOutcome } from '../src/herdr/client.ts'
import type { RunResult } from '../src/exec.ts'
import { FakeHerdr } from './herdr/fake.ts'

export type Call = { fn: string; args: unknown[] }
type Fn = (...a: any[]) => any

/** Réponses scriptées dans l'ordre ; la dernière est répétée ensuite. */
export function seq<T>(...values: T[]): () => T {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] as T
}

/** Doublure de herdr complète : la disposition de `FakeHerdr`, plus les agents et les notifications. */
export class FakeEngineHerdr extends FakeHerdr {
  started = new Set<string>()
  async agentStart(name: string, _kind: string, _pane: string, _args: string[], _timeoutMs: number): Promise<void> {
    this.started.add(name)
  }
  async agentPrompt(_name: string, _text: string, opts: { wait: boolean; timeoutMs?: number }): Promise<PromptOutcome> {
    return opts.wait ? 'idle' : 'sent'
  }
  async agentWait(_name: string, _opts: { until: ('idle' | 'done' | 'blocked')[]; timeoutMs: number }): Promise<PromptOutcome> {
    return 'idle'
  }
  async agentGet(name: string): Promise<{ state: string } | null> {
    return this.started.has(name) ? { state: 'idle' } : null
  }
  async agentRead(_name: string, _lines: number): Promise<string> {
    return ''
  }
  async notify(_title: string, _body: string, _sound: 'done' | 'request'): Promise<void> {}
}

const HERDR_METHODS = [
  'workspaceList', 'worktreeCreate', 'workspaceFocus', 'workspaceClose', 'tabList', 'tabCreate', 'tabRename', 'tabFocus',
  'paneList', 'paneSplit', 'paneRename', 'paneRun', 'paneWaitOutput', 'paneLayout', 'paneProcessInfo', 'paneSendKeys',
  'agentStart', 'agentPrompt', 'agentWait', 'agentGet', 'agentRead', 'notify',
] as const satisfies readonly (keyof EngineHerdr)[]

export interface FakeOverrides {
  herdr?: Partial<EngineHerdr>
  agents?: Partial<Agents>
  git?: Partial<typeof gitModule>
  forge?: Partial<typeof forgeModule>
  runInPane?: Effects['runInPane']
  run?: Effects['run']
  now?: () => Date
  sleep?: Effects['sleep']
}

export interface FakeEffects extends Effects {
  herdr: FakeEngineHerdr
  /** Tous les appels, dans l'ordre : `herdr.agentPrompt`, `git.commitFiles`, `runInPane`, `run`, `sleep`… */
  calls: Call[]
  /** Arguments de chaque appel à `fn`. */
  callsOf(fn: string): unknown[][]
}

const ok: RunResult = { stdout: '', stderr: '', exitCode: 0 }

/**
 * Effets factices : chaque appel est enregistré dans `calls`, et chaque fonction rend une réponse par défaut
 * (succès) que `overrides` remplace. `seq(...)` scripte des réponses successives.
 */
export function fakeEffects(overrides: FakeOverrides = {}): FakeEffects {
  const calls: Call[] = []
  const rec = <F extends Fn>(fn: string, impl: F): F =>
    ((...args: unknown[]) => {
      calls.push({ fn, args })
      return impl(...args)
    }) as F
  const wrapAll = <T extends object>(prefix: string, base: T, over: Partial<T> = {}): T => {
    const out = {} as T
    for (const k of Object.keys(base) as (keyof T)[]) {
      const f = (over[k] ?? base[k]) as Fn
      out[k] = rec(`${prefix}.${String(k)}`, f) as T[keyof T]
    }
    return out
  }

  const herdr = new FakeEngineHerdr()
  for (const m of HERDR_METHODS) {
    const impl = ((overrides.herdr?.[m] as Fn | undefined) ?? (herdr[m] as Fn).bind(herdr))
    ;(herdr as unknown as Record<string, Fn>)[m] = rec(`herdr.${m}`, impl)
  }

  const git: typeof gitModule = {
    headSha: async () => 'sha-head',
    currentBranch: async () => 'herness/provisoire',
    isClean: async () => false,
    renameBranch: async () => {},
    fetchMain: async () => {},
    fetchBranch: async () => {},
    // Par défaut : pas de branche distante, la branche locale est gardée.
    localOnlyCommits: async () => null,
    deleteBranch: async () => {},
    identity: async () => ({ name: 'Moi', email: 'moi@example.com' }),
    controlCommits: async () => ({ ok: true, commits: 1 }),
    diffPackage: async (_wt, base) => ({ base, head: 'sha-head', commits: 1 }),
    commitFiles: async () => 'sha-commit',
    push: async () => {},
    mergeBase: async () => 'sha-base',
    changedFiles: async () => [],
    worktreeAddDetached: async () => {},
    worktreeRemove: async () => {},
    rebaseOnto: async () => ({ ok: true, changedCode: false }),
    unpushedCount: async () => 1,
    isAncestor: async () => true,
  }
  const forge: typeof forgeModule = {
    readIssue: async () => ({ title: 'titre', body: 'corps', comments: [] }),
    createPr: async () => 'https://github.com/o/r/pull/1',
    findPr: async () => null,
  }
  const agents: Agents = {
    // Un agent démarré est visible par `herdr.agentGet`, comme avec le vrai `AgentRunner`.
    start: async (name: string) => {
      herdr.started.add(name)
    },
    ask: async () => 'done',
    wait: async () => 'done',
  }

  return {
    herdr,
    agents: wrapAll('agents', agents, overrides.agents),
    git: wrapAll('git', git, overrides.git),
    forge: wrapAll('forge', forge, overrides.forge),
    runInPane: rec('runInPane', overrides.runInPane ?? (async () => ({ exitCode: 0, logPath: '/dev/null', tail: '', durationMs: 1 }))),
    // Par défaut tout réussit, y compris les contrôles d'environnement (`cursor-agent status` connecté).
    run: rec('run', overrides.run ?? (async (cmd: string) => (cmd === 'cursor-agent' ? { ...ok, stdout: 'Logged in' } : ok))),
    now: overrides.now ?? (() => new Date('2026-10-29T10:00:00Z')),
    sleep: rec('sleep', overrides.sleep ?? (async () => {})),
    calls,
    callsOf: (fn) => calls.filter((c) => c.fn === fn).map((c) => c.args),
  }
}
