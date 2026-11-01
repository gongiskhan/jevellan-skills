// Store tests: schema, request ids, states, concurrent writers. Every test runs against a temporary JV_HOME.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'jv-store-test-'));
process.env.JV_HOME = home;

const { Store, SCHEMA_VERSION, TABLES } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');
const { paths } = await import('../src/paths.js');
const { isId } = await import('../src/ids.js');

type StoreT = import('../src/store.js').Store;

after(() => rmSync(home, { recursive: true, force: true }));

let counter = 0;
function freshStore(options: { idSource?: (kind: 'task') => string } = {}): StoreT {
  counter++;
  return Store.open({ file: join(home, `store-${counter}.sqlite`), ...(options as object) });
}

function seed(store: StoreT) {
  const project = store.createProject({ name: `p${counter}`, path: '/tmp/p', default_branch: 'main' }).row;
  const task = store.createTask({
    project_id: project.id,
    request_id: 'req-task',
    kind: 'feature',
    title: 'Customers empty state',
    task_text: 'Show a message when there are no customers.',
    workflow_json: '{"name":"feature","steps":[]}',
  }).row;
  const step = store.createStep({ task_id: task.id, ordinal: 1, duty: 'implement', instructions: 'Do it.' }).row;
  const session = store.createSession({
    project_id: project.id,
    task_id: task.id,
    step_id: step.id,
    request_id: 'req-session',
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'claude-opus-5-5',
    effort: 'high',
    cwd: '/tmp/p',
  }).row;
  return { project, task, step, session };
}

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof JvError) return error.exitCode;
    throw error;
  }
  return undefined;
}

// Section 4, table by table: the column names in order.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  projects: ['id', 'name', 'path', 'default_branch', 'created_at'],
  tasks: [
    'id', 'project_id', 'parent_task_id', 'after_task_id', 'request_id', 'kind', 'title', 'task_text',
    'workflow_json', 'state', 'state_reason', 'current_step', 'branch', 'worktree_path', 'base_commit',
    'landed_commit', 'visible', 'created_at', 'started_at', 'ended_at',
  ],
  steps: [
    'id', 'task_id', 'ordinal', 'duty', 'instructions', 'when_rule', 'on_fail_json', 'state', 'state_reason',
    'attempts', 'started_at', 'ended_at',
  ],
  sessions: [
    'id', 'project_id', 'task_id', 'step_id', 'request_id', 'kind', 'runtime', 'provider', 'model', 'effort', 'cwd',
    'native_session_id', 'pid', 'pgid', 'tmux_target', 'state', 'state_reason', 'started_at', 'ended_at',
    'last_event_at', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd',
  ],
  events: ['id', 'session_id', 'seq', 'at', 'kind', 'payload'],
  reports: [
    'id', 'session_id', 'step_id', 'task_id', 'status', 'summary', 'question', 'options_json', 'tests_json',
    'changed_files_json', 'screenshots_json', 'limitations', 'owner_commands_json', 'created_at',
  ],
  decisions: [
    'id', 'kind', 'project_id', 'task_id', 'step_id', 'session_id', 'skill_name', 'skill_hash', 'jev_model',
    'state_json', 'questions_json', 'answers_json', 'chosen_json', 'override_json', 'override_mode', 'outcome_json',
    'latency_ms', 'usage_json', 'created_at',
  ],
  landings: [
    'id', 'task_id', 'decision_id', 'route', 'state', 'checks_json', 'commit_sha', 'reason', 'created_at', 'ended_at',
  ],
  messages: ['id', 'task_id', 'session_id', 'direction', 'text', 'created_at', 'delivered_at'],
  provider_usage: [
    'provider', 'observed_at', 'source', 'five_hour_pct', 'weekly_pct', 'five_hour_resets_at', 'weekly_resets_at',
    'local_week', 'local_input_tokens', 'local_output_tokens', 'local_cost_usd',
  ],
  meta: ['key', 'value'],
};

