// jv attach S with a fake tmux runner: claude-tmux attaches to the live window, claude-sdk and codex start a
// takeover window through jv exec and mark the run waiting, running turns and llm are refused, and outside a
// terminal the command is printed instead of attaching.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-attach-test-');
process.env.JV_HOME = home;
mkdirSync(join(home, 'homes', 'codex', '.codex'), { recursive: true });
const { attachSession, ATTACHED_REASON } = await import('../src/attach.js');
const { openStore } = await import('../src/store.js');
const { parseProviders } = await import('../src/providers.js');

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);
const raw = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')) as { providers: unknown[] };
raw.providers.push({ name: 'codex', kind: 'codex-subscription', home: '~/.jv/homes/codex', models: [{ id: 'gpt-test', label: 'GPT', efforts: ['high'] }] });
const providers = parseProviders(raw, join(home, 'providers.json'));

function fakeTmux(live: Set<string>) {
  const calls: string[][] = [];
  const runner = (args: readonly string[]) => {
    calls.push([...args]);
    const t = (args[args.indexOf('-t') + 1] ?? '').replace(/^=/, '');
    if (args[0] === 'has-session') return { status: live.has(t) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'new-session') live.add(args[args.indexOf('-s') + 1]!);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

let n = 0;
function row(runtime: 'claude-sdk' | 'claude-tmux' | 'codex' | 'llm', native: string | null, state: 'done' | 'running' = 'done', provider = 'claude-main') {
  n++;
  const s = store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-attach-${n}`,
    kind: 'step',
    runtime,
    provider,
    model: runtime === 'codex' ? 'gpt-test' : 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
  return store.setSessionState(s.id, state, 'test');
}

test('claude-sdk: a takeover window through jv exec with claude --resume, the newest run marked waiting', () => {
  const first = row('claude-sdk', 'sdk-uuid-1');
  const second = row('claude-sdk', 'sdk-uuid-1');
  const { runner, calls } = fakeTmux(new Set());
  const r = attachSession(store, first.id, { tmux: runner, providers: () => providers, tty: false, insideTmux: false, claude: '/opt/claude' });
  assert.equal(r.tmuxTarget, `jv-${second.id}`);
  assert.equal(r.created, true);
  assert.equal(r.attached, false);
  assert.deepEqual(r.command, ['tmux', 'attach', '-t', `=jv-${second.id}`]);
  const created = calls.find((c) => c[0] === 'new-session')!;
  assert.deepEqual(created.slice(0, 6), ['new-session', '-d', '-s', `jv-${second.id}`, '-c', seeded.repo]);
  const exec = created.indexOf('exec');
  assert.deepEqual(created.slice(exec, exec + 4), ['exec', '--session', second.id, '--']);
  assert.deepEqual(created.slice(exec + 4, exec + 11), ['/opt/claude', '--resume', 'sdk-uuid-1', '--model', 'model-strong', '--effort', 'high']);
  assert.deepEqual(created.slice(-2), ['--setting-sources', 'user'], 'the takeover loads the provider home settings only, like the SDK turn');
  assert.ok(!JSON.stringify(calls).includes(FAKE_TOKEN));
  const after = store.requireSession(second.id);
  assert.equal(after.state, 'waiting');
  assert.equal(after.state_reason, ATTACHED_REASON);
  assert.equal(after.tmux_target, `jv-${second.id}`);
  // The provider home is ready for an interactive start.
  const prefs = JSON.parse(readFileSync(join(home, 'homes', 'claude-main', '.claude.json'), 'utf8')) as { hasCompletedOnboarding: boolean };
  assert.equal(prefs.hasCompletedOnboarding, true);
  // A second attach finds the window instead of starting another one; in a terminal inside tmux it switches.
  const switched: string[][] = [];
  const again = attachSession(store, second.id, {
    tmux: runner,
    providers: () => providers,
    tty: true,
    insideTmux: true,
    interactive: (a) => {
      switched.push(a);
      return 0;
    },
  });
  assert.equal(again.created, false);
  assert.equal(again.attached, true);
  assert.deepEqual(switched, [['switch-client', '-t', `=jv-${second.id}`]]);
});

test('codex: codex resume <thread> with model and effort through jv exec', () => {
  const s = row('codex', 'thread-9', 'done', 'codex');
  const { runner, calls } = fakeTmux(new Set());
  const r = attachSession(store, s.id, { tmux: runner, providers: () => providers, tty: false, insideTmux: false, codex: '/opt/codex' });
  assert.equal(r.waiting, s.id);
  const created = calls.find((c) => c[0] === 'new-session')!;
  const exec = created.indexOf('exec');
  assert.deepEqual(created.slice(exec + 4), ['/opt/codex', 'resume', 'thread-9', '-m', 'gpt-test', '-c', 'model_reasoning_effort="high"', '-c', 'project_doc_max_bytes=262144']);
});

test('claude-tmux attaches to the live window of the conversation; a gone window is refused', () => {
  const first = row('claude-tmux', 'tmux-uuid');
  store.updateSession(first.id, { tmux_target: `jv-${first.id}` });
  const second = row('claude-tmux', 'tmux-uuid');
  store.updateSession(second.id, { tmux_target: `jv-${first.id}` });
  const { runner, calls } = fakeTmux(new Set([`jv-${first.id}`]));
  const attachedTo: string[][] = [];
  const r = attachSession(store, second.id, { tmux: runner, providers: () => providers, tty: true, insideTmux: false, interactive: (a) => (attachedTo.push(a), 0) });
  assert.equal(r.tmuxTarget, `jv-${first.id}`);
  assert.deepEqual(attachedTo, [['attach', '-t', `=jv-${first.id}`]]);
  assert.ok(!calls.some((c) => c[0] === 'new-session'));
  assert.equal(store.requireSession(second.id).state, 'done');
  const gone = fakeTmux(new Set());
  assert.throws(() => attachSession(store, second.id, { tmux: gone.runner, providers: () => providers, tty: false }), /is gone; jv task resume/);
});

test('a running turn, a session without a native id, and llm sessions are refused', () => {
  const running = row('claude-sdk', 'sdk-busy', 'running');
  const { runner } = fakeTmux(new Set());
  assert.throws(() => attachSession(store, running.id, { tmux: runner, providers: () => providers, tty: false }), /still running/);
  const fresh = row('claude-sdk', null);
  assert.throws(() => attachSession(store, fresh.id, { tmux: runner, providers: () => providers, tty: false }), /no native session/);
  const plain = row('llm', null);
  assert.throws(() => attachSession(store, plain.id, { tmux: runner, providers: () => providers, tty: false }), /llm/);
});
