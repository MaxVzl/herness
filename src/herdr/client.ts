import { run } from '../exec.js';

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
}
export interface HerdrTab {
  tabId: string;
  workspaceId: string;
  label: string;
  number: number;
}
export interface HerdrPane {
  paneId: string;
  tabId: string;
  workspaceId: string;
  /** Absent tant que le panneau n'a jamais été renommé. */
  label?: string;
  /** Agent reconnu dans le panneau (absent pour un simple shell). */
  agent?: string;
}
export interface PaneLayoutEntry {
  paneId: string;
  rect: { x: number; y: number; width: number; height: number };
}
export interface PaneProcessInfo {
  shellPid: number | null;
  foregroundPids: number[];
}
export type PromptOutcome = 'idle' | 'done' | 'blocked' | 'timeout' | 'stalled' | 'sent';

/** Surface de `Herdr` utilisée par la disposition ; une doublure l'implémente dans les tests. */
export interface HerdrApi {
  workspaceList(): Promise<HerdrWorkspace[]>;
  worktreeCreate(a: { cwd: string; branch: string; base: string; path: string; label: string }): Promise<{ workspaceId: string; path: string }>;
  workspaceFocus(id: string): Promise<void>;
  workspaceClose(id: string): Promise<void>;
  tabList(ws: string): Promise<HerdrTab[]>;
  tabCreate(a: { workspace: string; cwd: string; label: string }): Promise<{ tabId: string; rootPaneId: string }>;
  tabRename(tab: string, label: string): Promise<void>;
  tabFocus(tab: string): Promise<void>;
  paneList(ws: string): Promise<HerdrPane[]>;
  paneSplit(a: { pane: string; direction: 'right' | 'down'; ratio?: number; cwd: string }): Promise<{ paneId: string; tabId: string }>;
  paneRename(pane: string, label: string): Promise<void>;
  paneRun(pane: string, cmd: string): Promise<void>;
  /** Vrai si le motif est apparu avant le délai, faux sinon. */
  paneWaitOutput(pane: string, match: string, timeoutMs: number): Promise<boolean>;
  paneLayout(pane: string): Promise<PaneLayoutEntry[]>;
  paneProcessInfo(pane: string): Promise<PaneProcessInfo>;
  paneSendKeys(pane: string, ...keys: string[]): Promise<void>;
  /** Panneau qui exécute la commande (`herdr pane current`). */
  paneCurrent(): Promise<{ paneId: string; tabId: string; workspaceId: string; cwd: string }>;
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`herdr : ${code} : ${message}`);
  }
}

type Json = Record<string, any>;

function parseError(stderr: string, stdout: string): HerdrError {
  for (const text of [stderr, stdout]) {
    try {
      const e = JSON.parse(text).error;
      if (e?.code) return new HerdrError(String(e.code), String(e.message ?? ''));
    } catch {
      /* pas du JSON */
    }
  }
  return new HerdrError('cli_error', (stderr || stdout).trim());
}

/** Cherche récursivement un état d'agent dans la réponse d'une attente. */
function findStatus(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const o = v as Json;
    if (typeof o['agent_status'] === 'string') return o['agent_status'];
    for (const x of Object.values(o)) {
      const f = findStatus(x);
      if (f) return f;
    }
  }
  return undefined;
}

/** Client typé de la CLI `herdr`. Les formes JSON lues sont celles de `herdr api schema --json`. */
export class Herdr implements HerdrApi {
  constructor(private readonly log: (message: string) => void = (m) => console.error(m)) {}

  /**
   * État lu après une attente : seuls idle, done et blocked sont une fin. Tout autre état (working, inconnu…) n'est
   * pas réglé : `timeout`, avec l'état brut journalisé.
   */
  private settled(name: string, status: string | undefined): PromptOutcome {
    if (status === 'idle' || status === 'done' || status === 'blocked') return status;
    this.log(`herdr : agent ${name} dans l'état « ${status ?? 'inconnu'} » après l'attente : non réglé, traité comme timeout`);
    return 'timeout';
  }

  private async raw(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return run('herdr', args, { reject: false });
  }

  /** Appelle la CLI et rend `result` ; lève HerdrError sur code non nul. */
  private async call(args: string[]): Promise<Json> {
    const r = await this.raw(args);
    if (r.exitCode !== 0) throw parseError(r.stderr, r.stdout);
    // `pane run`, `rename`, `focus`... répondent par une sortie vide en cas de succès
    if (r.stdout.trim() === '') return {};
    try {
      return (JSON.parse(r.stdout) as Json)['result'] ?? {};
    } catch {
      throw new HerdrError('bad_json', `réponse illisible pour « herdr ${args.join(' ')} » : ${r.stdout.slice(0, 200)}`);
    }
  }

