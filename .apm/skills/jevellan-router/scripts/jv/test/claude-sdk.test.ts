// The claude-sdk runtime with an injected fake query() (no model): the options of section 6.1, the in-process report
// tool, events, the no-report retry and synthesized report, usage deltas across resumed rows, failures and stops.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { createSdkMcpServer, type Options } from '@anthropic-ai/claude-agent-sdk';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-claude-sdk-test-');
process.env.JV_HOME = home;
const sdk = await import('../src/runtimes/claude-sdk.js');
const { RunFailure, RunStopped } = await import('../src/runtimes/types.js');
const { openStore } = await import('../src/store.js');
const { NO_REPORT_PROMPT } = await import('../src/prompt.js');
const { REPORT_TOOL_QUALIFIED } = await import('../src/report.js');

after(() => rmSync(home, { recursive: true, force: true }));

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
    request_id: `req-sdk-${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

const turnInput = (mode: 'write' | 'read-only', writeFiles?: string[]) => ({
  systemAppend: 'RULES\n\nDUTY\n\nTASK',
  env: { HOME: '/h', JV_SESSION: 'x' },
  tools: { mode, ...(writeFiles ? { writeFiles } : {}) },
  mcp: {
    servers: { pw: { type: 'stdio' as const, command: 'npx', args: ['playwright-mcp'] } },
    report: { type: 'stdio' as const, command: 'node', args: ['report-mcp.js', '--session', 'x'] },
  },
});

const ZERO_T = { input: 0, output: 0, read: 0, write: 0, cost: 0 };

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

interface Call {
  prompt: string;
  options: Options;
}

/** Runtime with a fake query: each call runs the next script with the report tool handler at hand. */
function runtimeWith(scripts: Array<(call: Call, report: Handler) => AsyncGenerator<unknown>>) {
  const calls: Call[] = [];
  let handler: Handler | undefined;
  const runtime = sdk.createClaudeSdkRuntime({
    openStore: () => store,
    stderr: () => {},
    createSdkMcpServer: ((opts: Parameters<typeof createSdkMcpServer>[0]) => {
      handler = opts.tools![0]!.handler as unknown as Handler;
      return createSdkMcpServer(opts);
    }) as typeof createSdkMcpServer,
    query: ({ prompt, options }) => {
      const call = { prompt, options };
      calls.push(call);
      const script = scripts[calls.length - 1];
      if (!script) throw new Error('no more scripts');
      return script(call, (args, extra) => handler!(args, extra));
    },
  });
  return { runtime, calls };
}

const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid, cwd: '/w', tools: [], mcp_servers: [] });
const result = (sid: string, totals: { input: number; output: number; read?: number; write?: number; cost?: number }, extra: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: sid,
  num_turns: 3,
  duration_ms: 1200,
  result: 'done',
  modelUsage: {
    'model-strong': {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadInputTokens: totals.read ?? 0,
      cacheCreationInputTokens: totals.write ?? 0,
      costUSD: totals.cost ?? 0,
    },
  },
  ...extra,
});

test('query options for a write duty: section 6.1 exactly', () => {
  const s = newRun();
  const o = sdk.queryOptions(s, turnInput('write'), { type: 'sdk', name: 'jv' } as never, undefined, () => {});
  assert.equal(o.cwd, seeded.repo);
  assert.deepEqual(o.env, { HOME: '/h', JV_SESSION: 'x' });
  assert.equal(o.model, 'model-strong');
  assert.equal(o.effort, 'high');
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'RULES\n\nDUTY\n\nTASK' });
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
  assert.equal(o.tools, undefined);
  assert.deepEqual(Object.keys(o.mcpServers!).sort(), ['jv', 'pw']);
  assert.deepEqual(o.settingSources, ['user']);
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.maxTurns, undefined);
  assert.equal(o.hooks, undefined);
  assert.equal(o.resume, undefined);
  assert.equal(sdk.queryOptions(s, turnInput('write'), { type: 'sdk', name: 'jv' } as never, 'native-1', () => {}).resume, 'native-1');
});

test('query options for read-only duties: dontAsk, the read-only tools, the report tool allowed; plan may Write', () => {
  const s = newRun();
  const o = sdk.queryOptions(s, turnInput('read-only'), { type: 'sdk', name: 'jv' } as never, undefined, () => {});
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch']);
  assert.ok(o.allowedTools!.includes(REPORT_TOOL_QUALIFIED));
  assert.equal(REPORT_TOOL_QUALIFIED, 'mcp__jv__jv_report');
  assert.ok(o.allowedTools!.includes('mcp__pw'));
  assert.ok(!o.allowedTools!.includes('Write'));
  const plan = sdk.queryOptions(s, turnInput('read-only', ['plan.md']), { type: 'sdk', name: 'jv' } as never, undefined, () => {});
  assert.deepEqual(plan.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'Write']);
  assert.ok(plan.allowedTools!.includes('Write'));
  const odd = store.createSession({ ...s, request_id: 'req-sdk-odd', effort: 'extreme' } as never).row;
  assert.equal(sdk.queryOptions(odd, turnInput('write'), {} as never, undefined, () => {}).effort, undefined);
});

test('a turn: native id before the first text, events, the in-process report tool, usage', async () => {
  const s = newRun();
  const { runtime, calls } = runtimeWith([
    async function* (_call, report) {
      yield init('native-A');
      assert.equal(store.getSession(s.id)!.native_session_id, 'native-A', 'stored before the first text event');
      yield { type: 'stream_event', session_id: 'native-A', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Look' } } };
      yield {
        type: 'assistant',
        session_id: 'native-A',
        message: {
          content: [
            { type: 'thinking', thinking: 'Summary of the reasoning.' },
            { type: 'text', text: 'Looking at the entry point.' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/index.ts' } },
          ],
        },
      };
      yield { type: 'user', session_id: 'native-A', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(5000) }] } };
      yield { type: 'rate_limit_event', session_id: 'native-A', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1_900_000_000 }, seven_day: { utilization: 0.5 } } } };
      const bad = await report({ status: 'needs-decision', summary: 'Choose.' }, {});
      assert.equal(bad.isError, true);
      const ok = await report({ status: 'done', summary: 'src/index.ts:3 starts the app.' }, {});
      assert.equal(ok.content[0]!.text, 'Report recorded. End your turn.');
      const again = await report({ status: 'done', summary: 'twice' }, {});
      assert.equal(again.content[0]!.text, 'Report already sent for this turn.');
      yield result('native-A', { input: 100, output: 40, read: 1000, write: 10, cost: 0.5 });
    },
  ]);
  const started = await runtime.start(s, { prompt: 'Start the step now. End with jv_report.', ...turnInput('read-only') });
  assert.equal(started.nativeSessionId, 'native-A');
  assert.equal(started.pid, process.pid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.abortController instanceof AbortController, true);
  const events = store.listEvents(s.id).map((e) => ({ kind: e.kind, p: JSON.parse(e.payload) as Record<string, unknown> }));
  assert.deepEqual(events.map((e) => e.kind), ['thinking', 'text', 'tool-call', 'tool-result', 'rate-limit', 'report', 'usage']);
  assert.equal(events[0]!.p.text, 'Summary of the reasoning.');
  assert.equal(events[2]!.p.name, 'Read');
  assert.equal((events[3]!.p.output as string).length, sdk.TOOL_TEXT_MAX);
  assert.equal(events[3]!.p.outputTruncated, true);
  assert.deepEqual(events[4]!.p, { fiveHourPct: 25, weeklyPct: 50, fiveHourResetsAt: new Date(1_900_000_000_000).toISOString() });
  const row = store.getSession(s.id)!;
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.cost_usd], [100, 40, 1000, 10, 0.5]);
  assert.equal(store.getReportBySession(s.id)!.status, 'done');
  assert.equal(store.latestProviderUsage('claude-main', 'stream')!.weekly_pct, 50);
});

test('no report: resumed once in the same row with the no-report prompt; the report lands on that row', async () => {
  const s = newRun();
  const { runtime, calls } = runtimeWith([
    async function* () {
      yield init('native-B');
      yield { type: 'assistant', session_id: 'native-B', message: { content: [{ type: 'text', text: 'I am done.' }] } };
      yield result('native-B', { input: 50, output: 10 });
    },
    async function* (_call, report) {
      yield init('native-B');
      await report({ status: 'done', summary: 'Reported when asked.' }, {});
      // Cumulative across the resumed conversation: the first query's 50/10 are in these totals.
      yield result('native-B', { input: 80, output: 15 });
    },
  ]);
  await runtime.start(s, { prompt: 'Start', ...turnInput('write') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.prompt, NO_REPORT_PROMPT);
  assert.equal(calls[1]!.options.resume, 'native-B');
  assert.equal(store.getReportBySession(s.id)!.summary, 'Reported when asked.');
  const row = store.getSession(s.id)!;
  assert.deepEqual([row.input_tokens, row.output_tokens], [80, 15]);
});

test('no report after the retry either: a blocked report is synthesized, saying no report', async () => {
  const s = newRun();
  const silent = async function* () {
    yield init('native-C');
    yield result('native-C', { input: 1, output: 1 });
  };
  const { runtime, calls } = runtimeWith([silent, silent]);
  await runtime.start(s, { prompt: 'Start', ...turnInput('write') });
  assert.equal(calls.length, 2);
  const r = store.getReportBySession(s.id)!;
  assert.equal(r.status, 'blocked');
  assert.match(r.summary, /no report/);
  assert.equal(r.limitations, 'synthesized: no report');
});

test('a resumed row counts only its own share of the cumulative totals', async () => {
  const first = newRun('native-D');
  store.addSessionUsage(first.id, { input_tokens: 100, output_tokens: 20, cache_read_tokens: 500, cache_write_tokens: 5, cost_usd: 0.2 });
  const second = newRun('native-D');
  assert.deepEqual(sdk.earlierTotals(store, second), { input: 100, output: 20, read: 500, write: 5, cost: 0.2 });
  const { runtime, calls } = runtimeWith([
    async function* (_call, report) {
      yield init('native-D');
      await report({ status: 'progress', summary: 'More to do.' }, {});
      yield result('native-D', { input: 130, output: 30, read: 900, write: 5, cost: 0.3 });
    },
  ]);
  await runtime.resume(second, 'Continue.', turnInput('write'));
  assert.equal(calls[0]!.prompt, 'Continue.');
  assert.equal(calls[0]!.options.resume, 'native-D');
  const row = store.getSession(second.id)!;
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens], [30, 10, 400, 0]);
  assert.ok(Math.abs((row.cost_usd ?? 0) - 0.1) < 1e-9);
  const noisy = sdk.usageDelta({ input: 0, output: 0, read: 0, write: 0, cost: 0.3 }, { input: 0, output: 0, read: 0, write: 0, cost: 0.1 + 0.2 });
  assert.equal(noisy.cost, 0, 'float noise is not a reset of the totals');
  assert.ok(Math.abs(sdk.usageDelta({ ...ZERO_T, cost: 0.35 }, { ...ZERO_T, cost: 0.1 + 0.2 }).cost - 0.05) < 1e-9);
  assert.equal(sdk.usageDelta({ ...ZERO_T, cost: 0.02 }, { ...ZERO_T, cost: 0.3 }).cost, 0.02);
  assert.deepEqual(sdk.usageDelta({ input: 5, output: 1, read: 0, write: 0, cost: 0 }, { input: 100, output: 20, read: 0, write: 0, cost: 0 }), {
    input: 5,
    output: 1,
    read: 0,
    write: 0,
    cost: 0,
  });
});

test('an unsuccessful result fails the turn with its reason; an abort stops it', async () => {
  const s = newRun();
  const { runtime } = runtimeWith([
    async function* () {
      yield init('native-E');
      yield result('native-E', { input: 1, output: 0 }, { subtype: 'error_during_execution', is_error: true, errors: ['Invalid API key'] });
    },
  ]);
  await assert.rejects(() => runtime.start(s, { prompt: 'Start', ...turnInput('write') }), (e: unknown) => e instanceof RunFailure && /Invalid API key/.test((e as Error).message));
  assert.equal(store.getReportBySession(s.id), undefined);
  assert.ok(store.listEvents(s.id).some((e) => e.kind === 'error'));

  const t = newRun();
  const controller = new AbortController();
  const { runtime: r2 } = runtimeWith([
    async function* (call) {
      yield init('native-F');
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (call.options.abortController!.signal.aborted) throw new Error('aborted by the host');
      yield result('native-F', { input: 1, output: 1 });
    },
  ]);
  await assert.rejects(() => r2.start(t, { prompt: 'Start', ...turnInput('write'), signal: controller.signal }), (e: unknown) => e instanceof RunStopped);
});

test('claudeStreamUsage: unified windows, the event own window, nothing for per-model windows', () => {
  assert.deepEqual(sdk.claudeStreamUsage({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.123, resetsAt: 1_900_000_000 } }), {
    weeklyPct: 12.3,
    weeklyResetsAt: new Date(1_900_000_000_000).toISOString(),
  });
  assert.equal(sdk.claudeStreamUsage({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day_opus', utilization: 0.9 } }), undefined);
  assert.equal(sdk.claudeStreamUsage({ type: 'assistant' }), undefined);
  assert.deepEqual(sdk.claudeStreamUsage({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1.5 } } } }), { fiveHourPct: 100 });
});
