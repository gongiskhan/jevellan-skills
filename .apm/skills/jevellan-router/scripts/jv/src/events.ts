// recordEvent (section 6): the one function every runtime adapter writes events through.
//
// - seq comes from store.appendEvent, which also sets the session's last_event_at, in one transaction.
// - Every string of the payload (and every key) is redacted first, then each string longer than 20000 characters is
//   cut and the payload gets `truncated: true`. Redacting before cutting means a secret is never split across the cut
//   (a split half would no longer match the redactor).
// - `usage` events add their tokens and cost to the session's counters; `rate-limit` events are also written to
//   provider_usage with source `stream`, under the session's provider. Both in the event's transaction.
// - tailEvents reads a session's events from the store (the tail() of every runtime module).

import { defaultRedactor, type Redactor } from './redact.js';
import type { Store, UsageDelta } from './store.js';
import type { EventKind, EventRow } from './types.js';

export const EVENT_TEXT_MAX = 20000;

export interface RecordEventOptions {
  redactor?: Redactor;
  at?: string;
}

/** Usage payload of a `usage` event (deltas for this turn). */
export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

/** Payload of a `rate-limit` event (ported claudeStreamUsage shape). */
export interface RateLimitPayload {
  fiveHourPct?: number;
  weeklyPct?: number;
  fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
  [key: string]: unknown;
}

/** The text cut to at most `max` characters (code points, so a surrogate pair is never split). */
export function trimText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false };
  return { text: chars.slice(0, max).join(''), truncated: true };
}

/** A copy of a JSON-like value with every string cut to `max`; reports whether anything was cut. */
export function trimStrings<T>(value: T, max: number = EVENT_TEXT_MAX): { value: T; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const t = trimText(v, max);
      if (t.truncated) truncated = true;
      return t.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, truncated };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function pct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function iso(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * Appends one event to a session: redacts, trims, assigns seq, updates last_event_at, and for `usage` and
 * `rate-limit` events the session's counters and provider_usage. Returns the stored row.
 */
export function recordEvent(
  store: Store,
  sessionId: string,
  kind: EventKind,
  payload: unknown,
  options: RecordEventOptions = {},
): EventRow {
  const redactor = options.redactor ?? defaultRedactor();
  const redacted = redactor.redactValue(payload ?? {});
  const { value, truncated } = trimStrings(redacted, EVENT_TEXT_MAX);
  const stored =
    truncated && value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), truncated: true }
      : truncated
        ? { value, truncated: true }
        : value;
  return store.tx(() => {
    const row = store.appendEvent(sessionId, kind, stored, options.at);
    if (kind === 'usage' && value && typeof value === 'object') {
      const u = value as UsagePayload;
      const delta: UsageDelta = {
        input_tokens: count(u.inputTokens),
        output_tokens: count(u.outputTokens),
        cache_read_tokens: count(u.cacheReadTokens),
        cache_write_tokens: count(u.cacheWriteTokens),
      };
      if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0) delta.cost_usd = u.costUsd;
      store.addSessionUsage(sessionId, delta);
    }
    if (kind === 'rate-limit' && value && typeof value === 'object') {
      const r = value as RateLimitPayload;
      const session = store.requireSession(sessionId);
      const fiveHour = pct(r.fiveHourPct);
      const weekly = pct(r.weeklyPct);
      if (fiveHour !== null || weekly !== null) {
        store.recordProviderUsage({
          provider: session.provider,
          observed_at: row.at,
          source: 'stream',
          five_hour_pct: fiveHour,
          weekly_pct: weekly,
          five_hour_resets_at: iso(r.fiveHourResetsAt),
          weekly_resets_at: iso(r.weeklyResetsAt),
        });
      }
    }
    return row;
  });
}

/** A recorder bound to one session (what an adapter keeps for the length of a run). */
export function eventRecorder(store: Store, sessionId: string, options: RecordEventOptions = {}) {
  return (kind: EventKind, payload: unknown): EventRow => recordEvent(store, sessionId, kind, payload, options);
}

export interface TailOptions {
  /** Keep reading until the session has an `end` event (default false: what is there now). */
  follow?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called between polls in follow mode (jv tail marks lost sessions there). */
  onPoll?: () => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

const FINAL_STATES = new Set(['done', 'failed', 'lost', 'stopped']);
/** How long follow waits for the `end` event of a run already in a final state (stopRun allows 10 s). */
const END_WAIT_MS = 15_000;

/**
 * The events of a session after `sinceSeq`, oldest first. With follow, polls until an `end` event was read, or the
 * session reached a final state and no event followed (a lost session never writes `end`).
 */
export async function* tailEvents(store: Store, sessionId: string, sinceSeq = 0, options: TailOptions = {}): AsyncGenerator<EventRow> {
  let after = sinceSeq;
  let finalSince: number | undefined;
  const pollMs = options.pollMs ?? 500;
  for (;;) {
    const rows = store.listEvents(sessionId, { afterSeq: after });
    for (const row of rows) {
      after = row.seq;
      yield row;
      if (row.kind === 'end' && options.follow) return;
    }
    if (!options.follow || options.signal?.aborted) return;
    const session = store.getSession(sessionId);
    if (!session) return;
    // A lost run never writes `end`; every other final state gets one (run.ts before its final state, stopRun after
    // a kill), so follow waits for it, up to a bound in case the writer died in between.
    if (rows.length === 0 && FINAL_STATES.has(session.state) && store.listEvents(sessionId, { afterSeq: after }).length === 0) {
      if (session.state === 'lost' || store.lastEvent(sessionId, 'end')) return;
      finalSince ??= Date.now();
      if (Date.now() - finalSince > END_WAIT_MS) return;
    }
    await sleep(pollMs, options.signal);
    options.onPoll?.();
  }
}
