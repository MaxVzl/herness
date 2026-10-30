import { describe, expect, it } from 'vitest';
import { AgentRunner, agentArgs, type AgentApi } from '../../src/agents/adapters.js';

const base = { model: 'm', worktree: '/wt', missionDir: '/home/u/missions/42' };
const orch = { ...base, permissionMode: 'auto' as const };

describe('agentArgs', () => {
  it("l'orchestrateur reçoit son serveur MCP, son prompt système et l'interdiction de herness valider", () => {
    const r = agentArgs('orchestrator', { ...orch, mcpConfigPath: '/m/mcp.json', systemPromptPath: '/m/p.md', sessionId: 'sid-1' });
    expect(r.kind).toBe('claude');
    expect(r.args).toEqual([
      '--model', 'm', '--effort', 'high', '--permission-mode', 'auto', '--session-id', 'sid-1',
      '--mcp-config', '/m/mcp.json', '--append-system-prompt-file', '/m/p.md',
      '--add-dir', '/home/u/missions/42', '--name', 'herness-42',
      '--disallowedTools', 'Bash(herness valider:*)', 'Bash(herness refuser:*)', 'Edit(//home/u/missions/42/inbox/**)',
      'Bash(herdr:*)', 'Bash(script:*)', 'Bash(unbuffer:*)',
    ]);
  });

  it("l'orchestrateur applique le mode de permission configuré", () => {
    const r = agentArgs('orchestrator', { ...base, permissionMode: 'acceptEdits' });
    expect(r.args[r.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it("l'orchestrateur sans mode de permission est refusé", () => {
    expect(() => agentArgs('orchestrator', base)).toThrow('mode de permission');
  });

  it("l'orchestrateur repris utilise --resume avec le même identifiant de session", () => {
    const r = agentArgs('orchestrator', { ...orch, mcpConfigPath: '/m/mcp.json', systemPromptPath: '/m/p.md', sessionId: 'sid-1', resume: true });
    expect(r.args).toContain('--resume');
    expect(r.args[r.args.indexOf('--resume') + 1]).toBe('sid-1');
    expect(r.args).not.toContain('--session-id');
  });

  it('le relecteur est en dontAsk et ne peut écrire que dans le dossier de mission', () => {
    const r = agentArgs('reviewer', base);
    expect(r.kind).toBe('claude');
    expect(r.args).toEqual([
      '--model', 'm', '--effort', 'high', '--permission-mode', 'dontAsk',
      '--add-dir', '/home/u/missions/42',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit(//home/u/missions/42/**)',
      'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
    ]);
  });

  it("l'implémenteur est un agent cursor en --force --trust sur le modèle demandé", () => {
    expect(agentArgs('implementer', { ...base, model: 'grok-4.7-high' })).toEqual({ kind: 'cursor', args: ['--model', 'grok-4.7-high', '--force', '--trust'] });
  });
});

function fake(outcome: string, state = 'working') {
  const calls: string[] = [];
  const api: AgentApi = {
    agentStart: async (n, k, p, a, t) => void calls.push(`start ${n} ${k} ${p} ${a.join(' ')} ${t}`),
    agentPrompt: async (n, text, o) => (calls.push(`prompt ${n} ${text} ${o.wait} ${o.timeoutMs}`), outcome as never),
    agentWait: async (n, o) => (calls.push(`wait ${n} ${o.until.join(',')} ${o.timeoutMs}`), outcome as never),
    agentGet: async (n) => (calls.push(`get ${n}`), { state }),
    agentRead: async (n, l) => (calls.push(`read ${n} ${l}`), 'sortie'),
  };
  return { api, calls };
}

describe('AgentRunner', () => {
  it('start lance l\'agent avec ses arguments', async () => {
    const { api, calls } = fake('idle');
    await new AgentRunner(api, () => {}).start('a', 'implementer', 'w:p1', { kind: 'cursor', args: ['--force'] });
    expect(calls[0]).toMatch(/^start a cursor w:p1 --force \d+$/);
  });

  it('ask rend done sur idle et done, blocked sur blocked', async () => {
    for (const [o, e] of [['idle', 'done'], ['done', 'done'], ['blocked', 'blocked']] as const) {
      const { api, calls } = fake(o);
      expect(await new AgentRunner(api, () => {}).ask('a', '/p/brief.md', 5000)).toBe(e);
      expect(calls[0]).toBe('prompt a Lis et exécute intégralement le fichier /p/brief.md true 5000');
    }
  });

  it('ask rend timeout après un stalled sans renvoyer le prompt', async () => {
    const { api, calls } = fake('stalled');
    const logs: string[] = [];
    expect(await new AgentRunner(api, (m) => logs.push(m)).ask('a', '/p/brief.md', 5000)).toBe('timeout');
    expect(calls.filter((c) => c.startsWith('prompt'))).toHaveLength(1);
    expect(calls).toContain('get a');
    expect(calls.some((c) => c.startsWith('read a'))).toBe(true);
    expect(logs.join('\n')).toContain('sortie');
  });

  it('ask traite un état inconnu comme un timeout', async () => {
    const { api, calls } = fake('sent');
    expect(await new AgentRunner(api, () => {}).ask('a', '/p/b.md', 1)).toBe('timeout');
    expect(calls.filter((c) => c.startsWith('prompt'))).toHaveLength(1);
  });

  it('wait attend sans rien envoyer, avec la même correspondance que ask', async () => {
    for (const [o, e] of [['idle', 'done'], ['done', 'done'], ['blocked', 'blocked'], ['timeout', 'timeout']] as const) {
      const { api, calls } = fake(o);
      expect(await new AgentRunner(api, () => {}).wait('a', 5000)).toBe(e);
      expect(calls[0]).toBe('wait a idle,done,blocked 5000');
      expect(calls.some((c) => c.startsWith('prompt'))).toBe(false);
    }
  });
});
