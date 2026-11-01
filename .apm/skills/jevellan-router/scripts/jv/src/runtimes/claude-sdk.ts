// The claude-sdk runtime (section 6.1): one turn of Claude Code through the agent SDK's query(), in the `jv run`
// process. Ported from jevellan runtimes/claude/src/worker.ts at 8e2788ec (turnSession, execute, workerEnvironment)
// and the stream usage part of runtimes/claude/src/control.ts (claudeStreamUsage).
//
// Differences from the original, with reasons:
// - The environment is env.minimalEnvironment (built by `jv run`), never the whole process environment.
// - query() options are exactly section 6.1's: cwd, env, model, effort, the claude_code preset with the append,
//   bypassPermissions for write duties and dontAsk with the read-only tool list for read-only duties, the in-process
//   report server plus project.json's servers, settingSources ['user'], includePartialMessages, resume, no maxTurns,
//   no hooks. In dontAsk mode a tool runs only when allowedTools pre-approves it, so allowedTools names the report tool
//   (mcp__jv__jv_report), the two web tools of the read-only list, Write for plan, and each project MCP server.
// - Events: text and thinking are recorded per complete assistant block (the thinking blocks are the summaries the
//   model returns), not per stream delta, so a turn is a few dozen rows, not thousands; tool calls and results are
//   recorded once per tool id with input and output trimmed to 4000 characters.
// - Usage: modelUsage and total_cost_usd are cumulative across the turns of a resumed conversation ("a resumed session
//   continues from the totals its transcript saved"). Every turn is its own row and process (D-006), so the totals
//   already counted come from the store (the rows before this one with the same native_session_id), and each usage
//   event carries the delta, clamped like Jevellan's control.previous.
// - No report on result: the turn is resumed once, in this same process and row, with NO_REPORT_PROMPT; still none:
//   a `blocked` report is synthesized with "no report" (section 5).

import { createSdkMcpServer, query, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { recordEvent, tailEvents } from '../events.js';
import { processGroup, stopRun } from '../launcher.js';
import { NO_REPORT_PROMPT } from '../prompt.js';
import { defaultRedactor, type Redactor } from '../redact.js';
import {
  REPORT_SERVER_NAME,
  REPORT_TOOL_DESCRIPTION,
  REPORT_TOOL_NAME,
  REPORT_TOOL_QUALIFIED,
  ReportFieldsSchema,
  synthesizeReport,
  writeReport,
} from '../report.js';
import { openStore, type Store } from '../store.js';
import type { EventKind, SessionRow } from '../types.js';
import { RunFailure, RunStopped, type McpServerSpec, type RuntimeModule, type StartInput, type TurnInput } from './types.js';

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const TOOL_TEXT_MAX = 4000;
/** Cost amounts closer than this are the same amount (rows store costs rounded to 1e-6). */
export const COST_EPSILON = 1e-5;
export const NO_REPORT_SUMMARY = 'The session ended its turn without jv_report, also after being asked once more (no report).';
export const NO_REPORT_LIMITATIONS = 'synthesized: no report';

// ---- ported from control.ts: the account's usage from a rate_limit_event ------------------------------------------

export interface StreamUsage {
  fiveHourPct?: number;
  weeklyPct?: number;
  fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The account's usage from a Claude Code `rate_limit_event` (fractions and reset seconds, like the probe's headers):
 * the unified five-hour and seven-day windows, else the event's own window when it is one of them. A per-model window
 * is never the account's week. Undefined otherwise.
 */
export function claudeStreamUsage(raw: unknown): StreamUsage | undefined {
  const e = raw as { type?: unknown; rate_limit_info?: Record<string, unknown> } | null;
  if (!e || e.type !== 'rate_limit_event' || !e.rate_limit_info || typeof e.rate_limit_info !== 'object') return undefined;
  const info = e.rate_limit_info;
  const own = (type: string) =>
    info.rateLimitType === type ? { utilization: num(info.utilization), resetsAt: num(info.resetsAt) } : undefined;
  const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown } | null | undefined>;
  const win = (w: { utilization?: unknown; resetsAt?: unknown } | null | undefined) =>
    w ? { utilization: num(w.utilization), resetsAt: num(w.resetsAt) } : undefined;
  const five = win(windows.five_hour) ?? own('five_hour');
  const week = win(windows.seven_day) ?? own('seven_day');
  const pct = (v: number | undefined) => (v !== undefined && v >= 0 ? Math.min(100, Math.round(v * 1000) / 10) : undefined);
  const at = (v: number | undefined) => (v !== undefined && v >= 0 && v < 8.64e12 ? new Date(v * 1000).toISOString() : undefined);
  const fiveHourPct = pct(five?.utilization);
  const weeklyPct = pct(week?.utilization);
  if (fiveHourPct === undefined && weeklyPct === undefined) return undefined;
  const fiveHourResetsAt = fiveHourPct === undefined ? undefined : at(five?.resetsAt);
  const weeklyResetsAt = weeklyPct === undefined ? undefined : at(week?.resetsAt);
  return {
    ...(fiveHourPct === undefined ? {} : { fiveHourPct }),
    ...(weeklyPct === undefined ? {} : { weeklyPct }),
    ...(fiveHourResetsAt ? { fiveHourResetsAt } : {}),
    ...(weeklyResetsAt ? { weeklyResetsAt } : {}),
  };
}

