// Shared helpers of the acceptance scripts. Plain ESM, Node 22.13 or later, no dependencies.
//
// The scripts drive the installed jv (`$JV_HOME/bin/jv`, JV_HOME defaults to ~/.jv), import the installed runtime's
// own modules from `$JV_HOME/runtime/dist/` where a phase has no command yet, and read the store read-only with
// node:sqlite. They never print a secret: the leak check feeds each key file's lines to `grep -F -f -` on stdin
// and prints only the file names that matched.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const JV_HOME = process.env.JV_HOME || join(homedir(), '.jv');
process.env.JV_HOME = JV_HOME;
export const JV = join(JV_HOME, 'bin', 'jv');
export const SANDBOX = process.env.JV_SANDBOX || '/home/ggomes/jevellan-projects/jevellan-live-sandbox';
export const SANDBOX_NAME = 'jevellan-live-sandbox';
export const STORE_FILE = join(JV_HOME, 'store.sqlite');

/**
 * The runtime the scripts import: `$JV_HOME/runtime/dist`, or JV_ACCEPT_RUNTIME_DIST (a script that runs part of a
 * check against a temporary JV_HOME, which has no runtime of its own, keeps importing the installed one).
 */
export const RUNTIME_DIST = process.env.JV_ACCEPT_RUNTIME_DIST || join(JV_HOME, 'runtime', 'dist');

/** Imports a module of the installed runtime (`<RUNTIME_DIST>/<name>`). */
export function runtimeModule(name) {
  return import(pathToFileURL(join(RUNTIME_DIST, name)).href);
}

/** Runs the installed jv. Returns {status, stdout, stderr, json}; json is the parsed stdout when it is JSON. */
export function jv(args, options = {}) {
  const r = spawnSync(JV, args, {
    encoding: 'utf8',
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 120_000,
  });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
}

/** A read-only connection to the store (closed by the caller). */
export function readStore(file = STORE_FILE) {
  return new DatabaseSync(file, { readOnly: true });
}

export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

/** What the main checkout looks like: HEAD, branch, porcelain status, worktree list. */
export function checkoutState(repo) {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: git(repo, ['status', '--porcelain']),
  };
}

let failures = 0;
const results = [];

/** The assertions recorded so far, in order: {name, ok, detail, at}. */
export function checkResults() {
  return results.map((r) => ({ ...r }));
}

/** Records one assertion and prints PASS or FAIL with the detail. */
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail, at: new Date().toISOString() });
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}\n`);
  return !!ok;
}

export function summary() {
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
  return failures === 0 ? 0 : 1;
}

/**
 * The patterns of one secret file: every line of at least 6 characters, and the value of NAME=value lines (the
 * redactor's rule, D-014). Shorter lines are not keys and would match ordinary text.
 */
function secretPatterns(file) {
  const out = new Set();
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length >= 6) out.add(line);
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(line);
    if (m && m[1].trim().length >= 6) out.add(m[1].trim());
  }
  return [...out];
}

/** The secret files: every file under $JV_HOME/secrets. */
export function secretFiles() {
  const dir = join(JV_HOME, 'secrets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((f) => statSync(f).isFile());
}

/**
 * grep -a -q -F -f - <targets> per secret file, patterns on stdin (never on argv, never on disk). Returns the list of
 * {secret, target} pairs that matched, by file name only.
 */
export function secretLeaks(targets) {
  const present = targets.filter((t) => existsSync(t));
  const leaks = [];
  for (const secret of secretFiles()) {
    const patterns = secretPatterns(secret);
    if (!patterns.length) continue;
    for (const target of present) {
      const r = spawnSync('grep', ['-a', '-q', '-F', '-f', '-', target], { input: `${patterns.join('\n')}\n` });
      if (r.status === 0) leaks.push({ secret, target });
      else if (r.status !== 1) leaks.push({ secret, target, error: `grep exit ${r.status}` });
    }
  }
  return { checked: present, secrets: secretFiles().length, leaks };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('T', 't').replace('Z', 'z');
}

/**
 * The disposable clone of the sandbox that phases 4 and 5 land into (never the real sandbox): JV_ACCEPT_CLONE, and
 * its jv project name JV_ACCEPT_PROJECT (default sandbox-clone). The scripts refuse to run without the clone.
 */
export const CLONE = process.env.JV_ACCEPT_CLONE || '';
export const CLONE_PROJECT = process.env.JV_ACCEPT_PROJECT || 'sandbox-clone';
/** The real sandbox's main before any acceptance run: landing must never move it. */
export const SANDBOX_MAIN = '61fc71abcf86d4cd14a127bb47ff473fddece17b';

/** Runs jv with --json appended; exits are data, not exceptions. */
export function jvJson(args, options = {}) {
  return jv([...args, '--json'], options);
}

/** Polls fn every intervalMs until it returns a value other than undefined/false, or the timeout passes (undefined). */
export async function waitFor(fn, { timeoutMs, intervalMs = 5000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false && v !== null) return v;
    if (Date.now() > deadline) return undefined;
    if (onTick) onTick();
    await sleep(intervalMs);
  }
}

/** One query against a fresh read-only store connection. */
export function query(sql, ...params) {
  const db = readStore();
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function queryOne(sql, ...params) {
  return query(sql, ...params)[0];
}

export function taskByRequest(requestId) {
  return queryOne('SELECT * FROM tasks WHERE request_id = ?', requestId);
}

export function log(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

/** Whether `commit` is on `branch` of `repo`. */
export function onBranch(repo, commit, branch) {
  return spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, branch]).status === 0;
}

/** Live (queued, starting, running) step sessions of a task. */
export function liveSessions(taskId) {
  return query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' AND state IN ('queued','starting','running') ORDER BY started_at", taskId);
}
