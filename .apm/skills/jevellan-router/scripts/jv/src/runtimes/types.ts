// The runtime module contract (section 6). Every runtime (claude-sdk now; claude-tmux, codex and llm in phase 7) is a
// module exporting these four functions. `jv run` picks the module by the session row's `runtime` (runtimes/index.ts)
// and calls start() for a row without a native session, resume() for a row that continues one (D-006: every turn is
// its own row; rows of one conversation share native_session_id).
//
// start() and resume() run the turn to its end in the calling `jv run` process and resolve when it ended (its report,
// a synthesized one, or none for a failed turn is in the store); they reject when the turn failed. Events go through
// events.recordEvent. stop() is SIGTERM to the session's process group, SIGKILL after 10 s, state `stopped`.

import type { EventRow, SessionRow } from '../types.js';

/** Tools a worker may use (7.3). */
export interface ToolPolicy {
  /** write: every tool, no permission prompts. read-only: Read, Glob, Grep, WebSearch, WebFetch, ToolSearch. */
  mode: 'write' | 'read-only';
  /** Read-only duties that may write one file (plan: plan.md at the worktree root, enforced by instruction). */
  writeFiles?: string[];
}

/** One MCP server for a worker: stdio, or http/sse as project.json lists it. */
export type McpServerSpec =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export interface McpConfig {
  /** The project's own MCP servers (project.json mcpServers), by name. Never contains `jv`. */
  servers: Record<string, McpServerSpec>;
  /** The stdio report server for this session (jv-report-mcp); in-process runtimes use their own instead. */
  report: Extract<McpServerSpec, { command: string }>;
}

export interface StartInput {
  /** The first user message (start) or the resume message. */
  prompt: string;
  /** Shared worker rules + duty body + AGENTS.md + task block (7.4). */
  systemAppend: string;
  /** The worker's environment (env.minimalEnvironment); values may be secrets. */
  env: Record<string, string>;
  tools: ToolPolicy;
  mcp: McpConfig;
  /** Aborted when `jv run` receives SIGTERM (jv task stop): the turn ends as soon as it can. */
  signal?: AbortSignal;
}

/** What resume() needs besides the message: the same inputs as a start. */
export type TurnInput = Omit<StartInput, 'prompt'>;

export interface StartResult {
  nativeSessionId?: string;
  pid: number;
  pgid: number;
  tmuxTarget?: string;
}

export interface RuntimeModule {
  start(session: SessionRow, input: StartInput): Promise<StartResult>;
  /** Runs a turn that continues session.native_session_id with `message`. */
  resume(session: SessionRow, message: string, input?: TurnInput): Promise<void>;
  stop(session: SessionRow, reason: string): Promise<void>;
  tail(session: SessionRow, sinceSeq: number): AsyncIterable<EventRow>;
}

/** A turn ended in failure (the runtime said so, or the process could not run). The message is short and redacted. */
export class RunFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunFailure';
  }
}

/** The turn was stopped (SIGTERM from jv task stop, or the abort signal). */
export class RunStopped extends Error {
  constructor(message = 'stopped') {
    super(message);
    this.name = 'RunStopped';
  }
}
