import type { HerdrApi, HerdrPane, HerdrTab, HerdrWorkspace, PaneLayoutEntry, PaneProcessInfo } from '../../src/herdr/client.js';

interface FakePane extends HerdrPane {
  rect: { x: number; y: number; width: number; height: number };
  busy: boolean;
}

/** Doublure de Herdr : un seul espace, des onglets et des panneaux avec leurs `rect`. */
export class FakeHerdr implements HerdrApi {
  calls: string[] = [];
  workspaces: HerdrWorkspace[] = [];
  tabs: HerdrTab[] = [];
  panes: FakePane[] = [];
  runs: { pane: string; cmd: string }[] = [];
  private n = 0;
  private nextId(): number {
    return ++this.n;
  }

  /** Prépare un espace avec un onglet (au libellé donné) et un panneau racine de 200x60. */
  seedWorkspace(label: string, firstTabLabel = 'shell'): { ws: string; tab: string; pane: string } {
    const ws = `w${this.nextId()}`;
    this.workspaces.push({ workspaceId: ws, label });
    const tab = this.addTab(ws, firstTabLabel);
    return { ws, tab: tab.tabId, pane: tab.rootPaneId };
  }

  private addTab(ws: string, label: string): { tabId: string; rootPaneId: string } {
    const tabId = `${ws}:t${this.nextId()}`;
    this.tabs.push({ tabId, workspaceId: ws, label, number: this.tabs.length + 1 });
    const paneId = `${ws}:p${this.nextId()}`;
    this.panes.push({ paneId, tabId, workspaceId: ws, rect: { x: 0, y: 0, width: 200, height: 60 }, busy: false });
    return { tabId, rootPaneId: paneId };
  }

  addPane(tabId: string, rect: FakePane['rect'], label?: string): string {
    const ws = tabId.split(':')[0] as string;
    const paneId = `${ws}:p${this.nextId()}`;
    this.panes.push({ paneId, tabId, workspaceId: ws, rect, busy: false, ...(label ? { label } : {}) });
    return paneId;
  }

  pane(id: string): FakePane {
    const p = this.panes.find((x) => x.paneId === id);
    if (!p) throw new Error(`panneau ${id} inconnu`);
    return p;
  }

  async workspaceList(): Promise<HerdrWorkspace[]> {
    return this.workspaces;
  }
  async worktreeCreate(a: { cwd: string; branch: string; base: string; path: string; label: string }) {
    this.calls.push(`worktreeCreate ${a.label} ${a.branch} ${a.base} ${a.path} ${a.cwd}`);
    const s = this.seedWorkspace(a.label);
    return { workspaceId: s.ws, path: a.path };
  }
  async workspaceFocus(id: string) {
    this.calls.push(`workspaceFocus ${id}`);
  }
  async workspaceClose(id: string) {
    this.calls.push(`workspaceClose ${id}`);
    this.workspaces = this.workspaces.filter((w) => w.workspaceId !== id);
  }
  async tabList(ws: string): Promise<HerdrTab[]> {
    return this.tabs.filter((t) => t.workspaceId === ws);
  }
  async tabCreate(a: { workspace: string; cwd: string; label: string }) {
    this.calls.push(`tabCreate ${a.label} ${a.cwd}`);
    return this.addTab(a.workspace, a.label);
  }
  async tabRename(tab: string, label: string) {
    this.calls.push(`tabRename ${label}`);
    const t = this.tabs.find((x) => x.tabId === tab);
    if (t) t.label = label;
  }
  async tabFocus(tab: string) {
    this.calls.push(`tabFocus ${tab}`);
  }
  async tabClose(tab: string) {
    this.calls.push(`tabClose ${tab}`);
    this.tabs = this.tabs.filter((t) => t.tabId !== tab);
    this.panes = this.panes.filter((p) => p.tabId !== tab);
  }
  async paneList(ws: string): Promise<HerdrPane[]> {
    return this.panes.filter((p) => p.workspaceId === ws).map(({ rect: _r, busy: _b, ...p }) => p);
  }
  async paneSplit(a: { pane: string; direction: 'right' | 'down'; ratio?: number; cwd: string }) {
    this.calls.push(`paneSplit ${a.direction} ${a.ratio ?? '-'} ${a.cwd}`);
    const src = this.pane(a.pane);
    const r = src.rect;
    let nr: FakePane['rect'];
    if (a.direction === 'right') {
      const w = Math.floor(r.width / 2);
      nr = { x: r.x + r.width - w, y: r.y, width: w, height: r.height };
      src.rect = { ...r, width: r.width - w };
    } else {
      const h = Math.floor(r.height / 2);
      nr = { x: r.x, y: r.y + r.height - h, width: r.width, height: h };
      src.rect = { ...r, height: r.height - h };
    }
    return { paneId: this.addPane(src.tabId, nr), tabId: src.tabId };
  }
  async paneRename(pane: string, label: string) {
    this.calls.push(`paneRename ${label}`);
    this.pane(pane).label = label;
  }
  async paneRun(pane: string, cmd: string) {
    this.calls.push(`paneRun ${cmd}`);
    this.runs.push({ pane, cmd });
  }
  async paneWaitOutput() {
    return true;
  }
  async paneLayout(pane: string): Promise<PaneLayoutEntry[]> {
    const tab = this.pane(pane).tabId;
    return this.panes.filter((p) => p.tabId === tab).map((p) => ({ paneId: p.paneId, rect: p.rect }));
  }
  async paneProcessInfo(pane: string): Promise<PaneProcessInfo> {
    return { shellPid: 1, foregroundPids: this.pane(pane).busy ? [2] : [1] };
  }
  async paneSendKeys(pane: string, ...keys: string[]) {
    this.calls.push(`paneSendKeys ${keys.join(' ')}`);
    if (keys.includes('ctrl+c')) this.pane(pane).busy = false;
  }
  async paneCurrent() {
    const p = this.panes[0];
    if (!p) throw new Error('aucun panneau');
    return { paneId: p.paneId, tabId: p.tabId, workspaceId: p.workspaceId, cwd: '/fake' };
  }
}
