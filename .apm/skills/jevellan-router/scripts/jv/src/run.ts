// `jv run <R>` (internal): the detached process that executes one run (one turn, D-006) to its end.
//
// 1. Records its own pid and process group on the row and moves it to `starting`.
// 2. Builds the turn's input: the provider's minimal environment (env.ts), the system append (prompt.ts, 7.4), the
//    tool policy from the duty's jv-needs (7.3), project.json's MCP servers plus the stdio report server, and the
//    message: START_PROMPT for a first turn; for a turn that continues a conversation, the message createRun stored
//    and the task's undelivered messages ("From the owner:" / "From the coordinator:"), else CONTINUE_PROMPT.
// 3. Picks the runtime module by the row's runtime (runtimes/index.ts) and runs start() or resume().
// 4. Writes the `end` event, then the final state with a reason: done, failed (the runtime's reason), or stopped
//    (SIGTERM from jv task stop: the turn is aborted and the state stopRun wrote is kept).
// 5. Calls afterRun(store, sessionId) from advance.ts.
//
// Exit code: 0 done or stopped, 1 failed, 2 refused (the runtime is not built yet, the row cannot run).

import { existsSync, readFileSync } from 'node:fs';
import { afterRun } from './advance.js';
import { minimalEnvironment } from './env.js';
import { isJvError, notFound, refused } from './errors.js';
import { recordEvent } from './events.js';
import { processGroup, runMessage } from './launcher.js';
import { paths } from './paths.js';
import { buildSystemAppend, CONTINUE_PROMPT, resumeMessage, START_PROMPT } from './prompt.js';
import { findProvider, loadProviders, type ProvidersConfig } from './providers.js';
import { redact } from './redact.js';
import { reportMcpServerSpec } from './report-mcp.js';
import { loadRuntime } from './runtimes/index.js';
import { RunFailure, RunStopped, type McpServerSpec, type RuntimeModule, type StartInput, type TurnInput } from './runtimes/types.js';
import { openStore, type Store } from './store.js';
import type { MessageRow, ReportRow, Runtime, SessionRow, SessionState } from './types.js';

export interface PreparedRun {
  session: SessionRow;
  /** True when the row continues a conversation (native_session_id set). */
  resume: boolean;
  /** The first user message (start) or the resume message. */
  prompt: string;
  turn: TurnInput;
  /** Messages of the task this turn delivers. */
  messages: MessageRow[];
}

export interface PrepareOptions {
  store?: Store;
  providers?: ProvidersConfig;
  skillsDir?: string;
  rulesFile?: string;
  env?: NodeJS.ProcessEnv;
}

/** project.json mcpServers: an object by name, or a list of entries with a name. `jv` is reserved. */
export function projectMcpServers(projectName: string): Record<string, McpServerSpec> {
  const file = paths.projectJson(projectName);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown }).mcpServers;
  } catch {
    throw refused(`${file} is not valid JSON`);
  }
  const out: Record<string, McpServerSpec> = {};
  const take = (name: unknown, spec: unknown): void => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw refused(`${file}: mcpServers entry has no valid name`);
    if (name === 'jv') throw refused(`${file}: the MCP server name jv is reserved for the report tool`);
    const s = (spec ?? {}) as Record<string, unknown>;
    if (typeof s.command === 'string' && s.command !== '') {
      out[name] = {
        type: 'stdio',
        command: s.command,
        ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
        ...(s.env && typeof s.env === 'object' ? { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)])) } : {}),
      };
    } else if ((s.type === 'http' || s.type === 'sse') && typeof s.url === 'string') {
      out[name] = {
        type: s.type,
        url: s.url,
        ...(s.headers && typeof s.headers === 'object'
          ? { headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, String(v)])) }
          : {}),
      };
    } else throw refused(`${file}: mcpServers.${name} needs a command, or a type http/sse with a url`);
  };
  if (Array.isArray(raw)) for (const e of raw) take((e as { name?: unknown } | null)?.name, e);
  else if (raw && typeof raw === 'object') for (const [name, spec] of Object.entries(raw)) take(name, spec);
  return out;
}