// ---- usage totals -----------------------------------------------------------------------------------------------

export interface Totals {
  input: number;
  output: number;
  read: number;
  write: number;
  cost: number;
}

const ZERO: Totals = { input: 0, output: 0, read: 0, write: 0, cost: 0 };

/** What the earlier rows of this conversation already counted (the totals a resumed transcript starts from). */
export function earlierTotals(store: Store, session: SessionRow): Totals {
  if (!session.native_session_id) return { ...ZERO };
  const out = { ...ZERO };
  for (const row of store.listSessions({ native_session_id: session.native_session_id })) {
    if (row.id === session.id) break;
    out.input += row.input_tokens;
    out.output += row.output_tokens;
    out.read += row.cache_read_tokens;
    out.write += row.cache_write_tokens;
    out.cost += row.cost_usd ?? 0;
  }
  return out;
}

/** The totals of a result's modelUsage (every model the turn used). */
export function resultTotals(modelUsage: unknown): Totals | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const out = { ...ZERO };
  for (const u of Object.values(modelUsage as Record<string, Record<string, unknown>>)) {
    if (!u || typeof u !== 'object') continue;
    out.input += num(u.inputTokens) ?? 0;
    out.output += num(u.outputTokens) ?? 0;
    out.read += num(u.cacheReadInputTokens) ?? 0;
    out.write += num(u.cacheCreationInputTokens) ?? 0;
    out.cost += num(u.costUSD) ?? 0;
  }
  return out;
}

/** This turn's share of cumulative totals: totals minus what was counted before, or the totals when they are lower. */
export function usageDelta(totals: Totals, previous: Totals): Totals {
  const d = (k: keyof Totals) => (totals[k] >= previous[k] ? totals[k] - previous[k] : totals[k]);
  // Costs are floats: earlier rows hold rounded shares, the SDK an unrounded sum, so equal amounts may differ by noise.
  const cost = totals.cost >= previous.cost - COST_EPSILON ? Math.max(0, totals.cost - previous.cost) : totals.cost;
  return { input: d('input'), output: d('output'), read: d('read'), write: d('write'), cost };
}

// ---- options ----------------------------------------------------------------------------------------------------

type SdkQuery = AsyncIterable<unknown> & { close?: () => void; interrupt?: () => Promise<void> };

export interface ClaudeSdkDeps {
  openStore?: () => Store;
  query?: (args: { prompt: string; options: Options }) => SdkQuery;
  createSdkMcpServer?: typeof createSdkMcpServer;
  tool?: typeof tool;
  redactor?: Redactor;
  /** Where the CLI's stderr goes (default: this process's stderr, the session log), redacted. */
  stderr?: (text: string) => void;
}

/** The in-process report server of one session row: one tool, jv_report. */
export function reportServer(store: Store, sessionId: string, deps: ClaudeSdkDeps = {}) {
  const makeTool = deps.tool ?? tool;
  const makeServer = deps.createSdkMcpServer ?? createSdkMcpServer;
  const jvReport = makeTool(
    REPORT_TOOL_NAME,
    REPORT_TOOL_DESCRIPTION,
    ReportFieldsSchema.shape,
    async (args) => {
      const r = writeReport(store, sessionId, args, deps.redactor ? { redactor: deps.redactor } : {});
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.outcome === 'invalid' ? { isError: true } : {}) };
    },
    { alwaysLoad: true },
  );
  return makeServer({ name: REPORT_SERVER_NAME, version: '0.1.0', tools: [jvReport], alwaysLoad: true });
}

