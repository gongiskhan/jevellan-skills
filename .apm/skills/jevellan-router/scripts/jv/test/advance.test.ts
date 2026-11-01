// advance.ts (section 7.6) with a fake router (placeStep), a recording spawn, a fake wake and a fake landing: runs
// are ended by hand (state, report) and afterRun is awaited. No process, no model, no network.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { makeHome, writeSkill } from './fixtures/run-fixture.js';

const home = makeHome('jv-advance-test-');
process.env.JV_HOME = home;
const A = await import('../src/advance.js');
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const { runMessage } = await import('../src/launcher.js');
const { refused } = await import('../src/errors.js');
const { workflowSteps } = await import('../src/workflows.js');
type PlaceStepInput = import('../src/route.js').PlaceStepInput;
type AdvanceDeps = import('../src/advance.js').AdvanceDeps;
type ReportInput = import('../src/report.js').ReportInput;
type Workflow = import('../src/workflows.js').Workflow;

writeSkill(home, 'verify', ['repo-write', 'shell', 'browser'], 'Verify.');
writeSkill(home, 'document', ['repo-write'], 'Document.');
writeSkill(home, 'answer', [], 'Answer.');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const repo = join(home, 'repos', 'sandbox');
const project = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;
const worktree = join(home, 'worktrees', 'sandbox', 'task');

let placed: PlaceStepInput[] = [];
let spawned: string[] = [];
let woken: string[] = [];
let landed: Array<{ task: string; auto?: boolean; force?: boolean }> = [];
let refuseJev = false;
let spawnFails = false;
let landMakesDone = true;
let closed: Array<{ taskId: string; stepId?: string }> = [];

beforeEach(() => {
  placed = [];
  spawned = [];
  woken = [];
  landed = [];
  refuseJev = false;
  spawnFails = false;
  landMakesDone = true;
  closed = [];
});

