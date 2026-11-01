// jv task (tasks.ts): create (workflow, request id, preflight, worktree, task.md, workflow questions, step 1), the
// Jev refusal of J9 through the real router with no key, message, answer, stop, resume and override. A temporary
// JV_HOME and git repository; the router, spawn, wake and landing are fakes unless a test says otherwise.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { makeHome, writeSkill } from './fixtures/run-fixture.js';

const home = makeHome('jv-tasks-test-');
process.env.JV_HOME = home;
const T = await import('../src/tasks.js');
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const { runMessage } = await import('../src/launcher.js');
const { JvError, refused } = await import('../src/errors.js');
const { recordProviderAuth } = await import('../src/providers.js');
const { RUNTIME_ROOT, paths } = await import('../src/paths.js');
const { main } = await import('../src/cli.js');
type TaskDeps = import('../src/tasks.js').TaskDeps;
type PlaceStepInput = import('../src/route.js').PlaceStepInput;

writeSkill(home, 'verify', ['repo-write', 'shell', 'browser'], 'Verify.');
writeSkill(home, 'document', ['repo-write'], 'Document.');
writeSkill(home, 'answer', [], 'Answer.');
const packageSkills = join(RUNTIME_ROOT, '..', '..', '..');
for (const kind of ['feature', 'bug']) {
  mkdirSync(join(home, 'skills', `jevellan-workflow-${kind}`), { recursive: true });
  writeFileSync(
    join(home, 'skills', `jevellan-workflow-${kind}`, 'workflow.json'),
    readFileSync(join(packageSkills, `jevellan-workflow-${kind}`, 'workflow.json'), 'utf8'),
  );
}
mkdirSync(join(home, 'skills', 'jevellan-router'), { recursive: true });
writeFileSync(
  join(home, 'skills', 'jevellan-router', 'SKILL.md'),
  [
    '---',
    'name: jevellan-router',
    '---',
    '## model',
    'Choose the model.',
    '## model descriptions',
    'model-strong: Strong.',
    'model-small: Small.',
    'glm-big: Big.',
    'glm-mid: Mid.',
    'glm-tiny: Tiny.',
    '## effort',
    'Choose the effort.',
    '## effort guide',
    'low: Low.',
    'medium: Medium.',
    'high: High.',
    'max: Max.',
    '## questions',
    'needs_plan: Does it need a plan? true: Big. false: Small.',
    'needs_docs: Does it need docs? true: Visible. false: Internal.',
    '## rules',
    'Be sensible.',
    '',
  ].join('\n'),
);

const repo = join(home, 'repos', 'sandbox');
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# sandbox\n');
git('add', '.');
git('commit', '-q', '-m', 'first');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
const project = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;

function freshAuth(): void {
  for (const p of ['claude-main', 'glm']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });
}
freshAuth();

let placed: PlaceStepInput[] = [];
let spawned: string[] = [];
let woken: string[] = [];
let landed: Array<{ task: string; force?: boolean; auto?: boolean }> = [];
let probed: string[][] = [];
let asked = 0;

beforeEach(() => {
  placed = [];
  spawned = [];
  woken = [];
  landed = [];
  probed = [];
  asked = 0;
  freshAuth();
});

