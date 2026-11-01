// Native transcripts (Claude Code's and Codex's JSONL session files): the parser ported from jevellan
// packages/mesh/src/native-transcript.ts at 8e2788ec (nativeRecords, parseNativeTranscript, nativeActivityFacts,
// nativeActivity; Claude and Codex branches), plus what the claude-tmux runtime needs on top of it: the transcript
// path, an incremental reader of complete lines, the end of a turn, the turn's token usage and the jv events.
//
// Differences from the original, with reasons:
// - No @jevellan/core cursor schema: a turn is the small TranscriptTurn below, and display values are plain strings
//   (cursorDisplayValue/cursorUserText were Jevellan's viewer helpers; jv trims text where it records events).
// - Only public display fields are projected, as in the original: no encrypted reasoning, no native credentials.
// - claudeTurnUsage sums the usage of a turn's API calls. Claude Code writes one transcript record per content block,
//   every one of them carrying its message's id and the same usage, so usage is counted once per message id.

import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type NativeRuntime = 'claude' | 'codex';

export const nativeObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const RecordSchema = z.object({ type: z.string().default('') }).catchall(z.unknown());
export type NativeRecordValue = z.infer<typeof RecordSchema>;

export interface NativeRecord {
  /** `journal:<byte offset of the line>`, stable across polls. */
  id: string;
  value: NativeRecordValue;
}

/** The JSON records of a transcript chunk that starts at byte `offset`. Lines that do not parse are skipped. */
export function nativeRecords(raw: string, offset = 0): NativeRecord[] {
  const records: NativeRecord[] = [];
  let byte = offset;
  for (const line of raw.split('\n')) {
    const id = `journal:${byte}`;
    byte += Buffer.byteLength(line) + 1;
    if (line.trim() === '') continue;
    try {
      const value = RecordSchema.safeParse(JSON.parse(line));
      if (value.success) records.push({ id, value: value.data });
    } catch {
      // An incomplete trailing write is read again on the next poll (readComplete keeps it unread).
    }
  }
  return records;
}

const partsText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value
          .map(nativeObject)
          .map((p) =>
            ['image', 'input_image'].includes(String(p.type))
              ? '[Image attachment]'
              : ['text', 'input_text', 'output_text', 'summary_text'].includes(String(p.type)) && typeof p.text === 'string'
                ? p.text
                : '',
          )
          .filter(Boolean)
          .join('\n')
      : '';

/** A value as display text: strings as they are, anything else as JSON. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

const cleanUser = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/^\s*## My request:\s*/i, '')
    .trim();

export type TranscriptBlock =
  | { type: 'text' | 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: string; output?: string; state: 'unknown' | 'completed' | 'failed' };

export interface TranscriptTurn {
  id: string;
  role: 'user' | 'assistant';
  blocks: TranscriptBlock[];
  automated?: true;
  at?: string;
}

/** The display turns of a transcript chunk. Only public display fields are projected. */
export function parseNativeTranscript(raw: string, runtime: NativeRuntime, offset = 0): TranscriptTurn[] {
  return turnsFromRecords(nativeRecords(raw, offset), runtime);
}