const deps: Partial<AdvanceDeps> = {
  placeStep: async (input) => {
    placed.push(input);
    if (refuseJev) throw refused('Jev: no key configured');
    const step = store.requireStep(input.stepId);
    const task = store.requireTask(input.taskId);
    const decision = store.createDecision({
      kind: 'placement',
      project_id: task.project_id,
      task_id: task.id,
      step_id: step.id,
      skill_name: 'jevellan-router',
      skill_hash: 'hash',
      jev_model: 'jev-test',
      state_json: JSON.stringify({ attempt: input.attempt, failure: input.failure ?? null }),
      questions_json: '{}',
      answers_json: '{}',
      chosen_json: JSON.stringify({ duty: step.duty, model: 'model-strong', effort: 'high' }),
      latency_ms: 1,
      usage_json: '{}',
    });
    return { runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', decisionId: decision.id, decision };
  },
  spawn: (_s, id) => {
    if (spawnFails) throw new Error('no node');
    spawned.push(id);
  },
  notify: async (_s, input) => {
    woken.push(input.line);
  },
  land: async (s, taskId, options) => {
    landed.push({ task: taskId, ...options });
    if (landMakesDone) s.setTaskState(taskId, 'done', 'landed (fake)');
    return { route: 'land', state: landMakesDone ? 'landed' : 'asked', reason: 'fake', taskId };
  },
  closeWindows: async (_s, scope) => {
    closed.push(scope);
    return [];
  },
};

let n = 0;
function newTask(workflow: Workflow, extra: { kind?: 'feature' | 'single' | 'bug'; after?: string } = {}) {
  n++;
  const task = store.createTask({
    project_id: project.id,
    request_id: `req-${n}`,
    kind: extra.kind ?? 'feature',
    title: `Task ${n}`,
    task_text: 'Do the thing.',
    workflow_json: JSON.stringify(workflow),
    ...(extra.after ? { after_task_id: extra.after } : {}),
  }).row;
  for (const s of workflowSteps(task.id, workflow)) store.createStep(s);
  return store.updateTask(task.id, { worktree_path: worktree, branch: `jv/task-${n}` });
}

const FEATURE: Workflow = {
  name: 'feature',
  steps: [
    { duty: 'plan', when: 'jev:needs_plan', instructions: 'Plan.' },
    { duty: 'implement', when: 'always', instructions: 'Implement.' },
    { duty: 'verify', when: 'always', instructions: 'Verify.', onFail: { goto: 'implement', maxLoops: 2 } },
    { duty: 'document', when: 'always', instructions: 'Docs.' },
  ],
};

let native = 0;
/** Ends a run by hand: running, a native id, the report, the end state; then afterRun. */
async function endRun(id: string, report: ReportInput | null, state: 'done' | 'failed' = 'done', reason = 'turn ended') {
  const s = store.requireSession(id);
  store.setSessionState(id, 'running', 'fake turn', s.native_session_id ? {} : { native_session_id: `native-${++native}` });
  if (report) assert.equal(writeReport(store, id, report).outcome, 'recorded');
  store.setSessionState(id, state, reason);
  await A.afterRun(store, id, deps);
}

const stepOf = (taskId: string, ordinal: number) => store.getStepByOrdinal(taskId, ordinal)!;
const lastRun = (taskId: string) => store.listSessions({ task_id: taskId }).at(-1)!;

test('a feature task advances step by step and lands after the last step', async () => {
  const task = newTask(FEATURE);
  store.setStepState(stepOf(task.id, 1).id, 'skipped', 'Jev: not needed');
  const start = await A.startStep(store, task.id, { reason: 'task created', deps });
  assert.equal(start.state, 'started');
  if (start.state !== 'started') return;
  assert.equal(start.step.duty, 'implement');
  assert.equal(start.session.cwd, worktree);
  assert.equal(start.session.request_id, `run:${start.placement.decisionId}`);
  assert.equal(store.requireDecision(start.placement.decisionId).session_id, start.session.id);
  assert.deepEqual(spawned, [start.session.id]);
  let t = store.requireTask(task.id);
  assert.equal(t.state, 'running');
  assert.equal(t.current_step, 2);
  assert.equal(stepOf(task.id, 2).state, 'running');
  assert.equal(stepOf(task.id, 2).attempts, 1);
  assert.equal(placed[0]!.attempt, 1);

  await endRun(start.session.id, { status: 'done', summary: 'Implemented.' });
  assert.equal(stepOf(task.id, 2).state, 'done');
  const outcome = JSON.parse(store.requireDecision(start.placement.decisionId).outcome_json!) as Record<string, unknown>;
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.attempts, 1);
  assert.equal(typeof outcome.durationMs, 'number');
  assert.ok('costUsd' in outcome);
  const verify = lastRun(task.id);
  assert.equal(store.requireStep(verify.step_id!).duty, 'verify');
  assert.equal(store.requireTask(task.id).current_step, 3);

  await endRun(verify.id, { status: 'done', summary: 'All green.', testsRun: { command: 'npm test', passed: true, summary: 'ok' } });
  const doc = lastRun(task.id);
  assert.equal(store.requireStep(doc.step_id!).duty, 'document');
  await endRun(doc.id, { status: 'done', summary: 'Docs updated.' });
  assert.deepEqual(landed, [{ task: task.id, auto: true }]);
  t = store.requireTask(task.id);
  assert.equal(t.state, 'done');
  assert.equal(placed.length, 3);
});

test('a single task is done after its step, and a task waiting with --after starts then', async () => {
  const single: Workflow = { name: 'single', steps: [{ duty: 'investigate', when: 'always', instructions: '' }] };
  const first = newTask(single, { kind: 'single' });
  const second = newTask(single, { kind: 'single', after: first.id });
  const waiting = await A.startStep(store, second.id, { reason: 'task created', deps });
  assert.equal(waiting.state, 'waiting');
  assert.equal(store.requireTask(second.id).state, 'queued');
  assert.match(store.requireTask(second.id).state_reason, new RegExp(`waiting for ${first.id}`));
  const s = await A.startStep(store, first.id, { reason: 'task created', deps });
  assert.equal(s.state, 'started');
  await endRun(lastRun(first.id).id, { status: 'done', summary: 'Found it.' });
  assert.equal(store.requireTask(first.id).state, 'done');
  assert.equal(landed.length, 0, 'a single task does not land');
  assert.equal(store.requireTask(second.id).state, 'running', 'the dependent started');
  assert.equal(store.listSessions({ task_id: second.id }).length, 1);
});

