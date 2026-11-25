import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrApi, HerdrPane, PaneProcessInfo } from './client.js';

/** Tunable delays (tests set them to 0). */
// Claude Code quits only when the second ctrl+c follows the first quickly (measured: 1500 ms is not enough, 300 ms is).
export const timing = { retireDelayMs: 250, pollMs: 500, retirePolls: 20, signalPolls: 6 };

/** Sends a signal to a process; replaceable in tests. */
export const signals = { kill: (pid: number, sig: 'SIGTERM' | 'SIGKILL'): void => void process.kill(pid, sig) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wsOf = (id: string) => id.split(':')[0] as string;

export interface MissionSpace {
  workspace: string;
  worktree: string;
  tabs: { master: string; docs: string; agents: string; checks: string; process: string };
  panes: { orchestrator: string; tasks: string; lazygit: string; engine: string; spec: string; plan: string };
}

export async function createMissionSpace(
  h: HerdrApi,
  opts: { projectCwd: string; id: string; branch: string; base: string; worktreePath: string },
): Promise<MissionSpace> {
  const wt = opts.worktreePath;
  const existing = (await h.workspaceList()).find((w) => w.label === opts.id);
  const workspace =
    existing?.workspaceId ?? (await h.worktreeCreate({ cwd: opts.projectCwd, branch: opts.branch, base: opts.base, path: wt, label: opts.id })).workspaceId;

  const tabsNow = async () => [...(await h.tabList(workspace))].sort((a, b) => a.number - b.number);
  let tabs = await tabsNow();
  let master = tabs.find((t) => t.label === 'master')?.tabId;
  if (!master) {
    const first = tabs[0];
    if (!first) throw new Error(`workspace ${workspace} has no tab`);
    await h.tabRename(first.tabId, 'master');
    master = first.tabId;
  }

  // Master tab: orchestrator | tasks / lazygit
  let panes = await h.paneList(workspace);
  const inTab = (tab: string) => panes.filter((p) => p.tabId === tab);
  const byLabel = (tab: string, label: string): HerdrPane | undefined => inTab(tab).find((p) => p.label === label);

  let orchestrator = byLabel(master, 'orchestrator')?.paneId;
  if (!orchestrator) {
    const root = inTab(master).find((p) => !p.label) ?? inTab(master)[0];
    if (!root) throw new Error('master tab has no pane');
    await h.paneRename(root.paneId, 'orchestrator');
    orchestrator = root.paneId;
  }
  let tasks = byLabel(master, 'tasks')?.paneId;
  if (!tasks) {
    tasks = (await h.paneSplit({ pane: orchestrator, direction: 'right', ratio: 0.5, cwd: wt })).paneId;
    await h.paneRename(tasks, 'tasks');
  }
  let lazygit = byLabel(master, 'lazygit')?.paneId;
  if (!lazygit) {
    lazygit = (await h.paneSplit({ pane: tasks, direction: 'down', ratio: 0.5, cwd: wt })).paneId;
    await h.paneRename(lazygit, 'lazygit');
    await h.paneRun(lazygit, `lazygit -p ${wt}`);
  }

  const ensureTab = async (label: string): Promise<{ tabId: string; created: string | null }> => {
    const found = (await tabsNow()).find((t) => t.label === label);
    if (found) return { tabId: found.tabId, created: null };
    const c = await h.tabCreate({ workspace, cwd: wt, label });
    return { tabId: c.tabId, created: c.rootPaneId };
  };
  // herdr has no reordering: `docs` is created right after master, creation order is tab order.
  const docsTab = await ensureTab('docs');
  const agents = (await ensureTab('agents')).tabId;
  const checks = (await ensureTab('checks')).tabId;
  const proc = await ensureTab('process');

  panes = await h.paneList(workspace);
  let engine = byLabel(proc.tabId, 'engine')?.paneId;
  if (!engine) {
    engine = proc.created ?? inTab(proc.tabId)[0]?.paneId;
    if (!engine) throw new Error('process tab has no pane');
    await h.paneRename(engine, 'engine');
  }

  // Docs tab: spec | plan
  panes = await h.paneList(workspace);
  let spec = byLabel(docsTab.tabId, 'spec')?.paneId;
  if (!spec) {
    spec = docsTab.created ?? inTab(docsTab.tabId).find((p) => !p.label)?.paneId ?? inTab(docsTab.tabId)[0]?.paneId;
    if (!spec) throw new Error('docs tab has no pane');
    await h.paneRename(spec, 'spec');
  }
  let plan = byLabel(docsTab.tabId, 'plan')?.paneId;
  if (!plan) {
    plan = (await h.paneSplit({ pane: spec, direction: 'right', ratio: 0.5, cwd: wt })).paneId;
    await h.paneRename(plan, 'plan');
  }

  return {
    workspace,
    worktree: wt,
    tabs: { master, docs: docsTab.tabId, agents, checks, process: proc.tabId },
    panes: { orchestrator, tasks, lazygit, engine, spec, plan },
  };
}

/**
 * Single rule (layout and lifecycle): a pane is idle when no process other than its shell
 * is in the foreground; an empty list counts as idle.
 */
export function paneIsIdle(i: PaneProcessInfo): boolean {
  return i.foregroundPids.every((p) => p === i.shellPid);
}

/** A pane is free: no recognized agent and nothing but the shell in the foreground. */
async function isFree(h: HerdrApi, pane: HerdrPane): Promise<boolean> {
  if (pane.agent) return false;
  return paneIsIdle(await h.paneProcessInfo(pane.paneId));
}

/** Re-reads the pane (the agent may have gone) until it is free; `polls` attempts. */
async function freedWithin(h: HerdrApi, pane: HerdrPane, polls: number): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    const fresh = (await h.paneList(wsOf(pane.paneId))).find((p) => p.paneId === pane.paneId) ?? pane;
    if (await isFree(h, fresh)) return true;
    await sleep(timing.pollMs);
  }
  return false;
}