/** The query() options of section 6.1 for one turn. */
export function queryOptions(
  session: SessionRow,
  input: TurnInput,
  jv: NonNullable<Options['mcpServers']>[string],
  resume: string | undefined,
  stderr: (text: string) => void,
): Options {
  const projectServers = Object.fromEntries(
    Object.entries(input.mcp.servers).filter(([name]) => name !== REPORT_SERVER_NAME),
  ) as Record<string, McpServerSpec>;
  const effort = (EFFORT_LEVELS as readonly string[]).includes(session.effort)
    ? (session.effort as (typeof EFFORT_LEVELS)[number])
    : undefined;
  const writes = input.tools.writeFiles?.length ? ['Write'] : [];
  const permissions: Partial<Options> =
    input.tools.mode === 'write'
      ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
      : {
          permissionMode: 'dontAsk',
          tools: [...READ_ONLY_TOOLS, ...writes],
          allowedTools: [
            REPORT_TOOL_QUALIFIED,
            'WebSearch',
            'WebFetch',
            ...writes,
            ...Object.keys(projectServers).map((name) => `mcp__${name}`),
          ],
        };
  return {
    cwd: session.cwd,
    env: input.env,
    model: session.model,
    ...(effort ? { effort } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
    ...permissions,
    mcpServers: { ...(projectServers as NonNullable<Options['mcpServers']>), [REPORT_SERVER_NAME]: jv },
    settingSources: ['user'],
    includePartialMessages: true,
    ...(resume ? { resume } : {}),
    stderr,
  };
}

// ---- one query --------------------------------------------------------------------------------------------------

interface Control {
  previous: Totals;
}

function blocks(message: unknown): unknown[] {
  const content = (message as { message?: { content?: unknown } } | null)?.message?.content;
  return Array.isArray(content) ? content : [];
}

function short(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const texts = value.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : undefined));
    if (texts.every((t) => t !== undefined)) return texts.join('\n');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trimmed(text: string, max = TOOL_TEXT_MAX): { text: string; truncated?: true } {
  const chars = [...text];
  return chars.length <= max ? { text } : { text: chars.slice(0, max).join(''), truncated: true };
}

/** Runs one query() to its end, recording events. Rejects with RunStopped or RunFailure. */
async function runQuery(
  store: Store,
  session: SessionRow,
  prompt: string,
  input: TurnInput,
  resume: string | undefined,
  control: Control,
  deps: ClaudeSdkDeps,
): Promise<void> {
  const redactor = deps.redactor ?? defaultRedactor();
  const emit = (kind: EventKind, payload: unknown) => recordEvent(store, session.id, kind, payload, { redactor });
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const options = queryOptions(session, input, reportServer(store, session.id, deps), resume, (data) => stderr(redactor.redact(data)));
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) throw new RunStopped();
  input.signal?.addEventListener('abort', onAbort, { once: true });

  let succeeded = false;
  let sawResult = false;
  let failure: string | undefined;
  const started = new Set<string>();
  const ended = new Set<string>();
  let q: SdkQuery | undefined;
  try {
    q = (deps.query ?? (query as unknown as NonNullable<ClaudeSdkDeps['query']>))({ prompt, options: { ...options, abortController: controller } });
    for await (const raw of q) {
      const event = raw as Record<string, unknown>;
      const type = event.type;
      const sid = typeof event.session_id === 'string' && event.session_id !== '' ? event.session_id : undefined;
      if (sid) {
        // The native id is stored before anything else of this message is recorded (system/init comes first).
        const row = store.getSession(session.id);
        if (row && !row.native_session_id) store.updateSession(session.id, { native_session_id: sid });
      }
      if (type === 'rate_limit_event') {
        const usage = claudeStreamUsage(event);
        if (usage) emit('rate-limit', usage);
        continue;
      }
      if (type === 'assistant') {
        for (const block of blocks(event)) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') emit('text', { text: b.text });
          else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() !== '') emit('thinking', { text: b.thinking });
          else if (b.type === 'tool_use' && typeof b.id === 'string' && !started.has(b.id)) {
            started.add(b.id);
            const t = trimmed(asText(b.input ?? {}));
            emit('tool-call', { id: b.id, name: typeof b.name === 'string' ? b.name : 'unknown', input: t.text, ...(t.truncated ? { inputTruncated: true } : {}) });
          }
        }
        if (typeof event.error === 'string') {
          failure = event.error;
          emit('error', { message: short(event.error) });
        }
        continue;
      }
      if (type === 'user') {
        for (const block of blocks(event)) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !ended.has(b.tool_use_id)) {
            ended.add(b.tool_use_id);
            const t = trimmed(asText(b.content ?? ''));
            emit('tool-result', { id: b.tool_use_id, ok: b.is_error !== true, output: t.text, ...(t.truncated ? { outputTruncated: true } : {}) });
          }
        }
        continue;
      }
      if (type === 'result') {
        sawResult = true;
        const totals = resultTotals(event.modelUsage);
        if (totals) {
          const delta = usageDelta(totals, control.previous);
          control.previous = totals;
          emit('usage', {
            inputTokens: delta.input,
            outputTokens: delta.output,
            cacheReadTokens: delta.read,
            cacheWriteTokens: delta.write,
            costUsd: Math.round(delta.cost * 1e6) / 1e6,
            numTurns: num(event.num_turns) ?? null,
            durationMs: num(event.duration_ms) ?? null,
          });
        }
        succeeded = event.is_error !== true && event.subtype === 'success';
        if (!succeeded) {
          const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === 'string') : [];
          failure = errors.join('; ') || (typeof event.result === 'string' ? event.result : '') || failure || 'Claude returned an unsuccessful result.';
          emit('error', { message: short(failure), subtype: typeof event.subtype === 'string' ? event.subtype : null });
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new RunStopped();
    const message = error instanceof Error ? error.message : String(error);
    emit('error', { message: short(message) });
    throw new RunFailure(short(redactor.redact(message)));
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    try {
      q?.close?.();
    } catch {
      // already closed
    }
  }
  if (controller.signal.aborted) throw new RunStopped();
  if (!sawResult) throw new RunFailure(short(redactor.redact(failure ?? 'Claude ended without a result.')));
  if (!succeeded) throw new RunFailure(short(redactor.redact(failure ?? 'Claude ended without a successful result.')));
}