const deps: Partial<TaskDeps> = {
  placeStep: async (input) => {
    placed.push(input);
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
      state_json: '{}',
      questions_json: '{}',
      answers_json: '{}',
      chosen_json: JSON.stringify({ duty: step.duty, model: 'model-strong', effort: 'high' }),
      latency_ms: 1,
      usage_json: '{}',
    });
    return { runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', decisionId: decision.id, decision };
  },
  askWorkflowQuestions: async ({ store: s, taskId }) => {
    asked++;
    const steps = s.listSteps(taskId);
    const plan = steps.find((x) => x.duty === 'plan');
    const decision = s.createDecision({
      kind: 'workflow',
      project_id: project.id,
      task_id: taskId,
      skill_name: 'jevellan-router',
      skill_hash: 'hash',
      jev_model: 'jev-test',
      state_json: '{}',
      questions_json: '{}',
      answers_json: '{}',
      chosen_json: '{}',
      latency_ms: 1,
      usage_json: '{}',
    });
    return {
      decision,
      answers: { needs_plan: { value: false, probability: 0.1 }, needs_docs: { value: true, probability: 0.9 } },
      skip: plan ? [{ stepId: plan.id, ordinal: plan.ordinal, duty: 'plan', question: 'needs_plan', reason: 'Jev: not needed' }] : [],
    };
  },
  spawn: (_s, id) => {
    spawned.push(id);
  },
  notify: async (_s, input) => {
    woken.push(input.line);
  },
  land: async (s, taskId, options) => {
    landed.push({ task: taskId, ...options });
    return { route: 'land', state: 'landed', reason: 'fake', taskId };
  },
  probeLogins: async (names) => {
    probed.push(names);
    return names.map((n) => ({ name: `login:${n}`, status: 'FAIL', line: `FAIL login:${n}: the one-turn probe failed - fix: jv providers login ${n}` }));
  },
};

let k = 0;
const input = (extra: Partial<import('../src/tasks.js').CreateTaskInput> = {}) => ({
  project: 'sandbox',
  kind: 'feature',
  title: `Customers empty state ${++k}`,
  text: 'Show a message when there are no customers.\r\n',
  ...extra,
});

const lastRun = (taskId: string) => store.listSessions({ task_id: taskId }).at(-1)!;
function endRun(id: string, report: Parameters<typeof writeReport>[2] | null, nativeId = `native-${id}`) {
  store.setSessionState(id, 'running', 'fake', { native_session_id: nativeId });
  if (report) writeReport(store, id, report);
  store.setSessionState(id, 'done', 'turn ended');
}

test('create: workflow, auto request id, worktree, task.md, workflow questions and step 1', async () => {
  const first = input();
  const r = await T.createTask(store, first, deps);
  assert.equal(r.created, true);
  assert.equal(r.workflow.source, join(home, 'skills', 'jevellan-workflow-feature', 'workflow.json'));
  const t = r.task;
  assert.match(t.request_id, /^auto:[0-9a-f]{64}$/);
  const id6 = t.id.slice(1).toLowerCase();
  assert.equal(t.branch, `jv/customers-empty-state-${k}-${id6}`);
  assert.equal(t.worktree_path, join(home, 'worktrees', 'sandbox', `customers-empty-state-${k}-${id6}`));
  assert.ok(existsSync(join(t.worktree_path!, 'README.md')));
  assert.equal(t.base_commit, git('rev-parse', 'main'));
  assert.equal(t.task_text, 'Show a message when there are no customers.');
  assert.equal(readFileSync(paths.taskFile('sandbox', t.id), 'utf8'), 'Show a message when there are no customers.\n');
  assert.deepEqual(
    r.steps.map((s) => [s.duty, s.when_rule, s.state]),
    [
      ['plan', 'jev:needs_plan', 'skipped'],
      ['implement', 'always', 'running'],
      ['verify', 'always', 'pending'],
      ['document', 'jev:needs_docs', 'pending'],
    ],
  );
  assert.equal(r.steps[0]!.state_reason, 'Jev: not needed');
  assert.equal(r.steps[2]!.on_fail_json, '{"goto":"implement","maxLoops":2}');
  assert.equal(JSON.parse(t.workflow_json).source, r.workflow.source);
  assert.equal(r.start?.state, 'started');
  assert.equal(t.state, 'running');
  assert.equal(spawned.length, 1);
  assert.equal(lastRun(t.id).cwd, t.worktree_path);
  assert.deepEqual(probed, [], 'fresh login states are not probed');

  // The same command again is the same task, and nothing starts twice.
  const again = await T.createTask(store, { ...first }, deps);
  assert.equal(again.created, false);
  assert.equal(again.task.id, t.id);
  assert.equal(spawned.length, 1);
  assert.equal(placed.length, 1);
  assert.equal(asked, 1);
  await assert.rejects(
    T.createTask(store, { ...input(), requestId: t.request_id }, deps),
    (e: unknown) => e instanceof JvError && e.exitCode === 4,
  );
});

