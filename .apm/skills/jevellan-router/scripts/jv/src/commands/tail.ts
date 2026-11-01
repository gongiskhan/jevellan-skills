// jv tail S [--follow]: prints a session's events. Text: one line per event. --json: one JSON object per line
// ({seq, at, kind, payload}). --follow keeps reading until the session's end event (or it is lost). Lost runs are
// marked at read time (launcher.markLost).

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagInt, requirePositional } from '../command.js';
import { tailEvents } from '../events.js';
import { normalizeId } from '../ids.js';
import { markLost } from '../launcher.js';
import { openStore } from '../store.js';
import type { EventRow } from '../types.js';

function oneLine(text: string, max = 400): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** One event as a line for humans. */
export function formatEvent(row: EventRow): string {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // keep {}
  }
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  let body: string;
  switch (row.kind) {
    case 'start':
      body = `${s('runtime')} ${s('provider')} ${s('model')} ${s('effort')} in ${s('cwd')}${p.resume ? ' (resume)' : ''}`;
      break;
    case 'text':
    case 'thinking':
      body = oneLine(s('text'));
      break;
    case 'tool-call':
      body = `${s('name')} ${oneLine(s('input'), 200)}`;
      break;
    case 'tool-result':
      body = `${p.ok === false ? 'error ' : ''}${oneLine(s('output'), 200)}`;
      break;
    case 'report':
      body = `${s('status')}: ${oneLine(s('summary'))}`;
      break;
    case 'usage':
      body = `in ${String(p.inputTokens ?? 0)} out ${String(p.outputTokens ?? 0)} cache read ${String(p.cacheReadTokens ?? 0)} write ${String(p.cacheWriteTokens ?? 0)}${typeof p.costUsd === 'number' ? ` $${p.costUsd}` : ''}`;
      break;
    case 'rate-limit':
      body = `five-hour ${String(p.fiveHourPct ?? '?')}% weekly ${String(p.weeklyPct ?? '?')}%`;
      break;
    case 'error':
    case 'message':
      body = oneLine(s('message') || s('text'));
      break;
    case 'end':
      body = `${s('status')}${s('reason') ? ` (${s('reason')})` : ''}`;
      break;
    default:
      body = oneLine(row.payload);
  }
  return `${row.seq} ${row.at} ${row.kind} ${body}`;
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const id = normalizeId(requirePositional(args, 0, 'the session id (jv tail S)'));
  const follow = flagBool(args, 'follow');
  const since = flagInt(args, 'since') ?? 0;
  const store = openStore();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  try {
    store.requireSession(id);
    markLost(store);
    for await (const row of tailEvents(store, id, since, {
      follow,
      signal: controller.signal,
      onPoll: () => markLost(store),
    })) {
      if (io.json) {
        let payload: unknown = row.payload;
        try {
          payload = JSON.parse(row.payload);
        } catch {
          // keep the text
        }
        io.write(`${JSON.stringify({ session: row.session_id, seq: row.seq, at: row.at, kind: row.kind, payload })}\n`);
      } else io.write(`${formatEvent(row)}\n`);
    }
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    store.close();
  }
}
