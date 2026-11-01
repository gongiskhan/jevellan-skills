// git.ts against temporary repositories: the task worktree (created from the base, reused on a repeat, refused when
// the branch or the folder is in the way), parseWorktrees, uncommitted files, and the worktree setup command (once
// per worktree, output in the session log, one event, a failure fails and is tried again).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-git-test-'));
process.env.JV_HOME = home;
const G = await import('../src/git.js');
const { JvError } = await import('../src/errors.js');
const { openStore } = await import('../src/store.js');
const { paths } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'first');
  return sh(dir, 'rev-parse', 'HEAD');
}

const conflictErr = (e: unknown) => e instanceof JvError && e.exitCode === 4;
const refusedErr = (re: RegExp) => (e: unknown) => e instanceof JvError && e.exitCode === 2 && re.test(e.message);

test('createWorktree adds the task branch from the base and finds it again on a repeat', () => {
  const repo = join(home, 'repo-a');
  const head = makeRepo(repo);
  const path = join(home, 'worktrees', 'a', 'customers-empty-abc123');
  const w = G.createWorktree({ repo, path, branch: 'jv/customers-empty-abc123', base: 'main' });
  assert.equal(w.created, true);
  assert.equal(w.baseCommit, head);
  assert.ok(existsSync(join(path, 'README.md')));
  assert.equal(sh(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'jv/customers-empty-abc123');
  assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the checkout is untouched');
  writeFileSync(join(repo, 'later.txt'), 'main moved on');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'later');
  const again = G.createWorktree({ repo, path, branch: 'jv/customers-empty-abc123', base: 'main' });
  assert.equal(again.created, false);
  assert.equal(again.baseCommit, head, 'the fork point, not the moved main');
  const entries = G.listWorktrees(repo);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.branch === 'refs/heads/jv/customers-empty-abc123'));
  assert.deepEqual(G.uncommittedFiles(path), []);
  writeFileSync(join(path, 'new.txt'), 'x');
  assert.deepEqual(G.uncommittedFiles(path), ['new.txt']);
  assert.equal(G.headCommit(path), head);
});

test('a child task starts from the parent task branch', () => {
  const repo = join(home, 'repo-b');
  makeRepo(repo);
  const parentPath = join(home, 'worktrees', 'b', 'parent-aaaaaa');
  G.createWorktree({ repo, path: parentPath, branch: 'jv/parent-aaaaaa', base: 'main' });
  writeFileSync(join(parentPath, 'parent.txt'), 'p');
  sh(parentPath, 'add', '.');
  sh(parentPath, 'commit', '-q', '-m', 'parent work');
  const parentHead = sh(parentPath, 'rev-parse', 'HEAD');
  const child = G.createWorktree({ repo, path: join(home, 'worktrees', 'b', 'child-bbbbbb'), branch: 'jv/child-bbbbbb', base: 'jv/parent-aaaaaa' });
  assert.equal(child.baseCommit, parentHead);
  assert.ok(existsSync(join(child.path, 'parent.txt')));
});

test('createWorktree refuses what is in the way and deletes nothing', () => {
  const repo = join(home, 'repo-c');
  makeRepo(repo);
  sh(repo, 'branch', 'jv/taken-cccccc');
  assert.throws(() => G.createWorktree({ repo, path: join(home, 'worktrees', 'c', 'taken-cccccc'), branch: 'jv/taken-cccccc', base: 'main' }), conflictErr);
  assert.ok(G.branchExists(repo, 'jv/taken-cccccc'), 'the branch is kept');
  const blocked = join(home, 'worktrees', 'c', 'blocked-dddddd');
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, 'keep.txt'), 'mine');
  assert.throws(() => G.createWorktree({ repo, path: blocked, branch: 'jv/blocked-dddddd', base: 'main' }), refusedErr(/not a worktree/));
  assert.equal(readFileSync(join(blocked, 'keep.txt'), 'utf8'), 'mine');
  assert.throws(() => G.createWorktree({ repo, path: join(home, 'worktrees', 'c', 'x'), branch: 'jv/bad..name', base: 'main' }), refusedErr(/check-ref-format/));
  assert.throws(() => G.createWorktree({ repo, path: join(home, 'worktrees', 'c', 'y'), branch: 'jv/y-eeeeee', base: 'nope' }), refusedErr(/base branch nope/));
});

