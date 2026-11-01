// Git operations of landing and jv gc (sections 8 and 3). Ported from the merge, fast-forward and worktree parts of
// jevellan packages/projects/src/landing.ts and worktree.ts (main at 8e2788ec), reshaped for jv:
//
// - the changed files are `git diff --numstat --no-renames -z <base>...<branch>` (Jevellan's #files), binary rows
//   ("-\t-") count 0 additions and 0 deletions;
// - the default branch is merged into the task branch in the task's worktree (Jevellan rebased; the brief merges), a
//   conflict is aborted and reported with the conflicted files (Jevellan's --diff-filter=U listing);
// - the project checkout's default branch is fast-forwarded with `merge --ff-only` when it is checked out there, or its
//   ref alone is moved with `push . <branch>:<default>` when another branch (or a detached HEAD) is checked out;
// - worktrees are listed with `worktree list --porcelain -z` (ported parseWorktrees), removed with `worktree remove`
//   (never --force) and moved with `worktree move`. Nothing here prunes, deletes a branch or rewrites history.
//
// Every git call runs with GIT_TERMINAL_PROMPT=0 and the machine's git identity (env.ts machineGitIdentity): jv land is
// usually run by the coordinator, whose HOME is a provider home without a .gitconfig, and a merge commit needs one.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { machineGitIdentity } from './env.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Exit codes that are not an error (0 always is). */
  permitted?: readonly number[];
  timeoutMs?: number;
}

/** Network calls (push) and long local operations give up after this. */
export const GIT_TIMEOUT_MS = 120_000;

let cachedEnv: NodeJS.ProcessEnv | undefined;

/** The environment of every landing git call: the process environment plus the machine identity, no prompts. */
export function gitEnv(): NodeJS.ProcessEnv {
  if (cachedEnv) return cachedEnv;
  const id = machineGitIdentity();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (id.name) {
    env.GIT_AUTHOR_NAME = id.name;
    env.GIT_COMMITTER_NAME = id.name;
  }
  if (id.email) {
    env.GIT_AUTHOR_EMAIL = id.email;
    env.GIT_COMMITTER_EMAIL = id.email;
  }
  cachedEnv = env;
  return env;
}

