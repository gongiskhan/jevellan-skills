// jv gc tests: temporary git repositories and JV_HOME. A clean landed worktree is removed (its evidence archived,
// the branch kept); a dirty or discarded one is moved to the archive and stays registered; retention, dry runs and a
// second run change nothing; nothing is pruned and no branch is deleted.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-gc-test-'));
process.env.JV_HOME = home;
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { gc, formatGc } = await import('../src/gc.js');
const { ensureGitExclude } = await import('../src/project.js');
const { openStore } = await import('../src/store.js');

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

const store = openStore();
const DAY = 86_400_000;

function makeProject(name: string, retentionDays?: number) {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  ensureGitExclude(repo);
  mkdirSync(join(home, 'projects', name), { recursive: true });
  writeFileSync(join(home, 'projects', name, 'project.json'), JSON.stringify(retentionDays === undefined ? {} : { retentionDays }));
  return { repo, project: store.createProject({ name, path: repo, default_branch: 'main' }).row };
}

let n = 0;
function makeTask(p: ReturnType<typeof makeProject>, how: { land?: boolean; stop?: boolean }) {
  const task = store.createTask({
    project_id: p.project.id,
    request_id: `gc-${++n}`,
    kind: 'feature',
    title: `Task ${n}`,
    task_text: 'text',
    workflow_json: '{}',
  }).row;
  const branch = `jv/task-${n}-${task.id.slice(1).toLowerCase()}`;
  const worktree = join(home, 'worktrees', p.project.name, branch.slice(3));
  mkdirSync(join(home, 'worktrees', p.project.name), { recursive: true });
  git(p.repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
  writeFileSync(join(worktree, `file-${n}.txt`), `${n}\n`);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', `task ${n}`);
  const head = git(worktree, 'rev-parse', 'HEAD');
  store.updateTask(task.id, { branch, worktree_path: worktree, base_commit: git(p.repo, 'rev-parse', 'main') });
  if (how.land) {
    git(p.repo, 'merge', '-q', '--ff-only', branch);
    store.setTaskState(task.id, 'done', 'landed', { landed_commit: head });
  } else if (how.stop) {
    store.setTaskState(task.id, 'stopped', 'discarded by the owner');
  }
  return { task: store.requireTask(task.id), branch, worktree, head };
}

describe('jv gc', () => {
  const p = makeProject('gcproj');
  const clean = makeTask(p, { land: true });
  mkdirSync(join(clean.worktree, '.jv-evidence'), { recursive: true });
  writeFileSync(join(clean.worktree, '.jv-evidence', 'customers-phone.png'), 'png');
  writeFileSync(join(clean.worktree, 'plan.md'), '# plan\n');
  const dirty = makeTask(p, { land: true });
  writeFileSync(join(dirty.worktree, 'unsaved.txt'), 'work in progress\n');
  const discarded = makeTask(p, { stop: true });
  const running = makeTask(p, {});
  const later = new Date(Date.now() + 4 * DAY);

  test('nothing happens before the retention (default 3 days)', async () => {
    assert.deepEqual(await gc(store, { now: new Date(Date.now() + 2 * DAY) }), []);
  });

  test('--dry-run lists the actions and changes nothing', async () => {
    const actions = await gc(store, { now: later, dryRun: true });
    assert.deepEqual(
      actions.map((a) => [a.taskId, a.action, a.dryRun]),
      [
        [clean.task.id, 'removed', true],
        [dirty.task.id, 'archived', true],
        [discarded.task.id, 'archived', true],
      ],
    );
    assert.ok(existsSync(clean.worktree) && existsSync(dirty.worktree) && existsSync(discarded.worktree));
    assert.equal(store.requireTask(clean.task.id).worktree_path, clean.worktree);
    assert.match(formatGc(actions), /^\(dry run\) /);
  });

  test('removes the clean landed worktree, moves the others to the archive, keeps every branch', async () => {
    const actions = await gc(store, { now: later });
    const by = new Map(actions.map((a) => [a.taskId, a]));
    const date = later.toISOString().slice(0, 10);
    const archive = join(home, 'archive', 'worktrees', 'gcproj');

    const removed = by.get(clean.task.id)!;
    assert.equal(removed.action, 'removed');
    assert.equal(existsSync(clean.worktree), false);
    assert.equal(removed.to, join(archive, `${clean.branch.slice(3)}-${date}`));
    assert.equal(readFileSync(join(removed.to!, '.jv-evidence', 'customers-phone.png'), 'utf8'), 'png');
    assert.ok(existsSync(join(removed.to!, 'plan.md')));
    assert.equal(store.requireTask(clean.task.id).worktree_path, removed.to);

    const moved = by.get(dirty.task.id)!;
    assert.equal(moved.action, 'archived');
    assert.match(moved.reason, /uncommitted changes \(unsaved\.txt\)/);
    assert.equal(existsSync(dirty.worktree), false);
    assert.equal(readFileSync(join(moved.to!, 'unsaved.txt'), 'utf8'), 'work in progress\n');
    assert.equal(store.requireTask(dirty.task.id).worktree_path, moved.to);

    const kept = by.get(discarded.task.id)!;
    assert.equal(kept.action, 'archived');
    assert.match(kept.reason, /discarded/);
    assert.ok(existsSync(join(kept.to!, `file-3.txt`)));

    const list = git(p.repo, 'worktree', 'list', '--porcelain');
    assert.ok(!list.includes(clean.worktree));
    assert.ok(list.includes(moved.to!), 'a moved worktree stays registered');
    assert.ok(list.includes(kept.to!));
    assert.ok(list.includes(running.worktree), 'a running task is never touched');
    assert.equal(git(moved.to!, 'rev-parse', '--abbrev-ref', 'HEAD'), dirty.branch);
    for (const t of [clean, dirty, discarded, running]) assert.equal(git(p.repo, 'rev-parse', `refs/heads/${t.branch}`), t.head);
  });

  test('a second run has nothing left to do', async () => {
    assert.deepEqual(await gc(store, { now: new Date(Date.now() + 10 * DAY) }), []);
  });

  test("project.json retentionDays is each project's own", async () => {
    const q = makeProject('gclong', 10);
    const t = makeTask(q, { land: true });
    assert.deepEqual(await gc(store, { project: 'gclong', now: later }), []);
    const actions = await gc(store, { project: 'gclong', now: new Date(Date.now() + 11 * DAY) });
    assert.deepEqual(actions.map((a) => [a.taskId, a.action]), [[t.task.id, 'removed']]);
    assert.equal(store.requireTask(t.task.id).worktree_path, null, 'no evidence: nothing archived');
  });
});
