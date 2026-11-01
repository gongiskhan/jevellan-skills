// The llm runtime with a fake query() (Claude providers) and a fake fetch (openai-compatible): the one-turn options,
// the report parsed from the last fenced json block, the synthesized report, resume, chat history as message events,
// the reasoning_effort fallback, usage, the local usage row, failures. No model, no network.

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-llm-test-');
process.env.JV_HOME = home;
const OPENAI_KEY = 'fake-openai-key-0123456789abcdef';
writeFileSync(join(home, 'secrets', 'deepseek.key'), `${OPENAI_KEY}\n`, { mode: 0o600 });
const llm = await import('../src/runtimes/llm.js');
const { RunFailure } = await import('../src/runtimes/types.js');
const { openStore } = await import('../src/store.js');
const { parseProviders } = await import('../src/providers.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home, { duties: ['answer'] });

const providers = parseProviders(
  {
    jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-test' },
    providers: [
      { name: 'claude-main', kind: 'claude-subscription', home: '~/.jv/homes/claude-main', tokenFile: '~/.jv/secrets/claude-main.token', models: [{ id: 'model-small', label: 'Small', efforts: ['low'] }] },
      { name: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://chat.example.test/v1', keyFile: '~/.jv/secrets/deepseek.key', models: [{ id: 'chat-model', label: 'Chat', efforts: ['low', 'high'], maxTokens: 2048 }] },
      { name: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:8b', label: 'Qwen', efforts: ['low'] }] },
    ],
  },
  join(home, 'providers.json'),
);

let n = 0;
function newRun(provider: string, model: string, native?: string, effort = 'low') {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-llm-${n}`,
    kind: 'step',
    runtime: 'llm',
    provider,
    model,
    effort,
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

const turn = () => ({
  systemAppend: 'RULES\n\nDUTY answer\n\nTASK',
  env: { HOME: join(home, 'homes', 'claude-main'), JV_SESSION: 'x' },
  tools: { mode: 'read-only' as const },
  mcp: { servers: {}, report: { type: 'stdio' as const, command: '/node', args: [] } },
});

const block = (v: unknown) => `\n\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;

test('lastJsonBlock takes the last fenced json block', () => {
  assert.equal(llm.lastJsonBlock('a ```json\n{"x":1}\n``` b ```json\n{"x":2}\n```'), '{"x":2}\n');
  assert.equal(llm.lastJsonBlock('no block ```\n{}\n```'), undefined);
});

test('Claude path: one turn, no tools, no MCP, no settings; the report from the block; native id kept', async () => {
  const s = newRun('claude-main', 'model-small');
  const calls: Array<{ prompt: string; options: Options }> = [];
  const answer = `The capital of Portugal is Lisbon.${block({ status: 'done', summary: 'Lisbon is the capital of Portugal.' })}`;
  const rt = llm.createLlmRuntime({
    openStore: () => store,
    providers: () => providers,
    stderr: () => {},
    query: (args) => {
      calls.push(args);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-llm-1' };
        yield { type: 'assistant', session_id: 'sdk-llm-1', message: { content: [{ type: 'text', text: answer }] } };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-llm-1',
          modelUsage: { 'model-small': { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 100, costUSD: 0.001 } },
        };
      })();
    },
  });
  const r = await rt.start(s, { prompt: 'Start the step now. End with jv_report.', ...turn() });
  assert.equal(r.nativeSessionId, 'sdk-llm-1');
  const o = calls[0]!.options;
  assert.deepEqual(o.tools, []);
  assert.equal(o.maxTurns, 1);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.mcpServers, undefined);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'RULES\n\nDUTY answer\n\nTASK' });
  assert.equal(o.effort, 'low');
  assert.equal(o.resume, undefined);
  const report = store.getReportBySession(s.id)!;
  assert.equal(report.status, 'done');
  assert.equal(report.summary, 'Lisbon is the capital of Portugal.');
  assert.equal(report.limitations, null);
  assert.equal(store.requireSession(s.id).cache_write_tokens, 100);

  // Resume: the same native session, one more turn.
  const s2 = newRun('claude-main', 'model-small', 'sdk-llm-1');
  await rt.resume(s2, 'From the owner: and Spain?', turn());
  assert.equal(calls[1]!.options.resume, 'sdk-llm-1');
  assert.equal(calls[1]!.prompt, 'From the owner: and Spain?');
});

