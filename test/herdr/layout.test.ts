import { beforeEach, describe, expect, it } from 'vitest';
import { createMissionSpace, markDone, paneIsIdle, release, releaseTab, signals, slot, timing } from '../../src/herdr/layout.js';
import { FakeHerdr } from './fake.js';

// Real value, read before the tests set it to zero.
const RETIRE_DELAY_MS = timing.retireDelayMs;

beforeEach(() => {
  signals.kill = () => {
    throw new Error('a real signal is forbidden in tests');
  };
  timing.retireDelayMs = 0;
  timing.pollMs = 0;
});

const opts = { projectCwd: '/p', id: '1234567890', branch: 'herness/1234567890', base: 'main', worktreePath: '/wt' };

describe('createMissionSpace', () => {
  it('creates master (orchestrator | tasks / lazygit), agents, checks, process', async () => {
    const h = new FakeHerdr();
    const s = await createMissionSpace(h, opts);
    expect(h.calls[0]).toBe('worktreeCreate 1234567890 herness/1234567890 main /wt /p');
    const labels = (await h.tabList(s.workspace)).map((t) => t.label);
    expect(labels).toEqual(['master', 'docs', 'agents', 'checks', 'process']);
    expect(s.worktree).toBe('/wt');
    const byId = (id: string) => h.pane(id);
    expect(byId(s.panes.orchestrator).label).toBe('orchestrator');
    expect(byId(s.panes.tasks).label).toBe('tasks');
    expect(byId(s.panes.lazygit).label).toBe('lazygit');
    expect(byId(s.panes.engine).label).toBe('engine');
    expect(byId(s.panes.orchestrator).tabId).toBe(s.tabs.master);
    expect(byId(s.panes.tasks).tabId).toBe(s.tabs.master);
    expect(byId(s.panes.lazygit).tabId).toBe(s.tabs.master);
    expect(byId(s.panes.engine).tabId).toBe(s.tabs.process);
    // orchestrator | tasks side by side; lazygit under tasks
    expect(byId(s.panes.tasks).rect.x).toBeGreaterThan(byId(s.panes.orchestrator).rect.x);
    expect(byId(s.panes.lazygit).rect.y).toBeGreaterThan(byId(s.panes.tasks).rect.y);
    // Docs tab: spec | plan, created right after master (creation order is tab order).
    expect(s.tabs.docs).toBeTruthy();
    expect(byId(s.panes.spec).label).toBe('spec');
    expect(byId(s.panes.plan).label).toBe('plan');
    expect(byId(s.panes.spec).tabId).toBe(s.tabs.docs);
    expect(byId(s.panes.plan).tabId).toBe(s.tabs.docs);
    expect(byId(s.panes.plan).rect.x).toBeGreaterThan(byId(s.panes.spec).rect.x);
    expect((await h.tabList(s.workspace)).find((t) => t.tabId === s.tabs.docs)?.label).toBe('docs');
    expect(h.calls).toContain('paneSplit right 0.5 /wt');
    expect(h.calls).toContain('paneSplit down 0.5 /wt');
    expect(h.runs).toEqual([{ pane: s.panes.lazygit, cmd: 'lazygit -p /wt' }]);
  });

  it("adds the docs tab to a workspace that does not have one (older mission) without touching the rest", async () => {
    const h = new FakeHerdr();
    const first = await createMissionSpace(h, opts);
    const docs = h.tabs.findIndex((t) => t.tabId === first.tabs.docs);
    h.panes = h.panes.filter((p) => p.tabId !== first.tabs.docs);
    h.tabs.splice(docs, 1);
    const again = await createMissionSpace(h, opts);
    expect({ ...again.tabs, docs: '' }).toEqual({ ...first.tabs, docs: '' });
    expect(again.panes.engine).toBe(first.panes.engine);
    expect(h.pane(again.panes.spec).label).toBe('spec');
    expect(h.pane(again.panes.plan).label).toBe('plan');
    expect(h.calls.filter((c) => c === 'tabCreate docs /wt')).toHaveLength(2);
  });

  it('called again on a complete workspace creates nothing', async () => {
    const h = new FakeHerdr();
    const first = await createMissionSpace(h, opts);
    const before = h.calls.length;
    const tabsBefore = h.tabs.length;
    const panesBefore = h.panes.length;
    const again = await createMissionSpace(h, opts);
    expect(again).toEqual(first);
    expect(h.tabs.length).toBe(tabsBefore);
    expect(h.panes.length).toBe(panesBefore);
    const newCalls = h.calls.slice(before);
    expect(newCalls.filter((c) => /^(worktreeCreate|tabCreate|paneSplit|paneRun)/.test(c))).toEqual([]);
  });
});

