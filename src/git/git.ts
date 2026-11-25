import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, matchesGlob } from 'node:path';
import { run } from '../exec.js';

const git = (wt: string, args: string[], reject = true) => run('git', ['-C', wt, ...args], { reject });

export async function headSha(wt: string): Promise<string> {
  return (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function currentBranch(wt: string): Promise<string> {
  return (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
}

/** True when the file has no change, neither staged nor untracked. */
export async function isClean(wt: string, file: string): Promise<boolean> {
  return (await git(wt, ['status', '--porcelain', '--', file])).stdout.trim() === '';
}

export async function renameBranch(wt: string, from: string, to: string): Promise<void> {
  await git(wt, ['branch', '-m', from, to]);
}

export async function fetchMain(repo: string, mainBranch: string): Promise<void> {
  await git(repo, ['fetch', 'origin', mainBranch]);
}

/** Updates `origin/<branch>`; fails when the remote branch does not exist or the network is missing. */
export async function fetchBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['fetch', 'origin', branch]);
}

/**
 * Commits of `branch` with no patch equivalent in `origin/<branch>` (`git cherry`): a commit rebased or
 * replayed on the remote does not count. `null`: no remote branch (tracked locally).
 */
export async function localOnlyCommits(repo: string, branch: string): Promise<number | null> {
  const remote = `origin/${branch}`;
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`], false)).exitCode !== 0) return null;
  const lines = (await git(repo, ['cherry', remote, branch])).stdout.split('\n');
  return lines.filter((l) => l.startsWith('+')).length;
}

/** Deletes the local branch (`git branch -D`); git refuses the one checked out in a worktree. */
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch]);
}

export async function identity(wt: string): Promise<{ name: string; email: string } | null> {
  const email = (await git(wt, ['config', 'user.email'], false)).stdout.trim();
  if (!email) return null;
  const name = (await git(wt, ['config', 'user.name'], false)).stdout.trim();
  return { name, email };
}

/** Reason of a failed check: `no-commit` marks an agent that stopped without committing anything. */
export type ControlCode = 'no-commit' | 'identity' | 'author' | 'dirty' | 'forbidden';
export type ControlResult = { ok: true; commits: number } | { ok: false; code: ControlCode; reason: string };

/**
 * Range of the branch commits since `base`, excluding those of `mainRef`: after a rebase, `base` is no longer
 * part of the branch and `base..HEAD` would include the main commits brought in by the rebase.
 * Without `mainRef` (missing ref), nothing is excluded.
 */
async function branchRange(wt: string, base: string, mainRef: string): Promise<string[]> {
  const known = await git(wt, ['rev-parse', '--verify', '--quiet', `${mainRef}^{commit}`], false);
  return known.exitCode === 0 ? [`${base}..HEAD`, '--not', mainRef] : [`${base}..HEAD`];
}

async function filesOf(wt: string, range: string[]): Promise<string[]> {
  const out = (await git(wt, ['log', '--name-only', '--no-renames', '--format=', ...range])).stdout;
  return [...new Set(out.split('\n').filter(Boolean))];
}

/** Files touched by the `base..HEAD` commits absent from `mainRef`, without duplicates (a rename: deletion + addition). */
export async function branchFiles(wt: string, base: string, mainRef: string): Promise<string[]> {
  return filesOf(wt, await branchRange(wt, base, mainRef));
}

/**
 * Checks the branch commits since `baseSha` (count, authors, clean tree, forbidden files).
 * Commits of `mainRef` are excluded: a rebase done by a fixer does not pull in colleagues' commits.
 */
export async function controlCommits(wt: string, baseSha: string, forbiddenPaths: string[], mainRef: string): Promise<ControlResult> {
  const range = await branchRange(wt, baseSha, mainRef);
  const commits = Number((await git(wt, ['rev-list', '--count', ...range])).stdout.trim());
  if (commits === 0) return { ok: false, code: 'no-commit', reason: `no commit since ${baseSha}` };

  const id = await identity(wt);
  if (!id) return { ok: false, code: 'identity', reason: 'git identity (user.email) is not configured in the worktree' };
  const authors = (await git(wt, ['log', '--format=%ae', ...range])).stdout.split('\n').filter(Boolean);
  const bad = [...new Set(authors.filter((a) => a !== id.email))];
  if (bad.length > 0) return { ok: false, code: 'author', reason: `author(s) ≠ ${id.email}: ${bad.join(', ')}` };

  const status = (await git(wt, ['status', '--porcelain'])).stdout.trim();
  if (status) return { ok: false, code: 'dirty', reason: `dirty tree:\n${status}` };

  const files = await filesOf(wt, range);
  const forbidden = files.filter((f) => forbiddenPaths.some((g) => matchesGlob(f, g)));
  if (forbidden.length > 0) return { ok: false, code: 'forbidden', reason: `forbidden file(s) modified: ${forbidden.join(', ')}` };

  return { ok: true, commits };
}

export async function diffPackage(
  wt: string,
  baseSha: string,
  outFile: string,
): Promise<{ base: string; head: string; commits: number }> {
  const head = await headSha(wt);
  const known = await git(wt, ['cat-file', '-e', `${baseSha}^{commit}`], false);
  if (known.exitCode !== 0) throw new Error(`unknown base: ${baseSha}`);
  const range = `${baseSha}..${head}`;
  const log = (await git(wt, ['log', '--oneline', range])).stdout;
  const stat = (await git(wt, ['diff', '--stat', range])).stdout;
  const diff = (await git(wt, ['diff', '-U10', range])).stdout;
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `# Commits\n${log}\n\n# Summary\n${stat}\n\n# Diff\n${diff}\n`);
  const commits = Number((await git(wt, ['rev-list', '--count', range])).stdout.trim());
  return { base: baseSha, head, commits };
}

export async function commitFiles(wt: string, files: string[], message: string): Promise<string> {
  await git(wt, ['add', '--', ...files]);
  await git(wt, ['commit', '-m', message, '--', ...files]);
  return headSha(wt);
}

/** Pushes the mission branch; `--force-with-lease`: the engine may have rebased it after a first push. */
export async function push(wt: string, branch: string): Promise<void> {
  await git(wt, ['push', '--force-with-lease', '-u', 'origin', branch]);
}

/** True when `ancestor` is an ancestor of `ref` (or the same commit). */
export async function isAncestor(wt: string, ancestor: string, ref: string): Promise<boolean> {
  return (await git(wt, ['merge-base', '--is-ancestor', ancestor, ref], false)).exitCode === 0;
}

export type RebaseResult = { ok: true; changedCode: boolean } | { ok: false };

/** `git rebase <ref>`; a conflict aborts the rebase (`--abort`). `changedCode`: commits were replayed (HEAD changed). */
export async function rebaseOnto(wt: string, ref: string): Promise<RebaseResult> {
  const before = await headSha(wt);
  const r = await git(wt, ['rebase', ref], false);
  if (r.exitCode !== 0) {
    await git(wt, ['rebase', '--abort'], false);
    return { ok: false };
  }
  return { ok: true, changedCode: (await headSha(wt)) !== before };
}

/**
 * Local commits absent from upstream (`@{u}..HEAD`). Without upstream: commits since the divergence from `mainRef`;
 * without `mainRef` either, every commit of HEAD.
 */
export async function unpushedCount(wt: string, mainRef = 'origin/main'): Promise<number> {
  const count = async (range: string) => Number((await git(wt, ['rev-list', '--count', range])).stdout.trim());
  if ((await git(wt, ['rev-parse', '--verify', '--quiet', '@{u}'], false)).exitCode === 0) return count('@{u}..HEAD');
  const base = await git(wt, ['merge-base', 'HEAD', mainRef], false);
  return count(base.exitCode === 0 ? `${base.stdout.trim()}..HEAD` : 'HEAD');
}

/** Divergence point between HEAD and `ref`. */
export async function mergeBase(wt: string, ref: string): Promise<string> {
  return (await git(wt, ['merge-base', 'HEAD', ref])).stdout.trim();
}

/** Files changed between `base` and `head`; a rename counts as deletion + addition. */
export async function changedFiles(wt: string, base: string, head = 'HEAD'): Promise<string[]> {
  return (await git(wt, ['diff', '--name-only', '--no-renames', base, head])).stdout.split('\n').filter(Boolean);
}

/** Temporary worktree detached at `ref` (proof on main). */
export async function worktreeAddDetached(repo: string, path: string, ref: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', path, ref]);
}

/** Removes a worktree even when dirty; tolerates a directory already deleted (prune). */
export async function worktreeRemove(repo: string, path: string): Promise<void> {
  const r = await git(repo, ['worktree', 'remove', '--force', '--force', path], false);
  if (r.exitCode !== 0) {
    await rm(path, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']);
  }
}
