import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/exec.js';
import { access } from 'node:fs/promises';
import { changedFiles, commitFiles, controlCommits, currentBranch, diffPackage, fetchMain, headSha, identity, isAncestor, isClean, mergeBase, push, rebaseOnto, renameBranch, unpushedCount, worktreeAddDetached, worktreeRemove } from '../../src/git/git.js';

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
  await git('config', 'user.name', 'Moi');
  await git('config', 'user.email', 'moi@example.com');
  await commit('a.txt', 'a\n', 'init');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('controlCommits', () => {
  it('KO « aucun commit » quand HEAD == base', async () => {
    const base = await headSha(dir);
    const r = await controlCommits(dir, base, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/aucun commit/);
    if (!r.ok) expect(r.code).toBe('no-commit');
  });

  it('KO « identity » quand user.email n’est pas configuré', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    await git('config', '--unset', 'user.email');
    // Sans la configuration globale de la machine (qui peut définir user.email).
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const r = await controlCommits(dir, base, []);
      expect(r).toMatchObject({ ok: false, code: 'identity' });
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.n;
    }
  });

  it('KO quand un commit a un autre auteur que l’identité configurée', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b', 'Autre <autre@example.com>');
    const r = await controlCommits(dir, base, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/autre@example.com/);
    if (!r.ok) expect(r.code).toBe('author');
  });

  it('KO quand un fichier non commité traîne', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    await writeFile(join(dir, 'trainard.txt'), 'x');
    const r = await controlCommits(dir, base, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/trainard\.txt/);
    if (!r.ok) expect(r.code).toBe('dirty');
  });

  it('KO quand un fichier interdit est modifié', async () => {
    const base = await headSha(dir);
    await commit('generated/x.ts', 'x\n', 'gen');
    const r = await controlCommits(dir, base, ['generated/**']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/generated\/x\.ts/);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('OK avec deux commits propres', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    await commit('src/c.txt', 'c\n', 'c');
    expect(await controlCommits(dir, base, ['generated/**'])).toEqual({ ok: true, commits: 2 });
  });
});

