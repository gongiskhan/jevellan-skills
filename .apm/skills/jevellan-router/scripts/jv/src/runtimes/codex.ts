// The codex runtime (section 6.3): one turn of Codex through @openai/codex-sdk 0.166.0 in the `jv run` process.
// Ported from jevellan runtimes/codex/src/worker.ts (codexRuntime, execute, turnSession) and configuration.ts
// (projectTrustOverride, worktreeGitDirs) at 8e2788ec.
//
// Differences from the original, with reasons:
// - The environment is the worker's minimal environment (env.ts: HOME and CODEX_HOME=<home>/.codex of the provider,
//   JV_SESSION, JV_HOME), passed as the SDK's `env`, which then inherits nothing from this process.
// - The Codex binary is the one the SDK ships (@openai/codex 0.166.0, the SDK's own version), not `codex` on PATH;
//   jv attach and jv providers login use the same binary (codexExecutable), so a thread is always resumed by the
//   version that wrote it.
// - The report tool is jv-report-mcp through the thread's MCP config (mcp_servers.jv.command/args/env, tool calls
//   pre-approved); project.json's servers are added beside it. No Jevellan safety hook, no daemon variables.
// - project_doc_max_bytes is 256 KiB (Jevellan's bound), so a large AGENTS.md is read whole instead of refused.
// - Codex has no system prompt channel: the first message of a new thread is "Instructions for this session:", the
//   system append (rules, duty, AGENTS.md, task block) and then the prompt. A resumed thread already holds them, so a
//   resume sends the message alone.
// - Sandbox: workspace-write with network for write duties, plus the linked worktree's git directories so commits
//   work (Jevellan's worktreeGitDirs); read-only for read-only duties; plan (one allowed file, plan.md) gets
//   workspace-write without network and without the git directories, so it can write plan.md but cannot commit.
// - Events: agent messages and reasoning once per completed item (D-027's rule for claude-sdk); command executions,
//   MCP calls, file changes and web searches as tool-call at first sight and tool-result when completed, trimmed to
//   4000 characters. Usage from turn.completed: Codex reports the thread's running totals there, so the event carries
//   this turn's share (the totals minus what the earlier rows of the thread counted, as D-027 does for claude-sdk).
// - No report after the turn: the thread is resumed once with NO_REPORT_PROMPT in the same row; still none, a
//   `blocked` report is synthesized (section 5's backstop, as claude-sdk does).

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Codex as CodexClass, CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import { refused } from '../errors.js';
import { recordEvent, tailEvents } from '../events.js';
import { processGroup, stopRun } from '../launcher.js';
import { NO_REPORT_PROMPT } from '../prompt.js';
import { defaultRedactor, type Redactor } from '../redact.js';
import { REPORT_SERVER_NAME, synthesizeReport } from '../report.js';
import { openStore, type Store } from '../store.js';
import type { EventKind, SessionRow } from '../types.js';
import { earlierTotals, usageDelta, type Totals } from './claude-sdk.js';
import { RunFailure, RunStopped, type McpServerSpec, type RuntimeModule, type StartInput, type TurnInput } from './types.js';

export const INSTRUCTIONS_PREFIX = 'Instructions for this session:';
/** Jevellan's bounded project instruction budget for managed Codex sessions. */
export const PROJECT_DOC_MAX_BYTES = 256 * 1024;
export const TOOL_TEXT_MAX = 4000;
export const NO_REPORT_SUMMARY = 'The session ended its turn without jv_report, also after being asked once more (no report).';
export const NO_REPORT_LIMITATIONS = 'synthesized: no report';
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// ---- the binary -------------------------------------------------------------------------------------------

const TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};
const PLATFORM_PACKAGES: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
};

/**
 * The Codex binary the SDK runs (the same lookup as the SDK's findCodexPath), or `codex` on PATH when the platform
 * package is not installed.
 */
