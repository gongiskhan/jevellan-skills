// Git for tasks: the task worktree (section 7.1) and the worktree setup command.
//
// Ported from jevellan packages/projects/src/worktree.ts (main at 8e2788ec): parseWorktrees as it is, and the shape of
// ThreadWorktree.create: the branch name is checked with check-ref-format, a worktree already registered at the
// path on the task branch is reused (so a repeated jv task create, or one interrupted after `worktree add`, goes on),
// and git runs in the project checkout only to change .git metadata and refs; the checkout's files, HEAD and index
// are never touched. Differences, on purpose:
// - the base is the local <default branch> (or the parent task's branch) as section 7.1 writes it, because landing
//   fast-forwards the local default branch; `git fetch` runs first when the repository has a remote and only
//   refreshes the remote-tracking refs (a failed fetch is a warning: the local branch is still a valid base);
// - nothing is ever deleted: no `worktree prune`, no `worktree remove`, no `branch -D`, no rm of a folder. A branch
//   that exists already, or a folder at the worktree path that git does not know, refuses the creation instead;
// - the setup command (project.json setupCommand, default "npm ci" when package-lock.json exists) runs once per
//   worktree inside the first run of the task, before the runtime starts: runWorktreeSetup().
//
// Every git call runs without a shell, with GIT_TERMINAL_PROMPT=0, and its output is never logged unredacted.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { conflict, refused } from './errors.js';
import { recordEvent } from './events.js';
import { paths, realpathAsFarAsExists } from './paths.js';
import { redact } from './redact.js';
import type { Store } from './store.js';
import type { SessionRow } from './types.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Exit codes that are not an error (default [0]). */
  permitted?: readonly number[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
}

/** Runs git in `cwd` (no shell). Throws exit 2 with git's first error line when the exit code is not permitted. */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): GitResult {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw refused(`git ${args[0] ?? ''} failed in ${cwd}: ${r.error.message}`);
  const result = { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (!(options.permitted ?? [0]).includes(result.code)) {
    const why = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
    throw refused(`git ${args.join(' ')} failed in ${cwd}: ${redact(why)}`);
  }
  return result;
}

/** The commit a ref names, or undefined. */
export function resolveRef(repo: string, ref: string): string | undefined {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { permitted: [0, 1, 128] });
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : undefined;
}

export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { permitted: [0, 1] }).code === 0;
}

/** The names of the repository's remotes. */
export function remotes(repo: string): string[] {
  return git(repo, ['remote']).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export type WorktreeEntry = { path: string; head?: string; branch?: string; prunable: boolean };

/** `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends each entry. (Ported as it is.) */
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
      current = { path: value, prunable: false };
    } else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value;
    else if (current && key === 'prunable') current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}

export function listWorktrees(repo: string): WorktreeEntry[] {
  return parseWorktrees(git(repo, ['worktree', 'list', '--porcelain', '-z']).stdout);
}

function samePath(a: string, b: string): boolean {
  return realpathAsFarAsExists(resolve(a)) === realpathAsFarAsExists(resolve(b));
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface CreateWorktreeInput {
  /** The project checkout. */
  repo: string;
  /** The worktree folder (~/.jv/worktrees/<project>/<branch slug>). */
  path: string;
  /** The task branch, jv/<slug>-<id6>. */
  branch: string;
  /** The branch the task starts from: the default branch, or the parent task's branch. */
  base: string;
  /** Run `git fetch` first when the repository has a remote (default true). */
  fetch?: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  base: string;
  baseCommit: string;
  /** False when an existing registration on the branch was reused. */
  created: boolean;
  /** Warnings for humans (a failed fetch). */
  warnings: string[];
}

/**
 * Creates (or finds again) the task worktree: `git worktree add -b <branch> <path> <base>` from the checkout. A
 * worktree registered at `path` on `branch` is reused. Refuses when the branch exists without that worktree (exit 4),
 * when another worktree holds the path, or when a folder git does not know is in the way (nothing is deleted).
 */
export function createWorktree(input: CreateWorktreeInput): CreatedWorktree {
  const { repo, path, branch, base } = input;
  const warnings: string[] = [];
  git(repo, ['check-ref-format', '--branch', branch]);
  const entries = listWorktrees(repo);
  const atPath = entries.find((e) => samePath(e.path, path));
  if (atPath) {
    if (atPath.branch !== `refs/heads/${branch}`) {
      throw conflict(`${path} is already a worktree of ${repo} on ${atPath.branch ?? 'a detached HEAD'}, not ${branch}`);
    }
    if (atPath.prunable || !existsSync(path)) {
      throw refused(`the worktree ${path} of ${branch} is registered but its folder is missing; restore it or run git worktree repair`);
    }
    // The fork point, not the base's head now: the base may have moved since the worktree was added.
    const baseRef = resolveRef(repo, `refs/heads/${base}`) ? `refs/heads/${base}` : base;
    const fork = git(repo, ['merge-base', `refs/heads/${branch}`, baseRef], { permitted: [0, 1, 128] }).stdout.trim();
    const baseCommit = fork || resolveRef(repo, baseRef) || '';
    return { path, branch, base, baseCommit, created: false, warnings };
  }
  if (branchExists(repo, branch)) {
    throw conflict(`the branch ${branch} already exists in ${repo}; jv never reuses or deletes a branch it did not create for this task`);
  }
  if (present(path)) throw refused(`${path} exists and is not a worktree of ${repo}; move it away (jv never deletes it)`);
  if (input.fetch !== false && remotes(repo).length) {
    const r = git(repo, ['fetch', '--quiet', '--no-prune'], { permitted: [0, 1, 128], timeoutMs: 60_000 });
    if (r.code !== 0) warnings.push(`git fetch failed (${redact(firstLine(r.stderr) || `exit ${r.code}`)}); the worktree starts from the local ${base}`);
  }
  const baseRef = resolveRef(repo, `refs/heads/${base}`) ? `refs/heads/${base}` : resolveRef(repo, `refs/remotes/origin/${base}`) ? `refs/remotes/origin/${base}` : undefined;
  if (!baseRef) throw refused(`the base branch ${base} does not exist in ${repo}`);
  const baseCommit = resolveRef(repo, baseRef)!;
  mkdirSync(dirname(path), { recursive: true });
  git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, baseCommit]);
  return { path, branch, base, baseCommit, created: true, warnings };
}

