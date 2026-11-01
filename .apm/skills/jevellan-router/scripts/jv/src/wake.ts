// Wake lines (section 9.4): when a task needs the coordinator, one [jv] line is typed into the project's
// coordinator tmux window (tmux send-keys -l, then Enter).
//
// - The caller builds the line: "[jv] <task id> (<title>) step <duty>: <event>. Run: jv report <R>" (or
//   "jv task show <T>"). It is made one line here (control characters become spaces), cut to 500 characters, and
//   masked by the redactor.
// - No coordinator registered, its row not live, or its tmux session gone: nothing is typed and nothing is queued;
//   the event waits for `jv status`.
// - At most one line every 5 s per project, across processes. The state is the meta row `wake:<project id>`:
//   {"lastSentAt": ISO time | null, "pending": [lines], "flusher": {"pid", "dueAt"} | absent}, read and written
//   only inside store transactions. Outside the window with nothing pending, the line is sent at once. Inside it,
//   the line is queued; the process that queued the first pending line is the flusher: it waits until the window
//   ends, takes every pending line, and sends the single line when there is one, else one merged line
//   "[jv] N updates. Run: jv status --json". A later event that finds pending lines whose flusher is gone (its pid
//   no longer exists, or it is more than 30 s past its due time) takes the flushing over, so a killed process
//   never strands the queue.

import { liveCoordinator, realTmux, typeLine, type TmuxRunner } from './coordinator.js';
import { isAlive } from './launcher.js';
import { redact } from './redact.js';
import type { Store } from './store.js';

export const WAKE_WINDOW_MS = 5_000;
export const WAKE_META_PREFIX = 'wake:';
export const WAKE_LINE_MAX = 500;
/** A flusher this long past its due time is taken over. */
export const FLUSHER_STALE_MS = 30_000;

export interface WakeInput {
  projectId: string;
  taskId?: string;
  /** The whole line, built by the caller. */
  line: string;
}

export interface WakeDeps {
  tmux?: TmuxRunner;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  /** Whether a pid is alive (tests). */
  alive?: (pid: number) => boolean;
  pid?: number;
}

export interface WakeState {
  lastSentAt: string | null;
  pending: string[];
  flusher?: { pid: number; dueAt: string };
}

/** What notifyCoordinator did, for tests and logs. */
export type WakeOutcome =
  | { action: 'no-coordinator' }
  | { action: 'sent'; line: string; typed: boolean }
  | { action: 'queued' }
  | { action: 'flushed'; line: string; count: number; typed: boolean }
  | { action: 'taken-over' };

export function wakeMetaKey(projectId: string): string {
  return `${WAKE_META_PREFIX}${projectId}`;
}

export function readWakeState(store: Store, projectId: string): WakeState {
  const raw = store.getMeta(wakeMetaKey(projectId));
  if (raw === undefined) return { lastSentAt: null, pending: [] };
  try {
    const v = JSON.parse(raw) as Partial<WakeState>;
    return {
      lastSentAt: typeof v.lastSentAt === 'string' ? v.lastSentAt : null,
      pending: Array.isArray(v.pending) ? v.pending.filter((l): l is string => typeof l === 'string') : [],
      ...(v.flusher && typeof v.flusher.pid === 'number' && typeof v.flusher.dueAt === 'string' ? { flusher: v.flusher } : {}),
    };
  } catch {
    return { lastSentAt: null, pending: [] };
  }
}

function writeWakeState(store: Store, projectId: string, state: WakeState): void {
  store.setMeta(wakeMetaKey(projectId), JSON.stringify(state));
}

/** One line, no control characters, at most WAKE_LINE_MAX characters, secrets masked. */
export function wakeLine(line: string): string {
  const flat = redact(line).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= WAKE_LINE_MAX ? flat : `${chars.slice(0, WAKE_LINE_MAX - 3).join('')}...`;
}

/** The line a flush sends for `lines`. */
export function mergedLine(lines: readonly string[]): string {
  return lines.length === 1 ? lines[0]! : `[jv] ${lines.length} updates. Run: jv status --json`;
}

/**
 * Types one [jv] line into the project's coordinator (section 9.4), throttled to one line every 5 s per project.
 * Never throws for a missing coordinator or a tmux failure: a wake line is a nudge, the store has the facts.
 */
export async function notifyCoordinator(store: Store, input: WakeInput, deps: WakeDeps = {}): Promise<void> {
  try {
    await wake(store, input, deps);
  } catch (error) {
    process.stderr.write(`jv: wake line for ${input.projectId} not sent: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  }
}

/** notifyCoordinator, returning what it did. */
export async function wake(store: Store, input: WakeInput, deps: WakeDeps = {}): Promise<WakeOutcome> {
  const tmux = deps.tmux ?? realTmux;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const windowMs = deps.windowMs ?? WAKE_WINDOW_MS;
  const alive = deps.alive ?? ((pid: number) => isAlive(pid));
  const pid = deps.pid ?? process.pid;

  const live = liveCoordinator(store, input.projectId, tmux);
  if (!live) return { action: 'no-coordinator' };
  const line = wakeLine(input.line);
  if (line === '') return { action: 'queued' };

  const decision = store.tx((): { send: string } | { flushAt: number; takenOver: boolean } | { queued: true } => {
    const state = readWakeState(store, input.projectId);
    const t = now();
    const last = state.lastSentAt ? Date.parse(state.lastSentAt) : Number.NEGATIVE_INFINITY;
    if (state.pending.length === 0 && t - last >= windowMs) {
      writeWakeState(store, input.projectId, { lastSentAt: new Date(t).toISOString(), pending: [] });
      return { send: line };
    }
    const hadPending = state.pending.length > 0;
    state.pending.push(line);
    const flusher = state.flusher;
    const flusherAlive = !!flusher && alive(flusher.pid) && t <= Date.parse(flusher.dueAt) + FLUSHER_STALE_MS;
    if (!hadPending || !flusherAlive) {
      const dueAt = Math.max(Number.isFinite(last) ? last + windowMs : t, t);
      writeWakeState(store, input.projectId, { ...state, flusher: { pid, dueAt: new Date(dueAt).toISOString() } });
      return { flushAt: dueAt, takenOver: hadPending };
    }
    writeWakeState(store, input.projectId, state);
    return { queued: true };
  });

  if ('send' in decision) return { action: 'sent', line: decision.send, typed: typeLine(tmux, live.record.tmuxSession, decision.send) };
  if ('queued' in decision) return { action: 'queued' };

  const wait = decision.flushAt - now();
  if (wait > 0) await sleep(wait);
  const taken = store.tx((): string[] | undefined => {
    const state = readWakeState(store, input.projectId);
    if (!state.flusher || state.flusher.pid !== pid) return undefined;
    const lines = state.pending;
    writeWakeState(store, input.projectId, { lastSentAt: new Date(now()).toISOString(), pending: [] });
    return lines;
  });
  if (taken === undefined) return { action: 'taken-over' };
  if (taken.length === 0) return { action: 'queued' };
  const out = mergedLine(taken);
  // The coordinator may have gone while this process waited; typing into a missing session is a no-op.
  const target = liveCoordinator(store, input.projectId, tmux);
  const typed = target ? typeLine(tmux, target.record.tmuxSession, out) : false;
  return { action: 'flushed', line: out, count: taken.length, typed };
}
