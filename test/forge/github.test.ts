import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/exec.js';
import { createPr, findPr, readIssue } from '../../src/forge/github.js';

type Call = { cmd: string; args: string[]; cwd?: string };

function fake(stdout: string) {
  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[], opts?: { cwd?: string }): Promise<RunResult> => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return { stdout, stderr: '', exitCode: 0 };
  };
  return { calls, runner };
}

describe('readIssue', () => {
  it('lit titre, corps et commentaires de la sortie gh', async () => {
    const f = fake(JSON.stringify({ title: 'T', body: 'B', comments: [{ body: 'c1' }, { body: 'c2' }] }));
    const r = await readIssue('https://github.com/o/r/issues/1', f.runner);
    expect(r).toEqual({ title: 'T', body: 'B', comments: ['c1', 'c2'] });
    expect(f.calls[0]).toMatchObject({ cmd: 'gh', args: ['issue', 'view', 'https://github.com/o/r/issues/1', '--json', 'title,body,comments'] });
  });
});

describe('createPr', () => {
  it('rend l’URL de la PR', async () => {
    const f = fake('https://github.com/o/r/pull/9\n');
    const url = await createPr('/wt', { base: 'main', title: 'Titre', bodyFile: '/b.md' }, f.runner);
    expect(url).toBe('https://github.com/o/r/pull/9');
    expect(f.calls[0]).toMatchObject({
      cmd: 'gh',
      args: ['pr', 'create', '--base', 'main', '--title', 'Titre', '--body-file', '/b.md'],
      cwd: '/wt',
    });
  });
});

describe('findPr', () => {
  it('rend l’URL de la PR ouverte pour la branche', async () => {
    const calls: Call[] = [];
    const runner = async (cmd: string, args: string[], opts?: { cwd?: string }): Promise<RunResult> => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { stdout: '{"url":"https://github.com/o/r/pull/4","state":"OPEN"}\n', stderr: '', exitCode: 0 };
    };
    expect(await findPr('/wt', 'feature/x', runner)).toBe('https://github.com/o/r/pull/4');
    expect(calls[0]).toMatchObject({ cmd: 'gh', args: ['pr', 'view', 'feature/x', '--json', 'url,state'], cwd: '/wt' });
  });

  it('rend null sans PR pour la branche ou si la PR est fermée', async () => {
    const none = async (): Promise<RunResult> => ({ stdout: '', stderr: 'no pull requests found for branch "feature/x"', exitCode: 1 });
    expect(await findPr('/wt', 'feature/x', none)).toBeNull();
    const closed = async (): Promise<RunResult> => ({ stdout: '{"url":"https://github.com/o/r/pull/4","state":"CLOSED"}', stderr: '', exitCode: 0 });
    expect(await findPr('/wt', 'feature/x', closed)).toBeNull();
  });
});
