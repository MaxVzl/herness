import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/exec.js';
import { access } from 'node:fs/promises';
import { branchFiles, changedFiles, deleteBranch, fetchBranch, localOnlyCommits, commitFiles, controlCommits, currentBranch, diffPackage, fetchMain, headSha, identity, isAncestor, isClean, mergeBase, push, rebaseOnto, renameBranch, unpushedCount, worktreeAddDetached, worktreeRemove } from '../../src/git/git.js';

let dir = '';
const git = (...a: string[]) => run('git', ['-C', dir, ...a]);

async function commit(file: string, content: string, msg: string, author?: string) {
  await mkdir(join(dir, file, '..'), { recursive: true });
  await writeFile(join(dir, file), content);
  await git('add', file);
  await git('commit', '-m', msg, ...(author ? [`--author=${author}`] : []));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herness-git-'));
  await run('git', ['init', '-b', 'main', dir]);
  await git('config', 'user.name', 'Me');
  await git('config', 'user.email', 'moi@example.com');
  await commit('a.txt', 'a\n', 'init');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('controlCommits', () => {
  beforeEach(async () => {
    await git('checkout', '-b', 'feature');
  });

  it('KO "no commit" when HEAD == base', async () => {
    const base = await headSha(dir);
    const r = await controlCommits(dir, base, [], 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no commit/);
    if (!r.ok) expect(r.code).toBe('no-commit');
  });

  it('KO "identity" when user.email is not configured', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    await git('config', '--unset', 'user.email');
    // Without the machine's global config (which may set user.email).
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const r = await controlCommits(dir, base, [], 'main');
      expect(r).toMatchObject({ ok: false, code: 'identity' });
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.n;
    }
  });

  it('KO when a commit has an author other than the configured identity', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b', 'Other <other@example.com>');
    const r = await controlCommits(dir, base, [], 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/other@example.com/);
    if (!r.ok) expect(r.code).toBe('author');
  });

  it('KO when an uncommitted file is left behind', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    await writeFile(join(dir, 'trainard.txt'), 'x');
    const r = await controlCommits(dir, base, [], 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/trainard\.txt/);
    if (!r.ok) expect(r.code).toBe('dirty');
  });

  it('KO when a forbidden file is modified', async () => {
    const base = await headSha(dir);
    await commit('generated/x.ts', 'x\n', 'gen');
    const r = await controlCommits(dir, base, ['generated/**'], 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/generated\/x\.ts/);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('OK with two clean commits', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    await commit('src/c.txt', 'c\n', 'c');
    expect(await controlCommits(dir, base, ['generated/**'], 'main')).toEqual({ ok: true, commits: 2 });
  });
  /** Feature branch with one commit, rebased onto a main that received two commits from a colleague (including a forbidden file). */
  async function rebaseOntoColleagueMain(): Promise<string> {
    await commit('b.txt', 'b\n', 'b');
    const fixBase = await headSha(dir);
    await git('checkout', 'main');
    await commit('m.txt', 'm\n', 'm', 'Colleague <coll@example.com>');
    await commit('generated/m.ts', 'm\n', 'gen', 'Colleague <coll@example.com>');
    await git('checkout', 'feature');
    await git('rebase', 'main');
    return fixBase;
  }

  it('OK after a rebase onto a main that contains another author\'s commits and a forbidden file', async () => {
    const fixBase = await rebaseOntoColleagueMain();
    await commit('c.txt', 'c\n', 'fix');
    expect(await controlCommits(dir, fixBase, ['generated/**'], 'main')).toEqual({ ok: true, commits: 2 });
  });

  it('OK after a rebase alone, with no correction commit', async () => {
    const fixBase = await rebaseOntoColleagueMain();
    expect(await controlCommits(dir, fixBase, ['generated/**'], 'main')).toEqual({ ok: true, commits: 1 });
  });

  it('KO when another author commits on the branch after the rebase', async () => {
    const fixBase = await rebaseOntoColleagueMain();
    await commit('c.txt', 'c\n', 'c', 'Other <other@example.com>');
    const r = await controlCommits(dir, fixBase, ['generated/**'], 'main');
    expect(r).toMatchObject({ ok: false, code: 'author' });
    if (!r.ok) expect(r.reason).toMatch(/other@example\.com/);
    if (!r.ok) expect(r.reason).not.toMatch(/coll@example\.com/);
  });

  it('OK when the fixer merges main instead of rebasing', async () => {
    await commit('b.txt', 'b\n', 'b');
    const fixBase = await headSha(dir);
    await git('checkout', 'main');
    await commit('m.txt', 'm\n', 'm', 'Colleague <coll@example.com>');
    await git('checkout', 'feature');
    await git('merge', '--no-ff', '-m', 'merge', 'main');
    const r = await controlCommits(dir, fixBase, [], 'main');
    expect(r.ok).toBe(true);
  });

  it('without a main ref, excludes nothing and does not throw', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    expect(await controlCommits(dir, base, [], 'origin/absent')).toEqual({ ok: true, commits: 1 });
  });
});

