// The llm runtime (section 6.5): plain one-answer calls for the answer and converse duties.
//
// Two paths, chosen by the provider's kind:
// - claude-subscription and claude-endpoint: the agent SDK's query() with no tools (tools: []), one turn
//   (maxTurns: 1), no MCP, permissionMode dontAsk, and section 6.1's system prompt (the claude_code preset with the
//   append; the form proven on a subscription login, which may refuse other system prompts). No setting
//   source is loaded (settingSources: []), so the provider home's Stop hook, which asks for jv_report, never runs in a
//   session that has no tools. The native session id comes from the stream as in claude-sdk, so the conversation is
//   resumable (`resume`). Usage and rate limits as in claude-sdk (deltas over a resumed conversation, D-027).
// - openai-compatible: POST <baseUrl>/chat/completions with the key from keyFile (none for a keyless local server),
//   messages [system: the append, ...history, user: the prompt], stream off, max_tokens from the model's maxTokens.
//   The session's effort goes as reasoning_effort; a provider that refuses that parameter gets it as a line of the
//   system message instead, and meta `llm_effort:<provider>` remembers the refusal. The conversation is the run rows
//   sharing one native id that jv makes up ("llm-<uuid>", D-006 rows need it to find each other), and its history is
//   their `message` events with a role (user, assistant). Usage from the response; the provider's `local`
//   provider_usage row for the week is written after each turn.
//
// The report is the last fenced ```json block of the answer, validated like a jv_report call. No block, or a block
// that is not a valid report: a `done` report is synthesized with the whole answer (trimmed to 4000 characters) and
// "synthesized" in limitations.

import { randomUUID } from 'node:crypto';
import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { recordEvent, tailEvents } from '../events.js';
import { processGroup, stopRun } from '../launcher.js';
import { findProvider, loadProviders, readSecretFile, type Provider, type ProvidersConfig } from '../providers.js';
import { defaultRedactor, type Redactor } from '../redact.js';
import { parseReport, synthesizeReport, writeReport, SUMMARY_MAX } from '../report.js';
import { openStore, type Store } from '../store.js';
import type { EventKind, SessionRow } from '../types.js';
import { recordLocalUsage } from '../usage.js';
import { claudeStreamUsage, EFFORT_LEVELS, earlierTotals, resultTotals, usageDelta, type Totals } from './claude-sdk.js';
import { RunFailure, RunStopped, type RuntimeModule, type StartInput, type TurnInput } from './types.js';

export const LLM_NATIVE_PREFIX = 'llm-';
export const EFFORT_META_PREFIX = 'llm_effort:';
export const SYNTHESIZED_NO_BLOCK = 'synthesized: the answer had no fenced json report block';
export const SYNTHESIZED_INVALID_BLOCK = 'synthesized: the answer\'s report block was not a valid report';
const CHAT_TIMEOUT_MS = 10 * 60_000;

// ---- the report block ---------------------------------------------------------------------------------------

/** The content of the last fenced ```json block of a text, or undefined. */
export function lastJsonBlock(text: string): string | undefined {
  const re = /```json[^\S\n]*\r?\n([\s\S]*?)```/g;
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last;
}

/** Writes the report of an llm turn: the parsed block, or a synthesized done with the whole answer. */
export function recordAnswerReport(store: Store, sessionId: string, answer: string, redactor?: Redactor): ReturnType<typeof writeReport> {
  const block = lastJsonBlock(answer);
  const options = redactor ? { redactor } : {};
  let reason = SYNTHESIZED_NO_BLOCK;
  if (block !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && parseReport(parsed).ok) return writeReport(store, sessionId, parsed, options);
    reason = SYNTHESIZED_INVALID_BLOCK;
  }
  const summary = [...answer.trim()].slice(0, SUMMARY_MAX).join('') || 'The answer was empty.';
  return synthesizeReport(store, sessionId, { status: 'done', summary, limitations: reason }, options);
}

// ---- deps ---------------------------------------------------------------------------------------------------

type SdkQuery = AsyncIterable<unknown> & { close?: () => void };

export interface LlmDeps {
  openStore?: () => Store;
  providers?: () => ProvidersConfig;
  query?: (args: { prompt: string; options: Options }) => SdkQuery;
  fetch?: typeof fetch;
  redactor?: Redactor;
  stderr?: (text: string) => void;
}