/** Builds everything a turn of `sessionId` needs. Refuses (exit 2/3) with the reason when it cannot run. */
export async function prepareRun(sessionId: string, options: PrepareOptions = {}): Promise<PreparedRun> {
  const store = options.store ?? openStore();
  try {
    const session = store.requireSession(sessionId);
    if (session.kind !== 'step' || !session.task_id || !session.step_id) {
      throw refused(`session ${sessionId} is not a step run; jv run executes step runs only`);
    }
    const project = store.getProject(session.project_id);
    if (!project) throw notFound(`no project ${session.project_id}`);
    const task = store.requireTask(session.task_id);
    const step = store.requireStep(session.step_id);
    const steps = store.listSteps(task.id);
    const reports = new Map<string, ReportRow>();
    for (const r of store.listReports({ task_id: task.id })) if (r.step_id) reports.set(r.step_id, r);
    const parent = task.parent_task_id ? store.getTask(task.parent_task_id) : undefined;
    const base = parent?.branch ?? project.default_branch;

    const providers = options.providers ?? loadProviders();
    const provider = findProvider(providers, session.provider);
    if (!provider) throw refused(`no provider ${session.provider} in ${providers.file}`);
    const env = minimalEnvironment({ provider, sessionId: session.id, ...(options.env ? { base: options.env } : {}) });

    const prompt = buildSystemAppend({
      project,
      task,
      step,
      steps,
      reports,
      cwd: session.cwd,
      base,
      ...(options.skillsDir ? { skillsDir: options.skillsDir } : {}),
      ...(options.rulesFile ? { rulesFile: options.rulesFile } : {}),
    });

    const messages = store.listMessages({ task_id: task.id, undelivered: true });
    const delivered = messages.map((m) => resumeMessage(m.direction, m.text));
    const resume = !!session.native_session_id;
    const extra = runMessage(store, session.id);
    let text: string;
    if (resume) {
      const parts = [...(extra ? [extra] : []), ...delivered];
      text = parts.length ? parts.join('\n\n') : CONTINUE_PROMPT;
    } else {
      text = [START_PROMPT, ...(extra ? [extra] : []), ...delivered].join('\n\n');
    }

    const turn: TurnInput = {
      systemAppend: prompt.systemAppend,
      env,
      tools: prompt.readOnly
        ? { mode: 'read-only', ...(step.duty === 'plan' ? { writeFiles: ['plan.md'] } : {}) }
        : { mode: 'write' },
      mcp: { servers: projectMcpServers(project.name), report: reportMcpServerSpec(session.id) },
    };
    return { session, resume, prompt: text, turn, messages };
  } finally {
    if (!options.store) store.close();
  }
}

export interface RunDeps extends Omit<PrepareOptions, 'store'> {
  store?: Store;
  loadRuntime?: (runtime: Runtime) => Promise<RuntimeModule>;
  /** Where progress lines go (default stdout, the session log). */
  log?: (line: string) => void;
  /** Install SIGTERM/SIGINT/SIGHUP handlers that abort the turn (default true; tests running in-process pass false). */
  handleSignals?: boolean;
  /** Aborts the turn like SIGTERM does. */
  signal?: AbortSignal;
}

export interface RunOutcome {
  session: SessionRow;
  state: SessionState;
  exitCode: number;
}