/** parseNativeTranscript over records already read. */
export function turnsFromRecords(records: readonly NativeRecord[], runtime: NativeRuntime): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const tools = new Map<string, Extract<TranscriptBlock, { type: 'tool' }>>();
  const userEvents =
    runtime === 'codex' && records.some(({ value }) => value.type === 'event_msg' && nativeObject(value.payload).type === 'user_message');
  for (const { id, value: row } of records) {
    let role: 'user' | 'assistant' = 'assistant';
    let automated = false;
    const blocks: TranscriptBlock[] = [];
    const addText = (value: string, thinking = false) => {
      if (value.trim()) blocks.push({ type: thinking ? 'thinking' : 'text', text: value });
    };
    const call = (key: unknown, name: unknown, input: unknown) => {
      const tool: Extract<TranscriptBlock, { type: 'tool' }> = {
        type: 'tool',
        id: typeof key === 'string' ? key : id,
        name: typeof name === 'string' ? name : 'Tool',
        input: displayValue(input ?? ''),
        state: 'unknown',
      };
      tools.set(tool.id, tool);
      blocks.push(tool);
    };
    const result = (key: unknown, output: unknown, failed: boolean) => {
      const text = partsText(output) || displayValue(output ?? '');
      const tool = tools.get(String(key));
      if (tool) {
        tool.output = text;
        tool.state = failed ? 'failed' : 'completed';
      } else {
        blocks.push({ type: 'tool', id: String(key ?? id), name: 'Tool result', input: '', output: text, state: failed ? 'failed' : 'completed' });
      }
    };
    if (runtime === 'claude') {
      if (!['user', 'assistant'].includes(row.type) || row.isSidechain === true) continue;
      role = row.type as 'user' | 'assistant';
      automated = row.isMeta === true;
      const content = nativeObject(row.message).content;
      for (const value of typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []) {
        const part = nativeObject(value);
        if (part.type === 'text' && typeof part.text === 'string') addText(role === 'user' ? cleanUser(part.text) : part.text);
        else if (part.type === 'thinking') addText(String(part.thinking ?? part.text ?? ''), true);
        else if (part.type === 'tool_use') call(part.id, part.name, part.input);
        else if (part.type === 'tool_result') result(part.tool_use_id, part.content, part.is_error === true);
        else if (part.type === 'image') addText('[Image attachment]');
      }
    } else {
      const part = nativeObject(row.payload);
      if (row.type === 'event_msg' && part.type === 'user_message') {
        role = 'user';
        addText(cleanUser(typeof part.message === 'string' ? part.message : ''));
      } else if (row.type !== 'response_item') continue;
      else if (part.type === 'message') {
        if ((part.role !== 'user' && part.role !== 'assistant') || (part.role === 'user' && userEvents)) continue;
        role = part.role as 'user' | 'assistant';
        const text = partsText(part.content);
        addText(role === 'user' ? cleanUser(text) : text);
      } else if (part.type === 'reasoning') addText(partsText(part.summary) || partsText(part.content), true);
      else if (part.type === 'function_call' || part.type === 'custom_tool_call') call(part.call_id ?? part.id, part.name, part.arguments ?? part.input);
      else if (part.type === 'function_call_output' || part.type === 'custom_tool_call_output') result(part.call_id, part.output, part.is_error === true);
    }
    if (blocks.length) {
      turns.push({
        id,
        role: blocks.every((block) => block.type === 'tool') ? 'assistant' : role,
        blocks,
        ...(automated ? { automated: true as const } : {}),
        ...(typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? { at: row.timestamp } : {}),
      });
    }
  }
  return turns;
}

// ---- activity (ported nativeActivityFacts / nativeActivityFromFacts / nativeActivity) -------------------------

export type ActivityFact = 'working' | 'idle' | 'text';

/** The activity a single record shows, if any. */
export function recordActivity(row: NativeRecordValue, runtime: NativeRuntime): ActivityFact | undefined {
  const part = nativeObject(row.payload);
  const message = nativeObject(row.message);
  let next: ActivityFact | undefined;
  if (runtime === 'codex') {
    if (row.type === 'event_msg') {
      if (['task_started', 'user_message'].includes(String(part.type))) next = 'working';
      if (['task_complete', 'turn_aborted', 'turn_complete', 'shutdown'].includes(String(part.type))) next = 'idle';
    } else if (row.type === 'response_item') {
      if (
        (part.type === 'message' && part.role === 'user') ||
        ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning'].includes(String(part.type))
      ) {
        next = 'working';
      }
      if (part.type === 'message' && part.role === 'assistant' && part.channel === 'final') next = 'idle';
    }
  } else {
    if (row.isSidechain === true) return undefined;
    if (row.type === 'user' && row.isMeta !== true) {
      next = /^\s*<command-name>\s*\/clear\s*<\/command-name>/.test(partsText(message.content)) ? 'idle' : 'working';
    }
    if (row.type === 'assistant') {
      next = ['end_turn', 'stop_sequence'].includes(String(message.stop_reason))
        ? 'idle'
        : message.stop_reason == null &&
            Array.isArray(message.content) &&
            message.content.length > 0 &&
            message.content.every((value) => nativeObject(value).type === 'text')
          ? 'text'
          : 'working';
    }
    if (row.type === 'system' && row.subtype === 'turn_duration') next = 'idle';
  }
  return next;
}