test('a single task whose step committed on its branch lands like any other (D-078); one that committed nothing is done', async () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const gitRepo = join(home, 'repos', 'single-docs');
  mkdirSync(gitRepo, { recursive: true });
  g(gitRepo, 'init', '-q', '-b', 'main');
  writeFileSync(join(gitRepo, 'README.md'), '# app\n');
  g(gitRepo, 'add', '-A');
  g(gitRepo, 'commit', '-q', '-m', 'init');
  const base = g(gitRepo, 'rev-parse', 'HEAD');
  const single: Workflow = { name: 'single', steps: [{ duty: 'document', when: 'always', instructions: '' }] };
  const make = (name: string) => {
    const t = newTask(single, { kind: 'single' });
    const wt = join(home, 'worktrees', 'single-docs', name);
    g(gitRepo, 'worktree', 'add', '-q', '-b', `jv/${name}`, wt, 'main');
    return store.updateTask(t.id, { worktree_path: wt, branch: `jv/${name}`, base_commit: base });
  };
  const docs = make('docs');
  writeFileSync(join(docs.worktree_path!, 'README.md'), '# app\n\n## How to run\n');
  g(docs.worktree_path!, 'commit', '-q', '-am', 'How to run');
  assert.equal(await A.singleHasCommits(store.requireTask(docs.id)), true);
  await A.startStep(store, docs.id, { reason: 'task created', deps });
  await endRun(lastRun(docs.id).id, { status: 'done', summary: 'Added How to run.' });
  assert.deepEqual(landed.map((l) => [l.task, l.auto]), [[docs.id, true]], 'the documented change lands');
  assert.equal(store.requireTask(docs.id).state, 'done');

  const nothing = make('nothing');
  assert.equal(await A.singleHasCommits(store.requireTask(nothing.id)), false);
  await A.startStep(store, nothing.id, { reason: 'task created', deps });
  await endRun(lastRun(nothing.id).id, { status: 'done', summary: 'Nothing to change.' });
  assert.equal(landed.length, 1, 'nothing committed: no landing');
  assert.equal(store.requireTask(nothing.id).state, 'done');
});

