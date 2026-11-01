// jv status (status.ts): waiting-on-owner first, done tasks out (listed apart for 24 hours), discarded (stopped)
// tasks out, failed tasks for 24 hours, the latest run and report per task, the options of a needs-decision and of a landing ask, lost runs marked
// at read time, and the --project filter.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-status-test-');
process.env.JV_HOME = home;
const S = await import('../src/status.js');
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const { main } = await import('../src/cli.js');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const p1 = store.createProject({ name: 'one', path: '/tmp/jv-status-one', default_branch: 'main' }).row;
const p2 = store.createProject({ name: 'two', path: '/tmp/jv-status-two', default_branch: 'main' }).row;
let n = 0;
function task(projectId: string, title: string, state: 'queued' | 'running' | 'waiting-owner' | 'landing' | 'done' | 'failed' | 'stopped') {
  n++;
  const t = store.createTask({ project_id: projectId, request_id: `r${n}`, kind: 'feature', title, task_text: 'x', workflow_json: '{}' }).row;
  const step = store.createStep({ task_id: t.id, ordinal: 1, duty: 'implement' }).row;
  store.createStep({ task_id: t.id, ordinal: 2, duty: 'verify' });
  const run = store.createSession({
    project_id: projectId,
    task_id: t.id,
    step_id: step.id,
    request_id: `s${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: '/tmp',
  }).row;
  store.setTaskState(t.id, state, `${state} for the test`, { current_step: 1 });
  return { task: store.requireTask(t.id), step, run };
}

const running = task(p1.id, 'Running one', 'running');
store.setSessionState(running.run.id, 'running', 'turn running');
const waiting = task(p1.id, 'Waiting one', 'waiting-owner');
store.setSessionState(waiting.run.id, 'running', 'x');
writeReport(store, waiting.run.id, { status: 'needs-decision', summary: 'Pick one.', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] });
store.setSessionState(waiting.run.id, 'done', 'turn ended: report needs-decision');
const asking = task(p1.id, 'Landing ask', 'waiting-owner');
store.createLanding({ task_id: asking.task.id, route: 'ask-owner', state: 'asked', reason: 'Touches stored data.' });
const lost = task(p1.id, 'Lost one', 'running');
store.setSessionState(lost.run.id, 'running', 'x', { pid: 999999, native_session_id: 'native-lost' });
const done = task(p1.id, 'Done one', 'done');
const failed = task(p2.id, 'Failed one', 'failed');
const discarded = task(p1.id, 'Discarded one', 'stopped');
store.setSessionState(discarded.run.id, 'stopped', 'discarded by the owner');
const queued = task(p2.id, 'Queued one', 'queued');
const coordinator = store.createSession({ project_id: p1.id, request_id: 'coord', kind: 'coordinator', runtime: 'claude-tmux', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: '/tmp' }).row;
store.setSessionState(coordinator.id, 'running', 'coordinator up', { tmux_target: 'jv-coord-one' });

test('status lists open work, waiting-on-owner first, and marks lost runs at read time', () => {
  const view = S.statusView(store);
  assert.deepEqual(view.lost, [lost.run.id]);
  const ids = view.tasks.map((t) => t.id);
  assert.deepEqual(ids.slice(0, 2).sort(), [waiting.task.id, asking.task.id].sort(), 'waiting-owner first');
  assert.ok(!ids.includes(done.task.id), 'done tasks are left out');
  assert.ok(ids.includes(failed.task.id), 'a task that failed in the last 24 hours is listed');
  assert.ok(!ids.includes(discarded.task.id), 'a task the owner discarded is no open work');
  assert.ok(!view.recent.some((r) => r.id === discarded.task.id));
  assert.ok(!view.sessions.some((s) => s.task === discarded.task.id));
  assert.deepEqual(view.tasks.map((t) => t.state), ['waiting-owner', 'waiting-owner', 'running', 'running', 'queued', 'failed']);
  assert.deepEqual(view.recent.map((r) => r.id), [done.task.id]);

  const w = view.tasks.find((t) => t.id === waiting.task.id)!;
  assert.equal(w.question, 'A or B?');
  assert.deepEqual(w.options, [{ label: 'A' }, { label: 'B' }]);
  assert.deepEqual(w.report, { session: waiting.run.id, status: 'needs-decision', summary: 'Pick one.' });
  assert.deepEqual(w.step, { ordinal: 1, duty: 'implement', state: 'pending', of: 2 });
  assert.equal(w.run?.model, 'model-strong');
  assert.equal(w.run?.provider, 'claude-main');
  assert.equal(w.run?.runtime, 'claude-sdk');
  assert.equal(w.state_reason, 'waiting-owner for the test');

  const a = view.tasks.find((t) => t.id === asking.task.id)!;
  assert.deepEqual(a.options?.map((o) => o.label), ['Land now', 'Leave it']);
  assert.match(a.question!, /Touches stored data/);
  assert.equal(a.options?.[0]?.description, `jv land ${asking.task.id} --force`);

  const l = view.tasks.find((t) => t.id === lost.task.id)!;
  assert.equal(l.lost, true);
  assert.equal(l.run?.state, 'lost');
  assert.ok(view.sessions.some((s) => s.id === lost.run.id && s.state === 'lost'));
  assert.ok(view.sessions.some((s) => s.id === coordinator.id && s.kind === 'coordinator'));
  assert.ok(!view.sessions.some((s) => s.id === done.run.id));
  assert.equal(view.tasks.find((t) => t.id === queued.task.id)?.run?.state, 'queued');

  const text = S.formatStatus(view);
  assert.match(text, /^waiting-owner:/);
  assert.match(text, /LOST: jv task resume/);
  assert.match(text, /Done in the last 24 hours:/);
});

test('--project filters; failed and done tasks older than 24 hours drop out', async () => {
  const later = Date.now() + 25 * 3600 * 1000;
  const view = S.statusView(store, { project: 'two', now: later, markLost: false });
  assert.deepEqual(view.tasks.map((t) => t.id), [queued.task.id]);
  assert.deepEqual(view.recent, []);
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (c: string) => (out.push(String(c)), true);
  let code: number;
  try {
    code = await main(['status', '--project', 'one', '--json']);
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
  assert.equal(code, 0);
  const json = JSON.parse(out.join('')) as { tasks: Array<{ id: string; project: string }> };
  assert.ok(json.tasks.length >= 4);
  assert.ok(json.tasks.every((t) => t.project === 'one'));
});