export function codexExecutable(): string {
  try {
    const triple = TRIPLES[`${process.platform}-${process.arch}`];
    const pkg = triple ? PLATFORM_PACKAGES[triple] : undefined;
    if (!triple || !pkg) return 'codex';
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@openai/codex-sdk'));
    const codexRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
    const root = join(dirname(codexRequire.resolve(`${pkg}/package.json`)), 'vendor', triple);
    for (const file of [join(root, 'bin', 'codex'), join(root, 'codex', 'codex')]) {
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  } catch {
    // not installed with its optional platform package
  }
  return 'codex';
}

// ---- configuration (ported from configuration.ts) -----------------------------------------------------------

/** Keeps the cwd as one TOML key (dots and symlinks included) and marks it untrusted, so no project .codex config loads. */
export function projectTrustOverride(cwd: string): string {
  return `projects={${JSON.stringify(realpathSync(cwd))}={trust_level="untrusted"}}`;
}

/**
 * What a commit in a linked worktree writes: the common directory's objects, refs and logs and the worktree's own git
 * directory, never the common directory root, so the owner checkout's index, HEAD and config stay outside the sandbox.
 */
export function worktreeGitDirs(cwd: string): string[] | undefined {
  try {
    if (!statSync(join(cwd, '.git')).isFile()) return undefined;
    const git = (flag: string) =>
      execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', flag], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const common = git('--git-common-dir');
    const own = git('--git-dir');
    if (!common || !own) return undefined;
    const directories = [join(common, 'objects'), join(common, 'refs'), join(common, 'logs'), own];
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    return directories;
  } catch {
    return undefined;
  }
}

type ConfigObject = NonNullable<CodexOptions['config']>;

/** The thread's MCP servers: jv-report-mcp (pre-approved) and project.json's servers (stdio and http). */
export function codexMcpServers(input: Pick<TurnInput, 'mcp'>): ConfigObject {
  const out: ConfigObject = {};
  const add = (name: string, spec: McpServerSpec) => {
    if ('command' in spec) {
      out[name] = {
        command: spec.command,
        args: spec.args ?? [],
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        default_tools_approval_mode: 'approve',
      };
    } else if (spec.type === 'http') {
      out[name] = { url: spec.url, ...(spec.headers ? { http_headers: spec.headers } : {}), default_tools_approval_mode: 'approve' };
    }
    // Codex has no SSE transport; such a project server is left out.
  };
  for (const [name, spec] of Object.entries(input.mcp.servers)) if (name !== REPORT_SERVER_NAME) add(name, spec);
  add(REPORT_SERVER_NAME, input.mcp.report);
  return out;
}

export type DutyAccess = 'write' | 'plan' | 'read-only';

export function dutyAccess(input: Pick<TurnInput, 'tools'>): DutyAccess {
  if (input.tools.mode === 'write') return 'write';
  return input.tools.writeFiles?.length ? 'plan' : 'read-only';
}

/** The Codex client options of a turn. */
export function codexOptions(session: SessionRow, input: TurnInput, executable?: string): CodexOptions {
  return {
    env: input.env,
    ...(executable ? { codexPathOverride: executable } : {}),
    configOverrides: [projectTrustOverride(session.cwd)],
    config: {
      project_doc_max_bytes: PROJECT_DOC_MAX_BYTES,
      features: { multi_agent: false },
      mcp_servers: codexMcpServers(input),
    },
  };
}

/** The thread options of a turn. */
export function threadOptions(session: SessionRow, input: TurnInput): ThreadOptions {
  const access = dutyAccess(input);
  const cwd = realpathSync(session.cwd);
  const writable = access === 'write' ? worktreeGitDirs(cwd) : undefined;
  const effort = (CODEX_EFFORTS as readonly string[]).includes(session.effort)
    ? (session.effort as (typeof CODEX_EFFORTS)[number])
    : undefined;
  return {
    workingDirectory: cwd,
    model: session.model,
    ...(effort ? { modelReasoningEffort: effort } : {}),
    sandboxMode: access === 'read-only' ? 'read-only' : 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: access === 'write',
    ...(writable ? { additionalDirectories: writable } : {}),
  };
}

/** The first message of a new thread. */
export function firstMessage(systemAppend: string, prompt: string): string {
  return `${INSTRUCTIONS_PREFIX}\n\n${systemAppend}\n\n${prompt}`;
}

// ---- one turn ------------------------------------------------------------------------------------------------

interface ThreadLike {
  readonly id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}
interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
}