describe('slot', () => {
  const setup = () => {
    const h = new FakeHerdr();
    const s = h.seedWorkspace('m');
    return { h, ...s };
  };

  it('takes the free root pane first', async () => {
    const { h, tab, pane } = setup();
    expect(await slot(h, tab, '/wt', 'T1')).toBe(pane);
    expect(h.pane(pane).label).toBe('T1');
  });

  it('splits a wide pane to the right and a tall pane downward', async () => {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1'; // racine 200x60 : large (200 > 2*60)
    const p2 = await slot(h, tab, '/wt', 'T2');
    expect(h.calls.at(-2)).toMatch(/^paneSplit right/);
    expect(h.pane(p2).rect.x).toBeGreaterThan(0);
    // both panes are 100x60: 100 <= 120 -> below
    await slot(h, tab, '/wt', 'T3');
    expect(h.calls.filter((c) => c.startsWith('paneSplit'))).toEqual(['paneSplit right - /wt', 'paneSplit down - /wt']);
  });

  it('recycles the oldest ✓ pane when 6 panes exist', async () => {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1 ✗';
    const ids = [pane];
    for (const l of ['T3 ✓', 'T2 ✓', 'T4', 'T5', 'T6']) ids.push(h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, l));
    for (const id of ids) h.pane(id).busy = true;
    const got = await slot(h, tab, '/wt', 'T7');
    expect(got).toBe(ids[0]); // T1 ✗ is the oldest (smallest number)
    expect(h.pane(got).label).toBe('T7');
    expect(h.calls.filter((c) => c === 'paneSendKeys ctrl+c')).toHaveLength(2);
    expect(h.panes).toHaveLength(6);
  });

  // Measured: Claude Code does not quit on two ctrl+c 1500 ms apart, but quits at 300 ms (cursor-agent does too at 250 ms).
  it('the two ctrl+c are 250 ms apart', () => {
    expect(RETIRE_DELAY_MS).toBe(250);
  });

  function fullGrid() {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1 ✓';
    for (const l of ['T2', 'T3', 'T4', 'T5', 'T6']) h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, l);
    for (const p of h.panes) p.busy = true;
    h.pane(pane).deaf = true;
    return { h, tab, pane };
  }

  it('a pane deaf to ctrl+c is freed by SIGTERM to its foreground processes, never the shell', async () => {
    const { h, tab, pane } = fullGrid();
    const sent: [number, string][] = [];
    signals.kill = (pid, sig) => {
      sent.push([pid, sig]);
      h.pane(pane).busy = false;
    };
    expect(await slot(h, tab, '/wt', 'T7')).toBe(pane);
    expect(sent).toEqual([[2, 'SIGTERM']]);
  });

  it('SIGKILL when SIGTERM is not enough', async () => {
    const { h, tab, pane } = fullGrid();
    const sent: [number, string][] = [];
    signals.kill = (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 'SIGKILL') h.pane(pane).busy = false;
    };
    expect(await slot(h, tab, '/wt', 'T7')).toBe(pane);
    expect(sent).toEqual([[2, 'SIGTERM'], [2, 'SIGKILL']]);
  });

  it('final failure: the message names the pane, its agent and the PIDs', async () => {
    const { h, tab, pane } = fullGrid();
    h.pane(pane).agent = 'claude';
    signals.kill = () => {};
    await expect(slot(h, tab, '/wt', 'T7')).rejects.toThrow(
      `pane ${pane} (T1 ✓, agent claude, PID 2) did not return to the shell after ctrl+c, SIGTERM and SIGKILL`,
    );
  });

  it('fails with "grid full" when no pane can be recycled', async () => {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1';
    for (const l of ['T2', 'T3', 'T4', 'T5', 'T6']) h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, l);
    for (const p of h.panes) p.busy = true;
    await expect(slot(h, tab, '/wt', 'T7')).rejects.toThrow(/grid full/);
  });
});

describe('markDone', () => {
  it('adds the mark without doubling it', async () => {
    const h = new FakeHerdr();
    const { pane } = h.seedWorkspace('m');
    h.pane(pane).label = 'T1 ✗';
    await markDone(h, pane, '✓');
    expect(h.pane(pane).label).toBe('T1 ✓');
  });
});