describe('schema', () => {
  test('tables and columns are exactly section 4', () => {
    const store = freshStore();
    try {
      const tables = (
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      assert.deepEqual(tables, Object.keys(EXPECTED_COLUMNS));
      assert.deepEqual([...TABLES], Object.keys(EXPECTED_COLUMNS));
      for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        const actual = (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        assert.deepEqual(actual, columns, `columns of ${table}`);
      }
    } finally {
      store.close();
    }
  });

  test('schema version and pragmas', () => {
    const store = freshStore();
    try {
      assert.equal(store.schemaVersion(), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, '1');
      const pragma = (name: string) => Object.values(store.db.prepare(`PRAGMA ${name}`).get() as object)[0];
      assert.equal(pragma('journal_mode'), 'wal');
      assert.equal(pragma('busy_timeout'), 5000);
      assert.equal(pragma('synchronous'), 1); // NORMAL
      assert.equal(pragma('foreign_keys'), 1);
    } finally {
      store.close();
    }
  });

  test('reopening an existing store keeps its rows and version', () => {
    const file = join(home, 'reopen.sqlite');
    const a = Store.open({ file });
    a.createProject({ name: 'kept', path: '/tmp/kept', default_branch: 'main' });
    a.close();
    const b = Store.open({ file });
    try {
      assert.equal(b.listProjects().length, 1);
      assert.equal(b.schemaVersion(), '1');
    } finally {
      b.close();
    }
  });

  test('a store with another schema version is refused', () => {
    const file = join(home, 'future.sqlite');
    const a = Store.open({ file });
    a.setMeta('schema_version', '99');
    a.close();
    assert.equal(exitCodeOf(() => Store.open({ file })), 2);
  });

  test('the default store lives under JV_HOME, never ~/.jv', () => {
    assert.equal(paths.home, home);
    assert.equal(paths.store, join(home, 'store.sqlite'));
  });

  test('the store module has no DELETE statement', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/store.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(source, /\bDROP\s+TABLE\b/i);
  });
});

describe('ids', () => {
  test('every row id is a prefix and 6 Crockford base32 characters', () => {
    const store = freshStore();
    try {
      const { project, task, step, session } = seed(store);
      assert.ok(isId(project.id, 'project') && project.id.startsWith('P'));
      assert.ok(isId(task.id, 'task') && task.id.startsWith('T'));
      assert.ok(isId(step.id, 'step') && step.id.startsWith('S'));
      assert.ok(isId(session.id, 'session') && session.id.startsWith('R'));
      const report = store.createReport({ session_id: session.id, status: 'done', summary: 'ok' }).row;
      assert.ok(report.id.startsWith('E') && isId(report.id, 'report'));
      const message = store.createMessage({ task_id: task.id, direction: 'owner', text: 'hi' });
      assert.ok(message.id.startsWith('M') && isId(message.id, 'message'));
      for (const id of [project.id, task.id, step.id, session.id]) assert.match(id, /^[A-Z][0-9A-HJKMNP-TV-Z]{6}$/);
    } finally {
      store.close();
    }
  });

  test('an id collision is retried with a fresh id', () => {
    const ids = ['PAAAAAA', 'TAAAAAA', 'TAAAAAA', 'TBBBBBB'];
    const store = freshStore({ idSource: () => ids.shift() ?? 'TZZZZZZ' });
    try {
      const project = store.createProject({ name: 'collide', path: '/tmp/c', default_branch: 'main' }).row;
      const base = { project_id: project.id, kind: 'single' as const, task_text: 'x', workflow_json: '{}' };
      const first = store.createTask({ ...base, request_id: 'a', title: 'a' }).row;
      const second = store.createTask({ ...base, request_id: 'b', title: 'b' }).row;
      assert.equal(first.id, 'TAAAAAA');
      assert.equal(second.id, 'TBBBBBB');
    } finally {
      store.close();
    }
  });
});