/** Bounded activity evidence of a transcript: the last activity fact and its time. */
export function nativeActivityFacts(raw: string, runtime: NativeRuntime, modified: number): { state: ActivityFact | undefined; at: number } {
  let state: ActivityFact | undefined;
  let at = modified;
  for (const { value: row } of nativeRecords(raw)) {
    const next = recordActivity(row, runtime);
    if (next) {
      state = next;
      const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      if (Number.isFinite(time)) at = time;
    }
  }
  return { state, at };
}

export function nativeActivityFromFacts(
  facts: ReturnType<typeof nativeActivityFacts>,
  modified: number,
  now = Date.now(),
): 'working' | 'idle' | 'unknown' {
  let { state } = facts;
  if (state === 'text') state = now - facts.at > 5000 ? 'idle' : 'working';
  if (state === 'working' && now - modified > 6 * 60 * 60_000) return 'unknown';
  return state ?? (now - modified <= 20_000 ? 'working' : 'unknown');
}

export function nativeActivity(raw: string, runtime: NativeRuntime, modified: number, now = Date.now()): 'working' | 'idle' | 'unknown' {
  return nativeActivityFromFacts(nativeActivityFacts(raw, runtime, modified), modified, now);
}

// ---- Claude transcript files ------------------------------------------------------------------------------

/** Claude Code's project folder name for a cwd: every character that is not a letter or digit becomes "-". */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** <home>/.claude/projects/<cwd slug>/<session id>.jsonl (the cwd with symlinks resolved, as Claude Code sees it). */
export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  return join(home, '.claude', 'projects', cwdSlug(real(cwd)), `${sessionId}.jsonl`);
}

/**
 * The transcript of a Claude session: the expected path, else a `<session id>.jsonl` in any project folder of the
 * home (Claude Code shortens very long folder names), else undefined.
 */
export function findClaudeTranscript(home: string, cwd: string, sessionId: string): string | undefined {
  const expected = claudeTranscriptPath(home, cwd, sessionId);
  if (existsSync(expected)) return expected;
  const root = join(home, '.claude', 'projects');
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch {
    // no projects folder yet
  }
  return undefined;
}

