// The launcher and `jv run`, with a fake runtime module and no model: createRun, a detached spawnRun through the
// compiled CLI, the end state and afterRun, resume messages, lost runs, stopRun, and a runtime not built yet.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-launcher-test-');
process.env.JV_HOME = home;
const launcher = await import('../src/launcher.js');
const { executeRun } = await import('../src/run.js');
const { openStore } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');
const { START_PROMPT } = await import('../src/prompt.js');

after(() => rmSync(home, { recursive: true, force: true }));

const entry = fileURLToPath(new URL('./fixtures/run-entry.js', import.meta.url));
const fakeRuntime = fileURLToPath(new URL('./fixtures/fake-runtime.js', import.meta.url));
const rules = join(home, 'worker-rules.md');

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home, { agents: '# Sandbox rules\n' });

let n = 0;
function newRun(extra: { nativeSessionId?: string; message?: string; runtime?: 'claude-sdk' | 'codex'; taskId?: string; stepId?: string } = {}) {
  n++;
  return launcher.createRun(store, {
    requestId: `req-launch-${n}`,
    projectId: seeded.projectId,
    taskId: extra.taskId ?? seeded.taskId,
    stepId: extra.stepId ?? seeded.stepIds[0]!,
    runtime: extra.runtime ?? 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(extra.nativeSessionId ? { nativeSessionId: extra.nativeSessionId } : {}),
    ...(extra.message ? { message: extra.message } : {}),
  }).row;
}

function spawnFake(id: string, mode: string, dump?: string) {
  return launcher.spawnRun(store, id, {
    node: process.execPath,
    entry,
    env: {
      ...process.env,
      JV_TEST_RUNTIME_MODULE: fakeRuntime,
      JV_TEST_WORKER_RULES: rules,
      FAKE_RUNTIME_MODE: mode,
      ...(dump ? { FAKE_RUNTIME_DUMP: dump } : {}),
    },
  });
}

