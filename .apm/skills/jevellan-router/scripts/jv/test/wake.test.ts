// Wake lines (section 9.4) against a fake tmux and a fake clock: nothing typed without a live coordinator, the first
// line at once, later lines inside the 5 s window queued and merged by the process that queued the first one, a
// single queued line sent as it is, a dead flusher taken over, and lines made one line.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FakeTmux, writeCoordinatorHome } from './fixtures/coordinator-fixture.js';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-wake-test-');
writeCoordinatorHome(home);
process.env.JV_HOME = home;
const c = await import('../src/coordinator.js');
const w = await import('../src/wake.js');
const { openStore } = await import('../src/store.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());

function project(name: string) {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  return store.createProject({ name, path: repo, default_branch: 'main' }).row;
}

const tmux = new FakeTmux();
const coordDeps = {
  tmux: tmux.run,
  jvCommand: '/opt/jv/bin/jv',
  claudePath: '/usr/bin/claude',
  sleep: async () => {},
  readyTimeoutMs: 50,
  stopWaitMs: 50,
  readCmdline: (pid: number) => tmux.cmdline(pid),
};

/** A clock the test moves, and a sleep that resolves when the test says so (moving the clock to the due time). */
function controlledTime(start: number) {
  let now = start;
  const sleepers: Array<{ until: number; resolve: () => void }> = [];
  return {
    now: () => now,
    set: (t: number) => {
      now = t;
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ until: now + ms, resolve });
      }),
    /** Wakes every sleeper, moving the clock to the latest due time. */
    wakeAll: () => {
      for (const s of sleepers.splice(0)) {
        now = Math.max(now, s.until);
        s.resolve();
      }
    },
    sleeping: () => sleepers.length,
  };
}

const line = (n: number) => `[jv] T00000${n} (Task ${n}) step verify: needs-decision. Run: jv report R00000${n}`;

test('no coordinator registered: nothing is typed and nothing is queued', async () => {
  const p = project('none');
  const r = await w.wake(store, { projectId: p.id, line: line(1) }, { tmux: tmux.run });
  assert.deepEqual(r, { action: 'no-coordinator' });
  assert.equal(store.getMeta(w.wakeMetaKey(p.id)), undefined);
  await w.notifyCoordinator(store, { projectId: p.id, line: line(1) }, { tmux: tmux.run });
});

test('first line at once; lines inside the window are merged by the first queuer; one queued line goes as it is', async () => {
  const p = project('sandbox');
  await c.startCoordinator(store, 'sandbox', coordDeps);
  const screen = tmux.sessions.get('jv-coord-sandbox')!;
  const t = controlledTime(1_000_000);
  const d = { tmux: tmux.run, now: t.now, sleep: t.sleep, alive: () => true };

  assert.equal((await w.wake(store, { projectId: p.id, line: line(1) }, d)).action, 'sent');
  assert.deepEqual(screen.submitted, [line(1)]);

  t.set(1_001_000);
  const flusher = w.wake(store, { projectId: p.id, line: line(2) }, d);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.sleeping(), 1, 'the first queuer waits for the window');
  t.set(1_002_000);
  assert.deepEqual(await w.wake(store, { projectId: p.id, line: line(3) }, d), { action: 'queued' });
  t.set(1_003_000);
  assert.deepEqual(await w.wake(store, { projectId: p.id, line: line(4) }, d), { action: 'queued' });
  assert.equal(screen.submitted.length, 1, 'nothing more typed inside the window');
  t.wakeAll();
  const flushed = await flusher;
  assert.deepEqual(flushed, { action: 'flushed', line: '[jv] 3 updates. Run: jv status --json', count: 3, typed: true });
  assert.equal(t.now(), 1_005_000, 'flushed when the window of the first line ended');
  assert.deepEqual(screen.submitted, [line(1), '[jv] 3 updates. Run: jv status --json']);

  // Inside the next window, a single queued line is sent as it is.
  t.set(1_006_000);
  const single = w.wake(store, { projectId: p.id, line: line(5) }, d);
  await new Promise((r) => setImmediate(r));
  t.wakeAll();
  assert.deepEqual(await single, { action: 'flushed', line: line(5), count: 1, typed: true });
  assert.equal(t.now(), 1_010_000);

  // After the window, the next line goes at once again.
  t.set(1_020_000);
  assert.equal((await w.wake(store, { projectId: p.id, line: line(6) }, d)).action, 'sent');
  assert.deepEqual(screen.submitted.slice(-2), [line(5), line(6)]);
  assert.deepEqual(w.readWakeState(store, p.id).pending, []);
});

test('a dead flusher is taken over: its pending lines go out with the new one', async () => {
  const p = store.getProjectByName('sandbox')!;
  const screen = tmux.sessions.get('jv-coord-sandbox')!;
  const t = controlledTime(2_000_000);
  store.setMeta(
    w.wakeMetaKey(p.id),
    JSON.stringify({ lastSentAt: new Date(1_999_000).toISOString(), pending: ['[jv] stranded'], flusher: { pid: 999_999_999, dueAt: new Date(2_004_000).toISOString() } }),
  );
  const d = { tmux: tmux.run, now: t.now, sleep: t.sleep, alive: (pid: number) => pid !== 999_999_999 };
  const r = w.wake(store, { projectId: p.id, line: line(7) }, d);
  await new Promise((res) => setImmediate(res));
  t.wakeAll();
  assert.deepEqual(await r, { action: 'flushed', line: '[jv] 2 updates. Run: jv status --json', count: 2, typed: true });
  assert.equal(screen.submitted.at(-1), '[jv] 2 updates. Run: jv status --json');
});

test('a flusher that finds another process took over sends nothing', async () => {
  const p = store.getProjectByName('sandbox')!;
  const t = controlledTime(3_000_000);
  store.setMeta(w.wakeMetaKey(p.id), JSON.stringify({ lastSentAt: new Date(2_999_000).toISOString(), pending: [] }));
  const d = { tmux: tmux.run, now: t.now, sleep: t.sleep, alive: () => true, pid: 111 };
  const r = w.wake(store, { projectId: p.id, line: line(8) }, d);
  await new Promise((res) => setImmediate(res));
  const state = w.readWakeState(store, p.id);
  store.setMeta(w.wakeMetaKey(p.id), JSON.stringify({ ...state, flusher: { pid: 222, dueAt: state.flusher!.dueAt } }));
  t.wakeAll();
  assert.deepEqual(await r, { action: 'taken-over' });
});

test('lines are made one line, cut, and a stopped coordinator gets nothing', async () => {
  assert.equal(w.wakeLine('[jv] T1 (A\nB)\tstep x'), '[jv] T1 (A B) step x');
  assert.equal([...w.wakeLine(`[jv] ${'x'.repeat(2000)}`)].length, w.WAKE_LINE_MAX);
  assert.equal(w.mergedLine(['a']), 'a');
  assert.equal(w.mergedLine(['a', 'b']), '[jv] 2 updates. Run: jv status --json');

  const p = store.getProjectByName('sandbox')!;
  await c.stopCoordinator(store, 'sandbox', coordDeps);
  const before = tmux.calls.length;
  assert.deepEqual(await w.wake(store, { projectId: p.id, line: line(9) }, { tmux: tmux.run }), { action: 'no-coordinator' });
  assert.ok(!tmux.calls.slice(before).some((a) => a[0] === 'send-keys'));
});
