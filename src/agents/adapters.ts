import { basename } from 'node:path';
import type { Herdr } from '../herdr/client.js';

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type Role = 'orchestrator' | 'implementer' | 'reviewer';
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
export type AgentApi = Pick<Herdr, 'agentStart' | 'agentPrompt' | 'agentWait' | 'agentGet' | 'agentRead'>;

/** Dans une règle de permission, `/x` est relatif au projet : un chemin absolu prend `//`. */
const absRule = (tool: string, path: string, glob: string): string => `${tool}(/${path}/${glob})`;

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
        '--disallowedTools', 'AskUserQuestion', 'Bash(herness valider:*)', 'Bash(herness refuser:*)', absRule('Edit', o.missionDir, 'inbox/**'),
        'Bash(herdr:*)', 'Bash(script:*)', 'Bash(unbuffer:*)',
      );
      return { kind: 'claude', args };
    }
    case 'reviewer':
      return {
        kind: 'claude',
        args: [
          '--model', o.model, '--effort', 'high', '--permission-mode', 'dontAsk',
          '--add-dir', o.missionDir,
          '--allowedTools', 'Read', 'Grep', 'Glob', absRule('Edit', o.missionDir, '**'),
          'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
        ],
      };
    case 'implementer':
      return { kind: 'cursor', args: ['--model', o.model, '--force', '--trust'] };
  }
}

const START_TIMEOUT_MS = 90_000;

export class AgentRunner {
  constructor(
    private readonly h: AgentApi,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {}

  async start(name: string, _role: Role, pane: string, launch: AgentLaunch): Promise<void> {
    await this.h.agentStart(name, launch.kind, pane, launch.args, START_TIMEOUT_MS);
  }

  /** Donne un fichier de consigne à l'agent et attend. Jamais de renvoi à l'aveugle après un délai. */
  async ask(name: string, promptFile: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout'> {
    const outcome = await this.h.agentPrompt(name, `Lis et exécute intégralement le fichier ${promptFile}`, { wait: true, timeoutMs });
    return this.settle(name, outcome);
  }

  /** Attend la fin du travail en cours sans rien envoyer (reprise après un redémarrage du moteur). */
  async wait(name: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout'> {
    const outcome = await this.h.agentWait(name, { until: ['idle', 'done', 'blocked'], timeoutMs });
    return this.settle(name, outcome);
  }

  private async settle(name: string, outcome: string): Promise<'done' | 'blocked' | 'timeout'> {
    if (outcome === 'idle' || outcome === 'done') return 'done';
    if (outcome === 'blocked') return 'blocked';
    const info = await this.h.agentGet(name);
    const tail = await this.h.agentRead(name, 80);
    this.log(`agent ${name} : ${outcome}, état ${info?.state ?? 'introuvable'}\n${tail}`);
    return 'timeout';
  }
}