  private static pane(p: Json): HerdrPane {
    return {
      paneId: p['pane_id'],
      tabId: p['tab_id'],
      workspaceId: p['workspace_id'],
      ...(p['label'] ? { label: p['label'] } : {}),
      ...(p['agent'] ? { agent: p['agent'] } : {}),
    };
  }

  async workspaceList(): Promise<HerdrWorkspace[]> {
    const r = await this.call(['workspace', 'list']);
    return (r['workspaces'] as Json[]).map((w) => ({ workspaceId: w['workspace_id'], label: w['label'] ?? '' }));
  }

  /** `worktree_created` : `result.workspace.workspace_id` et `result.worktree.path`. */
  async worktreeCreate(a: { cwd: string; branch: string; base: string; path: string; label: string }): Promise<{ workspaceId: string; path: string }> {
    const r = await this.call(['worktree', 'create', '--cwd', a.cwd, '--branch', a.branch, '--base', a.base, '--path', a.path, '--label', a.label, '--no-focus']);
    return { workspaceId: r['workspace']['workspace_id'], path: r['worktree']['path'] };
  }

  async workspaceFocus(id: string): Promise<void> {
    await this.call(['workspace', 'focus', id]);
  }

  async workspaceClose(id: string): Promise<void> {
    await this.call(['workspace', 'close', id]);
  }

  async tabList(ws: string): Promise<HerdrTab[]> {
    const r = await this.call(['tab', 'list', '--workspace', ws]);
    return (r['tabs'] as Json[]).map((t) => ({ tabId: t['tab_id'], workspaceId: t['workspace_id'], label: t['label'] ?? '', number: t['number'] }));
  }

  async tabCreate(a: { workspace: string; cwd: string; label: string }): Promise<{ tabId: string; rootPaneId: string }> {
    const r = await this.call(['tab', 'create', '--workspace', a.workspace, '--cwd', a.cwd, '--label', a.label, '--no-focus']);
    return { tabId: r['tab']['tab_id'], rootPaneId: r['root_pane']['pane_id'] };
  }

  async tabRename(tab: string, label: string): Promise<void> {
    await this.call(['tab', 'rename', tab, label]);
  }

  async tabFocus(tab: string): Promise<void> {
    await this.call(['tab', 'focus', tab]);
  }

  async paneList(ws: string): Promise<HerdrPane[]> {
    const r = await this.call(['pane', 'list', '--workspace', ws]);
    return (r['panes'] as Json[]).map(Herdr.pane);
  }

  async paneSplit(a: { pane: string; direction: 'right' | 'down'; ratio?: number; cwd: string }): Promise<{ paneId: string; tabId: string }> {
    const args = ['pane', 'split', '--pane', a.pane, '--direction', a.direction, '--cwd', a.cwd, '--no-focus'];
    if (a.ratio !== undefined) args.push('--ratio', String(a.ratio));
    const r = await this.call(args);
    return { paneId: r['pane']['pane_id'], tabId: r['pane']['tab_id'] };
  }

  async paneRename(pane: string, label: string): Promise<void> {
    await this.call(['pane', 'rename', pane, label]);
  }

  async paneRun(pane: string, cmd: string): Promise<void> {
    await this.call(['pane', 'run', pane, cmd]);
  }

  async paneWaitOutput(pane: string, match: string, timeoutMs: number): Promise<boolean> {
    const r = await this.raw(['pane', 'wait-output', pane, '--match', match, '--source', 'recent', '--timeout', String(timeoutMs)]);
    if (r.exitCode === 0) return true;
    const e = parseError(r.stderr, r.stdout);
    if (/timeout|timed_out/.test(e.code)) return false;
    throw e;
  }

  /** `pane_layout` : `result.layout.panes[] = {pane_id, rect}`. */
  async paneLayout(pane: string): Promise<PaneLayoutEntry[]> {
    const r = await this.call(['pane', 'layout', '--pane', pane]);
    return (r['layout']['panes'] as Json[]).map((p) => ({ paneId: p['pane_id'], rect: p['rect'] }));
  }

  /** `pane_process_info` : `result.process_info.{shell_pid, foreground_processes[].pid}`. */
  async paneProcessInfo(pane: string): Promise<PaneProcessInfo> {
    const r = (await this.call(['pane', 'process-info', '--pane', pane]))['process_info'] as Json;
    return { shellPid: r['shell_pid'] ?? null, foregroundPids: ((r['foreground_processes'] ?? []) as Json[]).map((p) => p['pid']) };
  }