function short(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// ---- the Claude path ----------------------------------------------------------------------------------------

/** query() options of an llm turn on a Claude provider. */
export function llmQueryOptions(session: SessionRow, input: TurnInput, resume: string | undefined, stderr: (t: string) => void): Options {
  const effort = (EFFORT_LEVELS as readonly string[]).includes(session.effort) ? (session.effort as (typeof EFFORT_LEVELS)[number]) : undefined;
  return {
    cwd: session.cwd,
    env: input.env,
    model: session.model,
    ...(effort ? { effort } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
    tools: [],
    maxTurns: 1,
    permissionMode: 'dontAsk',
    settingSources: [],
    ...(resume ? { resume } : {}),
    stderr,
  };
}

async function claudeTurn(store: Store, session: SessionRow, prompt: string, input: TurnInput, resume: string | undefined, deps: LlmDeps, redactor: Redactor): Promise<string> {
  const emit = (kind: EventKind, payload: unknown) => recordEvent(store, session.id, kind, payload, { redactor });
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) throw new RunStopped();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const options = { ...llmQueryOptions(session, input, resume, (t) => stderr(redactor.redact(t))), abortController: controller };
  const previous: Totals = earlierTotals(store, session);
  const texts: string[] = [];
  let sawResult = false;
  let failure: string | undefined;
  let q: SdkQuery | undefined;
  try {
    q = (deps.query ?? (sdkQuery as unknown as NonNullable<LlmDeps['query']>))({ prompt, options });
    for await (const raw of q) {
      const event = raw as Record<string, unknown>;
      const sid = typeof event.session_id === 'string' && event.session_id !== '' ? event.session_id : undefined;
      if (sid) {
        const row = store.getSession(session.id);
        if (row && !row.native_session_id) store.updateSession(session.id, { native_session_id: sid });
      }
      if (event.type === 'rate_limit_event') {
        const usage = claudeStreamUsage(event);
        if (usage) emit('rate-limit', usage);
        continue;
      }
      if (event.type === 'assistant') {
        const content = (event.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
            texts.push(b.text);
            emit('text', { text: b.text });
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() !== '') emit('thinking', { text: b.thinking });
        }
        continue;
      }
      if (event.type === 'result') {
        sawResult = true;
        const totals = resultTotals(event.modelUsage);
        if (totals) {
          const d = usageDelta(totals, previous);
          emit('usage', {
            inputTokens: d.input,
            outputTokens: d.output,
            cacheReadTokens: d.read,
            cacheWriteTokens: d.write,
            costUsd: Math.round(d.cost * 1e6) / 1e6,
          });
        }
        // One turn with no tools: the answer is complete even when the turn limit is what ended it.
        const ok = event.subtype === 'success' || (event.subtype === 'error_max_turns' && texts.length > 0);
        if (!ok || (event.is_error === true && texts.length === 0)) {
          const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === 'string') : [];
          failure = errors.join('; ') || (typeof event.result === 'string' ? event.result : '') || 'Claude returned an unsuccessful result.';
          emit('error', { message: short(redactor.redact(failure)) });
        }
        if (texts.length === 0 && typeof event.result === 'string' && event.result.trim() !== '' && !failure) texts.push(event.result);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new RunStopped();
    const message = error instanceof Error ? error.message : String(error);
    emit('error', { message: short(redactor.redact(message)) });
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
  if (!sawResult) throw new RunFailure('Claude ended without a result.');
  if (failure) throw new RunFailure(short(redactor.redact(failure)));
  return texts.join('\n\n');
}

// ---- the openai-compatible path -----------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The conversation so far: the user and assistant `message` events of the earlier rows sharing the native id. */
export function chatHistory(store: Store, session: SessionRow): ChatMessage[] {
  if (!session.native_session_id) return [];
  const out: ChatMessage[] = [];
  for (const row of store.listSessions({ native_session_id: session.native_session_id })) {
    if (row.id === session.id) break;
    for (const e of store.listEvents(row.id)) {
      if (e.kind !== 'message') continue;
      try {
        const p = JSON.parse(e.payload) as { role?: unknown; text?: unknown };
        if ((p.role === 'user' || p.role === 'assistant') && typeof p.text === 'string') out.push({ role: p.role, content: p.text });
      } catch {
        // not a chat message
      }
    }
  }
  return out;
}

/** Whether an HTTP error body says the provider does not take reasoning_effort. */
export function refusesReasoningEffort(status: number, body: string): boolean {
  return status >= 400 && status < 500 && /reasoning[_ ]?effort/i.test(body);
}

export function effortLine(effort: string): string {
  return `Reasoning effort for this answer: ${effort}. Think as much as that effort calls for, no more.`;
}

async function chatTurn(store: Store, session: SessionRow, provider: Provider, prompt: string, input: TurnInput, deps: LlmDeps, redactor: Redactor): Promise<string> {
  const emit = (kind: EventKind, payload: unknown) => recordEvent(store, session.id, kind, payload, { redactor });
  if (input.signal?.aborted) throw new RunStopped();
  if (!provider.baseUrl) throw new RunFailure(`provider ${provider.name} has no baseUrl`);
  let key: string | undefined;
  if (provider.keyFile !== undefined) {
    key = readSecretFile(provider.keyFile);
    if (key === undefined) throw new RunFailure(`provider ${provider.name}: key file ${provider.keyFile} is missing or empty`);
  }
  let row = store.requireSession(session.id);
  if (!row.native_session_id) row = store.updateSession(session.id, { native_session_id: `${LLM_NATIVE_PREFIX}${randomUUID()}` });
  const history = chatHistory(store, row);
  const model = provider.models.find((m) => m.id === session.model);
  const effortKey = `${EFFORT_META_PREFIX}${provider.name}`;
  let effortInSystem = store.getMeta(effortKey) === 'refused';
  emit('message', { from: 'jv', role: 'user', text: prompt });

  const fetcher = deps.fetch ?? globalThis.fetch;
  const call = async () => {
    const system = effortInSystem ? `${input.systemAppend}\n\n${effortLine(session.effort)}` : input.systemAppend;
    const body = {
      model: session.model,
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }] satisfies ChatMessage[],
      stream: false,
      ...(model?.maxTokens ? { max_tokens: model.maxTokens } : {}),
      ...(effortInSystem ? {} : { reasoning_effort: session.effort }),
    };
    const signals = [AbortSignal.timeout(CHAT_TIMEOUT_MS), ...(input.signal ? [input.signal] : [])];
    return fetcher(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any(signals),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    });
  };
  let response: Response;
  let text: string;
  try {
    response = await call();
    text = await response.text();
    if (!response.ok && !effortInSystem && refusesReasoningEffort(response.status, text)) {
      store.setMeta(effortKey, 'refused');
      effortInSystem = true;
      response = await call();
      text = await response.text();
    }
  } catch (error) {
    if (input.signal?.aborted) throw new RunStopped();
    const message = short(redactor.redact(error instanceof Error ? error.message : String(error)));
    emit('error', { message });
    throw new RunFailure(`${provider.name}: ${message}`);
  }
  if (!response.ok) {
    const message = `${provider.name} answered HTTP ${response.status}: ${short(redactor.redact(text), 200)}`;
    emit('error', { message });
    throw new RunFailure(message);
  }
  let parsed: { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>; usage?: Record<string, unknown> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new RunFailure(`${provider.name} answered with something that is not JSON`);
  }
  const message = parsed.choices?.[0]?.message;
  const answer = typeof message?.content === 'string' ? message.content : '';
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() !== '') emit('thinking', { text: message.reasoning_content });
  if (answer.trim() !== '') emit('text', { text: answer });
  emit('message', { from: provider.name, role: 'assistant', text: answer });
  const u = parsed.usage ?? {};
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = num(details.cached_tokens) || num(u.prompt_cache_hit_tokens);
  emit('usage', {
    inputTokens: Math.max(0, num(u.prompt_tokens) - cached),
    outputTokens: num(u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  });
  try {
    recordLocalUsage(store, provider.name);
  } catch {
    // the local row is a summary; the session row holds the counts
  }
  return answer;
}

