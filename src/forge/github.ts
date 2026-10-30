import { run, type RunOptions, type RunResult } from '../exec.js';

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export async function readIssue(
  url: string,
  runner: Runner = run,
): Promise<{ title: string; body: string; comments: string[] }> {
  const r = await runner('gh', ['issue', 'view', url, '--json', 'title,body,comments']);
  const j = JSON.parse(r.stdout) as { title: string; body: string; comments?: { body: string }[] };
  return { title: j.title, body: j.body ?? '', comments: (j.comments ?? []).map((c) => c.body) };
}

export async function createPr(
  wt: string,
  opts: { base: string; title: string; bodyFile: string },
  runner: Runner = run,
): Promise<string> {
  const r = await runner('gh', ['pr', 'create', '--base', opts.base, '--title', opts.title, '--body-file', opts.bodyFile], {
    cwd: wt,
  });
  return r.stdout.trim();
}

/** PR ouverte pour la branche, ou null (aucune PR, ou PR fermée / fusionnée). */
export async function findPr(wt: string, branch: string, runner: Runner = run): Promise<string | null> {
  const r = await runner('gh', ['pr', 'view', branch, '--json', 'url,state'], { cwd: wt, reject: false });
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  const j = JSON.parse(r.stdout) as { url?: string; state?: string };
  return j.state === 'OPEN' && j.url ? j.url : null;
}
