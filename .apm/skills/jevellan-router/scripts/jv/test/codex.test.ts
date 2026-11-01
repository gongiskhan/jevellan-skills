// The codex runtime with a fake Codex SDK client (no binary, no model): client and thread options (env, MCP config,
// sandbox per duty, effort), the first message, events from the item stream, usage deltas, the native thread id, the
// no-report retry, failures and stops.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-codex-test-');
process.env.JV_HOME = home;
const codex = await import('../src/runtimes/codex.js');
const { RunFailure, RunStopped } = await import('../src/runtimes/types.js');
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const { NO_REPORT_PROMPT } = await import('../src/prompt.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);

let n = 0;
function newRun(native?: string, effort = 'xhigh') {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-codex-${n}`,
    kind: 'step',
    runtime: 'codex',
    provider: 'codex',
    model: 'gpt-test',
    effort,
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

const turn = (mode: 'write' | 'read-only', writeFiles?: string[]) => ({
  systemAppend: 'RULES\n\nDUTY\n\nTASK',
  env: { HOME: join(home, 'homes', 'codex'), CODEX_HOME: join(home, 'homes', 'codex', '.codex'), JV_SESSION: 'x', JV_HOME: home },
  tools: { mode, ...(writeFiles ? { writeFiles } : {}) },
  mcp: {
    servers: { pw: { type: 'stdio' as const, command: 'npx', args: ['playwright-mcp'] }, web: { type: 'http' as const, url: 'http://127.0.0.1:9/mcp' } },
    report: { type: 'stdio' as const, command: '/node', args: ['report-mcp.js', '--session', 'x'], env: { JV_HOME: home } },
  },
});

interface Recorded {
  options: CodexOptions;
  threads: Array<{ kind: 'start' | 'resume'; id?: string; options: ThreadOptions; inputs: string[] }>;
}

type Script = (input: string, thread: { id: string | null }) => AsyncGenerator<unknown>;

function fakeCodex(scripts: Script[], threadId = 'thread-123') {
  const recorded: Recorded[] = [];
  let calls = 0;
  const createCodex = (options: CodexOptions) => {
    const rec: Recorded = { options, threads: [] };
    recorded.push(rec);
    const make = (kind: 'start' | 'resume', options: ThreadOptions, id?: string) => {
      const t = { kind, ...(id ? { id } : {}), options, inputs: [] as string[] };
      rec.threads.push(t);
      const thread = {
        id: (id ?? null) as string | null,
        async runStreamed(input: string) {
          t.inputs.push(input);
          const script = scripts[calls++];
          if (!script) throw new Error('no more scripts');
          thread.id = id ?? threadId;
          return { events: script(input, thread) };
        },
      };
      return thread;
    };
    return {
      startThread: (o?: ThreadOptions) => make('start', o ?? {}),
      resumeThread: (id: string, o?: ThreadOptions) => make('resume', o ?? {}, id),
    };
  };
  return { createCodex, recorded };
}

const usage = (input: number, cached: number, output: number) => ({
  type: 'turn.completed',
  usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 1 },
});

test('a write turn: options, first message, events, report, usage and the thread id', async () => {
  const s = newRun();
  const { createCodex, recorded } = fakeCodex([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-123' };
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Planning the change.' } };
      yield { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } };
      yield { type: 'item.updated', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', status: 'in_progress' } };
      yield { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok 3', exit_code: 0, status: 'completed' } };
      yield { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } };
      writeReport(store, s.id, { status: 'done', summary: 'Changed src/a.ts; tests pass.' });
      yield { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'jv', tool: 'jv_report', arguments: { status: 'done' }, result: { content: [], structured_content: null }, status: 'completed' } };
      yield { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Done.' } };
      yield usage(1200, 1000, 80);
    },
  ]);
  const rt = codex.createCodexRuntime({ openStore: () => store, createCodex, executable: '/opt/codex/bin/codex' });
  const r = await rt.start(s, { prompt: 'Start the step now. End with jv_report.', ...turn('write') });
  assert.equal(r.nativeSessionId, 'thread-123');
  assert.equal(store.requireSession(s.id).native_session_id, 'thread-123');

  const o = recorded[0]!.options;
  assert.equal(o.codexPathOverride, '/opt/codex/bin/codex');
  assert.deepEqual(o.env, turn('write').env);
  assert.deepEqual(o.configOverrides, [`projects={${JSON.stringify(realpathSync(seeded.repo))}={trust_level="untrusted"}}`]);
  const config = o.config as Record<string, unknown>;
  assert.equal(config.project_doc_max_bytes, 262144);
  const servers = config.mcp_servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers.jv, { command: '/node', args: ['report-mcp.js', '--session', 'x'], env: { JV_HOME: home }, default_tools_approval_mode: 'approve' });
  assert.equal(servers.pw!.command, 'npx');
  assert.equal(servers.web!.url, 'http://127.0.0.1:9/mcp');

  const t = recorded[0]!.threads[0]!;
  assert.equal(t.kind, 'start');
  assert.equal(t.options.sandboxMode, 'workspace-write');
  assert.equal(t.options.networkAccessEnabled, true);
  assert.equal(t.options.approvalPolicy, 'never');
  assert.equal(t.options.modelReasoningEffort, 'xhigh');
  assert.equal(t.options.model, 'gpt-test');
  assert.equal(t.inputs[0], 'Instructions for this session:\n\nRULES\n\nDUTY\n\nTASK\n\nStart the step now. End with jv_report.');

  const events = store.listEvents(s.id).map((e) => [e.kind, JSON.parse(e.payload) as Record<string, unknown>] as const);
  assert.deepEqual(
    events.map(([k]) => k),
    ['thinking', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'report', 'tool-call', 'tool-result', 'text', 'usage'],
  );
  assert.equal(events[1]![1].name, 'Shell');
  assert.equal(events[2]![1].output, 'ok 3');
  assert.equal(events[2]![1].ok, true);
  assert.equal(events[6]![1].name, 'jv.jv_report');
  const u = events.at(-1)![1];
  assert.equal(u.inputTokens, 200);
  assert.equal(u.cacheReadTokens, 1000);
  assert.equal(u.outputTokens, 80);
});

test('a resumed turn sends the message alone and counts only its share of the thread totals', async () => {
  const s = newRun('thread-123');
  const { createCodex, recorded } = fakeCodex([
    async function* () {
      writeReport(store, s.id, { status: 'done', summary: 'Answered the owner.' });
      yield { type: 'item.completed', item: { id: 'a2', type: 'agent_message', text: 'Sure.' } };
      yield usage(2000, 1500, 120);
    },
  ]);
  const rt = codex.createCodexRuntime({ openStore: () => store, createCodex, executable: 'codex' });
  await rt.resume(s, 'From the owner: also update the docs', turn('write'));
  const t = recorded[0]!.threads[0]!;
  assert.equal(t.kind, 'resume');
  assert.equal(t.id, 'thread-123');
  assert.equal(t.inputs[0], 'From the owner: also update the docs');
  assert.equal(recorded[0]!.options.codexPathOverride, undefined);
  const u = JSON.parse(store.lastEvent(s.id, 'usage')!.payload) as Record<string, number>;
  // Totals 500 in, 1500 cached, 120 out; the earlier row counted 200, 1000, 80.
  assert.equal(u.inputTokens, 300);
  assert.equal(u.cacheReadTokens, 500);
  assert.equal(u.outputTokens, 40);
});

test('read-only and plan duties: read-only sandbox, or workspace-write without network for plan.md', () => {
  const s = newRun(undefined, 'turbo');
  const ro = codex.threadOptions(s, turn('read-only'));
  assert.equal(ro.sandboxMode, 'read-only');
  assert.equal(ro.networkAccessEnabled, false);
  assert.equal(ro.modelReasoningEffort, undefined);
  const plan = codex.threadOptions(s, turn('read-only', ['plan.md']));
  assert.equal(plan.sandboxMode, 'workspace-write');
  assert.equal(plan.networkAccessEnabled, false);
  assert.equal(plan.additionalDirectories, undefined);
});

test('a write turn in a linked worktree may write the common git directories it commits to', () => {
  const repo = join(home, 'repos', 'wt-codex');
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
  const wt = join(home, 'worktrees', 'sandbox', 'codex-wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'jv/codex-wt', wt], { env });
  const dirs = codex.worktreeGitDirs(wt)!;
  const common = join(realpathSync(repo), '.git');
  assert.deepEqual(dirs.slice(0, 3), [join(common, 'objects'), join(common, 'refs'), join(common, 'logs')]);
  assert.equal(dirs[3], join(common, 'worktrees', 'codex-wt'));
  assert.equal(codex.worktreeGitDirs(seeded.repo), undefined);
});

test('no report: the thread is resumed once with NO_REPORT_PROMPT, then blocked is synthesized', async () => {
  const s = newRun();
  const { createCodex, recorded } = fakeCodex(
    [
      async function* () {
        yield { type: 'thread.started', thread_id: 'thread-nr' };
        yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'I am done.' } };
        yield usage(10, 0, 1);
      },
      async function* () {
        yield { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Still no report.' } };
        yield usage(20, 0, 2);
      },
    ],
    'thread-nr',
  );
  const rt = codex.createCodexRuntime({ openStore: () => store, createCodex, executable: 'codex' });
  await rt.start(s, { prompt: 'Start.', ...turn('write') });
  const threads = recorded[0]!.threads;
  assert.equal(threads[1]!.kind, 'resume');
  assert.equal(threads[1]!.id, 'thread-nr');
  assert.equal(threads[1]!.inputs[0], NO_REPORT_PROMPT);
  const report = store.getReportBySession(s.id)!;
  assert.equal(report.status, 'blocked');
  assert.equal(report.limitations, 'synthesized: no report');
  assert.equal(store.requireSession(s.id).input_tokens, 20);
});

test('turn.failed fails the turn; an aborted signal stops it', async () => {
  const s = newRun();
  const failing = fakeCodex([
    async function* () {
      yield { type: 'thread.started', thread_id: 't-f' };
      yield { type: 'turn.failed', error: { message: 'stream disconnected' } };
    },
  ]);
  const rt = codex.createCodexRuntime({ openStore: () => store, createCodex: failing.createCodex, executable: 'codex' });
  await assert.rejects(rt.start(s, { prompt: 'Start.', ...turn('write') }), (e: unknown) => e instanceof RunFailure && /stream disconnected/.test((e as Error).message));
  assert.ok(store.listEvents(s.id).some((e) => e.kind === 'error'));

  const s2 = newRun();
  const controller = new AbortController();
  const stopping = fakeCodex([
    async function* () {
      yield { type: 'thread.started', thread_id: 't-s' };
      controller.abort();
      throw new Error('aborted');
    },
  ]);
  const rt2 = codex.createCodexRuntime({ openStore: () => store, createCodex: stopping.createCodex, executable: 'codex' });
  await assert.rejects(rt2.start(s2, { prompt: 'Start.', ...turn('write'), signal: controller.signal }), (e: unknown) => e instanceof RunStopped);
});

test('a provider without CODEX_HOME (not a codex-subscription) is refused before Codex starts', async () => {
  const s = newRun();
  const { createCodex, recorded } = fakeCodex([]);
  const rt = codex.createCodexRuntime({ openStore: () => store, createCodex, executable: 'codex' });
  const { CODEX_HOME: _drop, ...env } = turn('write').env;
  await assert.rejects(rt.start(s, { prompt: 'Start.', ...turn('write'), env }), (e: unknown) => (e as { exitCode?: number }).exitCode === 2 && /codex-subscription/.test((e as Error).message));
  assert.equal(recorded.length, 0);
});

test('the Codex binary is the SDK\'s own', () => {
  const exe = codex.codexExecutable();
  assert.ok(exe === 'codex' || /node_modules\/@openai\/codex-[a-z0-9-]+\/vendor\//.test(exe), exe);
});
