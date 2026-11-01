// Landing tests: jv land against temporary git repositories, a temporary JV_HOME and a fake Jev (no network, no
// model calls). Covers the refusals, the landing state, the three routes, merge conflicts, failed checks, the
// fast-forward with the default branch checked out or not, a default branch that moves during the checks, force,
// the owner's landing rules and the Jev refusal.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-land-test-'));
process.env.JV_HOME = home;
// The landing git calls inherit the process environment: keep the owner's global git config (signing, hooks) out.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const L = await import('../src/land.js');
const E = await import('../src/evals.js');
const H = await import('../src/handoff.js');
const G = await import('../src/land-git.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
const { loadProviders } = await import('../src/providers.js');
const { openStore } = await import('../src/store.js');
type Store = import('../src/store.js').Store;
type JevQuestions = import('../src/jev/contract.js').JevQuestions;
type WakeInput = import('../src/wake.js').WakeInput;

after(() => rmSync(home, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'jv test',
  GIT_AUTHOR_EMAIL: 'jv-test@example.invalid',
  GIT_COMMITTER_NAME: 'jv test',
  GIT_COMMITTER_EMAIL: 'jv-test@example.invalid',
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

// ---- JV_HOME fixtures -------------------------------------------------------------------------------------------

const JEV_KEY = 'jev-land-test-key-0123456789';
const policyFile = join(home, 'skills', 'jevellan-landing', 'SKILL.md');
const packagePolicy = readFileSync(join(RUNTIME_ROOT, '..', '..', '..', 'jevellan-landing', 'SKILL.md'), 'utf8');

mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
writeFileSync(join(home, 'secrets', 'jev.key'), `${JEV_KEY}\n`, { mode: 0o600 });
chmodSync(join(home, 'secrets', 'jev.key'), 0o600);
mkdirSync(join(home, 'homes', 'claude-main'), { recursive: true });
writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({
    jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-latest', timeoutMs: 4000 },
    providers: [
      { name: 'claude-main', kind: 'claude-subscription', home: '~/.jv/homes/claude-main', models: [{ id: 'claude-opus-5-5', label: 'Opus', efforts: ['high'] }] },
    ],
  }),
);
mkdirSync(join(home, 'skills', 'jevellan-landing'), { recursive: true });
writeFileSync(policyFile, packagePolicy);

// ---- fake Jev -----------------------------------------------------------------------------------------------------

interface Seen {
  auth: string | null;
  state: Record<string, unknown>;
  questions: JevQuestions;
}
let seen: Seen[] = [];

function jevFetch(route: string, options: { status?: number } = {}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: string; questions: JevQuestions };
    seen.push({ auth: new Headers(init?.headers).get('authorization'), state: JSON.parse(body.state), questions: body.questions });
    if (options.status) return new Response('nope', { status: options.status });
    const q = body.questions.landing_route!;
    assert.equal(q.type, 'choice');
    const keys = Object.keys(q.criteria as Record<string, string>);
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === route ? 0.8 : 0.1]));
    return new Response(
      JSON.stringify({ model: 'jev-test-1', answers: { landing_route: { type: 'choice', choice: route, probabilities, confidence: 0.8 } }, usage: { input_tokens: 50, output_tokens: 3 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

// ---- repositories and tasks ------------------------------------------------------------------------------------

let store: Store;
let n = 0;
let wakes: WakeInput[] = [];
const notify = async (_s: Store, input: WakeInput) => {
  wakes.push(input);
};

interface Fixture {
  repo: string;
  worktree: string;
  branch: string;
  projectName: string;
  projectId: string;
  taskId: string;
  base: string;
}

function writeProjectFiles(name: string, projectJson: Record<string, unknown>, landing: Record<string, unknown> = { riskyPaths: ['db/'], checks: [] }): void {
  mkdirSync(join(home, 'projects', name), { recursive: true });
  writeFileSync(join(home, 'projects', name, 'project.json'), JSON.stringify(projectJson));
  writeFileSync(join(home, 'projects', name, 'landing.json'), JSON.stringify(landing));
}

function addReport(taskId: string, stepId: string, status: 'done' | 'blocked', summary: string, tests?: { command: string; passed: boolean; summary: string }) {
  const task = store.requireTask(taskId);
  const session = store.createSession({
    project_id: task.project_id,
    task_id: taskId,
    step_id: stepId,
    request_id: `run-${++n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'claude-opus-5-5',
    effort: 'high',
    cwd: task.worktree_path ?? home,
  }).row;
  store.createReport({ session_id: session.id, step_id: stepId, task_id: taskId, status, summary, tests_json: tests ? JSON.stringify(tests) : null });
  return session;
}

/**
 * A repository with one commit on main, a registered project, and a feature task whose worktree has one commit
 * (src/feature.js) and whose two steps are done (verify with passing tests).
 */
function makeFixture(options: { projectJson?: Record<string, unknown>; landing?: Record<string, unknown>; stepsDone?: boolean } = {}): Fixture {
  const id = ++n;
  const projectName = `proj${id}`;
  const repo = join(home, 'repos', projectName);
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  writeFileSync(join(repo, 'src', 'shared.js'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeProjectFiles(projectName, options.projectJson ?? { testCommand: 'true', pushAfterLanding: false }, options.landing);
  const project = store.createProject({ name: projectName, path: repo, default_branch: 'main' }).row;
  const task = store.createTask({
    project_id: project.id,
    request_id: `task-${id}`,
    kind: 'feature',
    title: 'Customers empty state',
    task_text: 'Show a message on the customers page when there are no customers.',
    workflow_json: '{}',
  }).row;
  const branch = `jv/customers-empty-${task.id.slice(1).toLowerCase()}`;
  const worktree = join(home, 'worktrees', projectName, branch.replace(/^jv\//, ''));
  mkdirSync(join(home, 'worktrees', projectName), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
  writeFileSync(join(worktree, 'src', 'feature.js'), 'export const empty = "No customers yet";\nexport const b = 2;\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'Add the empty state');
  store.updateTask(task.id, { branch, worktree_path: worktree, base_commit: base });
  const implement = store.createStep({ task_id: task.id, ordinal: 1, duty: 'implement', instructions: 'Implement.' }).row;
  const verify = store.createStep({ task_id: task.id, ordinal: 2, duty: 'verify', instructions: 'Verify.' }).row;
  if (options.stepsDone !== false) {
    addReport(task.id, implement.id, 'done', 'Added the empty state message.');
    store.setStepState(implement.id, 'done', 'report done');
    addReport(task.id, verify.id, 'done', 'Tests pass.', { command: 'npm test', passed: true, summary: '12 passed' });
    store.setStepState(verify.id, 'done', 'report done');
  }
  store.setTaskState(task.id, 'landing', 'last step done');
  return { repo, worktree, branch, projectName, projectId: project.id, taskId: task.id, base };
}

function opts(route: string, extra: Partial<import('../src/land.js').LandOptions> = {}): import('../src/land.js').LandOptions {
  return { providers: loadProviders(), fetch: jevFetch(route), notify, policyFile, lockWaitMs: 2000, ...extra };
}

function refusedWith(includes: string) {
  return (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message.includes(includes);
}

beforeEach(() => {
  store?.close();
  store = openStore({ file: join(home, `store-${++n}.sqlite`) });
  seen = [];
  wakes = [];
});

// ---- tests ---------------------------------------------------------------------------------------------------------

describe('refusals', () => {
  test('a step that is not done or skipped refuses with exit 2 and changes nothing', async () => {
    const f = makeFixture({ stepsDone: false });
    await assert.rejects(L.landTask(store, f.taskId, opts('land')), refusedWith('not done or skipped: 1 implement (pending), 2 verify (pending)'));
    assert.equal(store.requireTask(f.taskId).state, 'landing');
    assert.equal(store.listLandings({ task_id: f.taskId }).length, 0);
    assert.equal(seen.length, 0);
  });

  test('uncommitted changes refuse, naming the files; .jv-evidence/ and plan.md do not count', async () => {
    const f = makeFixture();
    mkdirSync(join(f.worktree, '.jv-evidence'), { recursive: true });
    writeFileSync(join(f.worktree, '.jv-evidence', 'shot.png'), 'png');
    writeFileSync(join(f.worktree, 'plan.md'), '# plan\n');
    writeFileSync(join(f.worktree, 'src', 'feature.js'), 'changed\n');
    writeFileSync(join(f.worktree, 'notes.txt'), 'scratch\n');
    await assert.rejects(L.landTask(store, f.taskId, opts('land')), (e: unknown) => {
      assert.ok(e instanceof JvError && e.exitCode === 2);
      assert.match(e.message, /uncommitted changes: (src\/feature\.js, notes\.txt|notes\.txt, src\/feature\.js)\./);
      assert.doesNotMatch(e.message, /jv-evidence|plan\.md/);
      return true;
    });
    // With only the excluded files left, the worktree counts as clean.
    git(f.worktree, 'checkout', '--', 'src/feature.js');
    unlinkSync(join(f.worktree, 'notes.txt'));
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'landed');
  });

  test('auto: a refusal puts the task in waiting-owner and wakes the coordinator instead of throwing', async () => {
    const f = makeFixture();
    writeFileSync(join(f.worktree, 'left-over.txt'), 'x\n');
    const r = await L.landTask(store, f.taskId, opts('land', { auto: true }));
    assert.equal(r.state, 'refused');
    const task = store.requireTask(f.taskId);
    assert.equal(task.state, 'waiting-owner');
    assert.match(task.state_reason, /left-over\.txt/);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!.line, new RegExp(`^\\[jv\\] ${f.taskId} \\(Customers empty state\\) landing: refused, .*left-over\\.txt.*\\. Run: jv task show ${f.taskId}$`));
  });

  test('an unknown task is exit 3', async () => {
    await assert.rejects(L.landTask(store, 'TZZZZZZ', opts('land')), (e: unknown) => e instanceof JvError && e.exitCode === 3);
  });
});

describe('the land route', () => {
  test('Jev routes land: decision row, state, checks, fast-forward of the checked-out default branch, task done', async () => {
    const f = makeFixture({ landing: { riskyPaths: ['db/'], checks: [{ name: 'unit', command: 'echo checking; test -f src/feature.js' }] } });
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.route, 'land');
    assert.equal(r.state, 'landed');
    const head = git(f.worktree, 'rev-parse', 'HEAD');
    assert.equal(r.commit, head);
    assert.equal(git(f.repo, 'rev-parse', 'main'), head);
    assert.ok(existsSync(join(f.repo, 'src', 'feature.js')), 'the checkout working tree was fast-forwarded');
    assert.equal(git(f.repo, 'status', '--porcelain'), '');

    const task = store.requireTask(f.taskId);
    assert.equal(task.state, 'done');
    assert.equal(task.landed_commit, head);
    const [landing] = store.listLandings({ task_id: f.taskId });
    assert.equal(landing!.state, 'landed');
    assert.equal(landing!.commit_sha, head);
    const checks = JSON.parse(landing!.checks_json) as Array<{ name: string; passed: boolean; tail: string }>;
    assert.deepEqual(checks.map((c) => [c.name, c.passed]), [['unit', true]]);
    assert.match(checks[0]!.tail, /checking/);

    // One Jev call with the key, the landing question and the criteria of the policy's ## routes.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.auth, `Bearer ${JEV_KEY}`);
    const q = seen[0]!.questions.landing_route!;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria as Record<string, string>), ['land', 'verify-then-land', 'ask-owner']);
    assert.match(q.instructions, /^Choose how this checked task reaches/);
    const state = seen[0]!.state as Record<string, any>;
    assert.equal(state.schema, 'landing-route-state-v1');
    assert.equal(state.title, 'Customers empty state');
    assert.equal(state.task.kind, 'feature');
    assert.deepEqual(state.files, [{ path: 'src/feature.js', bytes: readFileSync(join(f.worktree, 'src', 'feature.js')).length, additions: 2, deletions: 0, risky: false }]);
    assert.deepEqual(state.riskyAreas, ['db/']);
    assert.deepEqual(state.checks.map((c: any) => [c.duty, c.command, c.passed]), [['verify', 'npm test', true]]);
    assert.deepEqual(state.summaries.map((s: any) => s.duty), ['implement', 'verify']);
    assert.match(state.rules, /Risky areas/);

    const decision = store.requireDecision(landing!.decision_id!);
    assert.equal(decision.kind, 'landing');
    assert.equal(decision.skill_name, 'jevellan-landing');
    assert.match(decision.skill_hash, /^[0-9a-f]{64}$/);
    assert.equal(decision.jev_model, 'jev-test-1');
    assert.equal(JSON.parse(decision.chosen_json).route, 'land');
    assert.equal(JSON.parse(decision.chosen_json).probabilities.land, 0.8);
    assert.equal(landing!.reason.startsWith('landed '), true);

    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!.line, new RegExp(`^\\[jv\\] ${f.taskId} \\(Customers empty state\\) landing: landed [0-9a-f]{12} on main\\. Run: jv task show ${f.taskId}$`));

    // Landing again returns the landed result and asks nothing.
    const again = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(again.state, 'landed');
    assert.equal(seen.length, 1);
  });

  test('another branch checked out in the checkout: only the ref moves, the working tree is left alone', async () => {
    const f = makeFixture();
    git(f.repo, 'checkout', '-q', '-b', 'owner-work');
    writeFileSync(join(f.repo, 'README.md'), '# app, edited by the owner\n');
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'landed');
    assert.equal(git(f.repo, 'rev-parse', 'main'), git(f.worktree, 'rev-parse', 'HEAD'));
    assert.equal(git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'owner-work');
    assert.equal(existsSync(join(f.repo, 'src', 'feature.js')), false);
    assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), '# app, edited by the owner\n');
    assert.match(store.listLandings({ task_id: f.taskId })[0]!.reason, /push \./);
  });

  test('the default branch moved since the task started: it is merged into the task branch first', async () => {
    const f = makeFixture();
    writeFileSync(join(f.repo, 'CHANGELOG.md'), 'owner change\n');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'owner change on main');
    const ownerCommit = git(f.repo, 'rev-parse', 'HEAD');
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'landed');
    git(f.repo, 'merge-base', '--is-ancestor', ownerCommit, 'main');
    assert.match(git(f.repo, 'log', '-1', '--format=%s', 'main'), /^Merge main into jv\//);
    assert.ok(existsSync(join(f.repo, 'CHANGELOG.md')) && existsSync(join(f.repo, 'src', 'feature.js')));
  });

  test('a task branch with no commits of its own catches up without a merge commit', async () => {
    const f = makeFixture();
    git(f.worktree, 'reset', '-q', '--hard', f.base);
    writeFileSync(join(f.repo, 'CHANGELOG.md'), 'owner change\n');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'owner change on main');
    const ownerHead = git(f.repo, 'rev-parse', 'HEAD');
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'landed');
    assert.equal(r.commit, ownerHead);
    assert.equal(git(f.repo, 'rev-parse', 'main'), ownerHead, 'no merge commit landed');
    assert.deepEqual((seen[0]!.state as { files: unknown[] }).files, []);
  });

  test('a default branch that moves during the checks is merged again and the checks run again', async () => {
    const f = makeFixture();
    let calls = 0;
    const runCheck: typeof L.runCheck = async (cwd, check, round) => {
      calls++;
      if (calls === 1) {
        // Another landing reached main while this one was checking.
        git(f.repo, 'checkout', '-q', '-b', 'side');
        writeFileSync(join(f.repo, 'OTHER.md'), 'other task\n');
        git(f.repo, 'add', '-A');
        git(f.repo, 'commit', '-q', '-m', 'other task');
        git(f.repo, 'checkout', '-q', 'main');
        git(f.repo, 'merge', '-q', '--ff-only', 'side');
      }
      return L.runCheck(cwd, check, round);
    };
    const r = await L.landTask(store, f.taskId, opts('land', { runCheck }));
    assert.equal(r.state, 'landed');
    assert.equal(calls, 2);
    assert.deepEqual(r.checks!.map((c) => c.round), [1, 2]);
    assert.ok(existsSync(join(f.repo, 'OTHER.md')) && existsSync(join(f.repo, 'src', 'feature.js')));
  });

  test('a failed check: landing failed, task waiting-owner, the coordinator gets the output tail', async () => {
    const f = makeFixture({ projectJson: { testCommand: 'echo "1 failing: customers page renders nothing"; exit 3' } });
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'failed');
    assert.equal(store.requireTask(f.taskId).state, 'waiting-owner');
    assert.match(store.requireTask(f.taskId).state_reason, /check test failed \(exit 3\)/);
    const [landing] = store.listLandings({ task_id: f.taskId });
    assert.equal(landing!.state, 'failed');
    const checks = JSON.parse(landing!.checks_json) as Array<{ passed: boolean; exitCode: number; tail: string }>;
    assert.equal(checks[0]!.passed, false);
    assert.equal(checks[0]!.exitCode, 3);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base, 'main did not move');
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!.line, /landing: check test failed \(exit 3\): 1 failing: customers page renders nothing\. Run: jv task show/);
  });

  test('a check that runs past its timeout is killed and fails', async () => {
    const started = Date.now();
    const r = await L.runCheck(home, { name: 'slow', command: 'echo started; sleep 30', timeoutMs: 300 }, 1);
    assert.equal(r.passed, false);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 10_000);
    assert.match(r.tail, /started/);
    assert.match(r.tail, /timed out after 300 ms/);
  });

  test('checks see no provider login or Jev key in their environment', () => {
    const env = L.checkEnvironment({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value', ANTHROPIC_AUTH_TOKEN: 'x', JV_SESSION: 'R1' });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.JV_SESSION, undefined);
    assert.equal(env.PATH, '/usr/bin');
    assert.ok(env.HOME);
  });

  test('a merge conflict is aborted and routed to ask-owner with reason merge conflict', async () => {
    const f = makeFixture();
    writeFileSync(join(f.worktree, 'src', 'shared.js'), 'export const a = "task";\n');
    git(f.worktree, 'commit', '-q', '-am', 'task edits shared');
    writeFileSync(join(f.repo, 'src', 'shared.js'), 'export const a = "owner";\n');
    git(f.repo, 'commit', '-q', '-am', 'owner edits shared');
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'asked');
    assert.equal(r.route, 'ask-owner');
    const [landing] = store.listLandings({ task_id: f.taskId });
    assert.equal(landing!.route, 'ask-owner');
    assert.equal(landing!.state, 'asked');
    assert.match(landing!.reason, /^merge conflict: .*src\/shared\.js/);
    assert.equal(git(f.worktree, 'status', '--porcelain'), '', 'the merge was aborted');
    assert.equal(store.requireTask(f.taskId).state, 'waiting-owner');
    assert.match(wakes[0]!.line, /ask-owner, merge conflict: .*Options: Land now \(jv land T\w+ --force\) or Leave it \(jv task stop T\w+ --discard\)/);
  });

  test('pushAfterLanding pushes the default branch to origin', async () => {
    const f = makeFixture({ projectJson: { testCommand: null, pushAfterLanding: true } });
    const remote = join(home, 'remotes', `${f.projectName}.git`);
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(f.repo, 'remote', 'add', 'origin', remote);
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.state, 'landed');
    assert.match(r.reason, /no checks configured; pushed main to origin/);
    assert.equal(git(remote, 'rev-parse', 'main'), r.commit);
  });
});

describe('a child task', () => {
  /** A parent task on its own branch with one commit, and a child task branched from the parent's branch with one more. */
  function makeChild(f: Fixture) {
    const parent = store.requireTask(f.taskId);
    store.setTaskState(parent.id, 'running', 'step 1 (implement): running');
    const parentHead = git(f.worktree, 'rev-parse', 'HEAD');
    const child = store.createTask({
      project_id: f.projectId,
      parent_task_id: parent.id,
      request_id: `child-${++n}`,
      kind: 'feature',
      title: 'Customers empty state copy',
      task_text: 'Word the empty state message.',
      workflow_json: '{}',
    }).row;
    const branch = `jv/empty-copy-${child.id.slice(1).toLowerCase()}`;
    const worktree = join(home, 'worktrees', f.projectName, branch.replace(/^jv\//, ''));
    git(f.repo, 'worktree', 'add', '-q', '-b', branch, worktree, f.branch);
    writeFileSync(join(worktree, 'src', 'copy.js'), 'export const copy = "Nothing here yet";\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'Word the empty state');
    store.updateTask(child.id, { branch, worktree_path: worktree, base_commit: parentHead });
    const step = store.createStep({ task_id: child.id, ordinal: 1, duty: 'implement', instructions: 'Implement.' }).row;
    addReport(child.id, step.id, 'done', 'Worded the message.');
    store.setStepState(step.id, 'done', 'report done');
    store.setTaskState(child.id, 'landing', 'last step done');
    return { parent, parentHead, childId: child.id, branch, worktree };
  }

  test('lands into the parent branch in the parent worktree; the default branch does not move and nothing is pushed', async () => {
    const f = makeFixture({ projectJson: { testCommand: 'test -f src/copy.js && test -f src/feature.js', pushAfterLanding: true } });
    const c = makeChild(f);
    const r = await L.landTask(store, c.childId, opts('land', { force: true }));
    assert.equal(r.state, 'landed');
    const childHead = git(c.worktree, 'rev-parse', 'HEAD');
    assert.equal(r.commit, childHead);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base, 'main is unchanged');
    assert.equal(git(f.repo, 'rev-parse', f.branch), childHead, "the parent's branch has the child's commit");
    assert.ok(existsSync(join(f.worktree, 'src', 'copy.js')), "the parent's worktree was fast-forwarded");
    assert.equal(git(f.worktree, 'status', '--porcelain'), '');
    assert.match(r.reason, new RegExp(`on ${f.branch} \\(the branch of the parent ${c.parent.id}\\) \\(merge --ff-only\\)`));
    assert.doesNotMatch(r.reason, /push/);
    assert.equal(store.requireTask(c.childId).state, 'done');
    assert.equal(store.requireTask(c.parent.id).landed_commit, null, 'the parent has not landed');
    assert.match(wakes.at(-1)!.line, new RegExp(`landing: landed [0-9a-f]{12} on ${f.branch} \\(the branch of the parent`));

    // The parent then lands into main with its own landing, carrying the child's commit.
    store.setTaskState(c.parent.id, 'landing', 'last step done');
    const p = await L.landTask(store, c.parent.id, opts('land', { force: true }));
    assert.equal(p.state, 'landed');
    assert.equal(git(f.repo, 'rev-parse', 'main'), childHead);
  });

  test("a parent branch that moved is merged into the child first; dirty touched files in the parent worktree refuse", async () => {
    const f = makeFixture();
    const c = makeChild(f);
    writeFileSync(join(f.worktree, 'src', 'parent-more.js'), 'export const more = 1;\n');
    git(f.worktree, 'add', '-A');
    git(f.worktree, 'commit', '-q', '-m', 'More parent work');
    const parentHead = git(f.worktree, 'rev-parse', 'HEAD');
    // The parent's worker has an uncommitted edit of a file the child changes.
    writeFileSync(join(f.worktree, 'src', 'copy.js'), 'export const copy = "parent edit";\n');
    const r = await L.landTask(store, c.childId, opts('land', { force: true }));
    assert.equal(r.state, 'failed');
    assert.match(r.reason, /uncommitted changes in files the task changes: src\/copy\.js/);
    assert.equal(git(f.repo, 'rev-parse', f.branch), parentHead, "the parent's branch did not move");
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base);
    assert.equal(await G.isAncestor(c.worktree, parentHead, 'HEAD'), true, "the parent's new commit was merged into the child");
    assert.equal(store.requireTask(c.childId).state, 'waiting-owner');
  });

  test('a parent that already landed or was discarded refuses the child landing', async () => {
    const f = makeFixture();
    const c = makeChild(f);
    store.setTaskState(c.parent.id, 'stopped', 'discarded by the owner');
    await assert.rejects(L.landTask(store, c.childId, opts('land', { force: true })), refusedWith(`the parent ${c.parent.id} was discarded`));
    store.setTaskState(c.parent.id, 'done', 'landed', { landed_commit: f.base });
    await assert.rejects(L.landTask(store, c.childId, opts('land', { force: true })), refusedWith(`the parent ${c.parent.id} already landed`));
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base);
    assert.equal(store.listLandings({ task_id: c.childId }).length, 0);
  });
});

describe('routes other than land', () => {
  test('Jev routes ask-owner: landing asked, task waiting-owner, both options in the wake line', async () => {
    const f = makeFixture();
    const r = await L.landTask(store, f.taskId, opts('ask-owner'));
    assert.equal(r.route, 'ask-owner');
    assert.equal(r.state, 'asked');
    assert.match(r.reason, /^Touches a risky area/);
    assert.equal(store.listLandings({ task_id: f.taskId })[0]!.state, 'asked');
    assert.equal(store.requireTask(f.taskId).state, 'waiting-owner');
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base);
    assert.match(wakes[0]!.line, /landing: ask-owner, Touches a risky area.*Options: Land now .* or Leave it /);

    // The owner answers "Land now": force lands without asking Jev.
    seen = [];
    const forced = await L.landTask(store, f.taskId, opts('ask-owner', { force: true }));
    assert.equal(forced.state, 'landed');
    assert.equal(seen.length, 0);
    const landings = store.listLandings({ task_id: f.taskId });
    // "Land now" answered the question: the asked row is closed, the new row is the landing.
    assert.deepEqual(landings.map((l) => [l.route, l.state]), [['ask-owner', 'failed'], ['land', 'landed']]);
    assert.equal(landings[0]!.reason, L.ANSWERED_LAND_NOW);
    assert.equal(landings[1]!.decision_id, null);
    assert.equal(store.requireTask(f.taskId).state, 'done');
    // An answered ask has no outcome of its own: jv evals landing skips it.
    const decision = store.requireDecision(landings[0]!.decision_id!);
    assert.equal(E.decisionVerdict(store, decision, JSON.parse(decision.state_json)), 'stopped');
  });

  test('ask-owner, then Land now whose check fails: no stale landing question in the handoff or for jv task answer', async () => {
    const f = makeFixture({ landing: { riskyPaths: ['db/'], checks: [{ name: 'unit', command: 'echo broken; exit 1' }] } });
    assert.equal((await L.landTask(store, f.taskId, opts('ask-owner'))).state, 'asked');
    const question = () => H.buildHandoff(store, f.projectId).questions.filter((q) => q.taskId === f.taskId);
    assert.deepEqual(question().map((q) => q.kind), ['landing']);

    // A refused "Land now" (uncommitted changes) leaves the question open.
    writeFileSync(join(f.worktree, 'dirty.txt'), 'x');
    await assert.rejects(L.landTask(store, f.taskId, opts('land', { force: true })), refusedWith('dirty.txt'));
    assert.equal(L.askedLanding(store, f.taskId)?.state, 'asked');
    unlinkSync(join(f.worktree, 'dirty.txt'));

    const forced = await L.landTask(store, f.taskId, opts('land', { force: true }));
    assert.equal(forced.state, 'failed');
    assert.deepEqual(store.listLandings({ task_id: f.taskId }).map((l) => [l.route, l.state]), [['ask-owner', 'failed'], ['land', 'failed']]);
    assert.equal(store.requireTask(f.taskId).state, 'waiting-owner');
    assert.equal(L.askedLanding(store, f.taskId), undefined);
    assert.deepEqual(question(), [], 'the handoff offers no answered landing question');
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base);
  });

  test('force: no Jev call, route land, reason forced by the owner; still refuses uncommitted changes', async () => {
    const f = makeFixture();
    writeFileSync(join(f.worktree, 'dirty.txt'), 'x');
    await assert.rejects(L.landTask(store, f.taskId, opts('land', { force: true })), refusedWith('dirty.txt'));
    unlinkSync(join(f.worktree, 'dirty.txt'));
    const released: string[] = [];
    const r = await L.landTask(store, f.taskId, { force: true, notify, lockWaitMs: 2000, releaseDependents: async (_s, id) => released.push(id) });
    assert.equal(r.state, 'landed');
    // A landing outside the auto path starts the tasks waiting --after this one.
    assert.deepEqual(released, [f.taskId]);
    assert.equal(seen.length, 0);
    assert.equal(store.listLandings({ task_id: f.taskId })[0]!.route, 'land');
    assert.equal(store.requireTask(f.taskId).state_reason.startsWith('landed '), true);
    assert.equal(store.listDecisions({ task_id: f.taskId }).length, 0);
  });

  test('verify-then-land appends one verify step, starts it, and lands when it passes without asking Jev again', async () => {
    const f = makeFixture();
    const started: Array<{ taskId: string; reason: string }> = [];
    const startStep = async (_s: Store, taskId: string, o: { reason: string }) => {
      started.push({ taskId, reason: o.reason });
      return undefined;
    };
    const r = await L.landTask(store, f.taskId, opts('verify-then-land', { startStep }));
    assert.equal(r.route, 'verify-then-land');
    assert.equal(r.state, 'checking');
    assert.equal(started.length, 1);
    const steps = store.listSteps(f.taskId);
    assert.equal(steps.length, 3);
    const extra = steps[2]!;
    assert.equal(extra.id, r.stepId);
    assert.equal(extra.duty, 'verify');
    assert.equal(extra.instructions, L.VERIFY_BEFORE_LANDING);
    assert.equal(extra.state, 'pending');
    assert.ok(L.isLandingVerifyStep(store, extra.id));
    assert.equal(L.isLandingVerifyStep(store, steps[1]!.id), false);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base);

    // While it runs, a manual jv land refuses and changes nothing.
    store.setStepState(extra.id, 'running', 'placed');
    await assert.rejects(L.landTask(store, f.taskId, opts('land')), refusedWith('verification before landing'));

    // The verify step passes; the launcher calls landTask again.
    addReport(f.taskId, extra.id, 'done', 'Everything passes.', { command: 'npm test && npm run test:browser', passed: true, summary: 'all passed' });
    store.setStepState(extra.id, 'done', 'report done');
    store.setTaskState(f.taskId, 'landing', 'last step done');
    const done = await L.landTask(store, f.taskId, opts('ask-owner', { auto: true, startStep }));
    assert.equal(done.state, 'landed');
    assert.equal(done.route, 'verify-then-land');
    assert.equal(seen.length, 1, 'Jev was asked once');
    assert.equal(store.listLandings({ task_id: f.taskId }).length, 1);
    assert.equal(store.requireTask(f.taskId).state, 'done');
    assert.equal(git(f.repo, 'rev-parse', 'main'), store.requireTask(f.taskId).landed_commit);
  });

  test('verify-then-land whose verification fails: landing failed, task waiting-owner with the failure', async () => {
    const f = makeFixture();
    const r = await L.landTask(store, f.taskId, opts('verify-then-land', { startStep: async () => undefined }));
    const extra = store.requireStep(r.stepId!);
    const run = addReport(f.taskId, extra.id, 'done', 'The browser journey fails.', { command: 'npm run test:browser', passed: false, summary: 'customers journey: 1 failed' });
    store.setStepState(extra.id, 'done', 'report done');
    const after = await L.landTask(store, f.taskId, opts('land', { auto: true }));
    assert.equal(after.state, 'failed');
    assert.equal(store.listLandings({ task_id: f.taskId })[0]!.state, 'failed');
    const task = store.requireTask(f.taskId);
    assert.equal(task.state, 'waiting-owner');
    assert.match(task.state_reason, /verification before landing failed: customers journey: 1 failed/);
    assert.match(wakes[wakes.length - 1]!.line, new RegExp(`step verify: verification before landing failed: customers journey: 1 failed\\. Run: jv report ${run.id}$`));
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.base);

    // The owner says "Land now": force lands past the failed landing verification.
    const forced = await L.landTask(store, f.taskId, opts('land', { force: true }));
    assert.equal(forced.state, 'landed');
  });

  test("the project's rules.json landing route override applies after Jev and is recorded", async () => {
    const f = makeFixture();
    writeFileSync(
      join(home, 'projects', f.projectName, 'rules.json'),
      JSON.stringify({ rules: [{ id: 'R1', when: { keywords: ['customers'] }, set: { landingRoute: 'ask-owner' }, note: 'the owner checks customer screens' }] }),
    );
    const r = await L.landTask(store, f.taskId, opts('land'));
    assert.equal(r.route, 'ask-owner');
    assert.equal(r.state, 'asked');
    assert.match(r.reason, /R1 changed the landing route from land to ask-owner \(the owner checks customer screens\)/);
    // The reason names Jev's route and its criterion, not the criterion of the route the rule imposed.
    assert.match(r.reason, /^Jev chose land \(/);
    const chosen = JSON.parse(store.requireDecision(store.listLandings({ task_id: f.taskId })[0]!.decision_id!).chosen_json);
    assert.equal(chosen.jevRoute, 'land');
    assert.equal(chosen.route, 'ask-owner');
    assert.deepEqual(chosen.rulesApplied, ['R1']);
  });

  test('Jev without a key: exit 2 with the Jev message, task waiting-owner, the coordinator told, no landing row', async () => {
    const f = makeFixture();
    const keyFile = join(home, 'secrets', 'jev.key');
    unlinkSync(keyFile);
    try {
      await assert.rejects(L.landTask(store, f.taskId, opts('land')), refusedWith('Jev: no key configured'));
    } finally {
      writeFileSync(keyFile, `${JEV_KEY}\n`, { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    }
    assert.equal(store.listLandings({ task_id: f.taskId }).length, 0);
    assert.equal(store.listDecisions({ task_id: f.taskId }).length, 0);
    const task = store.requireTask(f.taskId);
    assert.equal(task.state, 'waiting-owner');
    assert.match(task.state_reason, /Jev: no key configured/);
    assert.match(wakes[0]!.line, /landing: Jev refused \(no key configured\)\. Run: jv task show/);
  });
});

describe('the landing state', () => {
  test('risky files are flagged, corrections list earlier failures, the state stays under the cap', () => {
    // An earlier verify run failed before the passing one.
    const g = makeFixture({ stepsDone: false });
    const [impl, ver] = store.listSteps(g.taskId);
    addReport(g.taskId, impl!.id, 'done', 'Implemented.');
    store.setStepState(impl!.id, 'done', 'done');
    addReport(g.taskId, ver!.id, 'done', 'Fails.', { command: 'npm test', passed: false, summary: '2 failed in customers.test.js' });
    addReport(g.taskId, ver!.id, 'done', 'Passes now.', { command: 'npm test', passed: true, summary: 'all passed' });
    store.setStepState(ver!.id, 'done', 'done');
    const files = Array.from({ length: 4000 }, (_, i) => ({ path: `src/generated/file-${i}.js`, additions: i % 7, deletions: 1, bytes: 100 }));
    files.push({ path: 'db/migrations/001.sql', additions: 1, deletions: 0, bytes: 20 });
    const { state, json } = L.buildLandingState(store, {
      task: store.requireTask(g.taskId),
      project: store.requireProject(g.projectId),
      steps: store.listSteps(g.taskId),
      files,
      riskyPaths: ['db/'],
      rules: 'rules',
      guidance: '',
    });
    assert.ok(json.length <= 60_000, `state is ${json.length} characters`);
    assert.equal(state.totals.files, 4001);
    assert.ok(state.totals.filesOmitted > 0);
    assert.ok(state.files.some((x) => x.path === 'db/migrations/001.sql' && x.risky), 'risky files are kept');
    assert.deepEqual(state.corrections, ['verify failed: 2 failed in customers.test.js']);
    assert.deepEqual(state.checks.map((c) => c.passed), [true]);
  });

  test('pathMatches is a path prefix match', () => {
    assert.equal(L.pathMatches('db/schema.sql', 'db/'), true);
    assert.equal(L.pathMatches('db', 'db'), true);
    assert.equal(L.pathMatches('dbx/a', 'db'), false);
    assert.equal(L.pathMatches('src/auth/x.ts', './src/auth'), true);
  });

  test('parseNumstat counts binary files as 0 and keeps tabs in names', () => {
    assert.deepEqual(G.parseNumstat('3\t1\tsrc/a.js\0-\t-\timg.png\0'), [
      { path: 'src/a.js', additions: 3, deletions: 1 },
      { path: 'img.png', additions: 0, deletions: 0 },
    ]);
  });

  test('landing.json is validated strictly; project.json types are checked', () => {
    writeFileSync(join(home, 'bad-landing.json'), JSON.stringify({ riskyPaths: [], checks: [{ name: 'x', cmd: 'true' }] }));
    assert.throws(() => L.loadLandingConfig('x', join(home, 'bad-landing.json')), (e: unknown) => e instanceof JvError && /checks\.0/.test(e.message));
    writeFileSync(join(home, 'bad-project.json'), JSON.stringify({ pushAfterLanding: 'yes' }));
    assert.throws(() => L.loadProjectSettings('x', join(home, 'bad-project.json')), refusedWith('pushAfterLanding'));
    assert.deepEqual(L.loadProjectSettings('x', join(home, 'missing.json')), { testCommand: null, pushAfterLanding: false, retentionDays: 3 });
    assert.deepEqual(
      L.landingChecks({ riskyPaths: [], checks: [] }, { testCommand: 'npm test', pushAfterLanding: false, retentionDays: 3 }),
      [{ name: 'test', command: 'npm test', timeoutMs: L.CHECK_TIMEOUT_MS }],
    );
    assert.deepEqual(L.landingChecks({ riskyPaths: [], checks: [] }, { testCommand: null, pushAfterLanding: false, retentionDays: 3 }), []);
  });
});