test('create: the preflight probes stale logins and refuses with the doctor line before creating anything', async () => {
  const old = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  for (const p of ['claude-main', 'glm']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });
  recordProviderAuth(store, 'claude-main', { auth: 'needs-login', observedAt: old });
  recordProviderAuth(store, 'glm', { auth: 'needs-login', observedAt: old });
  const before = store.listTasks().length;
  await assert.rejects(T.createTask(store, input({ kind: 'single', duty: 'investigate' }), deps), (e: unknown) => {
    assert.ok(e instanceof JvError && e.exitCode === 2);
    assert.match(e.message, /no logged-in provider can run this task/);
    assert.match(e.message, /FAIL login:claude-main: the one-turn probe failed - fix: jv providers login claude-main/);
    return true;
  });
  assert.deepEqual(probed.map((p) => [...p].sort()), [['claude-main', 'glm']]);
  assert.equal(store.listTasks().length, before, 'nothing was created');

  // A probe that records a ready login lets the task through.
  const okDeps = {
    ...deps,
    probeLogins: async (names: string[]) => {
      for (const n of names) recordProviderAuth(store, n, { auth: 'ready', observedAt: new Date().toISOString() });
      return names.map((n) => ({ name: `login:${n}`, status: 'OK', line: `OK login:${n}` }));
    },
  };
  recordProviderAuth(store, 'claude-main', { auth: 'needs-login', observedAt: old });
  recordProviderAuth(store, 'glm', { auth: 'needs-login', observedAt: old });
  const r = await T.createTask(store, input({ kind: 'single', duty: 'investigate' }), okDeps);
  assert.equal(r.start?.state, 'started');

  // A fresh needs-login is believed: no probe, refused.
  recordProviderAuth(store, 'claude-main', { auth: 'needs-login', observedAt: new Date().toISOString() });
  recordProviderAuth(store, 'glm', { auth: 'needs-login', observedAt: new Date().toISOString() });
  probed = [];
  await assert.rejects(T.createTask(store, input({ kind: 'single', duty: 'investigate' }), deps), /FAIL logins: no logged-in provider/);
  assert.deepEqual(probed, []);
});

test('J9: with no Jev key the task exists, stays queued with its step pending, and resume starts it later', async () => {
  const real: Partial<TaskDeps> = { spawn: deps.spawn!, notify: deps.notify!, land: deps.land!, probeLogins: deps.probeLogins! };
  let createdId = '';
  await assert.rejects(T.createTask(store, input(), real), (e: unknown) => {
    assert.ok(e instanceof JvError && e.exitCode === 2);
    assert.match(e.message, /no key configured/);
    createdId = (e.details as { taskId: string }).taskId;
    return true;
  });
  const task = store.requireTask(createdId);
  assert.equal(task.state, 'queued');
  assert.match(task.state_reason, /Jev: no key configured/);
  const first = store.listSteps(task.id)[0]!;
  assert.equal(first.state, 'pending');
  assert.equal(first.state_reason, 'Jev: no key configured');
  assert.ok(existsSync(task.worktree_path!), 'the worktree was created before Jev was asked');
  assert.match(woken[0]!, new RegExp(`^\\[jv\\] ${task.id} .* not placed \\(Jev: no key configured\\)\\. Run: jv task show ${task.id}$`));

  // A single task fails at the placement instead (no workflow question), the same way.
  await assert.rejects(T.createTask(store, input({ kind: 'single', duty: 'investigate' }), real), /Jev: no key configured/);

  // The key is back: resume asks the workflow questions, then places step 1 (now through the fakes).
  const r = await T.resumeTask(store, task.id, deps);
  assert.equal(r.how, 'placed');
  assert.equal(asked, 1);
  assert.equal(store.requireTask(task.id).state, 'running');
  assert.equal(store.requireStep(lastRun(task.id).step_id!).duty, 'implement');
});