/**
 * Frees a finished pane: double ctrl+c, then SIGTERM and finally SIGKILL to the foreground processes (never the
 * shell). The failure message names the agent and the PIDs, so one knows what to stop by hand.
 */
async function retire(h: HerdrApi, pane: HerdrPane): Promise<void> {
  if (await isFree(h, pane)) return;
  for (let i = 0; i < 2; i++) {
    await h.paneSendKeys(pane.paneId, 'ctrl+c');
    await sleep(timing.retireDelayMs);
  }
  if (await freedWithin(h, pane, timing.retirePolls)) return;
  let pids: number[] = [];
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    const info = await h.paneProcessInfo(pane.paneId);
    pids = info.foregroundPids.filter((p) => p !== info.shellPid);
    for (const pid of pids) {
      try {
        signals.kill(pid, sig);
      } catch {
        /* process already finished */
      }
    }
    if (await freedWithin(h, pane, timing.signalPolls)) return;
  }
  const who = [pane.label, pane.agent ? `agent ${pane.agent}` : undefined, pids.length ? `PID ${pids.join(', ')}` : undefined].filter(Boolean).join(', ');
  throw new Error(`pane ${pane.paneId}${who ? ` (${who})` : ''} did not return to the shell after ctrl+c, SIGTERM and SIGKILL`);
}

/**
 * Stops a pane's agent and returns it to the shell. `false` when the pane is not found or already free
 * (no call to `paneSendKeys`). The error from `retire` propagates as-is.
 */
export async function release(h: HerdrApi, paneId: string): Promise<boolean> {
  const pane = (await h.paneList(wsOf(paneId))).find((p) => p.paneId === paneId);
  if (!pane || (await isFree(h, pane))) return false;
  await retire(h, pane);
  return true;
}

