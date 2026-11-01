// The owner's takeover of a claude-sdk run (jv attach, J6): what the owner did in the interactive claude becomes
// events of the attached run when jv task resume continues the task.
//
// - jv attach marks the run waiting ("attached by owner") and records where the conversation's native transcript
//   (<provider home>/.claude/projects/<cwd slug>/<native id>.jsonl) ended at that moment: meta `takeover:<R>` =
//   {file, offset, at}. The interactive `claude --resume <native id>` appends to that same file.
// - jv task resume first imports the entries appended since then (transcript.ts parser) as events of the attached
//   run, every payload with source "takeover": what the owner typed as `message` events (from owner, role user),
//   the assistant's text and thinking, and tool calls and their results (inputs and outputs trimmed to 4000
//   characters). Then the run is marked done with a reason that counts them, and the task continues with a new turn
//   of the same conversation, which already holds the takeover turns.
// - While the takeover window (jv-<R>) is still open the run stays waiting with a reason naming it, and the resume is
//   refused (exit 4): two writers on one conversation would interleave, as jv attach refuses while a turn runs.
// - Without the meta record (a run attached before it existed), the entries whose timestamp is later than the run's
//   last event are taken. An import is recorded in the meta record (importedAt, the next offset), so a second resume
//   imports nothing twice.

import { conflict } from './errors.js';
import { recordEvent } from './events.js';
import type { Store } from './store.js';
import {
  claudeTranscriptPath,
  fileSize,
  findClaudeTranscript,
  nativeRecords,
  readComplete,
  transcriptEvents,
  turnsFromRecords,
  type NativeRecord,
} from './transcript.js';
import type { EventKind, SessionRow } from './types.js';

/** The reason jv attach gives the run it marks waiting (D-062). */
export const ATTACHED_REASON = 'attached by owner';
export const TAKEOVER_META_PREFIX = 'takeover:';
export const TAKEOVER_SOURCE = 'takeover';

export interface TakeoverRecord {
  file: string;
  /** Byte offset of the transcript when the owner attached. */
  offset: number;
  at: string;
  importedAt?: string;
  /** The offset after the last imported line. */
  importedTo?: number;
  imported?: number;
}

export function takeoverMetaKey(sessionId: string): string {
  return `${TAKEOVER_META_PREFIX}${sessionId}`;
}