async function waitFor<T>(what: string, fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const finalState = (id: string) => {
  const s = store.getSession(id)!;
  return ['done', 'failed', 'stopped', 'lost'].includes(s.state) ? s : undefined;
};

test('createRun follows the request id rule and keeps the run message', () => {
  const input = {
    requestId: 'req-same',
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    stepId: seeded.stepIds[0]!,
    runtime: 'claude-sdk' as const,
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    message: 'Continue.',
  };
  const a = launcher.createRun(store, input);
  assert.equal(a.created, true);
  assert.equal(a.row.state, 'queued');
  const b = launcher.createRun(store, input);
  assert.equal(b.created, false);
  assert.equal(b.row.id, a.row.id);
  assert.equal(launcher.runMessage(store, a.row.id), 'Continue.');
  assert.throws(() => launcher.createRun(store, { ...input, model: 'model-small' }), (e: unknown) => e instanceof JvError && e.exitCode === 4);
});

test('a detached run executes to its end: pid and pgid, log, events, report, done, and afterRun', async () => {
  const run = newRun();
  const dump = join(home, 'dump-done.json');
  const spawned = spawnFake(run.id, 'done', dump);
  assert.equal(spawned.pgid, spawned.pid);
  const row = store.getSession(run.id)!;
  assert.equal(row.pid, spawned.pid);
  assert.equal(row.pgid, spawned.pid);
  const end = await waitFor('the run to end', () => finalState(run.id));
  assert.equal(end.state, 'done', `${end.state}: ${end.state_reason}\n${readFileSync(spawned.log, 'utf8')}`);
  assert.equal(end.state_reason, 'turn ended: report done');
  assert.equal(end.native_session_id, `fake-native-${run.id}`);
  assert.equal(end.input_tokens, 10);
  assert.equal(launcher.processGroup(process.pid) !== undefined, true);
  const kinds = store.listEvents(run.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['start', 'text', 'usage', 'report', 'end']);
  const endEvent = JSON.parse(store.lastEvent(run.id, 'end')!.payload) as { status: string; report: string };
  assert.deepEqual([endEvent.status, endEvent.report], ['done', 'done']);
  assert.ok(existsSync(spawned.log));
  const log = readFileSync(spawned.log, 'utf8');
  assert.match(log, new RegExp(`jv run ${run.id}: done`));
  assert.ok(!log.includes(FAKE_TOKEN));

  const input = JSON.parse(readFileSync(dump, 'utf8')) as {
    prompt: string;
    systemAppend: string;
    tools: { mode: string };
    envKeys: string[];
    home: string;
    jvSession: string;
    mcp: { servers: object; report: { args: string[]; env: { JV_HOME: string } } };
  };
  assert.equal(input.prompt, START_PROMPT);
  assert.match(input.systemAppend, /in the project "sandbox"/);
  assert.match(input.systemAppend, /Read the code the task names/);
  assert.match(input.systemAppend, /# Sandbox rules/);
  assert.match(input.systemAppend, /Kind: single\. Step 1 of 1: investigate\./);
  assert.equal(input.tools.mode, 'read-only');
  assert.equal(input.jvSession, run.id);
  assert.equal(input.home, join(home, 'homes', 'claude-main'));
  assert.ok(input.envKeys.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!input.envKeys.includes('JV_TEST_RUNTIME_MODULE'), 'the worker never gets the process environment');
  assert.deepEqual(input.mcp.report.args.slice(-2), ['--session', run.id]);
  assert.equal(input.mcp.report.env.JV_HOME, home);

  assert.equal(store.requireStep(seeded.stepIds[0]!).state, 'done');
  const task = store.requireTask(seeded.taskId);
  assert.equal(task.state, 'done');
  assert.equal(task.state_reason, 'step investigate done');

  assert.throws(() => spawnFake(run.id, 'done'), (e: unknown) => e instanceof JvError && e.exitCode === 2);
});

test('a run that continues a conversation gets its message and the undelivered task messages', async () => {
  const s = seedTask(store, home, { name: 'second' });
  const message = store.createMessage({ task_id: s.taskId, direction: 'owner', text: 'Use the second option.' });
  const run = newRun({ nativeSessionId: 'native-conv', message: 'Continue.', taskId: s.taskId, stepId: s.stepIds[0]! });
  const dump = join(home, 'dump-resume.json');
  spawnFake(run.id, 'progress', dump);
  const end = await waitFor('the resumed run to end', () => finalState(run.id));
  assert.equal(end.state, 'done');
  assert.equal(end.native_session_id, 'native-conv');
  const input = JSON.parse(readFileSync(dump, 'utf8')) as { prompt: string; native: string };
  assert.equal(input.native, 'native-conv');
  assert.equal(input.prompt, 'Continue.\n\nFrom the owner: Use the second option.');
  assert.equal(store.getMessage(message.id)!.delivered_at !== null, true);
  assert.equal(store.getMessage(message.id)!.session_id, run.id);
  const task = store.requireTask(s.taskId);
  assert.equal(task.state, 'waiting-owner');
  assert.equal(task.state_reason, 'progress');
});

test('a run whose process dies without an end event is lost at read time', async () => {
  const s = seedTask(store, home, { name: 'third' });
  const run = newRun({ taskId: s.taskId, stepId: s.stepIds[0]! });
  const spawned = spawnFake(run.id, 'crash');
  await waitFor('the process to exit', () => !launcher.isAlive(spawned.pid));
  assert.equal(store.getSession(run.id)!.state, 'running');
  const alive = newRun({ taskId: s.taskId, stepId: s.stepIds[0]! });
  store.setSessionState(alive.id, 'running', 'pretend', { pid: process.pid, pgid: process.pid });
  const lost = launcher.markLost(store, { alive: (r) => r.id === alive.id || launcher.isRunAlive(r) });
  assert.deepEqual(lost.map((r) => r.id), [run.id]);
  const row = store.getSession(run.id)!;
  assert.equal(row.state, 'lost');
  assert.match(row.state_reason, /ended without an end event/);
  assert.equal(store.getSession(alive.id)!.state, 'running');
  assert.deepEqual(launcher.markLost(store, { alive: (r) => r.id === alive.id }), []);
  store.setSessionState(alive.id, 'failed', 'test cleanup');
});

test('the pid of another process does not keep a run alive', () => {
  assert.equal(launcher.isAlive(process.pid), true);
  assert.equal(launcher.isAlive(2 ** 22 + 12345), false);
  assert.equal(launcher.isAlive(null), false);
  assert.equal(launcher.isRunAlive({ id: 'RNOTME1', pid: process.pid }), false);
});

test('stopRun ends a running run: SIGTERM to its group, state stopped, end event, task left alone', async () => {
  const s = seedTask(store, home, { name: 'fourth' });
  const run = newRun({ taskId: s.taskId, stepId: s.stepIds[0]! });
  const spawned = spawnFake(run.id, 'sleep');
  await waitFor('the fake turn to start', () => store.listEvents(run.id).some((e) => e.kind === 'text'));
  const r = await launcher.stopRun(store, run.id, 'stopped by the owner', { graceMs: 8000 });
  assert.equal(r.signalled, true, `${JSON.stringify(store.getSession(run.id))}\n${readFileSync(spawned.log, 'utf8')}`);
  assert.equal(r.killed, false);
  assert.equal(launcher.isAlive(spawned.pid), false);
  const row = store.getSession(run.id)!;
  assert.equal(row.state, 'stopped');
  assert.equal(row.state_reason, 'stopped by the owner');
  const ends = store.listEvents(run.id).filter((e) => e.kind === 'end');
  assert.equal(ends.length, 1);
  assert.equal((JSON.parse(ends[0]!.payload) as { status: string }).status, 'stopped');
  assert.equal(store.requireTask(s.taskId).state, 'queued');
  const again = await launcher.stopRun(store, run.id, 'again');
  assert.equal(again.signalled, false);
});

test('a runtime that is not built yet fails the run with exit 2; a failing turn fails it with its reason', async () => {
  const s = seedTask(store, home, { name: 'fifth' });
  const saved = process.env.JV_TEST_RUNTIME_MODULE;
  delete process.env.JV_TEST_RUNTIME_MODULE;
  const codex = newRun({ runtime: 'codex', taskId: s.taskId, stepId: s.stepIds[0]! });
  const out = await executeRun(codex.id, { store, handleSignals: false, rulesFile: rules, log: () => {} });
  assert.equal(out.exitCode, 2);
  assert.equal(out.state, 'failed');
  assert.match(out.session.state_reason, /codex runtime is not available/);
  assert.equal(store.lastEvent(codex.id, 'end') !== undefined, true);
  assert.equal(store.requireTask(s.taskId).state, 'waiting-owner');

  const failing = newRun({ taskId: s.taskId, stepId: s.stepIds[0]! });
  const failed = await executeRun(failing.id, {
    store,
    handleSignals: false,
    rulesFile: rules,
    log: () => {},
    loadRuntime: async () => ({
      start: async () => {
        throw new Error(`refused with ${FAKE_TOKEN}`);
      },
      resume: async () => {},
      stop: async () => {},
      tail: async function* () {},
    }),
  });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.state, 'failed');
  assert.ok(!failed.session.state_reason.includes(FAKE_TOKEN));
  assert.match(failed.session.state_reason, /refused with \[redacted\]/);
  await assert.rejects(() => executeRun(failing.id, { store, handleSignals: false, log: () => {} }), /a run executes once/);
  if (saved !== undefined) process.env.JV_TEST_RUNTIME_MODULE = saved;
});

test('jv tail and jv report read a finished run (text and --json)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeReport } = await import('../src/report.js');
  const { recordEvent } = await import('../src/events.js');
  const s = seedTask(store, home, { name: 'sixth' });
  const run = newRun({ taskId: s.taskId, stepId: s.stepIds[0]! });
  await executeRun(run.id, {
    store,
    handleSignals: false,
    rulesFile: rules,
    log: () => {},
    loadRuntime: async () => ({
      start: async (session) => {
        recordEvent(store, session.id, 'text', { text: 'Reading src/index.ts' });
        writeReport(store, session.id, {
          status: 'needs-decision',
          summary: 'Two entry points.',
          question: 'Which one is the app?',
          options: [{ label: 'src/index.ts' }, { label: 'src/server.ts', description: 'the HTTP server' }],
        });
        return { pid: process.pid, pgid: process.pid };
      },
      resume: async () => {},
      stop: async () => {},
      tail: async function* () {},
    }),
  });
  const cli = (...argv: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...argv], { env: { ...process.env, JV_HOME: home }, encoding: 'utf8' });
  const text = cli('tail', run.id);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^1 \S+ start claude-sdk claude-main model-strong high/m);
  assert.match(text.stdout, / text Reading src\/index\.ts$/m);
  assert.match(text.stdout, / report needs-decision: Two entry points\.$/m);
  assert.match(text.stdout, / end done \(turn ended: report needs-decision\)$/m);
  const json = cli('tail', run.id, '--json', '--follow');
  assert.equal(json.status, 0, json.stderr);
  const lines = json.stdout.trim().split('\n').map((l) => JSON.parse(l) as { seq: number; kind: string; payload: { status?: string } });
  assert.deepEqual(lines.map((l) => l.kind), ['start', 'text', 'report', 'end']);
  assert.equal(lines[2]!.payload.status, 'needs-decision');
  const rep = cli('report', run.id);
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /needs-decision/);
  assert.match(rep.stdout, /Question: Which one is the app\?/);
  assert.match(rep.stdout, /2\. src\/server\.ts - the HTTP server/);
  const repJson = JSON.parse(cli('report', run.id, '--json').stdout) as { status: string; options: unknown[]; question: string };
  assert.equal(repJson.status, 'needs-decision');
  assert.equal(repJson.options.length, 2);
  const none = cli('report', newRun({ taskId: s.taskId, stepId: s.stepIds[0]! }).id);
  assert.equal(none.status, 3);
  assert.equal(cli('tail', 'RZZZZZZ').status, 3);
});