describe('request ids', () => {
  test('a task with the same request id and the same input returns the existing row', () => {
    const store = freshStore();
    try {
      const { project, task } = seed(store);
      const again = store.createTask({
        project_id: project.id,
        request_id: 'req-task',
        kind: 'feature',
        title: 'Customers empty state',
        task_text: 'Show a message when there are no customers.',
        workflow_json: '{"name":"feature","steps":[]}',
      });
      assert.equal(again.created, false);
      assert.equal(again.row.id, task.id);
      assert.equal(store.listTasks().length, 1);
    } finally {
      store.close();
    }
  });

  test('a task with the same request id and different input exits 4', () => {
    const store = freshStore();
    try {
      const { project } = seed(store);
      const code = exitCodeOf(() =>
        store.createTask({
          project_id: project.id,
          request_id: 'req-task',
          kind: 'feature',
          title: 'A different title',
          task_text: 'Show a message when there are no customers.',
          workflow_json: '{"name":"feature","steps":[]}',
        }),
      );
      assert.equal(code, 4);
      const visible = exitCodeOf(() =>
        store.createTask({
          project_id: project.id,
          request_id: 'req-task',
          kind: 'feature',
          title: 'Customers empty state',
          task_text: 'Show a message when there are no customers.',
          workflow_json: '{"name":"feature","steps":[]}',
          visible: true,
        }),
      );
      assert.equal(visible, 4);
      assert.equal(store.listTasks().length, 1);
    } finally {
      store.close();
    }
  });

  test('sessions follow the same rule', () => {
    const store = freshStore();
    try {
      const { project, task, step, session } = seed(store);
      const input = {
        project_id: project.id,
        task_id: task.id,
        step_id: step.id,
        request_id: 'req-session',
        kind: 'step' as const,
        runtime: 'claude-sdk' as const,
        provider: 'claude-main',
        model: 'claude-opus-5-5',
        effort: 'high',
        cwd: '/tmp/p',
      };
      const again = store.createSession(input);
      assert.equal(again.created, false);
      assert.equal(again.row.id, session.id);
      assert.equal(exitCodeOf(() => store.createSession({ ...input, model: 'claude-fable-5-1' })), 4);
      // The state a session reached since is not input: a repeat still matches.
      store.setSessionState(session.id, 'running', 'started');
      assert.equal(store.createSession(input).created, false);
    } finally {
      store.close();
    }
  });

  test('steps are keyed on (task, ordinal) and reports on the session', () => {
    const store = freshStore();
    try {
      const { task, step, session } = seed(store);
      const again = store.createStep({ task_id: task.id, ordinal: 1, duty: 'implement', instructions: 'Do it.' });
      assert.equal(again.created, false);
      assert.equal(again.row.id, step.id);
      assert.equal(exitCodeOf(() => store.createStep({ task_id: task.id, ordinal: 1, duty: 'verify' })), 4);

      const report = store.createReport({ session_id: session.id, status: 'done', summary: 'Done.' });
      assert.equal(report.created, true);
      assert.equal(store.createReport({ session_id: session.id, status: 'done', summary: 'Done.' }).created, false);
      assert.equal(exitCodeOf(() => store.createReport({ session_id: session.id, status: 'blocked', summary: 'x' })), 4);
    } finally {
      store.close();
    }
  });

  test('projects are keyed on the name', () => {
    const store = freshStore();
    try {
      const a = store.createProject({ name: 'same', path: '/tmp/a', default_branch: 'main' });
      assert.equal(a.created, true);
      assert.equal(store.createProject({ name: 'same', path: '/tmp/a', default_branch: 'main' }).created, false);
      assert.equal(exitCodeOf(() => store.createProject({ name: 'same', path: '/tmp/b', default_branch: 'main' })), 4);
      // The same repository under a second name is a conflict that names the first project.
      assert.equal(exitCodeOf(() => store.createProject({ name: 'other', path: '/tmp/a', default_branch: 'main' })), 4);
      assert.throws(() => store.createProject({ name: 'other', path: '/tmp/a', default_branch: 'main' }), /registered as project same/);
      // Same name and path with another default branch updates the branch (the repository renamed it).
      const renamed = store.createProject({ name: 'same', path: '/tmp/a', default_branch: 'trunk' });
      assert.equal(renamed.created, false);
      assert.equal(renamed.branchChangedFrom, 'main');
      assert.equal(renamed.row.default_branch, 'trunk');
      assert.equal(renamed.row.id, a.row.id);
      assert.equal(store.listProjects().length, 1);
    } finally {
      store.close();
    }
  });

  test('opening an existing store for a read does not wait for a writer', async () => {
    const file = join(home, 'reader-vs-writer.sqlite');
    Store.open({ file }).close();
    const { DatabaseSync } = await import('node:sqlite');
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA busy_timeout = 5000');
    writer.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      const reader = Store.open({ file });
      try {
        assert.equal(reader.schemaVersion(), '1');
        assert.deepEqual(reader.listProjects(), []);
      } finally {
        reader.close();
      }
      assert.ok(Date.now() - t0 < 1000, `open took ${Date.now() - t0} ms while a writer held the lock`);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  test('missing references exit 3', () => {
    const store = freshStore();
    try {
      const code = exitCodeOf(() =>
        store.createTask({
          project_id: 'PNOPE00',
          request_id: 'r',
          kind: 'single',
          title: 't',
          task_text: 'x',
          workflow_json: '{}',
        }),
      );
      assert.equal(code, 3);
      assert.equal(exitCodeOf(() => store.setTaskState('TNOPE00', 'running', 'x')), 3);
      assert.equal(exitCodeOf(() => store.appendEvent('RNOPE00', 'text', {})), 3);
    } finally {
      store.close();
    }
  });
});

describe('states', () => {
  test('CHECK constraints reject unknown states and kinds', () => {
    const store = freshStore();
    try {
      const { task, step, session } = seed(store);
      const landing = store.createLanding({ task_id: task.id, route: 'land' });
      const rejects = (sql: string, ...params: string[]) =>
        assert.throws(() => store.db.prepare(sql).run(...params), /CHECK constraint failed/);
      rejects("UPDATE tasks SET state = 'finished' WHERE id = ?", task.id);
      rejects("UPDATE tasks SET kind = 'chore' WHERE id = ?", task.id);
      rejects("UPDATE steps SET state = 'waiting' WHERE id = ?", step.id);
      rejects("UPDATE sessions SET state = 'paused' WHERE id = ?", session.id);
      rejects("UPDATE sessions SET runtime = 'docker' WHERE id = ?", session.id);
      rejects("UPDATE landings SET state = 'merged' WHERE id = ?", landing.id);
      rejects("UPDATE landings SET route = 'yolo' WHERE id = ?", landing.id);
      rejects("INSERT INTO events (session_id, seq, at, kind, payload) VALUES (?, 99, 'x', 'noise', '{}')", session.id);
      rejects(
        "INSERT INTO reports (id, session_id, status, summary, created_at) VALUES ('EXXXXXX', ?, 'maybe', 's', 'x')",
        session.id,
      );
      rejects("UPDATE tasks SET title = ? WHERE id = ?", 'x'.repeat(121), task.id);
      // The setters refuse unknown states before SQLite sees them.
      assert.equal(exitCodeOf(() => store.setTaskState(task.id, 'finished' as never, 'x')), 2);
      assert.equal(exitCodeOf(() => store.setStepState(step.id, 'waiting' as never, 'x')), 2);
      assert.equal(exitCodeOf(() => store.setSessionState(session.id, 'paused' as never, 'x')), 2);
      assert.equal(exitCodeOf(() => store.setLandingState(landing.id, 'merged' as never, 'x')), 2);
      assert.equal(store.getTask(task.id)!.state, 'queued');
    } finally {
      store.close();
    }
  });

  test('every state change writes state_reason, and an empty reason is refused', () => {
    const store = freshStore();
    try {
      const { task, step, session } = seed(store);
      assert.equal(task.state_reason, 'created');
      assert.equal(step.state_reason, 'created');
      assert.equal(session.state_reason, 'created');
      assert.equal(exitCodeOf(() => store.setTaskState(task.id, 'running', '  ')), 2);
      assert.equal(exitCodeOf(() => store.setStepState(step.id, 'running', '')), 2);
      assert.equal(exitCodeOf(() => store.setSessionState(session.id, 'running', '')), 2);

      const running = store.setTaskState(task.id, 'running', 'step 1 started');
      assert.equal(running.state, 'running');
      assert.equal(running.state_reason, 'step 1 started');
      assert.ok(running.started_at);
      assert.equal(running.ended_at, null);

      const waiting = store.setTaskState(task.id, 'waiting-owner', 'needs-decision from implement');
      assert.equal(waiting.state_reason, 'needs-decision from implement');
      assert.equal(waiting.started_at, running.started_at, 'started_at is never overwritten');

      const done = store.setTaskState(task.id, 'done', 'landed', { landed_commit: 'abc123' });
      assert.ok(done.ended_at);
      assert.equal(done.landed_commit, 'abc123');
      assert.equal(done.started_at, running.started_at);
    } finally {
      store.close();
    }
  });

  test('steps, sessions and landings get the timestamps their states imply', () => {
    const store = freshStore();
    try {
      const { task, step, session } = seed(store);
      const s1 = store.setStepState(step.id, 'running', 'placed on Opus high');
      assert.ok(s1.started_at);
      assert.equal(s1.ended_at, null);
      const s2 = store.setStepState(step.id, 'failed', 'tests failed', { attempts: 1 });
      assert.ok(s2.ended_at);
      assert.equal(s2.attempts, 1);
      const s3 = store.setStepState(step.id, 'retrying', 'goto implement');
      assert.equal(s3.ended_at, null, 'a retried step is live again');
      assert.equal(s3.started_at, s1.started_at);

      const r1 = store.setSessionState(session.id, 'starting', 'spawned', { pid: 123, pgid: 123 });
      assert.ok(r1.started_at);
      assert.equal(r1.pid, 123);
      const r2 = store.setSessionState(session.id, 'lost', 'pid gone, no end event');
      assert.ok(r2.ended_at);
      assert.equal(r2.state_reason, 'pid gone, no end event');

      const landing = store.createLanding({ task_id: task.id, route: 'land' });
      assert.equal(landing.state, 'pending');
      assert.equal(landing.ended_at, null);
      const l2 = store.setLandingState(landing.id, 'checking', 'running npm test');
      assert.equal(l2.reason, 'running npm test');
      const l3 = store.setLandingState(landing.id, 'landed', 'fast-forwarded main', { commit_sha: 'def456' });
      assert.ok(l3.ended_at);
      assert.equal(l3.commit_sha, 'def456');
    } finally {
      store.close();
    }
  });

  test('events get consecutive seq per session and set last_event_at', () => {
    const store = freshStore();
    try {
      const { session } = seed(store);
      const a = store.appendEvent(session.id, 'start', { model: 'm' });
      const b = store.appendEvent(session.id, 'text', { text: 'hello' });
      assert.equal(a.seq, 1);
      assert.equal(b.seq, 2);
      assert.deepEqual(JSON.parse(b.payload), { text: 'hello' });
      assert.equal(store.getSession(session.id)!.last_event_at, b.at);
      assert.deepEqual(
        store.listEvents(session.id, { afterSeq: 1 }).map((e) => e.seq),
        [2],
      );
      const used = store.addSessionUsage(session.id, { input_tokens: 10, output_tokens: 5, cost_usd: 0.25 });
      assert.equal(used.input_tokens, 10);
      assert.equal(used.cost_usd, 0.25);
    } finally {
      store.close();
    }
  });

  test('decisions, messages, provider usage and meta', () => {
    const store = freshStore();
    try {
      const { project, task, step } = seed(store);
      const d = store.createDecision({
        kind: 'placement',
        project_id: project.id,
        task_id: task.id,
        step_id: step.id,
        skill_name: 'jevellan-router',
        skill_hash: 'h',
        jev_model: 'jev-latest',
        state_json: '{}',
        questions_json: '{}',
        answers_json: '{}',
        chosen_json: '{}',
        latency_ms: 12.4,
        usage_json: '{}',
      });
      assert.ok(d.id.startsWith('D'));
      assert.equal(d.latency_ms, 12);
      const o = store.updateDecision(d.id, { override_json: '{"model":"x"}', override_mode: 'undo' });
      assert.equal(o.override_mode, 'undo');
      assert.equal(exitCodeOf(() => store.updateDecision(d.id, { override_mode: 'maybe' as never })), 2);

      const m = store.createMessage({ task_id: task.id, direction: 'owner', text: 'Use the blue button.' });
      assert.equal(store.listMessages({ task_id: task.id, undelivered: true }).length, 1);
      store.markMessageDelivered(m.id, 'RAAAAAA');
      assert.equal(store.listMessages({ task_id: task.id, undelivered: true }).length, 0);

      const at = '2026-11-01T10:00:00.000Z';
      store.recordProviderUsage({ provider: 'claude-main', observed_at: at, source: 'probe', weekly_pct: 48 });
      const second = store.recordProviderUsage({ provider: 'claude-main', observed_at: at, source: 'stream', weekly_pct: 49 });
      assert.notEqual(second.observed_at, at, 'a clash moves the observation forward instead of losing it');
      assert.equal(store.latestProviderUsage('claude-main')!.weekly_pct, 49);
      assert.equal(store.listProviderUsage({ provider: 'claude-main' }).length, 2);

      store.setMeta('coordinator:p', 'jv-coord-p');
      assert.equal(store.getMeta('coordinator:p'), 'jv-coord-p');
      assert.deepEqual(store.listMeta('coordinator:'), [{ key: 'coordinator:p', value: 'jv-coord-p' }]);
    } finally {
      store.close();
    }
  });
});

describe('concurrent writers', () => {
  test('6 processes x 50 short transactions: every row present, no SQLITE_BUSY, unique seq', async () => {
    const file = join(home, 'concurrent.sqlite');
    const store = Store.open({ file });
    const project = store.createProject({ name: 'concurrent', path: '/tmp/c', default_branch: 'main' }).row;
    const shared = store.createSession({
      project_id: project.id,
      request_id: 'shared-session',
      kind: 'probe',
      runtime: 'llm',
      provider: 'p',
      model: 'm',
      effort: 'low',
      cwd: '/tmp',
    }).row;
    store.close();

    const workers = 6;
    const count = 50;
    const script = fileURLToPath(new URL('./fixtures/concurrent-writer.js', import.meta.url));
    const results = await Promise.all(
      Array.from({ length: workers }, (_, worker) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
          const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
            env: {
              ...process.env,
              JV_HOME: home,
              JV_TEST_WORKER: '1',
              JV_TEST_WORKER_ARGS: JSON.stringify({ file, worker, count, projectId: project.id, sharedSessionId: shared.id }),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
          child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
          child.on('close', (code) => resolveRun({ code, stdout, stderr }));
        }),
      ),
    );
    for (const r of results) {
      assert.equal(r.code, 0, `worker failed: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /SQLITE_BUSY|database is locked|busy/i);
    }
    const sharedCreated = results.reduce((n, r) => n + (JSON.parse(r.stdout.trim()) as { sharedCreated: number }).sharedCreated, 0);
    assert.equal(sharedCreated, 1, 'exactly one worker created the shared request id');

    const check = Store.open({ file });
    try {
      const n = (sql: string, ...p: string[]) => (check.db.prepare(sql).get(...p) as { n: number }).n;
      assert.equal(n('SELECT count(*) AS n FROM tasks'), workers * count + 1);
      assert.equal(n('SELECT count(*) AS n FROM sessions'), workers * count + 1);
      assert.equal(n('SELECT count(*) AS n FROM events'), workers * count * 2);
      for (let w = 0; w < workers; w++) {
        for (let j = 0; j < count; j++) assert.ok(check.getTaskByRequestId(`w${w}-t${j}`), `task w${w}-t${j}`);
      }
      const seqs = check.listEvents(shared.id).map((e: { seq: number }) => e.seq);
      assert.equal(seqs.length, workers * count);
      assert.deepEqual(seqs, Array.from({ length: workers * count }, (_, i) => i + 1), 'shared session seq is 1..N');
      assert.equal(
        n('SELECT count(*) AS n FROM (SELECT session_id, seq FROM events GROUP BY session_id, seq HAVING count(*) > 1)'),
        0,
      );
      assert.equal(check.getSession(shared.id)!.last_event_at, check.lastEvent(shared.id)!.at);
    } finally {
      check.close();
    }
  });
});