export function readTakeover(store: Store, sessionId: string): TakeoverRecord | undefined {
  const raw = store.getMeta(takeoverMetaKey(sessionId));
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as TakeoverRecord;
    return typeof v.file === 'string' && typeof v.offset === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records where the transcript of a claude-sdk run ends as the owner takes it over. A record that was not imported
 * yet is kept (a second jv attach to the same waiting run must not move the start past what the owner typed).
 */
export function recordTakeoverStart(store: Store, session: SessionRow, home: string): TakeoverRecord | undefined {
  if (session.runtime !== 'claude-sdk' || !session.native_session_id) return undefined;
  const existing = readTakeover(store, session.id);
  if (existing && existing.importedAt === undefined) return existing;
  const file = findClaudeTranscript(home, session.cwd, session.native_session_id) ?? claudeTranscriptPath(home, session.cwd, session.native_session_id);
  const record: TakeoverRecord = { file, offset: fileSize(file), at: new Date().toISOString() };
  store.setMeta(takeoverMetaKey(session.id), JSON.stringify(record));
  return record;
}

export interface TakeoverImport {
  file?: string;
  /** Events written to the run. */
  events: number;
  /** Of them, what the owner typed. */
  messages: number;
  reason: string;
}

const COMMAND_MARKUP = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function ownerText(records: readonly NativeRecord[]): Array<{ text: string; at?: string }> {
  const out: Array<{ text: string; at?: string }> = [];
  for (const turn of turnsFromRecords(records, 'claude')) {
    if (turn.role !== 'user' || turn.automated) continue;
    const text = turn.blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();
    // A slash command the owner typed (/exit) is recorded by Claude Code as markup, not as a message.
    if (text !== '' && !COMMAND_MARKUP.test(text)) out.push({ text, ...(turn.at ? { at: turn.at } : {}) });
  }
  return out;
}

/** Records of `records` in order, each turned into the events it gives (owner text as `message`, the rest as is). */
function takeoverEvents(records: readonly NativeRecord[]): Array<{ kind: EventKind; payload: Record<string, unknown>; at?: string }> {
  const out: Array<{ kind: EventKind; payload: Record<string, unknown>; at?: string }> = [];
  // One record at a time keeps the order of the transcript; a tool result finds its call through the shared parse.
  const callNames = new Map<string, string>();
  for (const record of records) {
    const at = typeof record.value.timestamp === 'string' && Number.isFinite(Date.parse(record.value.timestamp)) ? record.value.timestamp : undefined;
    for (const m of ownerText([record])) out.push({ kind: 'message', payload: { from: 'owner', role: 'user', text: m.text, source: TAKEOVER_SOURCE }, ...(at ? { at } : {}) });
    for (const e of transcriptEvents(turnsFromRecords([record], 'claude'))) {
      if (e.kind === 'tool-call') callNames.set(e.payload.id, e.payload.name);
      const payload: Record<string, unknown> = { ...e.payload, source: TAKEOVER_SOURCE };
      if (e.kind === 'tool-result' && callNames.has(e.payload.id)) payload.name = callNames.get(e.payload.id);
      out.push({ kind: e.kind, payload, ...(at ? { at } : {}) });
    }
  }
  return out;
}

/**
 * Imports the transcript entries the owner's takeover appended as events of `session`, once. Refuses (exit 4) while
 * the takeover window is still open (`windowOpen`), after setting the run's reason to say so.
 */
export function importTakeover(
  store: Store,
  session: SessionRow,
  options: { home: string; windowOpen: boolean },
): TakeoverImport {
  if (options.windowOpen) {
    const reason = `attached by owner; the takeover window ${session.tmux_target ?? `jv-${session.id}`} is still open`;
    store.setSessionState(session.id, 'waiting', reason);
    throw conflict(
      `the owner's takeover of ${session.id} is still open in tmux ${session.tmux_target ?? `jv-${session.id}`}: leave claude there (/exit), then run jv task resume again`,
    );
  }
  if (!session.native_session_id) return { events: 0, messages: 0, reason: 'no native session to read' };
  const meta = readTakeover(store, session.id);
  if (meta?.importedAt) return { file: meta.file, events: 0, messages: 0, reason: 'already imported' };
  const file = meta?.file ?? findClaudeTranscript(options.home, session.cwd, session.native_session_id);
  if (!file) return { events: 0, messages: 0, reason: 'no transcript found' };

  let records: NativeRecord[];
  let next: number;
  if (meta) {
    const chunk = readComplete(file, meta.offset, 64 * 1024 * 1024);
    records = nativeRecords(chunk.text, chunk.start);
    next = chunk.next;
  } else {
    // Attached before the start was recorded: everything later than the run's last event.
    const since = store.lastEvent(session.id)?.at ?? session.ended_at ?? session.started_at ?? undefined;
    const chunk = readComplete(file, 0, 64 * 1024 * 1024);
    next = chunk.next;
    records = nativeRecords(chunk.text, 0).filter((r) => {
      const t = r.value.timestamp;
      return since !== undefined && typeof t === 'string' && Date.parse(t) > Date.parse(since);
    });
  }
  // Sub-agent records are not the owner's conversation.
  records = records.filter((r) => r.value.isSidechain !== true);

  const events = takeoverEvents(records);
  let messages = 0;
  store.tx(() => {
    for (const e of events) {
      recordEvent(store, session.id, e.kind, e.payload, e.at ? { at: e.at } : {});
      if (e.kind === 'message') messages++;
    }
    store.setMeta(
      takeoverMetaKey(session.id),
      JSON.stringify({
        ...(meta ?? { file, offset: 0, at: new Date().toISOString() }),
        importedAt: new Date().toISOString(),
        importedTo: next,
        imported: events.length,
      } satisfies TakeoverRecord),
    );
  });
  const reason =
    events.length === 0
      ? 'the owner ended the takeover; nothing was typed in it'
      : `the owner ended the takeover; ${events.length} transcript entries imported (${messages} typed by the owner)`;
  return { file, events: events.length, messages, reason };
}