  async paneSendKeys(pane: string, ...keys: string[]): Promise<void> {
    await this.call(['pane', 'send-keys', pane, ...keys]);
  }

  /** `pane_info` : `result.pane.{pane_id, tab_id, workspace_id, cwd}`. */
  async paneCurrent(): Promise<{ paneId: string; tabId: string; workspaceId: string; cwd: string }> {
    const p = (await this.call(['pane', 'current']))['pane'] as Json;
    for (const k of ['pane_id', 'tab_id', 'workspace_id']) {
      if (typeof p?.[k] !== 'string' || p[k] === '') throw new HerdrError('bad_response', `« herdr pane current » : champ ${k} absent ou vide`);
    }
    return { paneId: p['pane_id'], tabId: p['tab_id'], workspaceId: p['workspace_id'], cwd: typeof p['cwd'] === 'string' ? p['cwd'] : '' };
  }

  async agentStart(name: string, kind: string, pane: string, args: string[], timeoutMs: number): Promise<void> {
    await this.call(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(timeoutMs), ...(args.length ? ['--', ...args] : [])]);
  }

  /** Sans attente : `sent`. Avec attente : l'état réglé, ou `timeout` / `stalled` / `blocked` selon le code d'erreur herdr. */
  async agentPrompt(name: string, text: string, opts: { wait: boolean; timeoutMs?: number }): Promise<PromptOutcome> {
    const args = ['agent', 'prompt', name, text];
    if (opts.wait) args.push('--wait');
    if (opts.timeoutMs !== undefined) args.push('--timeout', String(opts.timeoutMs));
    const r = await this.raw(args);
    if (r.exitCode !== 0) {
      const e = parseError(r.stderr, r.stdout);
      if (/stalled/.test(e.code)) return 'stalled';
      if (/timeout|timed_out/.test(e.code)) return 'timeout';
      if (/blocked/.test(e.code)) return 'blocked';
      throw e;
    }
    if (!opts.wait) return 'sent';
    let status: string | undefined;
    try {
      status = findStatus(JSON.parse(r.stdout));
    } catch {
      /* repli ci-dessous */
    }
    status ??= (await this.agentGet(name))?.state;
    return this.settled(name, status);
  }

  /**
   * Attend, sans rien envoyer, qu'un agent atteigne idle, done ou blocked (`herdr agent wait`).
   * Rend l'état atteint, ou `timeout` / `stalled` selon le code d'erreur herdr.
   */
  async agentWait(name: string, opts: { until: ('idle' | 'done' | 'blocked')[]; timeoutMs: number }): Promise<PromptOutcome> {
    const args = ['agent', 'wait', name, ...opts.until.flatMap((u) => ['--until', u]), '--timeout', String(opts.timeoutMs)];
    const r = await this.raw(args);
    if (r.exitCode !== 0) {
      const e = parseError(r.stderr, r.stdout);
      if (/stalled/.test(e.code)) return 'stalled';
      if (/timeout|timed_out/.test(e.code)) return 'timeout';
      if (/blocked/.test(e.code)) return 'blocked';
      throw e;
    }
    let status: string | undefined;
    try {
      status = findStatus(JSON.parse(r.stdout));
    } catch {
      /* repli ci-dessous */
    }
    status ??= (await this.agentGet(name))?.state;
    return this.settled(name, status);
  }

  /** `agent_info` : `result.agent.agent_status` ; `null` si l'agent n'existe pas (`agent_not_found`). */
  async agentGet(name: string): Promise<{ state: string } | null> {
    const r = await this.raw(['agent', 'get', name]);
    if (r.exitCode !== 0) {
      const e = parseError(r.stderr, r.stdout);
      if (e.code === 'agent_not_found') return null;
      throw e;
    }
    const a = (JSON.parse(r.stdout) as Json)['result']['agent'] as Json;
    return { state: a['agent_status'] };
  }

  /** `agent read` rend du texte brut, pas du JSON. */
  async agentRead(name: string, lines: number): Promise<string> {
    const r = await this.raw(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines)]);
    if (r.exitCode !== 0) throw parseError(r.stderr, r.stdout);
    return r.stdout;
  }

  async notify(title: string, body: string, sound: 'done' | 'request'): Promise<void> {
    await this.call(['notification', 'show', title, '--body', body, '--sound', sound]);
  }
}
