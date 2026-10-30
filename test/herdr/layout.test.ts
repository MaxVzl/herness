import { beforeEach, describe, expect, it } from 'vitest';
import { createMissionSpace, markDone, paneIsIdle, slot, timing } from '../../src/herdr/layout.js';
import { FakeHerdr } from './fake.js';

beforeEach(() => {
  timing.retireDelayMs = 0;
  timing.pollMs = 0;
});

const opts = { projectCwd: '/p', id: '1234567890', branch: 'herness/1234567890', base: 'main', worktreePath: '/wt' };

describe('createMissionSpace', () => {
  it('crée master (orchestrator | tasks / lazygit), agents, checks, process', async () => {
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
    // orchestrator | tasks côte à côte ; lazygit sous tasks
    expect(byId(s.panes.tasks).rect.x).toBeGreaterThan(byId(s.panes.orchestrator).rect.x);
    expect(byId(s.panes.lazygit).rect.y).toBeGreaterThan(byId(s.panes.tasks).rect.y);
    // Onglet docs : spec | plan, créé juste après master (l'ordre de création fait l'ordre des onglets).
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

  it("ajoute l'onglet docs à un espace qui n'en a pas (mission antérieure) sans toucher au reste", async () => {
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

  it('rappelée sur un espace complet ne crée rien', async () => {
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

  it('prend le panneau racine libre en premier', async () => {
    const { h, tab, pane } = setup();
    expect(await slot(h, tab, '/wt', 'T1')).toBe(pane);
    expect(h.pane(pane).label).toBe('T1');
  });

  it('coupe à droite un panneau large et en dessous un panneau haut', async () => {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1'; // racine 200x60 : large (200 > 2*60)
    const p2 = await slot(h, tab, '/wt', 'T2');
    expect(h.calls.at(-2)).toMatch(/^paneSplit right/);
    expect(h.pane(p2).rect.x).toBeGreaterThan(0);
    // les deux panneaux font 100x60 : 100 <= 120 -> en dessous
    await slot(h, tab, '/wt', 'T3');
    expect(h.calls.filter((c) => c.startsWith('paneSplit'))).toEqual(['paneSplit right - /wt', 'paneSplit down - /wt']);
  });

  it('recycle le plus ancien panneau ✓ quand 6 panneaux existent', async () => {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1 ✗';
    const ids = [pane];
    for (const l of ['T3 ✓', 'T2 ✓', 'T4', 'T5', 'T6']) ids.push(h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, l));
    for (const id of ids) h.pane(id).busy = true;
    const got = await slot(h, tab, '/wt', 'T7');
    expect(got).toBe(ids[0]); // T1 ✗ est le plus ancien (numéro le plus petit)
    expect(h.pane(got).label).toBe('T7');
    expect(h.calls.filter((c) => c === 'paneSendKeys ctrl+c')).toHaveLength(2);
    expect(h.panes).toHaveLength(6);
  });

  it('échoue avec « grille pleine » quand aucun panneau n’est recyclable', async () => {
    const { h, tab, pane } = setup();
    h.pane(pane).label = 'T1';
    for (const l of ['T2', 'T3', 'T4', 'T5', 'T6']) h.addPane(tab, { x: 0, y: 0, width: 10, height: 10 }, l);
    for (const p of h.panes) p.busy = true;
    await expect(slot(h, tab, '/wt', 'T7')).rejects.toThrow(/grille pleine/);
  });
});

describe('markDone', () => {
  it('ajoute la marque sans la doubler', async () => {
    const h = new FakeHerdr();
    const { pane } = h.seedWorkspace('m');
    h.pane(pane).label = 'T1 ✗';
    await markDone(h, pane, '✓');
    expect(h.pane(pane).label).toBe('T1 ✓');
  });
});

describe('paneIsIdle (règle unique de disposition et de cycle de vie)', () => {
  it('libre = aucun processus au premier plan autre que le shell ; liste vide = libre', () => {
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [] })).toBe(true);
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [1] })).toBe(true);
    expect(paneIsIdle({ shellPid: null, foregroundPids: [] })).toBe(true);
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [1, 2] })).toBe(false);
    expect(paneIsIdle({ shellPid: 1, foregroundPids: [2] })).toBe(false);
    expect(paneIsIdle({ shellPid: null, foregroundPids: [5] })).toBe(false);
  });

  it('slot prend un panneau sans processus au premier plan (liste vide) pour libre', async () => {
    const h = new FakeHerdr();
    const { tab, pane } = h.seedWorkspace('w', 'agents');
    h.paneProcessInfo = async () => ({ shellPid: 1, foregroundPids: [] });
    expect(await slot(h, tab, '/wt', 'T1 · m')).toBe(pane);
    expect(h.calls.some((c) => c.startsWith('paneSplit'))).toBe(false);
  });
});