// ---- the module ---------------------------------------------------------------------------------------------

export function createLlmRuntime(deps: LlmDeps = {}): RuntimeModule {
  const open = deps.openStore ?? (() => openStore());

  async function turn(session: SessionRow, prompt: string, input: TurnInput, resume: string | undefined): Promise<string | undefined> {
    const store = open();
    const redactor = deps.redactor ?? defaultRedactor();
    try {
      const config = (deps.providers ?? (() => loadProviders()))();
      const provider = findProvider(config, session.provider);
      if (!provider) throw new RunFailure(`no provider ${session.provider} in ${config.file}`);
      let answer: string;
      if (provider.kind === 'claude-subscription' || provider.kind === 'claude-endpoint') {
        answer = await claudeTurn(store, session, prompt, input, resume, deps, redactor);
      } else if (provider.kind === 'openai-compatible') {
        answer = await chatTurn(store, session, provider, prompt, input, deps, redactor);
      } else {
        throw new RunFailure(`the llm runtime does not run ${provider.kind} providers (${provider.name})`);
      }
      recordAnswerReport(store, session.id, answer, redactor);
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
      if (!session.native_session_id) throw new RunFailure(`session ${session.id} has no conversation to resume`);
      const turnInput = input ?? (await (await import('../run.js')).prepareRun(session.id)).turn;
      const resume = session.native_session_id.startsWith(LLM_NATIVE_PREFIX) ? undefined : session.native_session_id;
      await turn(session, message, turnInput, resume);
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

const runtime = createLlmRuntime();
export const start = runtime.start;
export const resume = runtime.resume;
export const stop = runtime.stop;
export const tail = runtime.tail;