/** Executes run `sessionId` to its end (what `jv run <R>` does). */
export async function executeRun(sessionId: string, deps: RunDeps = {}): Promise<RunOutcome> {
  const store = deps.store ?? openStore();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${redact(line)}\n`));
  const controller = new AbortController();
  let stopSignal: string | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    stopSignal = signal;
    log(`jv run ${sessionId}: ${signal}, stopping the turn`);
    controller.abort();
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  if (deps.handleSignals !== false) for (const s of signals) process.on(s, onSignal);
  deps.signal?.addEventListener('abort', () => onSignal('SIGTERM'), { once: true });
  try {
    const initial = store.requireSession(sessionId);
    if (initial.state !== 'queued' && initial.state !== 'starting') {
      throw refused(`session ${sessionId} is ${initial.state}; a run executes once`);
    }
    store.setSessionState(sessionId, 'starting', 'jv run is preparing the turn', {
      pid: process.pid,
      pgid: processGroup(process.pid) ?? process.pid,
    });
    log(`jv run ${sessionId}: ${initial.runtime} ${initial.provider} ${initial.model} ${initial.effort} in ${initial.cwd}`);

    let state: SessionState = 'done';
    let reason = '';
    let exitCode = 0;
    try {
      const prepared = await prepareRun(sessionId, { ...deps, store });
      const runtime = await (deps.loadRuntime ?? loadRuntime)(prepared.session.runtime);
      recordEvent(store, sessionId, 'start', {
        runtime: prepared.session.runtime,
        provider: prepared.session.provider,
        model: prepared.session.model,
        effort: prepared.session.effort,
        cwd: prepared.session.cwd,
        resume: prepared.resume,
      });
      if (prepared.messages.length) {
        recordEvent(store, sessionId, 'message', {
          from: 'jv',
          text: prepared.prompt,
          messages: prepared.messages.map((m) => m.id),
        });
      }
      if (controller.signal.aborted) throw new RunStopped();
      store.setSessionState(sessionId, 'running', `${prepared.session.runtime} turn running`);
      const input: StartInput = { prompt: prepared.prompt, ...prepared.turn, signal: controller.signal };
      if (prepared.resume) {
        await runtime.resume(store.requireSession(sessionId), prepared.prompt, { ...prepared.turn, signal: controller.signal });
      } else {
        const started = await runtime.start(store.requireSession(sessionId), input);
        const now = store.requireSession(sessionId);
        const patch = {
          ...(started.nativeSessionId && !now.native_session_id ? { native_session_id: started.nativeSessionId } : {}),
          ...(started.tmuxTarget ? { tmux_target: started.tmuxTarget } : {}),
        };
        if (Object.keys(patch).length) store.updateSession(sessionId, patch);
      }
      for (const m of prepared.messages) store.markMessageDelivered(m.id, sessionId);
      const report = store.getReportBySession(sessionId);
      reason = report ? `turn ended: report ${report.status}` : 'turn ended without a report';
    } catch (error) {
      if (error instanceof RunStopped || stopSignal !== undefined) {
        state = 'stopped';
        reason = `stopped (${stopSignal ?? 'abort'})`;
      } else if (isJvError(error)) {
        state = 'failed';
        reason = redact(error.message);
        exitCode = error.exitCode === 2 ? 2 : 1;
      } else {
        state = 'failed';
        reason = redact(error instanceof RunFailure || error instanceof Error ? error.message : String(error)) || 'the turn failed';
        exitCode = 1;
      }
    }

    const current = store.requireSession(sessionId);
    if (current.state === 'stopped') {
      state = 'stopped';
      reason = current.state_reason;
      exitCode = 0;
    }
    const report = store.getReportBySession(sessionId);
    if (!store.lastEvent(sessionId, 'end')) {
      recordEvent(store, sessionId, 'end', { status: state, reason, report: report?.status ?? null });
    }
    // stopRun wrote `stopped` before it signalled us: that state and its reason stay.
    if (current.state !== 'stopped') store.setSessionState(sessionId, state, reason);
    log(`jv run ${sessionId}: ${state} (${reason})`);
    try {
      afterRun(store, sessionId);
    } catch (error) {
      log(`jv run ${sessionId}: afterRun failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { session: store.requireSession(sessionId), state, exitCode };
  } finally {
    if (deps.handleSignals !== false) for (const s of signals) process.off(s, onSignal);
    if (!deps.store) store.close();
  }
}