describe('diffPackage', () => {
  it('écrit Commits, Résumé et Diff et rend le nombre de commits', async () => {
    const base = await headSha(dir);
    await commit('b.txt', 'b\n', 'ajoute b');
    await commit('c.txt', 'c\n', 'ajoute c');
    const out = join(dir, '..', `${Date.now()}-out`, 'diff.md');
    const r = await diffPackage(dir, base, out);
    expect(r).toEqual({ base, head: await headSha(dir), commits: 2 });
    const txt = await readFile(out, 'utf8');
    expect(txt).toMatch(/^# Commits\n.*ajoute c\n.*ajoute b\n\n# Résumé\n/s);
    expect(txt).toContain('# Diff\ndiff --git a/b.txt b/b.txt');
    await rm(join(out, '..'), { recursive: true, force: true });
  });
});

describe('renameBranch', () => {
  it('renomme la branche courante du worktree', async () => {
    const wt = `${dir}-wt`;
    await git('worktree', 'add', '-b', 'herness/1', wt);
    await renameBranch(wt, 'herness/1', 'feat/1-x');
    const b = await run('git', ['-C', wt, 'branch', '--show-current']);
    expect(b.stdout.trim()).toBe('feat/1-x');
    await git('worktree', 'remove', '--force', wt);
  });
});

describe('identity, commitFiles, push, fetchMain', () => {
  it('identity rend nom et email, ou null', async () => {
    expect(await identity(dir)).toEqual({ name: 'Moi', email: 'moi@example.com' });
  });

  it('commitFiles commit les fichiers indiqués et rend le SHA', async () => {
    await writeFile(join(dir, 'x.txt'), 'x');
    await writeFile(join(dir, 'y.txt'), 'y');
    const sha = await commitFiles(dir, ['x.txt'], 'docs: x');
    expect(sha).toBe(await headSha(dir));
    expect((await git('status', '--porcelain')).stdout).toBe('?? y.txt');
  });

  it('push et fetchMain avec un dépôt nu local', async () => {
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
  it('currentBranch rend la branche courante', async () => {
    expect(await currentBranch(dir)).toBe('main');
    await git('branch', '-m', 'main', 'feature/x');
    expect(await currentBranch(dir)).toBe('feature/x');
  });

  it('isClean : vrai pour un fichier commité inchangé, faux pour un fichier modifié ou non suivi', async () => {
    expect(await isClean(dir, 'a.txt')).toBe(true);
    await writeFile(join(dir, 'a.txt'), 'a2\n');
    expect(await isClean(dir, 'a.txt')).toBe(false);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'n.md'), 'n\n');
    expect(await isClean(dir, 'docs/n.md')).toBe(false);
  });
});

describe('mergeBase, changedFiles, worktreeAddDetached, worktreeRemove', () => {
  it('mergeBase rend le point de divergence avec une référence', async () => {
    const base = await headSha(dir);
    await git('branch', 'autre');
    await commit('b.txt', 'b\n', 'b');
    await git('checkout', '-q', 'autre');
    await commit('c.txt', 'c\n', 'c');
    await git('checkout', '-q', 'main');
    expect(await mergeBase(dir, 'autre')).toBe(base);
  });

  it('changedFiles liste les fichiers touchés depuis la base, renommage = suppression + ajout', async () => {
    const base = await headSha(dir);
    await commit('src/b.txt', 'b\n', 'b');
    await git('mv', 'a.txt', 'z.txt');
    await git('commit', '-q', '-m', 'renomme');
    expect((await changedFiles(dir, base)).sort()).toEqual(['a.txt', 'src/b.txt', 'z.txt']);
    const mid = (await git('rev-parse', 'HEAD~1')).stdout.trim();
    expect(await changedFiles(dir, base, mid)).toEqual(['src/b.txt']);
  });

  it('worktreeAddDetached crée un worktree détaché, worktreeRemove le supprime même sale', async () => {
    const first = await headSha(dir);
    await commit('b.txt', 'b\n', 'b');
    const wt = `${dir}-preuve`;
    await worktreeAddDetached(dir, wt, first);
    expect((await run('git', ['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(first);
    expect((await run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('HEAD');
    await writeFile(join(wt, 'sale.txt'), 'x');
    await worktreeRemove(dir, wt);
    await expect(access(wt)).rejects.toThrow();
    expect((await git('worktree', 'list')).stdout).not.toContain('preuve');
  });

  it('worktreeRemove tolère un worktree déjà supprimé à la main', async () => {
    const wt = `${dir}-preuve2`;
    await worktreeAddDetached(dir, wt, 'HEAD');
    await rm(wt, { recursive: true, force: true });
    await worktreeRemove(dir, wt);
    expect((await git('worktree', 'list')).stdout).not.toContain('preuve2');
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
    await run('git', ['-C', clone, 'config', 'user.name', 'Moi']);
    await writeFile(join(clone, file), content);
    await run('git', ['-C', clone, 'add', file]);
    await run('git', ['-C', clone, 'commit', '-m', `main ${file}`]);
    await run('git', ['-C', clone, 'push', '-q', 'origin', 'main']);
    await rm(clone, { recursive: true, force: true });
    await git('fetch', 'origin');
  }

  it('isAncestor : origin/main ancêtre de HEAD tant que main n’a pas avancé', async () => {
    await commit('b.txt', 'b\n', 'b');
    expect(await isAncestor(dir, 'origin/main', 'HEAD')).toBe(true);
    await advanceMain('m.txt', 'm\n');
    expect(await isAncestor(dir, 'origin/main', 'HEAD')).toBe(false);
  });

  it('rebaseOnto sans avancée de main : rien ne change', async () => {
    await commit('b.txt', 'b\n', 'b');
    const before = await headSha(dir);
    expect(await rebaseOnto(dir, 'origin/main')).toEqual({ ok: true, changedCode: false });
    expect(await headSha(dir)).toBe(before);
  });

  it('rebaseOnto rejoue les commits sur une main qui a avancé', async () => {
    await commit('b.txt', 'b\n', 'b');
    await advanceMain('m.txt', 'm\n');
    expect(await rebaseOnto(dir, 'origin/main')).toEqual({ ok: true, changedCode: true });
    expect(await isAncestor(dir, 'origin/main', 'HEAD')).toBe(true);
  });

  it('rebaseOnto annule le rebase sur un conflit', async () => {
    await commit('a.txt', 'branche\n', 'a branche');
    const before = await headSha(dir);
    await advanceMain('a.txt', 'main\n');
    expect(await rebaseOnto(dir, 'origin/main')).toEqual({ ok: false });
    expect(await headSha(dir)).toBe(before);
    expect(await currentBranch(dir)).toBe('feature/x');
    expect((await git('status', '--porcelain')).stdout).toBe('');
  });

  it('unpushedCount : sans amont, commits depuis origin/main ; avec amont, commits non poussés', async () => {
    await commit('b.txt', 'b\n', 'b');
    await commit('c.txt', 'c\n', 'c');
    expect(await unpushedCount(dir)).toBe(2);
    await push(dir, 'feature/x');
    expect(await unpushedCount(dir)).toBe(0);
    await commit('d.txt', 'd\n', 'd');
    expect(await unpushedCount(dir)).toBe(1);
  });

  it('push après un rebase d’une branche déjà poussée', async () => {
    await commit('b.txt', 'b\n', 'b');
    await push(dir, 'feature/x');
    await advanceMain('m.txt', 'm\n');
    await rebaseOnto(dir, 'origin/main');
    await push(dir, 'feature/x');
    const remote = await run('git', ['-C', bare, 'rev-parse', 'feature/x']);
    expect(remote.stdout.trim()).toBe(await headSha(dir));
  });
});
