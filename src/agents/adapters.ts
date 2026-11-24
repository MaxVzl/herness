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
  /** Required for the orchestrator (project config); ignored for the other roles. */
  permissionMode?: PermissionMode;
}

/** Slice of `Herdr` used here; a fake implements it in the tests. */
export type AgentApi = Pick<Herdr, 'agentStart' | 'agentPrompt' | 'agentWait' | 'agentGet' | 'agentRead'>;

/** In a permission rule, `/x` is relative to the project: an absolute path takes `//`. */
const absRule = (tool: string, path: string, glob: string): string => `${tool}(/${path}/${glob})`;

/** Reviewer: read-only on the worktree, write access in the mission directory, `git diff/log/show`. */
const reviewerArgs = (o: AgentOptions): string[] => [
  '--model', o.model, '--effort', 'high', '--permission-mode', 'dontAsk',
  '--add-dir', o.missionDir,
  '--allowedTools', 'Read', 'Grep', 'Glob', absRule('Edit', o.missionDir, '**'),
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
];

/**
 * Read-only git commands added for the preflight diagnostician. Excluded: `git fetch` (writes
 * refs), `git branch` (`-D`, `-m`) and `git reflog` with arguments (`expire`, `delete`), which write.
 */
const DIAGNOSTIC_GIT = [
  'Bash(git rev-parse:*)', 'Bash(git merge-base:*)', 'Bash(git status:*)', 'Bash(git rev-list:*)',
  'Bash(git reflog)', 'Bash(git reflog show:*)', 'Bash(git ls-files:*)', 'Bash(git blame:*)',
  'Bash(git cat-file:*)', 'Bash(git for-each-ref:*)',
];

export function agentArgs(role: Role, o: AgentOptions): AgentLaunch {
  switch (role) {
    case 'orchestrator': {
      // Permission mode set by the project config: never inherited from the user's settings.
      if (!o.permissionMode) throw new Error('orchestrator: permission mode required (orchestratorPermissionMode)');
      const args = ['--model', o.model, '--effort', 'high', '--permission-mode', o.permissionMode];
      if (o.sessionId) args.push(o.resume ? '--resume' : '--session-id', o.sessionId);
      if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
      if (o.systemPromptPath) args.push('--append-system-prompt-file', o.systemPromptPath);
      args.push(
        '--add-dir', o.missionDir,
        '--name', `herness-${basename(o.missionDir)}`,
        '--disallowedTools', 'Bash(herness approve:*)', 'Bash(herness reject:*)', absRule('Edit', o.missionDir, 'inbox/**'),
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

export class AgentRunner {
  constructor(
    private readonly h: AgentApi,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {}

  async start(name: string, _role: Role, pane: string, launch: AgentLaunch): Promise<void> {
    await this.h.agentStart(name, launch.kind, pane, launch.args, START_TIMEOUT_MS);
  }

  /** Gives the agent a brief file and waits. Never a blind resend after a delay. */
  async ask(name: string, promptFile: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout'> {
    const outcome = await this.h.agentPrompt(name, `Read and fully execute the file ${promptFile}`, { wait: true, timeoutMs });
    return this.settle(name, outcome);
  }

  /** Waits for the current work to finish without sending anything (resume after an engine restart). */
  async wait(name: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout'> {
    const outcome = await this.h.agentWait(name, { until: ['idle', 'done', 'blocked'], timeoutMs });
    return this.settle(name, outcome);
  }

  private async settle(name: string, outcome: string): Promise<'done' | 'blocked' | 'timeout'> {
    if (outcome === 'idle' || outcome === 'done') return 'done';
    if (outcome === 'blocked') return 'blocked';
    const info = await this.h.agentGet(name);
    const tail = await this.h.agentRead(name, 80);
    this.log(`agent ${name}: ${outcome}, state ${info?.state ?? 'not found'}\n${tail}`);
    return 'timeout';
  }
}