describe('branchFiles', () => {
  it('files of the branch commits, without main commits brought in by a rebase', async () => {
    await git('checkout', '-b', 'feature');
    await commit('b.txt', 'b\n', 'b');
    const fixBase = await headSha(dir);
    await git('checkout', 'main');
    await commit('m.txt', 'm\n', 'm', 'Colleague <coll@example.com>');
    await git('checkout', 'feature');
    await git('rebase', 'main');
    await commit('c.txt', 'c\n', 'fix');
    await commit('c.txt', 'c2\n', 'fix 2');
    expect((await branchFiles(dir, fixBase, 'main')).sort()).toEqual(['b.txt', 'c.txt']);
  });
});

describe('diffPackage', () => {
  it('writes Commits, Summary and Diff and returns the commit count', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'add b');
    await commit('c.txt', 'c\n', 'add c');
    const out = join(dir, '..', `${Date.now()}-out`, 'diff.md');
    const r = await diffPackage(dir, base, out);
    expect(r).toEqual({ base, head: await headSha(dir), commits: 2 });
    const txt = await readFile(out, 'utf8');
    expect(txt).toMatch(/^# Commits\n.*add c\n.*add b\n\n# Summary\n/s);
    expect(txt).toContain('# Diff\ndiff --git a/b.txt b/b.txt');
    await rm(join(out, '..'), { recursive: true, force: true });
  });
});

describe('renameBranch', () => {
  it('renames the worktree\'s current branch', async () => {
    const wt = `${dir}-wt`;
    await git('worktree', 'add', '-b', 'herness/1', wt);
    await renameBranch(wt, 'herness/1', 'feat/1-x');
    const b = await run('git', ['-C', wt, 'branch', '--show-current']);
    expect(b.stdout.trim()).toBe('feat/1-x');
    await git('worktree', 'remove', '--force', wt);
  });
});

describe('identity, commitFiles, push, fetchMain', () => {
  it('identity returns name and email, or null', async () => {
    expect(await identity(dir)).toEqual({ name: 'Me', email: 'moi@example.com' });
  });

  it('commitFiles commits the given files and returns the SHA', async () => {
    await writeFile(join(dir, 'x.txt'), 'x');
    await writeFile(join(dir, 'y.txt'), 'y');
    const sha = await commitFiles(dir, ['x.txt'], 'docs: x');
    expect(sha).toBe(await headSha(dir));
    expect((await git('status', '--porcelain')).stdout).toBe('?? y.txt');
  });

  it('push and fetchMain with a local bare repository', async () => {
    const bare = `${dir}-origin.git`;
    await run('git', ['init', '--bare', '-b', 'main', bare]);
    await git('remote', 'add', 'origin', bare);
    await push(dir, 'main');
    await fetchMain(dir, 'main');
    const remote = await run('git', ['-C', bare, 'rev-parse', 'main']);
    expect(remote.stdout.trim()).toBe(await headSha(dir));
    await rm(bare, { recursive: true, force: true });
  });
});

describe('currentBranch, isClean', () => {
  it('currentBranch returns the current branch', async () => {
    expect(await currentBranch(dir)).toBe('main');
    await git('branch', '-m', 'main', 'feature/x');
    expect(await currentBranch(dir)).toBe('feature/x');
  });

  it('isClean: true for an unchanged committed file, false for a modified or untracked file', async () => {
    expect(await isClean(dir, 'a.txt')).toBe(true);
    await writeFile(join(dir, 'a.txt'), 'a2\n');
    expect(await isClean(dir, 'a.txt')).toBe(false);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'n.md'), 'n\n');
    expect(await isClean(dir, 'docs/n.md')).toBe(false);
  });
});