/** Stops the panes of a tab: those marked ✓ or ✗ (`done`), or all of them (`all`). A failure does not stop the scan. */
export async function releaseTab(
  h: HerdrApi,
  tab: string,
  which: 'done' | 'all',
): Promise<{ released: string[]; failed: string[] }> {
  const panes = (await h.paneList(wsOf(tab))).filter((p) => p.tabId === tab);
  const targets = which === 'done' ? panes.filter((p) => /[✓✗]/.test(p.label ?? '')) : panes;
  const released: string[] = [];
  const failed: string[] = [];
  for (const pane of targets) {
    try {
      if (await release(h, pane.paneId)) released.push(pane.label ?? pane.paneId);
    } catch (err) {
      failed.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { released, failed };
}

/** Same rule as `cmd_slot` in herdr-ticket-grid.sh. Returns the id of a free pane, named `label`. */
export async function slot(h: HerdrApi, tab: string, cwd: string, label: string, max = 6): Promise<string> {
  const ws = wsOf(tab);
  const panes = (await h.paneList(ws)).filter((p) => p.tabId === tab);
  if (panes.length === 0) throw new Error(`tab ${tab} not found or empty`);

  // 1. pane never used
  for (const p of panes) {
    if (!p.label && (await isFree(h, p))) {
      await h.paneRename(p.paneId, label);
      return p.paneId;
    }
  }

  // 2. free slot: split the largest pane
  if (panes.length < max) {
    const layout = await h.paneLayout((panes[0] as HerdrPane).paneId);
    const area = (p: (typeof layout)[number]) => p.rect.width * p.rect.height;
    const big = layout.reduce((a, b) => {
      if (area(b) !== area(a)) return area(b) > area(a) ? b : a;
      if (b.rect.y !== a.rect.y) return b.rect.y < a.rect.y ? b : a;
      return b.rect.x < a.rect.x ? b : a;
    });
    const direction = big.rect.width > 2 * big.rect.height ? 'right' : 'down';
    const created = await h.paneSplit({ pane: big.paneId, direction, cwd });
    await h.paneRename(created.paneId, label);
    return created.paneId;
  }

  // 3. full grid: recycle the oldest finished pane (✓ or ✗)
  const num = (l?: string) => Number(/\d+/.exec(l ?? '')?.[0] ?? Number.MAX_SAFE_INTEGER);
  const done = panes.filter((p) => /[✓✗]/.test(p.label ?? '')).sort((a, b) => num(a.label) - num(b.label));
  const victim = done[0];
  if (!victim) throw new Error(`grid full (${max} panes) and no finished task to recycle`);
  await retire(h, victim);
  await h.paneRename(victim.paneId, label);
  return victim.paneId;
}

/** Adds ✓ or ✗ to the pane label (replacing a previous mark). */
export async function markDone(h: HerdrApi, pane: string, mark: '✓' | '✗'): Promise<void> {
  const p = (await h.paneList(wsOf(pane))).find((x) => x.paneId === pane);
  const label = (p?.label ?? '').replace(/ [✓✗]$/, '');
  await h.paneRename(pane, `${label} ${mark}`);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Script in logDir, `tee` to the log, code in `.exit`, marker absent from the typed line. */
export async function runInPane(
  h: HerdrApi,
  tab: string,
  cwd: string,
  label: string,
  cmd: string[],
  logDir: string,
  timeoutMs = 5_400_000,
): Promise<{ exitCode: number; logPath: string; tail: string; durationMs: number }> {
  await mkdir(logDir, { recursive: true });
  const id = String(Date.now());
  const slug = label.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40);
  const base = join(logDir, `${id}-${slug}`);
  const logPath = `${base}.log`;
  const codePath = `${base}.exit`;
  const runner = `${base}.sh`;
  const marker = `__HN_FIN_${id}__`;
  const quoted = cmd.map(shq).join(' ');

  await writeFile(
    runner,
    [
      '#!/usr/bin/env bash',
      `cd ${shq(cwd)} || exit 1`,
      `printf '\\n\\033[1m$ %s\\033[0m\\n\\n' ${shq(cmd.join(' '))}`,
      `{ ${quoted} ; } 2>&1 | tee ${shq(logPath)}`,
      `echo "\${PIPESTATUS[0]}" > ${shq(codePath)}`,
      `echo; echo "${marker}"`,
      '',
    ].join('\n'),
  );
  await chmod(runner, 0o755);

  const start = Date.now();
  const pane = await slot(h, tab, cwd, `${label} …`);
  await h.paneRun(pane, shq(runner));
  const finished = await h.paneWaitOutput(pane, marker, timeoutMs);

  let exitCode = 124;
  if (finished) {
    const raw = await readFile(codePath, 'utf8').catch(() => '');
    const n = Number.parseInt(raw.trim(), 10);
    exitCode = Number.isNaN(n) ? 255 : n;
  }
  const durationMs = Date.now() - start;
  await h.paneRename(pane, label);
  await markDone(h, pane, exitCode === 0 ? '✓' : '✗');
  const log = await readFile(logPath, 'utf8').catch(() => '');
  const tail = log.split('\n').slice(-60).join('\n');
  return { exitCode, logPath, tail, durationMs };
}