export interface CodexDeps {
  openStore?: () => Store;
  /** Builds the SDK client (tests pass a fake). */
  createCodex?: (options: CodexOptions) => CodexLike;
  /** The Codex binary (default codexExecutable()). */
  executable?: string;
  redactor?: Redactor;
}

function short(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function trimmed(text: string, max = TOOL_TEXT_MAX): { text: string; truncated?: true } {
  const chars = [...text];
  return chars.length <= max ? { text } : { text: chars.slice(0, max).join(''), truncated: true };
}

function json(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    return String(value);
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface Control {
  previous: Totals;
}

/** Runs one runStreamed() to its end, recording events. Rejects with RunStopped or RunFailure. */
async function runTurn(
  store: Store,
  session: SessionRow,
  thread: ThreadLike,
  message: string,
  input: TurnInput,
  control: Control,
  redactor: Redactor,
): Promise<void> {
  const emit = (kind: EventKind, payload: unknown) => recordEvent(store, session.id, kind, payload, { redactor });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) throw new RunStopped();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const started = new Set<string>();
  const ended = new Set<string>();
  let completed = false;
  let failure: string | undefined;
  try {
    const { events } = await thread.runStreamed(message, { signal: controller.signal });
    for await (const raw of events) {
      const event = (raw ?? {}) as Record<string, unknown>;
      const type = String(event.type ?? '');
      if (type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id !== '') {
        const row = store.getSession(session.id);
        if (row && !row.native_session_id) store.updateSession(session.id, { native_session_id: event.thread_id });
        continue;
      }
      if (type === 'turn.completed') {
        completed = true;
        const u = (event.usage ?? {}) as Record<string, unknown>;
        // Codex's input count includes the cached part; jv counts input without cache reads, as Claude does.
        const cached = num(u.cached_input_tokens);
        const totals: Totals = {
          input: Math.max(0, num(u.input_tokens) - cached),
          output: num(u.output_tokens),
          read: cached,
          write: num(u.cache_write_input_tokens),
          cost: 0,
        };
        const delta = usageDelta(totals, control.previous);
        control.previous = totals;
        emit('usage', {
          inputTokens: delta.input,
          outputTokens: delta.output,
          cacheReadTokens: delta.read,
          cacheWriteTokens: delta.write,
          reasoningTokens: num(u.reasoning_output_tokens),
          source: 'turn.completed',
        });
        continue;
      }
      if (type === 'turn.failed' || type === 'error') {
        const m = type === 'error' ? event.message : (event.error as { message?: unknown } | undefined)?.message;
        failure = typeof m === 'string' && m !== '' ? m : 'Codex reported an error.';
        emit('error', { message: short(redactor.redact(failure)) });
        continue;
      }
      const item = event.item as Record<string, unknown> | undefined;
      if (!item || typeof item.id !== 'string') continue;
      const id = item.id;
      const done = type === 'item.completed';
      switch (item.type) {
        case 'agent_message':
          if (done && typeof item.text === 'string' && item.text.trim() !== '') emit('text', { text: item.text });
          continue;
        case 'reasoning':
          if (done && typeof item.text === 'string' && item.text.trim() !== '') emit('thinking', { text: item.text });
          continue;
        case 'error':
          if (done && typeof item.message === 'string') emit('error', { message: short(item.message), item: true });
          continue;
        case 'todo_list':
          continue;
        case 'command_execution':
        case 'mcp_tool_call':
        case 'file_change':
        case 'web_search': {
          if (!started.has(id)) {
            started.add(id);
            const name =
              item.type === 'command_execution'
                ? 'Shell'
                : item.type === 'mcp_tool_call'
                  ? `${String(item.server)}.${String(item.tool)}`
                  : item.type === 'file_change'
                    ? 'Edit'
                    : 'WebSearch';
            const inputValue =
              item.type === 'command_execution'
                ? item.command
                : item.type === 'mcp_tool_call'
                  ? item.arguments
                  : item.type === 'file_change'
                    ? item.changes
                    : item.query;
            const t = trimmed(json(inputValue ?? ''));
            emit('tool-call', { id, name, input: t.text, ...(t.truncated ? { inputTruncated: true } : {}) });
          }
          if (done && !ended.has(id)) {
            ended.add(id);
            const output =
              item.type === 'command_execution'
                ? json(item.aggregated_output ?? '')
                : item.type === 'mcp_tool_call'
                  ? json(item.result ?? item.error ?? null)
                  : item.type === 'file_change'
                    ? json(item.changes)
                    : '';
            const ok = item.type === 'web_search' || (item.status === 'completed' && (item.type !== 'command_execution' || item.exit_code === 0));
            const t = trimmed(output);
            emit('tool-result', { id, ok, output: t.text, ...(t.truncated ? { outputTruncated: true } : {}) });
          }
          continue;
        }
        default:
          continue;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new RunStopped();
    const message = error instanceof Error ? error.message : String(error);
    emit('error', { message: short(redactor.redact(message)) });
    throw new RunFailure(short(redactor.redact(message)));
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
  }
  if (controller.signal.aborted) throw new RunStopped();
  // A resumed exec may not announce its thread again; the id the SDK holds is the thread's.
  if (thread.id) {
    const row = store.getSession(session.id);
    if (row && !row.native_session_id) store.updateSession(session.id, { native_session_id: thread.id });
  }
  if (failure) throw new RunFailure(short(redactor.redact(failure)));
  if (!completed) throw new RunFailure('Codex ended without a turn result.');
}

/** The four functions of section 6 over an injectable SDK and store. */
export function createCodexRuntime(deps: CodexDeps = {}): RuntimeModule {
  const open = deps.openStore ?? (() => openStore());
  const loadCodex = async (options: CodexOptions): Promise<CodexLike> => {
    if (deps.createCodex) return deps.createCodex(options);
    const { Codex } = (await import('@openai/codex-sdk')) as { Codex: typeof CodexClass };
    return new Codex(options) as unknown as CodexLike;
  };

  async function turn(session: SessionRow, message: string, input: TurnInput, resume: string | undefined): Promise<string | undefined> {
    // Only a codex-subscription provider's environment has CODEX_HOME (env.ts): Codex never runs in another home.
    if (!input.env.CODEX_HOME) throw refused(`the codex runtime runs codex-subscription providers only; ${session.provider} is not one`);
    const store = open();
    const redactor = deps.redactor ?? defaultRedactor();
    try {
      const executable = deps.executable ?? codexExecutable();
      const codex = await loadCodex(codexOptions(session, input, executable === 'codex' ? undefined : executable));
      const options = threadOptions(session, input);
      const control: Control = { previous: earlierTotals(store, session) };
      const thread = resume ? codex.resumeThread(resume, options) : codex.startThread(options);
      await runTurn(store, session, thread, resume ? message : firstMessage(input.systemAppend, message), input, control, redactor);
      if (!store.getReportBySession(session.id)) {
        const native = store.requireSession(session.id).native_session_id ?? thread.id ?? undefined;
        if (native) {
          recordEvent(store, session.id, 'message', { from: 'jv', text: NO_REPORT_PROMPT }, { redactor });
          await runTurn(store, session, codex.resumeThread(native, options), NO_REPORT_PROMPT, input, control, redactor);
        }
        if (!store.getReportBySession(session.id)) {
          synthesizeReport(store, session.id, { status: 'blocked', summary: NO_REPORT_SUMMARY, limitations: NO_REPORT_LIMITATIONS }, { redactor });
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
      if (!session.native_session_id) throw new RunFailure(`session ${session.id} has no Codex thread to resume`);
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

const runtime = createCodexRuntime();
export const start = runtime.start;
export const resume = runtime.resume;
export const stop = runtime.stop;
export const tail = runtime.tail;