// ---- the module -------------------------------------------------------------------------------------------------

/** The four functions of section 6 over injectable SDK and store (tests pass fakes). */
export function createClaudeSdkRuntime(deps: ClaudeSdkDeps = {}): RuntimeModule {
  const open = deps.openStore ?? (() => openStore());

  async function turn(session: SessionRow, prompt: string, input: TurnInput, resume: string | undefined): Promise<string | undefined> {
    const store = open();
    try {
      const control: Control = { previous: earlierTotals(store, session) };
      await runQuery(store, session, prompt, input, resume, control, deps);
      if (!store.getReportBySession(session.id)) {
        const native = store.requireSession(session.id).native_session_id ?? undefined;
        if (native) {
          recordEvent(store, session.id, 'message', { from: 'jv', text: NO_REPORT_PROMPT }, deps.redactor ? { redactor: deps.redactor } : {});
          await runQuery(store, session, NO_REPORT_PROMPT, input, native, control, deps);
        }
        if (!store.getReportBySession(session.id)) {
          synthesizeReport(
            store,
            session.id,
            { status: 'blocked', summary: NO_REPORT_SUMMARY, limitations: NO_REPORT_LIMITATIONS },
            deps.redactor ? { redactor: deps.redactor } : {},
          );
        }
      }
      return store.requireSession(session.id).native_session_id ?? undefined;
    } finally {
      if (!deps.openStore) store.close();
    }
  }

  return {
    async start(session: SessionRow, input: StartInput) {
      const { prompt, ...rest } = input;
      const nativeSessionId = await turn(session, prompt, rest, undefined);
      return { ...(nativeSessionId ? { nativeSessionId } : {}), pid: process.pid, pgid: processGroup(process.pid) ?? process.pid };
    },
    async resume(session: SessionRow, message: string, input?: TurnInput) {
      if (!session.native_session_id) throw new RunFailure(`session ${session.id} has no native session to resume`);
      const turnInput = input ?? (await (await import('../run.js')).prepareRun(session.id)).turn;
      await turn(session, message, turnInput, session.native_session_id);
    },
    async stop(session: SessionRow, reason: string) {
      const store = open();
      try {
        await stopRun(store, session.id, reason);
      } finally {
        if (!deps.openStore) store.close();
      }
    },
    async *tail(session: SessionRow, sinceSeq: number) {
      const store = open();
      try {
        yield* tailEvents(store, session.id, sinceSeq, { follow: true });
      } finally {
        if (!deps.openStore) store.close();
      }
    },
  };
}

const runtime = createClaudeSdkRuntime();
export const start = runtime.start;
export const resume = runtime.resume;
export const stop = runtime.stop;
export const tail = runtime.tail;
