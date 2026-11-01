// jv-report-mcp: the stdio MCP server of the report tool for claude-tmux and Codex sessions (section 5).
//
// Started by the session's MCP config as "node <JV_HOME>/runtime/dist/report-mcp.js --session R" (reportMcpServerSpec
// gives the bootstrap Node by absolute path and JV_HOME in the server's environment). Hand-rolled JSON-RPC 2.0 over
// newline-delimited stdio, no dependency: initialize, notifications/initialized, ping, tools/list and tools/call, one
// tool jv_report whose inputSchema is zod's toJSONSchema of the report fields.
//
// A claude-tmux or Codex conversation keeps one MCP process across turns while every turn is its own session row
// (D-006), so each call writes to the newest row sharing the given row's native_session_id that has no report yet
// (report.resolveReportSession). stdout carries only JSON-RPC messages; diagnostics go to stderr, redacted.

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { bootstrapNode } from './env.js';
import { paths } from './paths.js';
import { redact } from './redact.js';
import {
  REPORT_TOOL_DESCRIPTION,
  REPORT_TOOL_NAME,
  reportInputJsonSchema,
  resolveReportSession,
  writeReport,
} from './report.js';
import { openStore, type Store } from './store.js';

export const SERVER_NAME = 'jv-report-mcp';
export const SERVER_VERSION = '0.1.0';
/** Protocol version answered when the client asks for none. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** The MCP config entry of the stdio report server for one session. */
export function reportMcpServerSpec(sessionId: string, options: { node?: string; script?: string } = {}): {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    type: 'stdio',
    command: options.node ?? bootstrapNode(),
    args: ['--disable-warning=ExperimentalWarning', options.script ?? join(paths.runtimeDist, 'report-mcp.js'), '--session', sessionId],
    env: { JV_HOME: paths.home },
  };
}

type Id = string | number | null;

interface Request {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

export interface ServerOptions {
  sessionId: string;
  /** Opens the store for one call (default openStore()). */
  openStore?: () => Store;
  write?: (line: string) => void;
  log?: (text: string) => void;
}

function result(id: Id, value: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: value });
}

function error(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Answers one JSON-RPC message; undefined for a notification (no id) or nothing to say. */
export function handleMessage(line: string, options: ServerOptions): string | undefined {
  let msg: Request;
  try {
    msg = JSON.parse(line) as Request;
  } catch {
    return error(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(null, -32600, 'Invalid Request');
  const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;
  const id: Id = hasId ? (msg.id as Id) : null;
  const method = typeof msg.method === 'string' ? msg.method : undefined;
  if (method === undefined) return hasId ? error(id, -32600, 'Invalid Request') : undefined;
  if (!hasId) return undefined; // notifications/initialized, notifications/cancelled, ...
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, {
        tools: [{ name: REPORT_TOOL_NAME, description: REPORT_TOOL_DESCRIPTION, inputSchema: reportInputJsonSchema() }],
      });
    case 'tools/call': {
      const name = params.name;
      if (name !== REPORT_TOOL_NAME) return error(id, -32602, `Unknown tool: ${String(name)}`);
      const args = params.arguments ?? {};
      let store: Store | undefined;
      try {
        store = (options.openStore ?? (() => openStore()))();
        const target = resolveReportSession(store, options.sessionId);
        const r = writeReport(store, target.id, args);
        return result(id, { content: [{ type: 'text', text: r.text }], isError: r.outcome === 'invalid' });
      } catch (e) {
        const message = redact(e instanceof Error ? e.message : String(e));
        options.log?.(`jv_report failed: ${message}`);
        return result(id, { content: [{ type: 'text', text: `The report could not be recorded: ${message}` }], isError: true });
      } finally {
        store?.close();
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

/** Serves stdin until it closes. */
export function serve(options: ServerOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const reply = handleMessage(line, options);
    if (reply !== undefined) write(reply);
  });
  return new Promise((resolve) => rl.on('close', () => resolve()));
}

function argSession(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--session');
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--session='));
  return eq?.slice('--session='.length);
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const sessionId = argSession(process.argv.slice(2));
  const log = (text: string) => process.stderr.write(`${SERVER_NAME}: ${text}\n`);
  if (!sessionId) {
    log('--session R is required');
    process.exit(2);
  }
  void serve({ sessionId, log }).then(() => process.exit(0));
}