test('progress continues the same native session with Continue., up to 20 times, then blocks', async () => {
  const task = newTask({ name: 'single', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'single' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  let run = lastRun(task.id);
  await endRun(run.id, { status: 'progress', summary: 'Half way.' });
  const cont = lastRun(task.id);
  assert.notEqual(cont.id, run.id);
  assert.equal(cont.native_session_id, store.requireSession(run.id).native_session_id);
  assert.equal(cont.request_id, `continue:${run.id}`);
  assert.equal(runMessage(store, cont.id), 'Continue.');
  assert.equal(cont.model, run.model);
  assert.equal(store.requireTask(task.id).state, 'running');
  run = cont;
  for (let i = 2; i <= 21; i++) {
    await endRun(run.id, { status: 'progress', summary: `Progress ${i}.` });
    run = lastRun(task.id);
  }
  const t = store.requireTask(task.id);
  assert.equal(t.state, 'waiting-owner');
  assert.match(t.state_reason, /too many progress reports/);
  assert.equal(store.listSessions({ task_id: task.id }).length, 21, 'one start and twenty continues');
  assert.match(woken.at(-1)!, /blocked \(too many progress reports\)/);
});

test('needs-decision waits on the owner and wakes the coordinator with the report to read', async () => {
  const task = newTask({ name: 'single', steps: [{ duty: 'plan', when: 'always', instructions: '' }] }, { kind: 'single' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  const run = lastRun(task.id);
  await endRun(run.id, { status: 'needs-decision', summary: 'Two ways.', question: 'Which table?', options: [{ label: 'A' }, { label: 'B' }] });
  const t = store.requireTask(task.id);
  assert.equal(t.state, 'waiting-owner');
  assert.match(t.state_reason, /needs-decision: Which table\?/);
  assert.deepEqual(woken, [`[jv] ${task.id} (${task.title}) step plan: needs-decision. Run: jv report ${run.id}`]);
});

test('claude-tmux windows close when their step is done or the task ends, not while the step waits', async () => {
  const two: Workflow = { name: 'feature', steps: [{ duty: 'implement', when: 'always', instructions: '' }, { duty: 'verify', when: 'always', instructions: '' }] };
  const task = newTask(two);
  await A.startStep(store, task.id, { reason: 'go', deps });
  const first = lastRun(task.id);
  await endRun(first.id, { status: 'needs-decision', summary: 'Two ways.', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] });
  assert.deepEqual(closed, [], 'a step waiting on the owner keeps its window');
  store.setTaskState(task.id, 'running', 'answered');
  const cont = A.continueRun(store, store.requireSession(first.id), { requestId: `answer:${first.id}`, reason: 'answer', taskReason: 'answered', deps });
  await endRun(cont.id, { status: 'done', summary: 'Done.' });
  assert.deepEqual(closed, [{ taskId: task.id, stepId: stepOf(task.id, 1).id }], 'the finished step closes its windows');
  closed = [];
  await endRun(lastRun(task.id).id, { status: 'done', summary: 'Verified.' });
  assert.equal(store.requireTask(task.id).state, 'done');
  assert.deepEqual(closed, [{ taskId: task.id }], 'a task that ended closes every window it has');
});

test('a verify step with failing tests goes back to implement up to maxLoops, then the task fails', async () => {
  const task = newTask({ name: 'bug', steps: FEATURE.steps.slice(1, 3) }, { kind: 'bug' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  const failing = { status: 'done' as const, summary: 'Two tests fail in customers.', testsRun: { command: 'npm test', passed: false, summary: '2 failed' } };
  await endRun(lastRun(task.id).id, { status: 'done', summary: 'Fixed.' });
  await endRun(lastRun(task.id).id, failing);
  let impl = stepOf(task.id, 1);
  assert.equal(impl.state, 'retrying');
  assert.equal(impl.attempts, 2);
  assert.equal(stepOf(task.id, 2).state, 'pending');
  assert.equal(placed.at(-1)!.attempt, 2);
  assert.equal(placed.at(-1)!.failure, failing.summary);
  assert.equal(store.requireStep(lastRun(task.id).step_id!).duty, 'implement');
  const verifyDecision = store.listDecisions({ kind: 'placement', step_id: stepOf(task.id, 2).id }).at(-1)!;
  assert.equal((JSON.parse(verifyDecision.outcome_json!) as { status: string }).status, 'failed');

  await endRun(lastRun(task.id).id, { status: 'done', summary: 'Fixed again.' });
  assert.equal(stepOf(task.id, 1).state, 'done');
  await endRun(lastRun(task.id).id, failing);
  impl = stepOf(task.id, 1);
  assert.equal(impl.attempts, 3);
  await endRun(lastRun(task.id).id, { status: 'done', summary: 'Third fix.' });
  await endRun(lastRun(task.id).id, failing);
  const t = store.requireTask(task.id);
  assert.equal(t.state, 'failed');
  assert.match(t.state_reason, /failed after 2 retries: Two tests fail/);
  assert.equal(stepOf(task.id, 2).state, 'failed');
  assert.match(woken.at(-1)!, /step verify: failed/);
});

test('a failed run on a step without on_fail waits on the owner with the failure', async () => {
  const task = newTask({ name: 'single', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'single' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  await endRun(lastRun(task.id).id, null, 'failed', 'the model refused');
  const t = store.requireTask(task.id);
  assert.equal(t.state, 'waiting-owner');
  assert.match(t.state_reason, /failed: run R\w+ failed: the model refused/);
  assert.equal(stepOf(task.id, 1).state, 'failed');
});

test('a Jev refusal leaves the step pending with the message, the task queued, and wakes the coordinator', async () => {
  const task = newTask(FEATURE);
  refuseJev = true;
  const r = await A.startStep(store, task.id, { reason: 'task created', deps });
  assert.equal(r.state, 'refused');
  const step = stepOf(task.id, 1);
  assert.equal(step.state, 'pending');
  assert.equal(step.state_reason, 'Jev: no key configured');
  const t = store.requireTask(task.id);
  assert.equal(t.state, 'queued');
  assert.match(t.state_reason, /no key configured/);
  assert.equal(store.listSessions({ task_id: task.id }).length, 0);
  assert.match(woken[0]!, /^\[jv\] T\w+ \(Task \d+\) step plan: not placed \(Jev: no key configured\)\. Run: jv task show T\w+$/);
});

test('messages that arrived during the turn are delivered before advancing', async () => {
  const task = newTask({ name: 'bug', steps: FEATURE.steps.slice(1, 3) }, { kind: 'bug' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  const run = lastRun(task.id);
  store.createMessage({ task_id: task.id, direction: 'owner', text: 'Also handle the empty list.' });
  await endRun(run.id, { status: 'done', summary: 'Implemented.' });
  const next = lastRun(task.id);
  assert.equal(next.request_id, `messages:${run.id}`);
  assert.equal(next.step_id, run.step_id, 'still the implement step');
  assert.equal(next.native_session_id, store.requireSession(run.id).native_session_id);
  assert.equal(stepOf(task.id, 1).state, 'running', 'not advanced yet');
});

test('stopped, lost and superseded runs change nothing; a spawn failure fails the task', async () => {
  const task = newTask({ name: 'single', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'single' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  const run = lastRun(task.id);
  store.setSessionState(run.id, 'stopped', 'stopped by the owner');
  await A.afterRun(store, run.id, deps);
  store.setSessionState(run.id, 'lost', 'gone');
  await A.afterRun(store, run.id, deps);
  assert.equal(store.requireTask(task.id).state, 'running');
  assert.equal(store.listSessions({ task_id: task.id }).length, 1);

  const other = newTask({ name: 'single', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'single' });
  spawnFails = true;
  const r = await A.startStep(store, other.id, { reason: 'go', deps });
  assert.equal(r.state, 'failed');
  assert.equal(store.requireTask(other.id).state, 'failed');
  assert.equal(lastRun(other.id).state, 'failed');
});

test('a live run refuses a second start; answer and converse run in the project checkout', async () => {
  const task = newTask({ name: 'single', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'single' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  await assert.rejects(A.startStep(store, task.id, { reason: 'again', deps }), (e: unknown) => (e as { exitCode?: number }).exitCode === 4);
  const answer = newTask({ name: 'single', steps: [{ duty: 'answer', when: 'always', instructions: '' }] }, { kind: 'single' });
  await A.startStep(store, answer.id, { reason: 'go', deps });
  assert.equal(lastRun(answer.id).cwd, repo);
});

test('landing that cannot run leaves the task landing with the reason and wakes the coordinator', async () => {
  const task = newTask({ name: 'bug', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'bug' });
  await A.startStep(store, task.id, { reason: 'go', deps });
  const failingLand = { ...deps, land: async () => { throw refused('the worktree has uncommitted changes: a.txt'); } };
  const run = lastRun(task.id);
  store.setSessionState(run.id, 'running', 'x', { native_session_id: 'n-land' });
  writeReport(store, run.id, { status: 'done', summary: 'ok' });
  store.setSessionState(run.id, 'done', 'turn ended');
  await A.afterRun(store, run.id, failingLand);
  const t = store.requireTask(task.id);
  assert.equal(t.state, 'landing');
  assert.match(t.state_reason, /landing could not run: the worktree has uncommitted changes/);
  assert.match(woken.at(-1)!, /landing could not run/);
});

test('the extra verify step of verify-then-land goes back to landing when it ends, passed or failed', async () => {
  const task = newTask({ name: 'bug', steps: [{ duty: 'implement', when: 'always', instructions: '' }] }, { kind: 'bug' });
  store.setStepState(stepOf(task.id, 1).id, 'done', 'done earlier');
  const verify = store.createStep({ task_id: task.id, ordinal: 2, duty: 'verify', instructions: 'Full verification before landing.' }).row;
  const landing = store.createLanding({ task_id: task.id, route: 'verify-then-land', state: 'checking', reason: 'verification before landing' });
  store.setMeta(`landing_step:${landing.id}`, verify.id);
  const start = await A.startStep(store, task.id, { reason: 'verification before landing', stepId: verify.id, deps });
  assert.equal(start.state, 'started');
  await endRun(lastRun(task.id).id, { status: 'done', summary: 'Customers test fails.', testsRun: { command: 'npm test', passed: false, summary: '1 failed' } });
  assert.deepEqual(landed, [{ task: task.id, auto: true }], 'landing decides, not on_fail');
  assert.equal(stepOf(task.id, 2).state, 'failed');
  assert.equal(placed.length, 1, 'no retry was placed');
});