/** Files with uncommitted changes in a worktree (porcelain paths), untracked included. */
export function uncommittedFiles(cwd: string): string[] {
  return git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .stdout.split('\0')
    .filter((f) => f.length > 3)
    .map((f) => f.slice(3));
}

/** The commit HEAD of a worktree points at. */
export function headCommit(cwd: string): string | undefined {
  return resolveRef(cwd, 'HEAD');
}

// ---- the worktree setup command -----------------------------------------------------------------------------------

export const SETUP_TIMEOUT_MS = 15 * 60_000;
export const SETUP_META_PREFIX = 'worktree_setup:';

/** project.json setupCommand: a string runs, null or "" runs nothing; absent: "npm ci" when package-lock.json exists. */
export function setupCommand(projectName: string, worktree: string, file: string = paths.projectJson(projectName)): string | undefined {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refused(`${file} is not valid JSON`);
  }
  if (Object.hasOwn(raw, 'setupCommand')) {
    const v = raw.setupCommand;
    if (v === null || v === '') return undefined;
    if (typeof v !== 'string') throw refused(`${file}: setupCommand must be a string or null`);
    return v.trim() || undefined;
  }
  return existsSync(join(worktree, 'package-lock.json')) ? 'npm ci' : undefined;
}

export interface SetupRecord {
  status: 'ok' | 'failed' | 'none';
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  session: string;
  at: string;
}

export interface WorktreeSetupOptions {
  /** The worker's environment (the provider's minimal environment): the command runs as the session would. */
  env: Record<string, string>;
  /** Where the command's output goes (default: the session log ~/.jv/logs/<R>.log). */
  logFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Default: setupCommand(project, worktree). */
  command?: string | null;
}

/**
 * Runs the worktree setup command once per worktree, in the task's first run before the runtime starts (call it
 * from jv run right before runtime.start). The output goes to the session log; one `tool-result` event carries the
 * result. Done once: meta worktree_setup:<task id> records it, and later runs return that record. A failure throws
 * exit 2 ("worktree setup failed: ...") so the run fails; the failure is recorded too, and the next run of the task
 * tries again. Sessions whose cwd is not the task worktree (answer, converse) skip it.
 */
export async function runWorktreeSetup(store: Store, session: SessionRow, options: WorktreeSetupOptions): Promise<SetupRecord | undefined> {
  if (!session.task_id) return undefined;
  const task = store.requireTask(session.task_id);
  if (!task.worktree_path || !samePath(session.cwd, task.worktree_path)) return undefined;
  const key = `${SETUP_META_PREFIX}${task.id}`;
  const previous = store.getMeta(key);
  if (previous) {
    try {
      const rec = JSON.parse(previous) as SetupRecord;
      if (rec.status === 'ok' || rec.status === 'none') return rec;
    } catch {
      // run it again
    }
  }
  const project = store.getProject(task.project_id)!;
  const command = options.command === undefined ? setupCommand(project.name, task.worktree_path) : (options.command ?? undefined);
  const at = new Date().toISOString();
  if (!command) {
    const rec: SetupRecord = { status: 'none', command: null, exitCode: null, durationMs: 0, session: session.id, at };
    store.setMeta(key, JSON.stringify(rec));
    return rec;
  }
  const logFile = options.logFile ?? paths.sessionLog(session.id);
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${at} worktree setup: ${command} (in ${task.worktree_path})\n`);
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const { code, timedOut } = await new Promise<{ code: number | null; timedOut: boolean }>((resolvePromise) => {
    const child = spawn('sh', ['-c', command], {
      cwd: task.worktree_path!,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let timedOutFlag = false;
    const write = (chunk: Buffer) => {
      try {
        appendFileSync(logFile, redact(chunk.toString('utf8')));
      } catch {
        // the log is best effort
      }
    };
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    const timer = setTimeout(() => {
      timedOutFlag = true;
      kill();
    }, timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise({ code: null, timedOut: false });
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolvePromise({ code: c, timedOut: timedOutFlag });
    });
  });
  const durationMs = Date.now() - started;
  const ok = code === 0 && !timedOut;
  const rec: SetupRecord = { status: ok ? 'ok' : 'failed', command, exitCode: code, durationMs, session: session.id, at: new Date().toISOString() };
  store.setMeta(key, JSON.stringify(rec));
  appendFileSync(logFile, `${rec.at} worktree setup ${ok ? 'ok' : 'failed'}: exit ${code ?? 'none'}${timedOut ? ' (timed out)' : ''} after ${durationMs} ms\n`);
  recordEvent(store, session.id, 'tool-result', {
    name: 'worktree-setup',
    command,
    ok,
    exitCode: code,
    timedOut,
    durationMs,
    text: ok ? `Worktree setup: ${command} ok.` : `Worktree setup failed: ${command} exited ${code ?? 'without a code'}${timedOut ? ' (timed out)' : ''}. Output in the session log.`,
  });
  if (!ok) {
    throw refused(`worktree setup failed: ${command} exited ${code ?? 'without a code'}${timedOut ? ` after ${Math.round(timeoutMs / 1000)} s (timed out)` : ''}`);
  }
  return rec;
}