test('parseWorktrees reads the porcelain -z format', () => {
  const out = 'worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD def\0detached\0prunable gone\0\0';
  assert.deepEqual(G.parseWorktrees(out), [
    { path: '/r', head: 'abc', branch: 'refs/heads/main', prunable: false },
    { path: '/w', head: 'def', prunable: true },
  ]);
});

test('setupCommand: project.json, else npm ci with a lock file, else none', () => {
  const wt = join(home, 'wt-setup');
  mkdirSync(wt, { recursive: true });
  assert.equal(G.setupCommand('nosuch', wt), undefined);
  writeFileSync(join(wt, 'package-lock.json'), '{}');
  assert.equal(G.setupCommand('nosuch', wt), 'npm ci');
  mkdirSync(paths.projectDir('withcmd'), { recursive: true });
  writeFileSync(paths.projectJson('withcmd'), JSON.stringify({ setupCommand: 'pnpm install' }));
  assert.equal(G.setupCommand('withcmd', wt), 'pnpm install');
  writeFileSync(paths.projectJson('withcmd'), JSON.stringify({ setupCommand: null }));
  assert.equal(G.setupCommand('withcmd', wt), undefined);
});

test('runWorktreeSetup runs once per worktree, logs the output and records one event; a failure fails and retries', async () => {
  const store = openStore();
  try {
    const repo = join(home, 'repo-setup');
    makeRepo(repo);
    const project = store.createProject({ name: 'setup', path: repo, default_branch: 'main' }).row;
    const wt = join(home, 'worktrees', 'setup', 'task-ffffff');
    G.createWorktree({ repo, path: wt, branch: 'jv/task-ffffff', base: 'main' });
    const task = store.createTask({ project_id: project.id, request_id: 'r1', kind: 'single', title: 'T', task_text: 'x', workflow_json: '{}' }).row;
    store.updateTask(task.id, { worktree_path: wt, branch: 'jv/task-ffffff' });
    const step = store.createStep({ task_id: task.id, ordinal: 1, duty: 'implement' }).row;
    const mk = (n: number) =>
      store.createSession({ project_id: project.id, task_id: task.id, step_id: step.id, request_id: `s${n}`, kind: 'step', runtime: 'claude-sdk', provider: 'p', model: 'm', effort: 'high', cwd: wt }).row;
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home };

    const s1 = mk(1);
    await assert.rejects(G.runWorktreeSetup(store, s1, { env, command: 'echo broken >&2; exit 3' }), refusedErr(/worktree setup failed: .* exited 3/));
    assert.match(readFileSync(paths.sessionLog(s1.id), 'utf8'), /broken/);
    const ev1 = store.listEvents(s1.id);
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0]!.kind, 'tool-result');
    assert.equal((JSON.parse(ev1[0]!.payload) as { ok: boolean }).ok, false);

    const s2 = mk(2);
    const rec = await G.runWorktreeSetup(store, s2, { env, command: 'echo installed > setup.txt; echo done' });
    assert.equal(rec?.status, 'ok');
    assert.equal(readFileSync(join(wt, 'setup.txt'), 'utf8'), 'installed\n');
    assert.match(readFileSync(paths.sessionLog(s2.id), 'utf8'), /worktree setup ok/);
    assert.equal(store.listEvents(s2.id).length, 1);

    const s3 = mk(3);
    const again = await G.runWorktreeSetup(store, s3, { env, command: 'echo again > again.txt' });
    assert.equal(again?.session, s2.id, 'the earlier record is returned');
    assert.equal(existsSync(join(wt, 'again.txt')), false, 'not run twice');
    assert.equal(store.listEvents(s3.id).length, 0);

    const other = store.createSession({ project_id: project.id, task_id: task.id, step_id: step.id, request_id: 's4', kind: 'step', runtime: 'llm', provider: 'p', model: 'm', effort: 'low', cwd: repo }).row;
    assert.equal(await G.runWorktreeSetup(store, other, { env }), undefined, 'a run outside the worktree skips it');
  } finally {
    store.close();
  }
});

test('git fetch runs with the owner home, not a provider HOME (the coordinator\'s)', async () => {
  const G2 = await import('../src/git.js');
  const os = await import('node:os');
  const env = G2.fetchEnv({ HOME: '/tmp/provider-home', PATH: '/usr/bin' });
  assert.equal(env.HOME, os.userInfo().homedir);
  assert.equal(env.PATH, '/usr/bin');
});
