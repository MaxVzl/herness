import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrApi, HerdrPane, PaneProcessInfo } from './client.js';

/** Délais réglables (les tests les mettent à 0). */
// Claude Code ne quitte que si le second ctrl+c suit vite le premier (mesuré : 1500 ms ne suffit pas, 300 ms oui).
export const timing = { retireDelayMs: 250, pollMs: 500, retirePolls: 20, signalPolls: 6 };

/** Envoi d'un signal à un processus ; remplaçable dans les tests. */
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
    if (!first) throw new Error(`espace ${workspace} sans onglet`);
    await h.tabRename(first.tabId, 'master');
    master = first.tabId;
  }

  // Onglet master : orchestrator | tasks / lazygit
  let panes = await h.paneList(workspace);
  const inTab = (tab: string) => panes.filter((p) => p.tabId === tab);
  const byLabel = (tab: string, label: string): HerdrPane | undefined => inTab(tab).find((p) => p.label === label);

  let orchestrator = byLabel(master, 'orchestrator')?.paneId;
  if (!orchestrator) {
    const root = inTab(master).find((p) => !p.label) ?? inTab(master)[0];
    if (!root) throw new Error(`onglet master sans panneau`);
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
  // herdr n'a pas de réordonnancement : `docs` est créé juste après master, l'ordre de création fait l'ordre des onglets.
  const docsTab = await ensureTab('docs');
  const agents = (await ensureTab('agents')).tabId;
  const checks = (await ensureTab('checks')).tabId;
  const proc = await ensureTab('process');

  panes = await h.paneList(workspace);
  let engine = byLabel(proc.tabId, 'engine')?.paneId;
  if (!engine) {
    engine = proc.created ?? inTab(proc.tabId)[0]?.paneId;
    if (!engine) throw new Error(`onglet process sans panneau`);
    await h.paneRename(engine, 'engine');
  }

  // Onglet docs : spec | plan
  panes = await h.paneList(workspace);
  let spec = byLabel(docsTab.tabId, 'spec')?.paneId;
  if (!spec) {
    spec = docsTab.created ?? inTab(docsTab.tabId).find((p) => !p.label)?.paneId ?? inTab(docsTab.tabId)[0]?.paneId;
    if (!spec) throw new Error(`onglet docs sans panneau`);
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
 * Règle unique (disposition et cycle de vie) : un panneau est au repos quand aucun processus autre que son shell
 * n'est au premier plan ; une liste vide compte comme au repos.
 */
export function paneIsIdle(i: PaneProcessInfo): boolean {
  return i.foregroundPids.every((p) => p === i.shellPid);
}

/** Un panneau est libre : aucun agent reconnu et rien d'autre que le shell au premier plan. */
async function isFree(h: HerdrApi, pane: HerdrPane): Promise<boolean> {
  if (pane.agent) return false;
  return paneIsIdle(await h.paneProcessInfo(pane.paneId));
}

/** Relit le panneau (l'agent a pu disparaître) jusqu'à ce qu'il soit libre ; `polls` essais. */
async function freedWithin(h: HerdrApi, pane: HerdrPane, polls: number): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    const fresh = (await h.paneList(wsOf(pane.paneId))).find((p) => p.paneId === pane.paneId) ?? pane;
    if (await isFree(h, fresh)) return true;
    await sleep(timing.pollMs);
  }
  return false;
}

/**
 * Libère un panneau terminé : double ctrl+c, puis SIGTERM et enfin SIGKILL aux processus au premier plan (jamais au
 * shell). Le message d'échec nomme l'agent et les PID, pour savoir quoi arrêter à la main.
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
        /* processus déjà terminé */
      }
    }
    if (await freedWithin(h, pane, timing.signalPolls)) return;
  }
  const who = [pane.label, pane.agent ? `agent ${pane.agent}` : undefined, pids.length ? `PID ${pids.join(', ')}` : undefined].filter(Boolean).join(', ');
  throw new Error(`le panneau ${pane.paneId}${who ? ` (${who})` : ''} n'est pas revenu au shell après ctrl+c, SIGTERM et SIGKILL`);
}

/**
 * Arrête l'agent d'un panneau et le rend au shell. `false` si le panneau est introuvable ou déjà libre
 * (aucun appel à `paneSendKeys`). L'erreur de `retire` remonte telle quelle.
 */
export async function release(h: HerdrApi, paneId: string): Promise<boolean> {
  const pane = (await h.paneList(wsOf(paneId))).find((p) => p.paneId === paneId);
  if (!pane || (await isFree(h, pane))) return false;
  await retire(h, pane);
  return true;
}

/** Arrête les panneaux d'un onglet : ceux marqués ✓ ou ✗ (`done`), ou tous (`all`). Un échec n'arrête pas le balayage. */
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

/** Même règle que `cmd_slot` de herdr-ticket-grid.sh. Rend l'identifiant d'un panneau libre, nommé `label`. */
export async function slot(h: HerdrApi, tab: string, cwd: string, label: string, max = 6): Promise<string> {
  const ws = wsOf(tab);
  const panes = (await h.paneList(ws)).filter((p) => p.tabId === tab);
  if (panes.length === 0) throw new Error(`onglet ${tab} introuvable ou vide`);

  // 1. panneau jamais utilisé
  for (const p of panes) {
    if (!p.label && (await isFree(h, p))) {
      await h.paneRename(p.paneId, label);
      return p.paneId;
    }
  }

  // 2. place libre : couper le plus grand panneau
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

  // 3. grille pleine : recycler le plus ancien panneau terminé (✓ ou ✗)
  const num = (l?: string) => Number(/\d+/.exec(l ?? '')?.[0] ?? Number.MAX_SAFE_INTEGER);
  const done = panes.filter((p) => /[✓✗]/.test(p.label ?? '')).sort((a, b) => num(a.label) - num(b.label));
  const victim = done[0];
  if (!victim) throw new Error(`grille pleine (${max} panneaux) et aucune tâche validée à recycler`);
  await retire(h, victim);
  await h.paneRename(victim.paneId, label);
  return victim.paneId;
}

/** Ajoute ✓ ou ✗ au libellé du panneau (en remplaçant une marque précédente). */
export async function markDone(h: HerdrApi, pane: string, mark: '✓' | '✗'): Promise<void> {
  const p = (await h.paneList(wsOf(pane))).find((x) => x.paneId === pane);
  const label = (p?.label ?? '').replace(/ [✓✗]$/, '');
  await h.paneRename(pane, `${label} ${mark}`);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Script dans logDir, `tee` vers le journal, code dans `.exit`, marqueur absent de la ligne tapée. */
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