test('answer: an option label without case resumes the same native session; the coordinator is named', async () => {
  const r = await T.createTask(store, input({ kind: 'single', duty: 'plan' }), deps);
  const run = lastRun(r.task.id);
  endRun(run.id, { status: 'needs-decision', summary: 'Two tables.', question: 'Which table?', options: [{ label: 'Use table A' }, { label: 'Use table B' }] });
  store.setTaskState(r.task.id, 'waiting-owner', 'needs-decision');
  const a = await T.answerTask(store, r.task.id, 'use TABLE b', { env: {}, deps });
  assert.equal(a.answer, 'Use table B');
  assert.equal(a.message?.direction, 'answer');
  const next = store.requireSession(a.session!);
  assert.equal(next.native_session_id, `native-${run.id}`);
  assert.equal(next.request_id, `answer:${a.message!.id}`);
  assert.equal(runMessage(store, next.id), undefined, 'the answer goes as the task message, prefixed by its direction');
  assert.equal(store.requireTask(r.task.id).state, 'running');

  const coord = store.createSession({ project_id: project.id, request_id: `coord-${k}`, kind: 'coordinator', runtime: 'claude-tmux', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: repo }).row;
  endRun(next.id, { status: 'blocked', summary: 'Need a key.' }, `native-${run.id}`);
  store.setTaskState(r.task.id, 'waiting-owner', 'blocked');
  const b = await T.answerTask(store, r.task.id, 'The key is in place now.', { env: { JV_SESSION: coord.id }, deps });
  assert.equal(b.message?.direction, 'coordinator');
  await assert.rejects(T.answerTask(store, r.task.id, 'again', { env: {}, deps }), /not waiting on an answer/);
});

test('answer on a landing ask: Land now lands with force, Leave it stops with discard', async () => {
  const a = await T.createTask(store, input({ kind: 'bug' }), deps);
  store.createLanding({ task_id: a.task.id, route: 'ask-owner', state: 'asked', reason: 'touches stored data' });
  store.setTaskState(a.task.id, 'waiting-owner', 'landing: ask the owner');
  const r = await T.answerTask(store, a.task.id, 'land now', { env: {}, deps });
  assert.equal(r.answer, 'Land now');
  assert.deepEqual(landed, [{ task: a.task.id, force: true }]);

  const b = await T.createTask(store, input({ kind: 'bug' }), deps);
  store.createLanding({ task_id: b.task.id, route: 'ask-owner', state: 'asked', reason: 'large' });
  store.setTaskState(b.task.id, 'waiting-owner', 'landing: ask the owner');
  const s = await T.answerTask(store, b.task.id, 'Leave it', { env: {}, deps });
  assert.equal(s.stopped?.task.state, 'stopped');
  // "Leave it" answers the question: no asked row stays open.
  assert.deepEqual(store.listLandings({ task_id: b.task.id }).map((l) => [l.state, l.reason]), [['failed', 'discarded by the owner (Leave it)']]);
  assert.match(store.requireTask(b.task.id).state_reason, /discarded by the owner; the worktree stays at/);
  await assert.rejects(T.answerTask(store, b.task.id, 'maybe', { env: {}, deps }), /not waiting on an answer/);
});

