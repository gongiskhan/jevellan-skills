// The launcher: creates run rows, starts each run as a detached `jv run <R>` process, tells live runs from lost ones,
// and stops runs.
//
// - createRun inserts a sessions row (one run = one turn, D-006) under a request id; a repeat with the same input
//   returns the row (store request_id rule). A run that continues a conversation carries its native_session_id; the
//   message it delivers besides the task's undelivered messages (for example "Continue.") is kept in meta
//   `run_message:<R>`, read by `jv run`.
// - spawnRun starts "<node> --disable-warning=ExperimentalWarning <JV_HOME>/runtime/bin/jv.mjs run <R>" detached
//   (its own session and process group: pgid = pid), stdout and stderr appended to ~/.jv/logs/<R>.log, and records
//   pid and pgid. The child gets this process's environment without JV_SESSION (a coordinator's id must not leak into
//   the run); the worker's own environment is built from scratch inside the run (env.ts).
// - markLost flips starting/running rows whose process is gone and that have no `end` event to `lost` (jv status and
//   jv tail call it at read time).
// - stopRun marks the row stopped, sends SIGTERM to its process group, and SIGKILL after the grace period (10 s).

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refused } from './errors.js';
import { bootstrapNode } from './env.js';
import { recordEvent } from './events.js';
import { paths } from './paths.js';
import type { Created, Store } from './store.js';
import type { Runtime, SessionKind, SessionRow, SessionState } from './types.js';

export const STOP_GRACE_MS = 10_000;
export const RUN_MESSAGE_META_PREFIX = 'run_message:';

export interface CreateRunInput {
  requestId: string;
  projectId: string;
  taskId?: string | null;
  stepId?: string | null;
  kind?: SessionKind;
  runtime: Runtime;
  provider: string;
  model: string;
  effort: string;
  cwd: string;
  /** The conversation this run continues (resume); absent for a first turn. */
  nativeSessionId?: string | null;
  /** A message this run delivers besides the task's undelivered messages (e.g. "Continue."). */
  message?: string;
  stateReason?: string;
}

/** Inserts the run's sessions row (state queued). */
export function createRun(store: Store, input: CreateRunInput): Created<SessionRow> {
  return store.tx(() => {
    const created = store.createSession({
      request_id: input.requestId,
      project_id: input.projectId,
      task_id: input.taskId ?? null,
      step_id: input.stepId ?? null,
      kind: input.kind ?? 'step',
      runtime: input.runtime,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      ...(input.nativeSessionId ? { native_session_id: input.nativeSessionId } : {}),
      state: 'queued',
      state_reason: input.stateReason ?? (input.nativeSessionId ? 'queued to continue the conversation' : 'queued'),
    });
    if (created.created && input.message !== undefined && input.message.trim() !== '') {
      store.setMeta(`${RUN_MESSAGE_META_PREFIX}${created.row.id}`, input.message);
    }
    return created;
  });
}

/** The extra message createRun stored for a run, if any. */
export function runMessage(store: Store, sessionId: string): string | undefined {
  return store.getMeta(`${RUN_MESSAGE_META_PREFIX}${sessionId}`);
}

export interface SpawnRunOptions {
  /** Node binary (default: the bootstrap Node of install.json, else this process's). */
  node?: string;
  /** The jv entry script (default: $JV_HOME/runtime/bin/jv.mjs). */
  entry?: string;
  /** Environment of the run process (default: process.env without JV_SESSION). JV_HOME is always set. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedRun {
  pid: number;
  pgid: number;
  log: string;
}

/** Starts `jv run <R>` detached. Only a queued row can be started. */
export function spawnRun(store: Store, sessionId: string, options: SpawnRunOptions = {}): SpawnedRun {
  const session = store.requireSession(sessionId);
  if (session.state !== 'queued') throw refused(`session ${sessionId} is ${session.state}; only a queued run can be started`);
  const node = options.node ?? bootstrapNode();
  const entry = options.entry ?? join(paths.runtimeDir, 'bin', 'jv.mjs');
  const log = paths.sessionLog(sessionId);
  mkdirSync(paths.logsDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), JV_HOME: paths.home };
  delete env.JV_SESSION;
  store.setSessionState(sessionId, 'starting', 'launching jv run');
  const fd = openSync(log, 'a', 0o600);
  try {
    const child = spawn(node, ['--disable-warning=ExperimentalWarning', entry, 'run', sessionId], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
      cwd: paths.home,
    });
    const pid = child.pid;
    if (pid === undefined) {
      store.setSessionState(sessionId, 'failed', `could not start jv run (${node})`);
      throw refused(`could not start jv run for ${sessionId}`);
    }
    child.on('error', () => {
      // reported through the row: markLost sees the process gone without an end event
    });
    child.unref();
    store.updateSession(sessionId, { pid, pgid: pid });
    return { pid, pgid: pid, log };
  } finally {
    closeSync(fd);
  }
}