/** Size of a file in bytes, 0 when it does not exist. */
export function fileSize(file: string | undefined): number {
  if (!file) return 0;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The complete lines of `file` after byte `offset`: the text up to and including the last newline, and the offset
 * after it. An incomplete last line stays unread for the next call. A file that shrank is read from the start.
 */
export function readComplete(file: string, offset: number, maxBytes = 8 * 1024 * 1024): { text: string; start: number; next: number } {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { text: '', start: offset, next: offset };
  }
  const start = size < offset ? 0 : offset;
  if (size === start) return { text: '', start, next: start };
  const length = Math.min(size - start, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  let read = 0;
  try {
    read = readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const chunk = buffer.subarray(0, read);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // One line longer than maxBytes is skipped whole; a short incomplete line waits.
    return length === maxBytes ? { text: '', start, next: start + read } : { text: '', start, next: start };
  }
  return { text: chunk.subarray(0, lastNewline + 1).toString('utf8'), start, next: start + lastNewline + 1 };
}

// ---- turn state, usage and events of a Claude transcript ---------------------------------------------------

/** Follows the records of one turn: whether it ended (idle), and since when. */
export class TurnTracker {
  state: ActivityFact | undefined;
  /** The time the last activity fact arrived (Date.now() of the caller). */
  changedAt = 0;
  /** Whether a user record (the typed prompt) arrived. */
  sawUser = false;

  constructor(private readonly runtime: NativeRuntime = 'claude') {}

  feed(records: readonly NativeRecord[], now: number): void {
    for (const { value } of records) {
      if (value.type === 'user' && value.isMeta !== true && value.isSidechain !== true) this.sawUser = true;
      const next = recordActivity(value, this.runtime);
      if (next) {
        this.state = next;
        this.changedAt = now;
      }
    }
  }

  /** The turn ended: idle, or text with no stop reason that stayed quiet for `textQuietMs`. */
  ended(now: number, textQuietMs = 5000): boolean {
    if (this.state === 'idle') return true;
    return this.state === 'text' && now - this.changedAt > textQuietMs;
  }

  reset(now: number): void {
    this.state = 'working';
    this.changedAt = now;
  }
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** API calls counted (distinct message ids). */
  calls: number;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Collects the usage of a turn's assistant messages, once per message id. */
export class UsageCollector {
  readonly #byMessage = new Map<string, { input: number; output: number; read: number; write: number }>();

  feed(records: readonly NativeRecord[]): void {
    for (const { id, value } of records) {
      if (value.type !== 'assistant' || value.isSidechain === true) continue;
      const message = nativeObject(value.message);
      const usage = nativeObject(message.usage);
      if (Object.keys(usage).length === 0) continue;
      const key = typeof message.id === 'string' && message.id !== '' ? message.id : id;
      const u = {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        read: count(usage.cache_read_input_tokens),
        write: count(usage.cache_creation_input_tokens),
      };
      const prev = this.#byMessage.get(key);
      // Records of one message repeat its usage; a later record may carry the final output count, so keep the larger.
      this.#byMessage.set(
        key,
        prev
          ? {
              input: Math.max(prev.input, u.input),
              output: Math.max(prev.output, u.output),
              read: Math.max(prev.read, u.read),
              write: Math.max(prev.write, u.write),
            }
          : u,
      );
    }
  }

  total(): TurnUsage {
    const out: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: this.#byMessage.size };
    for (const u of this.#byMessage.values()) {
      out.inputTokens += u.input;
      out.outputTokens += u.output;
      out.cacheReadTokens += u.read;
      out.cacheWriteTokens += u.write;
    }
    return out;
  }
}

/** Usage of a set of records (UsageCollector in one call). */
export function claudeTurnUsage(records: readonly NativeRecord[]): TurnUsage {
  const c = new UsageCollector();
  c.feed(records);
  return c.total();
}

export const TOOL_TEXT_MAX = 4000;

function trimmed(text: string, max = TOOL_TEXT_MAX): { text: string; truncated?: true } {
  const chars = [...text];
  return chars.length <= max ? { text } : { text: chars.slice(0, max).join(''), truncated: true };
}

export type TranscriptEvent =
  | { kind: 'text' | 'thinking'; payload: { text: string; at?: string } }
  | { kind: 'tool-call'; payload: { id: string; name: string; input: string; inputTruncated?: true } }
  | { kind: 'tool-result'; payload: { id: string; ok: boolean; output: string; outputTruncated?: true } };

/**
 * The jv events of parsed turns: assistant text and thinking, tool calls and their results (inputs and outputs
 * trimmed to 4000 characters). User text (the typed prompt, hook feedback) is not an event: jv records what it
 * typed itself. A tool result that arrives in a later chunk than its call is an event of its own.
 */
export function transcriptEvents(turns: readonly TranscriptTurn[]): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type !== 'tool') {
        if (turn.role === 'assistant') out.push({ kind: block.type, payload: { text: block.text, ...(turn.at ? { at: turn.at } : {}) } });
        continue;
      }
      if (block.name !== 'Tool result') {
        const t = trimmed(block.input);
        out.push({ kind: 'tool-call', payload: { id: block.id, name: block.name, input: t.text, ...(t.truncated ? { inputTruncated: true as const } : {}) } });
      }
      if (block.output !== undefined) {
        const t = trimmed(block.output);
        out.push({
          kind: 'tool-result',
          payload: { id: block.id, ok: block.state !== 'failed', output: t.text, ...(t.truncated ? { outputTruncated: true as const } : {}) },
        });
      }
    }
  }
  return out;
}
