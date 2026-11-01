// The stdio report server (jv-report-mcp): the compiled server is spawned as a claude-tmux or Codex session would
// start it, and spoken to in newline-delimited JSON-RPC.

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-report-mcp-test-');
process.env.JV_HOME = home;
const { openStore } = await import('../src/store.js');
const { reportMcpServerSpec } = await import('../src/report-mcp.js');

after(() => rmSync(home, { recursive: true, force: true }));

const server = fileURLToPath(new URL('../src/report-mcp.js', import.meta.url));

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);
let n = 0;
function newRun(native?: string) {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-mcp-${n}`,
    kind: 'step',
    runtime: 'claude-tmux',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  readonly unsolicited: unknown[] = [];
  private nextId = 1;
  stderr = '';

  constructor(sessionId: string) {
    const spec = reportMcpServerSpec(sessionId, { node: process.execPath, script: server });
    this.child = spawn(spec.command, spec.args, { env: { PATH: process.env.PATH ?? '', ...spec.env }, stdio: 'pipe' });
    this.child.stderr.on('data', (d) => (this.stderr += String(d)));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const resolve = typeof msg.id === 'number' ? this.waiting.get(msg.id) : undefined;
      if (resolve) {
        this.waiting.delete(msg.id as number);
        resolve(msg);
      } else this.unsolicited.push(msg);
    });
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${this.stderr}`)), 10_000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  send(raw: string): void {
    this.child.stdin.write(`${raw}\n`);
  }

  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.child.on('exit', (code) => resolve(code));
      this.child.stdin.end();
    });
  }
}

test('the spec starts the bootstrap node with the compiled server, the session and JV_HOME', () => {
  const spec = reportMcpServerSpec('R123456');
  assert.equal(spec.type, 'stdio');
  assert.deepEqual(spec.args.slice(-2), ['--session', 'R123456']);
  assert.ok(spec.args.some((a) => a.endsWith('/runtime/dist/report-mcp.js')));
  assert.equal(spec.env.JV_HOME, home);
});

test('initialize, tools/list, ping, notifications and errors over stdio', async () => {
  const run = newRun();
  const c = new Client(run.id);
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const r = init.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
    assert.equal(r.protocolVersion, '2025-03-26');
    assert.ok(r.capabilities.tools);
    assert.equal(r.serverInfo.name, 'jv-report-mcp');
    c.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.deepEqual((await c.request('ping')).result, {});
    const list = (await c.request('tools/list')).result as { tools: Array<{ name: string; description: string; inputSchema: { type: string; required: string[] } }> };
    assert.equal(list.tools.length, 1);
    assert.equal(list.tools[0]!.name, 'jv_report');
    assert.equal(list.tools[0]!.inputSchema.type, 'object');
    assert.deepEqual(list.tools[0]!.inputSchema.required.sort(), ['status', 'summary']);
    const missing = await c.request('resources/list');
    assert.equal((missing.error as { code: number }).code, -32601);
    const unknownTool = await c.request('tools/call', { name: 'other', arguments: {} });
    assert.equal((unknownTool.error as { code: number }).code, -32602);
    c.send('{not json');
    await c.request('ping');
    assert.equal((c.unsolicited[0] as { error: { code: number } }).error.code, -32700);
    assert.equal(c.unsolicited.length, 1, 'a notification gets no answer');
  } finally {
    assert.equal(await c.close(), 0);
  }
});

test('tools/call records the report once; the second call says it was already sent', async () => {
  const run = newRun();
  const c = new Client(run.id);
  try {
    await c.request('initialize', {});
    const bad = (await c.request('tools/call', { name: 'jv_report', arguments: { status: 'needs-decision', summary: 'Pick one.' } })).result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /question/);
    const ok = (await c.request('tools/call', { name: 'jv_report', arguments: { status: 'done', summary: 'Found it in src/index.ts:3.' } })).result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(ok.isError, false);
    assert.deepEqual(ok.content, [{ type: 'text', text: 'Report recorded. End your turn.' }]);
    const again = (await c.request('tools/call', { name: 'jv_report', arguments: { status: 'blocked', summary: 'Other.' } })).result as {
      content: Array<{ text: string }>;
    };
    assert.equal(again.content[0]!.text, 'Report already sent for this turn.');
  } finally {
    await c.close();
  }
  const row = store.getReportBySession(run.id)!;
  assert.equal(row.status, 'done');
  assert.equal(store.listEvents(run.id).filter((e) => e.kind === 'report').length, 1);
});

test('one server process across turns writes each report to the newest row of the conversation', async () => {
  const first = newRun('native-tmux-1');
  const c = new Client(first.id);
  try {
    await c.request('initialize', {});
    await c.request('tools/call', { name: 'jv_report', arguments: { status: 'progress', summary: 'Turn one.' } });
    const second = newRun('native-tmux-1');
    const r = (await c.request('tools/call', { name: 'jv_report', arguments: { status: 'done', summary: 'Turn two.' } })).result as {
      content: Array<{ text: string }>;
    };
    assert.equal(r.content[0]!.text, 'Report recorded. End your turn.');
    assert.equal(store.getReportBySession(first.id)!.summary, 'Turn one.');
    assert.equal(store.getReportBySession(second.id)!.summary, 'Turn two.');
  } finally {
    await c.close();
  }
});

test('without --session the server refuses to start', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', server], { env: { ...process.env, JV_HOME: home } });
  let err = '';
  child.stderr.on('data', (d) => (err += String(d)));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 2);
  assert.match(err, /--session/);
});
