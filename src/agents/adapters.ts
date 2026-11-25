import { basename } from 'node:path';
import type { Herdr } from '../herdr/client.js';

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type Role = 'orchestrator' | 'implementer' | 'reviewer' | 'diagnostic';
export type AgentKind = 'claude' | 'cursor';
export interface AgentLaunch {
  kind: AgentKind;
  args: string[];
}
export interface AgentOptions {
  model: string;
  worktree: string;
  missionDir: string;
  mcpConfigPath?: string;
  systemPromptPath?: string;
  sessionId?: string;
  resume?: boolean;
  /** Obligatoire pour l'orchestrateur (config du projet) ; ignoré des autres rôles. */
  permissionMode?: PermissionMode;
}

/** Surface de `Herdr` utilisée ici ; une doublure l'implémente dans les tests. */
export type AgentApi = Pick<Herdr, 'agentStart' | 'agentPrompt' | 'agentWait' | 'agentGet' | 'agentRead' | 'paneSendKeys'>;

/** Dans une règle de permission, `/x` est relatif au projet : un chemin absolu prend `//`. */
const absRule = (tool: string, path: string, glob: string): string => `${tool}(/${path}/${glob})`;

/** Relecteur : lecture seule sur le worktree, écriture dans le dossier de mission, `git diff/log/show`. */
const reviewerArgs = (o: AgentOptions): string[] => [
  '--model', o.model, '--effort', 'high', '--permission-mode', 'dontAsk',
  '--add-dir', o.missionDir,
  '--allowedTools', 'Read', 'Grep', 'Glob', absRule('Edit', o.missionDir, '**'),
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
];

/**
 * Commandes git en lecture seule ajoutées pour le diagnostiqueur du preflight. Exclues : `git fetch` (écrit des
 * refs), `git branch` (`-D`, `-m`) et `git reflog` avec arguments (`expire`, `delete`), qui écrivent.
 */
const DIAGNOSTIC_GIT = [
  'Bash(git rev-parse:*)', 'Bash(git merge-base:*)', 'Bash(git status:*)', 'Bash(git rev-list:*)',
  'Bash(git reflog)', 'Bash(git reflog show:*)', 'Bash(git ls-files:*)', 'Bash(git blame:*)',
  'Bash(git cat-file:*)', 'Bash(git for-each-ref:*)',
];

export function agentArgs(role: Role, o: AgentOptions): AgentLaunch {
  switch (role) {
    case 'orchestrator': {
      // Mode de permission fixé par la config du projet : jamais hérité des réglages de l'utilisateur.
      if (!o.permissionMode) throw new Error("orchestrateur : mode de permission requis (orchestratorPermissionMode)");
      const args = ['--model', o.model, '--effort', 'high', '--permission-mode', o.permissionMode];
      if (o.sessionId) args.push(o.resume ? '--resume' : '--session-id', o.sessionId);
      if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
      if (o.systemPromptPath) args.push('--append-system-prompt-file', o.systemPromptPath);
      args.push(
        '--add-dir', o.missionDir,
        '--name', `herness-${basename(o.missionDir)}`,
        '--disallowedTools', 'Bash(herness valider:*)', 'Bash(herness refuser:*)', absRule('Edit', o.missionDir, 'inbox/**'),
        'Bash(herdr:*)', 'Bash(script:*)', 'Bash(unbuffer:*)',
      );
      return { kind: 'claude', args };
    }
    case 'reviewer':
      return { kind: 'claude', args: reviewerArgs(o) };
    case 'diagnostic':
      return { kind: 'claude', args: [...reviewerArgs(o), ...DIAGNOSTIC_GIT] };
    case 'implementer':
      return { kind: 'cursor', args: ['--model', o.model, '--force', '--trust'] };
  }
}

const START_TIMEOUT_MS = 90_000;

/** Même garde que `agent prompt --wait` : une activité doit apparaître dans les 5 s, sinon l'Entrée n'a rien lancé. */
const ACTIVITY_GUARD_MS = 5_000;
const ACTIVITY_POLL_MS = 200;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT_MARK = 'Lis et exécute intégralement le fichier';

export class AgentRunner {
  constructor(
    private readonly h: AgentApi,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {}

  async start(name: string, _role: Role, pane: string, launch: AgentLaunch): Promise<void> {
    await this.h.agentStart(name, launch.kind, pane, launch.args, START_TIMEOUT_MS);
  }

  /**
   * Donne un fichier de consigne à l'agent et attend. Jamais de renvoi à l'aveugle après un délai.
   * `stalled` rendu tel quel : l'appelant peut tenter `nudge`.
   */
  async ask(name: string, promptFile: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout' | 'stalled'> {
    const outcome = await this.h.agentPrompt(name, `${PROMPT_MARK} ${promptFile}`, { wait: true, timeoutMs });
    if (outcome === 'stalled') {
      await this.note(name, outcome);
      return 'stalled';
    }
    return this.settle(name, outcome);
  }

  /**
   * Jamais de renvoi du texte : une seule Entrée si la consigne est encore visible.
   * L'attente ne part que si l'agent passe à `working` ou `blocked` pendant la garde ; sinon `timeout`.
   */
  async nudge(name: string, pane: string, promptFile: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout' | 'absent'> {
    const tail = await this.h.agentRead(name, 40);
    if (!tail.includes(basename(promptFile)) || !tail.includes(PROMPT_MARK)) return 'absent';
    await this.h.paneSendKeys(pane, 'Enter');
    if (!(await this.sawActivity(name))) return 'timeout';
    return this.wait(name, timeoutMs);
  }

  /** `working` ou `blocked` observé via `agentGet` dans les ~5 s qui suivent l'Entrée. */
  private async sawActivity(name: string): Promise<boolean> {
    const deadline = Date.now() + ACTIVITY_GUARD_MS;
    for (;;) {
      const state = (await this.h.agentGet(name))?.state;
      if (state === 'working' || state === 'blocked') return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(ACTIVITY_POLL_MS, remaining));
    }
  }

  /** Attend la fin du travail en cours sans rien envoyer (reprise après un redémarrage du moteur). */
  async wait(name: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout'> {
    const outcome = await this.h.agentWait(name, { until: ['idle', 'done', 'blocked'], timeoutMs });
    return this.settle(name, outcome);
  }

  private async note(name: string, outcome: string): Promise<void> {
    const info = await this.h.agentGet(name);
    const tail = await this.h.agentRead(name, 80);
    this.log(`agent ${name} : ${outcome}, état ${info?.state ?? 'introuvable'}\n${tail}`);
  }

  private async settle(name: string, outcome: string): Promise<'done' | 'blocked' | 'timeout'> {
    if (outcome === 'idle' || outcome === 'done') return 'done';
    if (outcome === 'blocked') return 'blocked';
    await this.note(name, outcome);
    return 'timeout';
  }
}