test('message: next turn while running, resumes a task waiting on the owner, the coordinator direction', async () => {
  const r = await T.createTask(store, input({ kind: 'single', duty: 'implement' }), deps);
  const run = lastRun(r.task.id);
  store.setSessionState(run.id, 'running', 'fake');
  const m1 = await T.messageTask(store, r.task.id, 'Also the phone width.', { env: {}, deps });
  assert.equal(m1.delivery, 'next-turn');
  assert.equal(m1.message.direction, 'owner');
  assert.equal(m1.message.delivered_at, null);
  endRun(run.id, { status: 'blocked', summary: 'Stuck.' });
  store.setTaskState(r.task.id, 'waiting-owner', 'blocked');
  const coord = store.createSession({ project_id: project.id, request_id: `coord-m-${k}`, kind: 'coordinator', runtime: 'claude-tmux', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: repo }).row;
  const m2 = await T.messageTask(store, r.task.id, 'Try the other port.', { env: { JV_SESSION: coord.id }, deps });
  assert.equal(m2.delivery, 'resumed');
  assert.equal(m2.message.direction, 'coordinator');
  assert.equal(store.requireSession(m2.session!).native_session_id, `native-${run.id}`);
});

test('stop keeps the task state unless --discard; resume continues a lost run natively (J7)', async () => {
  const r = await T.createTask(store, input({ kind: 'single', duty: 'implement' }), deps);
  const run = lastRun(r.task.id);
  const stopped = await T.stopTask(store, r.task.id, { deps });
  assert.deepEqual(stopped.stopped, [run.id]);
  assert.equal(stopped.task.state, 'running');
  assert.match(stopped.task.state_reason, /stopped by the owner; jv task resume/);
  assert.equal(store.requireSession(run.id).state, 'stopped');

  // A stopped run without a native id is placed again.
  const placedBefore = placed.length;
  const res1 = await T.resumeTask(store, r.task.id, deps);
  assert.equal(res1.how, 'placed');
  assert.equal(placed.length, placedBefore + 1);

  // A lost run with a native id resumes the same native session.
  const second = lastRun(r.task.id);
  store.setSessionState(second.id, 'running', 'fake', { native_session_id: 'native-lost', pid: 999999 });
  const res2 = await T.resumeTask(store, r.task.id, deps);
  assert.equal(store.requireSession(second.id).state, 'lost', 'marked lost at read time');
  assert.equal(res2.how, 'native');
  const third = store.requireSession(res2.session!);
  assert.equal(third.native_session_id, 'native-lost');
  assert.equal(third.request_id, `resume:${second.id}`);
  assert.equal(runMessage(store, third.id), 'Continue.');
  await assert.rejects(T.resumeTask(store, r.task.id, deps), (e: unknown) => e instanceof JvError && e.exitCode === 4);

  const verifying = store.createLanding({ task_id: r.task.id, route: 'verify-then-land', state: 'checking', reason: 'verifying before landing' });
  store.setMeta(`landing_step:${verifying.id}`, store.listSteps(r.task.id)[0]!.id);
  const stepId = store.listSteps(r.task.id)[0]!.id;
  assert.equal(store.requireStep(stepId).state, 'running');
  const d = await T.stopTask(store, r.task.id, { discard: true, deps });
  assert.equal(d.task.state, 'stopped');
  // The running step ends with the task (it read "running" under a stopped task before); no outcome is recorded.
  assert.deepEqual([store.requireStep(stepId).state, store.requireStep(stepId).state_reason], ['failed', 'discarded by the owner']);
  assert.ok(!store.listDecisions({ step_id: stepId }).some((x) => x.outcome_json !== null), 'a discard records no placement outcome');
  // The open verify-then-land landing is closed with the task.
  const closed = store.requireLanding(verifying.id);
  assert.deepEqual([closed.state, closed.reason], ['failed', 'discarded by the owner']);
  await assert.rejects(T.resumeTask(store, r.task.id, deps), /discarded/);
});