describe('release', () => {
  it('a busy pane receives two ctrl+c and returns to the shell, label unchanged', async () => {
    const h = new FakeHerdr();
    const { pane } = h.seedWorkspace('m');
    const n = h.panes.length;
    h.pane(pane).label = 'T1 · grok ✓';
    h.pane(pane).busy = true;
    h.pane(pane).agent = 'ct-1-t1';
    expect(await release(h, pane)).toBe(true);
    expect(h.calls.filter((c) => c === 'paneSendKeys ctrl+c')).toHaveLength(2);
    expect(h.pane(pane).busy).toBe(false);
    expect(h.pane(pane).agent).toBeUndefined();
    expect(h.pane(pane).label).toBe('T1 · grok ✓');
    expect(h.panes).toHaveLength(n);
  });

  it('an already free pane receives nothing', async () => {
    const h = new FakeHerdr();
    const { pane } = h.seedWorkspace('m');
    h.pane(pane).busy = false;
    expect(await release(h, pane)).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('paneSendKeys'))).toEqual([]);
  });

  it('an unknown pane returns false', async () => {
    const h = new FakeHerdr();
    h.seedWorkspace('m');
    expect(await release(h, 'w1:p999')).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('paneSendKeys'))).toEqual([]);
  });

  it("the final failure propagates with the pane, the agent and the PIDs", async () => {
    const h = new FakeHerdr();
    const { pane } = h.seedWorkspace('m');
    h.pane(pane).deaf = true;
    h.pane(pane).busy = true;
    h.pane(pane).agent = 'claude';
    signals.kill = () => {};
    await expect(release(h, pane)).rejects.toThrow(
      `pane ${pane} (agent claude, PID 2) did not return to the shell after ctrl+c, SIGTERM and SIGKILL`,
    );
  });
});

describe('releaseTab', () => {
  it('done: stops only the ✓ panes, keeps the others', async () => {
    const h = new FakeHerdr();
    const { tab, pane } = h.seedWorkspace('m', 'agents');
    h.pane(pane).label = 'T1 · grok ✓';
    h.pane(pane).busy = true;
    h.pane(pane).agent = 'ct-1-t1';
    const t2 = h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, 'T2 · grok');
    h.pane(t2).busy = true;
    h.pane(t2).agent = 'ct-1-t2';
    h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, 'T1 · opus ✓');
    expect(await releaseTab(h, tab, 'done')).toEqual({ released: ['T1 · grok ✓'], failed: [] });
    expect(h.pane(t2).busy).toBe(true);
    expect(h.pane(t2).agent).toBe('ct-1-t2');
  });

  it("all: stops every busy pane of the tab, never those of another tab", async () => {
    const h = new FakeHerdr();
    const { ws, tab, pane } = h.seedWorkspace('m', 'agents');
    h.pane(pane).label = 'T1 · grok';
    h.pane(pane).busy = true;
    h.pane(pane).agent = 'a';
    const second = h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, 'T2 · grok');
    h.pane(second).busy = true;
    h.pane(second).agent = 'b';
    const other = await h.tabCreate({ workspace: ws, cwd: '/wt', label: 'autre' });
    h.pane(other.rootPaneId).label = 'ailleurs';
    h.pane(other.rootPaneId).busy = true;
    h.pane(other.rootPaneId).agent = 'c';
    const result = await releaseTab(h, tab, 'all');
    expect(result.failed).toEqual([]);
    expect(result.released).toEqual(['T1 · grok', 'T2 · grok']);
    expect(h.pane(pane).busy).toBe(false);
    expect(h.pane(second).busy).toBe(false);
    expect(h.pane(other.rootPaneId).busy).toBe(true);
    expect(h.pane(other.rootPaneId).agent).toBe('c');
  });

  it("a failure does not prevent the following ones", async () => {
    const h = new FakeHerdr();
    const { tab, pane } = h.seedWorkspace('m', 'agents');
    h.pane(pane).label = 'T1 · grok ✓';
    h.pane(pane).deaf = true;
    h.pane(pane).busy = true;
    h.pane(pane).agent = 'claude';
    const second = h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, 'T2 · opus ✓');
    h.pane(second).busy = true;
    h.pane(second).agent = 'ct-1-t2';
    signals.kill = () => {};
    const result = await releaseTab(h, tab, 'done');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain('did not return to the shell');
    expect(result.released).toEqual(['T2 · opus ✓']);
    expect(h.pane(second).busy).toBe(false);
    expect(h.pane(second).agent).toBeUndefined();
  });
});

describe('paneIsIdle (single rule of layout and lifecycle)', () => {
  it('free = no foreground process other than the shell; empty list = free', () => {
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [] })).toBe(true);
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [1] })).toBe(true);
    expect(paneIsIdle({ shellPid: null, foregroundPids: [] })).toBe(true);
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [1, 2] })).toBe(false);
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [2] })).toBe(false);
    expect(paneIsIdle({ shellPid: null, foregroundPids: [5] })).toBe(false);
  });

  it('slot treats a pane with no foreground process (empty list) as free', async () => {
    const h = new FakeHerdr();
    const { tab, pane } = h.seedWorkspace('w', 'agents');
    h.paneProcessInfo = async () => ({ shellPid: 1, foregroundPids: [] });
    expect(await slot(h, tab, '/wt', 'T1 · m')).toBe(pane);
    expect(h.calls.some((c) => c.startsWith('paneSplit'))).toBe(false);
  });
});