describe('mergeBase, changedFiles, worktreeAddDetached, worktreeRemove', () => {
  it('mergeBase returns the divergence point with a ref', async () => {
    const base = await headSha(dir);
    await git('branch', 'other');
    await commit('b.txt', 'b\n', 'b');
    await git('checkout', '-q', 'other');
    await commit('c.txt', 'c\n', 'c');
    await git('checkout', '-q', 'main');
    expect(await mergeBase(dir, 'other')).toBe(base);
  });

  it('changedFiles lists files touched since the base, rename = deletion + addition', async () => {
    const base = await headSha(dir);
    await commit('src/b.txt', 'b\n', 'b');
    await git('mv', 'a.txt', 'z.txt');
    await git('commit', '-q', '-m', 'rename');
    expect((await changedFiles(dir, base)).sort()).toEqual(['a.txt', 'src/b.txt', 'z.txt']);
    const mid = (await git('rev-parse', 'HEAD~1')).stdout.trim();
    expect(await changedFiles(dir, base, mid)).toEqual(['src/b.txt']);
  });

  it('worktreeAddDetached creates a detached worktree, worktreeRemove deletes it even when dirty', async () => {
    const first = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    const wt = `${dir}-proof`;
    await worktreeAddDetached(dir, wt, first);
    expect((await run('git', ['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(first);
    expect((await run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('HEAD');
    await writeFile(join(wt, 'sale.txt'), 'x');
    await worktreeRemove(dir, wt);
    await expect(access(wt)).rejects.toThrow();
    expect((await git('worktree', 'list')).stdout).not.toContain('proof');
  });

  it('worktreeRemove tolerates a worktree already deleted by hand', async () => {
    const wt = `${dir}-proof2`;
    await worktreeAddDetached(dir, wt, 'HEAD');
    await rm(wt, { recursive: true, force: true });
    await worktreeRemove(dir, wt);
    expect((await git('worktree', 'list')).stdout).not.toContain('proof2');
  });
});

describe('rebaseOnto, unpushedCount, isAncestor', () => {
  let bare = '';
  beforeEach(async () => {
    bare = `${dir}-origin.git`;
    await run('git', ['init', '--bare', '-b', 'main', bare]);
    await git('remote', 'add', 'origin', bare);
    await git('push', 'origin', 'main');
    await git('fetch', 'origin');
    await git('checkout', '-b', 'feature/x');
  });
  afterEach(async () => {
    await rm(bare, { recursive: true, force: true });
  });

  /** Fait avancer `origin/main` d'un commit touchant `file`, depuis un clone. */
  async function advanceMain(file: string, content: string) {
    const clone = `${dir}-clone`;
    await run('git', ['clone', '-q', bare, clone]);
    await run('git', ['-C', clone, 'config', 'user.email', 'moi@example.com']);
    await run('git', ['-C', clone, 'config', 'user.name', 'Me']);
    await writeFile(join(clone, file), content);
    await run('git', ['-C', clone, 'add', file]);
    await run('git', ['-C', clone, 'commit', '-m', `main ${file}`]);
    await run('git', ['-C', clone, 'push', '-q', 'origin', 'main']);
    await rm(clone, { recursive: true, force: true });
    await git('fetch', 'origin');
  }

  it('isAncestor: origin/main is an ancestor of HEAD until main moves', async () => {
    await commit('b.txt', 'b\n', 'b');
    expect(await isAncestor(dir, 'origin/main', 'HEAD')).toBe(true);
    await advanceMain('m.txt', 'm\n');
    expect(await isAncestor(dir, 'origin/main', 'HEAD')).toBe(false);
  });

  it('rebaseOnto with no main movement: nothing changes', async () => {
    await commit('b.txt', 'b\n', 'b');
    const before = await headSha(dir);
    expect(await rebaseOnto(dir, 'origin/main')).toEqual({ ok: true, changedCode: false });
    expect(await headSha(dir)).toBe(before);
  });

  it('rebaseOnto replays commits onto a main that has moved', async () => {
    await commit('b.txt', 'b\n', 'b');
    await advanceMain('m.txt', 'm\n');
    expect(await rebaseOnto(dir, 'origin/main')).toEqual({ ok: true, changedCode: true });
    expect(await isAncestor(dir, 'origin/main', 'HEAD')).toBe(true);
  });

  it('rebaseOnto aborts the rebase on a conflict', async () => {
    await commit('a.txt', 'branch\n', 'on branch');
    const before = await headSha(dir);
    await advanceMain('a.txt', 'main\n');
    expect(await rebaseOnto(dir, 'origin/main')).toEqual({ ok: false });
    expect(await headSha(dir)).toBe(before);
    expect(await currentBranch(dir)).toBe('feature/x');
    expect((await git('status', '--porcelain')).stdout).toBe('');
  });

  it('unpushedCount: without upstream, commits since origin/main; with upstream, unpushed commits', async () => {
    await commit('b.txt', 'b\n', 'b');
    await commit('c.txt', 'c\n', 'c');
    expect(await unpushedCount(dir)).toBe(2);
    await push(dir, 'feature/x');
    expect(await unpushedCount(dir)).toBe(0);
    await commit('d.txt', 'd\n', 'd');
    expect(await unpushedCount(dir)).toBe(1);
  });

  it('push after rebasing an already pushed branch', async () => {
    await commit('b.txt', 'b\n', 'b');
    await push(dir, 'feature/x');
    await advanceMain('m.txt', 'm\n');
    await rebaseOnto(dir, 'origin/main');
    await push(dir, 'feature/x');
    const remote = await run('git', ['-C', bare, 'rev-parse', 'feature/x']);
    expect(remote.stdout.trim()).toBe(await headSha(dir));
  });
});

describe('fetchBranch, localOnlyCommits, deleteBranch', () => {
  let bare = '';
  beforeEach(async () => {
    bare = `${dir}-origin.git`;
    await run('git', ['init', '--bare', '-b', 'main', bare]);
    await git('remote', 'add', 'origin', bare);
    await git('push', 'origin', 'main');
    await git('checkout', '-b', 'herness/x');
  });
  afterEach(async () => {
    await rm(bare, { recursive: true, force: true });
    await rm(`${dir}-clone`, { recursive: true, force: true });
  });

  /** Clone of origin, starting from `origin/main`, where `fn` commits before pushing to `herness/x`. */
  async function remoteCommits(files: [string, string, string?][]) {
    const clone = `${dir}-clone`;
    await run('git', ['clone', '-q', bare, clone]);
    const c = (...a: string[]) => run('git', ['-C', clone, ...a]);
    await c('config', 'user.email', 'other@example.com');
    await c('config', 'user.name', 'Other');
    await c('checkout', '-q', '-b', 'herness/x', 'origin/main');
    for (const [f, content, msg] of files) {
      await writeFile(join(clone, f), content);
      await c('add', f);
      await c('commit', '-q', '-m', msg ?? `distant ${f}`);
    }
    await c('push', '-q', 'origin', 'herness/x');
  }

  it('identical to origin: 0 local-only commit, branch can be deleted', async () => {
    await commit('b.txt', 'b\n', 'b');
    await push(dir, 'herness/x');
    await git('checkout', 'main');
    await fetchBranch(dir, 'herness/x');
    expect(await localOnlyCommits(dir, 'herness/x')).toBe(0);
    await deleteBranch(dir, 'herness/x');
    expect((await git('branch', '--list', 'herness/x')).stdout.trim()).toBe('');
    // The remote branch is intact.
    expect((await run('git', ['-C', bare, 'rev-parse', '--verify', 'herness/x'])).exitCode).toBe(0);
  });

  it('ahead with a real new commit: counted, branch kept', async () => {
    await commit('b.txt', 'b\n', 'b');
    await push(dir, 'herness/x');
    await commit('c.txt', 'c\n', 'c');
    await commit('d.txt', 'd\n', 'd');
    await git('checkout', 'main');
    await fetchBranch(dir, 'herness/x');
    expect(await localOnlyCommits(dir, 'herness/x')).toBe(2);
  });

  it('ahead only by commits with an equivalent patch (rebased): 0', async () => {
    await commit('b.txt', 'b\n', 'b');
    await git('checkout', 'main');
    // Origin has the same patch with another SHA, plus extra commits.
    await remoteCommits([['b.txt', 'b\n', 'b rebased'], ['e.txt', 'e\n']]);
    await fetchBranch(dir, 'herness/x');
    expect(Number((await git('rev-list', '--count', 'origin/herness/x..herness/x')).stdout.trim())).toBe(1);
    expect(await localOnlyCommits(dir, 'herness/x')).toBe(0);
  });

  it('no remote branch: null', async () => {
    await commit('b.txt', 'b\n', 'b');
    await git('checkout', 'main');
    await fetchBranch(dir, 'herness/x').catch(() => {});
    expect(await localOnlyCommits(dir, 'herness/x')).toBeNull();
  });

  it('fetchBranch fails when the remote branch does not exist', async () => {
    await expect(fetchBranch(dir, 'herness/absente')).rejects.toThrow();
  });

  it('deleteBranch refuses the current branch (including main)', async () => {
    await git('checkout', 'main');
    await expect(deleteBranch(dir, 'main')).rejects.toThrow();
    expect((await git('branch', '--list', 'main')).stdout.trim()).not.toBe('');
  });
});
