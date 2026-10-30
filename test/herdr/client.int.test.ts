import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/exec.js';
import { Herdr } from '../../src/herdr/client.js';
import { runInPane } from '../../src/herdr/layout.js';

describe.skipIf(process.env['HERDR_ENV'] !== '1')('Herdr (intégration)', () => {
  const h = new Herdr();
  let dir = '';
  let ws = '';
  let tab = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herness-herdr-'));
    // le SEUL espace créé par ce test ; il est fermé en afterAll
    const r = await run('herdr', ['workspace', 'create', '--cwd', dir, '--label', 'herness-test-int', '--no-focus']);
    const res = JSON.parse(r.stdout).result;
    ws = res.workspace.workspace_id;
    tab = res.tab.tab_id;
  });

  afterAll(async () => {
    if (ws) await h.workspaceClose(ws);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("runInPane rend exitCode 3 et le journal pour « sh -c 'echo x; exit 3' »", async () => {
    const r = await runInPane(h, tab, dir, 'echo3', ['sh', '-c', 'echo x; exit 3'], join(dir, 'logs'), 60_000);
    expect(r.exitCode).toBe(3);
    expect(await readFile(r.logPath, 'utf8')).toContain('x');
    expect(r.tail).toContain('x');
    expect(r.durationMs).toBeGreaterThan(0);
    const panes = await h.paneList(ws);
    expect(panes.some((p) => p.label === 'echo3 ✗')).toBe(true);
  }, 90_000);

  it('lit les espaces, onglets, disposition et agents inexistants', async () => {
    expect((await h.workspaceList()).some((w) => w.workspaceId === ws && w.label === 'herness-test-int')).toBe(true);
    expect((await h.tabList(ws)).map((t) => t.tabId)).toContain(tab);
    const pane = (await h.paneList(ws))[0]!;
    expect((await h.paneLayout(pane.paneId))[0]!.rect.width).toBeGreaterThan(0);
    expect((await h.paneProcessInfo(pane.paneId)).shellPid).not.toBeNull();
    expect(await h.agentGet('herness-inexistant')).toBeNull();
    expect(await h.paneWaitOutput(pane.paneId, '__jamais_present__', 500)).toBe(false);
  });
});