test('override --keep records only; --undo stops the run and restarts the step on the owner placement', async () => {
  const r = await T.createTask(store, input({ kind: 'single', duty: 'implement' }), deps);
  const run = lastRun(r.task.id);
  const keep = await T.overrideTask(store, r.task.id, { model: 'model-small', mode: 'keep' }, deps);
  assert.equal(keep.mode, 'keep');
  const decision = store.requireDecision(keep.overridden!);
  assert.equal(decision.override_mode, 'keep');
  assert.equal(store.listSessions({ task_id: r.task.id }).length, 1);
  assert.equal(store.requireSession(run.id).state, 'queued', 'the run continues');

  const undo = await T.overrideTask(store, r.task.id, { model: 'model-small', effort: 'low', mode: 'undo' }, deps);
  assert.equal(undo.stopped, run.id);
  assert.equal(store.requireSession(run.id).state, 'stopped');
  const next = store.requireSession(undo.session!);
  assert.equal(next.model, 'model-small');
  assert.equal(next.effort, 'low');
  const owner = store.requireDecision(undo.decision!);
  assert.equal(JSON.parse(owner.chosen_json).source, 'owner');
  assert.equal(owner.session_id, next.id);
  assert.equal(store.requireStep(next.step_id!).state, 'retrying');
  assert.equal(next.request_id, `run:${owner.id}`);
});

test('show and the CLI: jv task show --json, and jv task create exits 2 with the Jev message', async () => {
  const r = await T.createTask(store, input({ kind: 'single', duty: 'investigate' }), deps);
  const view = T.taskView(store, r.task);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0]!.runs.length, 1);
  assert.equal(view.steps[0]!.placements.length, 1);
  assert.match(T.formatTaskView(view), new RegExp(`Task ${r.task.id}`));

  const writes: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (c: string) => (writes.push(String(c)), true);
  (process.stderr as { write: unknown }).write = (c: string) => (writes.push(String(c)), true);
  let code: number;
  try {
    code = await main(['task', 'create', '--project', 'sandbox', '--kind', 'single', '--duty', 'investigate', '--title', 'Where is main', '--text', 'Find the entry point.', '--json']);
  } finally {
    (process.stdout as { write: unknown }).write = out;
    (process.stderr as { write: unknown }).write = err;
  }
  assert.equal(code, 2, writes.join(''));
  assert.match(writes.join(''), /no key configured/);
  const created = store.listTasks().find((t) => t.title === 'Where is main');
  assert.equal(created?.state, 'queued');
  void refused;
});

test('message: typed at once into a live claude-tmux window; refused when only landing is left', async () => {
  const r = await T.createTask(store, input({ kind: 'single', duty: 'implement' }), deps);
  const run = lastRun(r.task.id);
  store.setSessionState(run.id, 'running', 'fake');
  store.db.prepare("UPDATE sessions SET runtime = 'claude-tmux', tmux_target = ? WHERE id = ?").run(`jv-${run.id}`, run.id);
  const typed: string[] = [];
  const m = await T.messageTask(store, r.task.id, 'Use the blue button.', {
    env: {},
    deps: { ...deps, typeIntoLive: async (_s, session, text) => (typed.push(`${session.id}:${text}`), true) },
  });
  assert.equal(m.delivery, 'typed');
  assert.deepEqual(typed, [`${run.id}:From the owner: Use the blue button.`]);
  assert.equal(store.getMessage(m.message.id)!.session_id, run.id);
  assert.notEqual(store.getMessage(m.message.id)!.delivered_at, null);

  const b = await T.createTask(store, input({ kind: 'bug' }), deps);
  for (const s of store.listSteps(b.task.id)) store.setStepState(s.id, 'done', 'done');
  store.setSessionState(lastRun(b.task.id).id, 'done', 'turn ended');
  store.setTaskState(b.task.id, 'waiting-owner', 'landing: checks failed');
  await assert.rejects(T.answerTask(store, b.task.id, 'go on', { env: {}, deps }), /only landing is left: jv land/);
  await assert.rejects(T.messageTask(store, b.task.id, 'hello', { env: {}, deps }), /only landing is left/);
  assert.equal(store.listMessages({ task_id: b.task.id }).length, 0);
});