export class GitError extends Error {
  readonly result: GitResult;
  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(' ')} failed (exit ${result.code}): ${firstLine(result.stderr) || firstLine(result.stdout)}`);
    this.name = 'GitError';
    this.result = result;
  }
}

export function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

/** Runs git in `cwd`. Throws GitError on an exit code that is neither 0 nor permitted. */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        const result = { code, stdout: String(stdout), stderr: String(stderr) };
        if (error && typeof error.code !== 'number') return reject(new GitError(args, { ...result, stderr: result.stderr || error.message }));
        if (code !== 0 && !(options.permitted ?? []).includes(code)) return reject(new GitError(args, result));
        resolvePromise(result);
      },
    );
  });
}

/** The commit a ref names, or undefined. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { permitted: [1, 128] });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const r = await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { permitted: [1] });
  return r.code === 0;
}

/** The branch checked out in `cwd` (short name), or undefined for a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { permitted: [1, 128] });
  const name = r.stdout.trim();
  return r.code === 0 && name !== '' ? name : undefined;
}

/**
 * Files with uncommitted changes (`git status --porcelain -z`, untracked files included, ignored files not): what
 * the repository's info/exclude lists (.jv-evidence/, plan.md) never counts. With `paths`, only those paths.
 */
export async function uncommittedFiles(cwd: string, paths?: readonly string[]): Promise<string[]> {
  if (paths && paths.length === 0) return [];
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
  const out: string[] = [];
  // Pathspecs in chunks so a large change cannot exceed the argument limit.
  const chunks = paths ? chunk(paths, 500) : [undefined];
  for (const c of chunks) {
    const r = await git(cwd, c ? [...args, '--', ...c.map((p) => `:(literal)${p}`)] : args);
    for (const field of r.stdout.split('\0')) {
      if (field.length > 3) out.push(field.slice(3));
    }
  }
  return [...new Set(out)];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  /** Size of the file at `head` (0 when deleted). */
  bytes: number;
}

/** Parses `git diff --numstat --no-renames -z`: "<add>\t<del>\t<path>\0" per file, "-" for binary counts. */
export function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number }> {
  const out: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const row of output.split('\0')) {
    if (row === '') continue;
    const [a, d, ...name] = row.split('\t');
    const path = name.join('\t');
    if (path === '') continue;
    out.push({ path, additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  return out;
}

/** The files a branch changed since its base: `git diff --numstat <base>...<head>`, with their size at `head`. */
export async function changedFiles(cwd: string, base: string, head: string): Promise<ChangedFile[]> {
  const r = await git(cwd, ['diff', '--numstat', '--no-renames', '-z', `${base}...${head}`]);
  const rows = parseNumstat(r.stdout);
  const sizes = await blobSizes(cwd, head, rows.map((row) => row.path));
  return rows.map((row) => ({ ...row, bytes: sizes.get(row.path) ?? 0 }));
}

/** Sizes of files at a commit, from `git ls-tree -r -l -z` (one call; deleted files are absent). */
async function blobSizes(cwd: string, commit: string, files: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (files.length === 0) return sizes;
  const wanted = new Set(files);
  const r = await git(cwd, ['ls-tree', '-r', '-l', '-z', commit]);
  for (const entry of r.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    if (!wanted.has(path)) continue;
    const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
    sizes.set(path, Number.isFinite(size) ? size : 0);
  }
  return sizes;
}

/** Files with merge conflicts in `cwd`. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return r.stdout.split('\0').filter((f) => f !== '').slice(0, 200);
}

export type MergeResult =
  | { kind: 'up-to-date'; head: string }
  | { kind: 'merged'; head: string }
  | { kind: 'conflict'; files: string[] };

/**
 * Merges `ref` (the default branch) into the branch checked out in `worktree`. A conflict is aborted, so the worktree
 * is left as it was, and the conflicted files are returned.
 */
export async function mergeInto(worktree: string, ref: string, message: string): Promise<MergeResult> {
  const target = await resolveCommit(worktree, ref);
  if (!target) throw new Error(`git: ${ref} does not name a commit`);
  if (await isAncestor(worktree, target, 'HEAD')) return { kind: 'up-to-date', head: (await resolveCommit(worktree, 'HEAD'))! };
  // A branch with nothing of its own (no commits, or commits the default already has) catches up without a merge
  // commit, so an empty merge never lands on the default branch.
  if (await isAncestor(worktree, 'HEAD', target)) {
    await git(worktree, ['merge', '--ff-only', '--no-edit', target]);
    return { kind: 'up-to-date', head: target };
  }
  const r = await git(worktree, ['merge', '--no-ff', '--no-edit', '-m', message, target], { permitted: [1, 2, 128] });
  if (r.code === 0) return { kind: 'merged', head: (await resolveCommit(worktree, 'HEAD'))! };
  const files = await conflictedFiles(worktree);
  await git(worktree, ['merge', '--abort'], { permitted: [1, 128] });
  if (files.length === 0) throw new GitError(['merge', target], r);
  return { kind: 'conflict', files };
}

export type FastForwardResult =
  | { kind: 'fast-forwarded'; commit: string; method: 'merge --ff-only' | 'push .' }
  /** The default branch moved since the merge: the task branch no longer contains it. */
  | { kind: 'moved'; defaultCommit: string }
  | { kind: 'refused'; reason: string };

/**
 * Moves the checkout's default branch to `branch` by fast-forward only (section 8). When the checkout has the default
 * branch checked out, the files the task touched must be clean there and `git merge --ff-only` updates the working
 * tree; otherwise only the ref moves (`git push . <branch>:<default>`) and the working tree is left alone. A child
 * task's landing passes its parent's worktree and branch as `checkout` and `defaultBranch`: the same rules then move
 * the parent's branch.
 */
export async function fastForwardDefault(checkout: string, branch: string, defaultBranch: string): Promise<FastForwardResult> {
  const head = await resolveCommit(checkout, `refs/heads/${branch}`);
  if (!head) return { kind: 'refused', reason: `the branch ${branch} does not exist` };
  const current = await resolveCommit(checkout, `refs/heads/${defaultBranch}`);
  if (!current) return { kind: 'refused', reason: `the branch ${defaultBranch} to land into does not exist in ${checkout}` };
  if (current === head) return { kind: 'fast-forwarded', commit: head, method: 'merge --ff-only' };
  if (!(await isAncestor(checkout, current, head))) return { kind: 'moved', defaultCommit: current };

  if ((await currentBranch(checkout)) === defaultBranch) {
    const touched = (await git(checkout, ['diff', '--name-only', '--no-renames', '-z', current, head])).stdout
      .split('\0')
      .filter((f) => f !== '');
    const dirty = await uncommittedFiles(checkout, touched);
    if (dirty.length) {
      return { kind: 'refused', reason: `the checkout ${checkout} has uncommitted changes in files the task changes: ${listText(dirty)}` };
    }
    const r = await git(checkout, ['merge', '--ff-only', '--no-edit', head], { permitted: [1, 128] });
    if (r.code !== 0) return { kind: 'refused', reason: `git merge --ff-only in ${checkout} failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
    return { kind: 'fast-forwarded', commit: head, method: 'merge --ff-only' };
  }
  const r = await git(checkout, ['push', '--quiet', '.', `refs/heads/${branch}:refs/heads/${defaultBranch}`], { permitted: [1, 128] });
  if (r.code !== 0) {
    // A concurrent update of the default branch shows as a rejected non-fast-forward.
    const now = await resolveCommit(checkout, `refs/heads/${defaultBranch}`);
    if (now && now !== current) return { kind: 'moved', defaultCommit: now };
    return { kind: 'refused', reason: `git push . ${branch}:${defaultBranch} in ${checkout} failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
  }
  return { kind: 'fast-forwarded', commit: head, method: 'push .' };
}

/** Whether the repository has a remote named origin. */
export async function hasOrigin(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['remote', 'get-url', 'origin'], { permitted: [2, 128] });
  return r.code === 0 && r.stdout.trim() !== '';
}

/** Pushes the default branch to origin (project.json pushAfterLanding). Never forced. */
export async function pushDefault(checkout: string, defaultBranch: string): Promise<{ ok: boolean; detail: string }> {
  const r = await git(checkout, ['push', '--quiet', 'origin', `refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`], {
    permitted: [1, 128],
  });
  return r.code === 0 ? { ok: true, detail: `pushed ${defaultBranch} to origin` } : { ok: false, detail: firstLine(r.stderr) || firstLine(r.stdout) };
}

// ---- worktrees ------------------------------------------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  prunable: boolean;
  locked: boolean;
}

/** `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends each entry (ported parseWorktrees). */
export function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of output.split('\0')) {
    if (!field) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { path: value, prunable: false, locked: false };
    } else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value;
    else if (current && key === 'prunable') current.prunable = true;
    else if (current && key === 'locked') current.locked = true;
  }
  if (current) entries.push(current);
  return entries;
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  return parseWorktrees((await git(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout);
}

/** The registered worktree at `path` (compared resolved), or undefined. */
export async function findWorktree(repo: string, path: string): Promise<WorktreeEntry | undefined> {
  const target = resolve(path);
  return (await listWorktrees(repo)).find((e) => resolve(e.path) === target);
}

/** `git worktree remove <path>` without --force: git itself refuses a worktree with changes or untracked files. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', path]);
}

/** `git worktree move <path> <dest>`: the worktree stays registered, at its new place. */
export async function moveWorktree(repo: string, path: string, dest: string): Promise<void> {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  await git(repo, ['worktree', 'move', path, dest]);
}

/** At most `max` names, then "and N more". */
export function listText(items: readonly string[], max = 10): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/** Whether git ignores `path` in `cwd` (info/exclude included); a tracked path is never ignored. */
export async function isIgnored(cwd: string, path: string): Promise<boolean> {
  const r = await git(cwd, ['check-ignore', '-q', '--', path], { permitted: [1, 128] });
  return r.code === 0;
}