test('no block: done is synthesized with the whole answer trimmed to 4000 characters', async () => {
  const s = newRun('claude-main', 'model-small');
  const long = `Answer: ${'x'.repeat(5000)}`;
  const rt = llm.createLlmRuntime({
    openStore: () => store,
    providers: () => providers,
    stderr: () => {},
    query: () =>
      (async function* () {
        yield { type: 'assistant', session_id: 'sdk-llm-2', message: { content: [{ type: 'text', text: long }] } };
        yield { type: 'result', subtype: 'success', session_id: 'sdk-llm-2', modelUsage: {} };
      })(),
  });
  await rt.start(s, { prompt: 'Start.', ...turn() });
  const report = store.getReportBySession(s.id)!;
  assert.equal(report.status, 'done');
  assert.equal(report.summary.length, 4000);
  assert.match(report.limitations ?? '', /^synthesized/);
  // An invalid block is synthesized too, and says so.
  const s3 = newRun('claude-main', 'model-small');
  llm.recordAnswerReport(store, s3.id, `Hm.${block({ status: 'needs-decision', summary: 'no options' })}`);
  assert.match(store.getReportBySession(s3.id)!.limitations ?? '', /not a valid report/);
});

test('openai-compatible: chat/completions with the key, history from message events, effort fallback, usage, local row', async () => {
  const s = newRun('deepseek', 'chat-model', undefined, 'high');
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let refuseEffort = true;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    if (refuseEffort && 'reasoning_effort' in body) {
      return new Response(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }), { status: 400 });
    }
    const round = requests.filter((r) => !('reasoning_effort' in r.body)).length;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `Answer ${round}.${block({ status: 'done', summary: `Answer ${round}.` })}`, reasoning_content: 'thought' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const rt = llm.createLlmRuntime({ openStore: () => store, providers: () => providers, fetch: fakeFetch });
  const r = await rt.start(s, { prompt: 'Start the step now.', ...turn() });
  assert.match(r.nativeSessionId ?? '', /^llm-[0-9a-f-]{36}$/);
  assert.equal(requests.length, 2);
  const [first, second] = requests;
  assert.equal(first!.url, 'https://chat.example.test/v1/chat/completions');
  assert.equal(first!.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(first!.body.reasoning_effort, 'high');
  assert.equal(first!.body.max_tokens, 2048);
  assert.equal(first!.body.stream, false);
  assert.equal(second!.body.reasoning_effort, undefined);
  const messages = second!.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, 'system');
  assert.match(messages[0]!.content, /Reasoning effort for this answer: high\./);
  assert.deepEqual(messages.slice(1), [{ role: 'user', content: 'Start the step now.' }]);
  assert.equal(store.getMeta('llm_effort:deepseek'), 'refused');
  assert.equal(store.getReportBySession(s.id)!.summary, 'Answer 1.');
  const row = store.requireSession(s.id);
  assert.equal(row.input_tokens, 40);
  assert.equal(row.cache_read_tokens, 60);
  assert.equal(row.output_tokens, 20);
  assert.ok(store.listEvents(s.id).some((e) => e.kind === 'thinking'));
  const local = store.latestProviderUsage('deepseek', 'local')!;
  assert.equal(local.local_input_tokens, 100);
  assert.equal(local.local_output_tokens, 20);
  // The key never reaches the store.
  assert.ok(!JSON.stringify(store.listEvents(s.id)).includes(OPENAI_KEY));

  // Resume: the history is the earlier user and assistant messages; the remembered refusal skips reasoning_effort.
  refuseEffort = false;
  const s2 = newRun('deepseek', 'chat-model', row.native_session_id!, 'high');
  await rt.resume(s2, 'From the owner: shorter please', turn());
  const third = requests[2]!;
  assert.equal(third.body.reasoning_effort, undefined);
  const m = (third.body.messages as Array<{ role: string; content: string }>).slice(1);
  assert.deepEqual(
    m.map((x) => x.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(m[0]!.content, 'Start the step now.');
  assert.match(m[1]!.content, /^Answer 1\./);
  assert.equal(m[2]!.content, 'From the owner: shorter please');
});

test('openai-compatible without a key file sends no authorization; an HTTP error fails the turn', async () => {
  const s = newRun('local', 'qwen3:8b');
  let headers: Record<string, string> = {};
  const rt = llm.createLlmRuntime({
    openStore: () => store,
    providers: () => providers,
    fetch: (async (_u: unknown, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response('{"error":"model not found"}', { status: 404 });
    }) as typeof fetch,
  });
  await assert.rejects(rt.start(s, { prompt: 'Start.', ...turn() }), (e: unknown) => e instanceof RunFailure && /HTTP 404/.test((e as Error).message));
  assert.equal(headers.authorization, undefined);
  assert.equal(store.getReportBySession(s.id), undefined);
});