/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
export function isAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process group of a pid from /proc (Linux), else undefined. */
export function processGroup(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid pgrp ...; comm may hold spaces and parentheses, so read after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(fields[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
  } catch {
    return undefined;
  }
}

function processZombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
}

/**
 * Whether the run's process is still there: the pid exists, is not a zombie, and (where /proc can tell) its command
 * line names this session, so a reused pid does not keep a dead run alive.
 */
export function isRunAlive(session: Pick<SessionRow, 'id' | 'pid'>): boolean {
  if (!isAlive(session.pid)) return false;
  const pid = session.pid!;
  if (processZombie(pid)) return false;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.split('\0').includes(session.id);
  } catch {
    return true;
  }
}

const LIVE_STATES: readonly SessionState[] = ['starting', 'running'];

/** Marks starting/running rows lost when their process is gone and no `end` event arrived. Returns them. */
export function markLost(store: Store, options: { alive?: (s: SessionRow) => boolean } = {}): SessionRow[] {
  const alive = options.alive ?? isRunAlive;
  const lost: SessionRow[] = [];
  for (const s of store.listSessions({ states: LIVE_STATES })) {
    if (s.pid === null) continue;
    if (alive(s)) continue;
    const row = store.tx(() => {
      const now = store.getSession(s.id);
      if (!now || !LIVE_STATES.includes(now.state)) return undefined;
      if (store.lastEvent(s.id, 'end')) return undefined;
      return store.setSessionState(s.id, 'lost', `process ${s.pid} ended without an end event`);
    });
    if (row) lost.push(row);
  }
  return lost;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface StopRunResult {
  session: SessionRow;
  signalled: boolean;
  killed: boolean;
}

/**
 * Stops a run: state stopped with `reason`, SIGTERM to its process group, SIGKILL when the group is still there
 * after `graceMs` (default 10 s). The run process writes its own `end` event on SIGTERM; when it had to be killed,
 * the `end` event is written here. A row that already ended is returned unchanged.
 */
export async function stopRun(store: Store, sessionId: string, reason: string, options: { graceMs?: number } = {}): Promise<StopRunResult> {
  const session = store.requireSession(sessionId);
  if (['done', 'failed', 'lost', 'stopped'].includes(session.state)) return { session, signalled: false, killed: false };
  const stopped = store.setSessionState(sessionId, 'stopped', reason);
  const pgid = session.pgid ?? session.pid;
  if (pgid === null || !groupAlive(pgid)) {
    if (!store.lastEvent(sessionId, 'end')) recordEvent(store, sessionId, 'end', { status: 'stopped', reason });
    return { session: store.requireSession(sessionId), signalled: false, killed: false };
  }
  const signalled = signalGroup(pgid, 'SIGTERM');
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pgid)) await new Promise((r) => setTimeout(r, 100));
  let killed = false;
  if (groupAlive(pgid)) killed = signalGroup(pgid, 'SIGKILL');
  if (!store.lastEvent(sessionId, 'end')) recordEvent(store, sessionId, 'end', { status: 'stopped', reason });
  return { session: store.getSession(sessionId) ?? stopped, signalled, killed };
}
