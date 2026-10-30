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

/** Vrai si le fichier n'a aucune modification, ni indexée, ni non suivie. */
export async function isClean(wt: string, file: string): Promise<boolean> {
  return (await git(wt, ['status', '--porcelain', '--', file])).stdout.trim() === '';
}

export async function renameBranch(wt: string, from: string, to: string): Promise<void> {
  await git(wt, ['branch', '-m', from, to]);
}

export async function fetchMain(repo: string, mainBranch: string): Promise<void> {
  await git(repo, ['fetch', 'origin', mainBranch]);
}

export async function identity(wt: string): Promise<{ name: string; email: string } | null> {
  const email = (await git(wt, ['config', 'user.email'], false)).stdout.trim();
  if (!email) return null;
  const name = (await git(wt, ['config', 'user.name'], false)).stdout.trim();
  return { name, email };
}

/** Motif d'un contrôle en échec : `no-commit` distingue un agent arrêté sans rien commiter. */
export type ControlCode = 'no-commit' | 'identity' | 'author' | 'dirty' | 'forbidden';
export type ControlResult = { ok: true; commits: number } | { ok: false; code: ControlCode; reason: string };

export async function controlCommits(wt: string, baseSha: string, forbiddenPaths: string[]): Promise<ControlResult> {
  const range = `${baseSha}..HEAD`;
  const commits = Number((await git(wt, ['rev-list', '--count', range])).stdout.trim());
  if (commits === 0) return { ok: false, code: 'no-commit', reason: `aucun commit depuis ${baseSha}` };

  const id = await identity(wt);
  if (!id) return { ok: false, code: 'identity', reason: 'identité git (user.email) non configurée dans le worktree' };
  const authors = (await git(wt, ['log', '--format=%ae', range])).stdout.split('\n').filter(Boolean);
  const bad = [...new Set(authors.filter((a) => a !== id.email))];
  if (bad.length > 0) return { ok: false, code: 'author', reason: `auteur(s) ≠ ${id.email} : ${bad.join(', ')}` };

  const status = (await git(wt, ['status', '--porcelain'])).stdout.trim();
  if (status) return { ok: false, code: 'dirty', reason: `arbre non propre :\n${status}` };

  const files = (await git(wt, ['diff', '--name-only', range])).stdout.split('\n').filter(Boolean);
  const forbidden = files.filter((f) => forbiddenPaths.some((g) => matchesGlob(f, g)));
  if (forbidden.length > 0) return { ok: false, code: 'forbidden', reason: `fichier(s) interdit(s) modifié(s) : ${forbidden.join(', ')}` };

  return { ok: true, commits };
}

export async function diffPackage(
  wt: string,
  baseSha: string,
  outFile: string,
): Promise<{ base: string; head: string; commits: number }> {
  const head = await headSha(wt);
  const known = await git(wt, ['cat-file', '-e', `${baseSha}^{commit}`], false);
  if (known.exitCode !== 0) throw new Error(`base inconnue : ${baseSha}`);
  const range = `${baseSha}..${head}`;
  const log = (await git(wt, ['log', '--oneline', range])).stdout;
  const stat = (await git(wt, ['diff', '--stat', range])).stdout;
  const diff = (await git(wt, ['diff', '-U10', range])).stdout;
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `# Commits\n${log}\n\n# Résumé\n${stat}\n\n# Diff\n${diff}\n`);
  const commits = Number((await git(wt, ['rev-list', '--count', range])).stdout.trim());
  return { base: baseSha, head, commits };
}

export async function commitFiles(wt: string, files: string[], message: string): Promise<string> {
  await git(wt, ['add', '--', ...files]);
  await git(wt, ['commit', '-m', message, '--', ...files]);
  return headSha(wt);
}

/** Pousse la branche de la mission ; `--force-with-lease` : elle a pu être rebasée par le moteur après un premier push. */
export async function push(wt: string, branch: string): Promise<void> {
  await git(wt, ['push', '--force-with-lease', '-u', 'origin', branch]);
}

/** Vrai si `ancestor` est un ancêtre de `ref` (ou le même commit). */
export async function isAncestor(wt: string, ancestor: string, ref: string): Promise<boolean> {
  return (await git(wt, ['merge-base', '--is-ancestor', ancestor, ref], false)).exitCode === 0;
}

export type RebaseResult = { ok: true; changedCode: boolean } | { ok: false };

/** `git rebase <ref>` ; un conflit annule le rebase (`--abort`). `changedCode` : des commits ont été rejoués (HEAD a changé). */
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
 * Commits locaux absents de l'amont (`@{u}..HEAD`). Sans amont : commits depuis la divergence avec `mainRef` ;
 * sans `mainRef` non plus, tous les commits de HEAD.
 */
export async function unpushedCount(wt: string, mainRef = 'origin/main'): Promise<number> {
  const count = async (range: string) => Number((await git(wt, ['rev-list', '--count', range])).stdout.trim());
  if ((await git(wt, ['rev-parse', '--verify', '--quiet', '@{u}'], false)).exitCode === 0) return count('@{u}..HEAD');
  const base = await git(wt, ['merge-base', 'HEAD', mainRef], false);
  return count(base.exitCode === 0 ? `${base.stdout.trim()}..HEAD` : 'HEAD');
}

/** Point de divergence entre HEAD et `ref`. */
export async function mergeBase(wt: string, ref: string): Promise<string> {
  return (await git(wt, ['merge-base', 'HEAD', ref])).stdout.trim();
}

/** Fichiers modifiés entre `base` et `head` ; un renommage compte comme suppression + ajout. */
export async function changedFiles(wt: string, base: string, head = 'HEAD'): Promise<string[]> {
  return (await git(wt, ['diff', '--name-only', '--no-renames', base, head])).stdout.split('\n').filter(Boolean);
}

/** Worktree temporaire détaché sur `ref` (preuve sur main). */
export async function worktreeAddDetached(repo: string, path: string, ref: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', path, ref]);
}

/** Supprime un worktree même sale ; tolère un dossier déjà effacé (élagage). */
export async function worktreeRemove(repo: string, path: string): Promise<void> {
  const r = await git(repo, ['worktree', 'remove', '--force', '--force', path], false);
  if (r.exitCode !== 0) {
    await rm(path, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']);
  }
}
