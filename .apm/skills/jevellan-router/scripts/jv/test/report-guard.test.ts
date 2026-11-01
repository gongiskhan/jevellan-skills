// The Stop hook guard (section 6.4): the compiled dist-test/src/report-guard.mjs is run as Claude Code runs a hook.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-guard-test-');
process.env.JV_HOME = home;
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');

after(() => rmSync(home, { recursive: true, force: true }));

const guard = fileURLToPath(new URL('../src/report-guard.mjs', import.meta.url));
const BLOCK = '{"decision":"block","reason":"End the turn with jv_report (status progress, done, blocked or needs-decision)."}';

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);
let n = 0;
function newRun(kind: 'step' | 'coordinator' = 'step', native?: string) {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: kind === 'step' ? seeded.taskId : null,
    step_id: kind === 'step' ? seeded.stepIds[0]! : null,
    request_id: `req-guard-${n}`,
    kind,
    runtime: kind === 'step' ? 'claude-sdk' : 'claude-tmux',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

function hook(env: Record<string, string | undefined>, flags: string[] = ['--disable-warning=ExperimentalWarning']) {
  const r = spawnSync(process.execPath, [...flags, guard], {
    env: { PATH: process.env.PATH ?? '', JV_HOME: home, ...env } as NodeJS.ProcessEnv,
    input: JSON.stringify({ session_id: 'x', hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('JV_SESSION is read before anything is imported: the compiled guard has no static import', () => {
  const text = readFileSync(guard, 'utf8');
  assert.equal(/^\s*import\s/m.test(text), false);
  assert.ok(text.indexOf('process.env.JV_SESSION') < text.indexOf("import('"));
});

test('an ordinary session (no JV_SESSION) passes at once, even with no store', () => {
  const r = hook({ JV_SESSION: undefined, JV_HOME: '/nonexistent/jv-home' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('the coordinator and unknown sessions are never blocked', () => {
  assert.deepEqual(hook({ JV_SESSION: newRun('coordinator').id }).stdout, '');
  assert.deepEqual(hook({ JV_SESSION: 'RZZZZZZ' }).stdout, '');
});

test('a step run without a report is blocked twice, then the turn may end', () => {
  const run = newRun();
  const a = hook({ JV_SESSION: run.id });
  assert.equal(a.code, 0);
  assert.equal(a.stdout.trim(), BLOCK);
  assert.equal(hook({ JV_SESSION: run.id }).stdout.trim(), BLOCK);
  const c = hook({ JV_SESSION: run.id });
  assert.equal(c.code, 0);
  assert.equal(c.stdout, '');
  assert.equal(store.getMeta(`report_guard:${run.id}`), '2');
});

test('a run with its report passes; the APM form without the warning flag prints nothing on stderr', () => {
  const run = newRun();
  writeReport(store, run.id, { status: 'done', summary: 'ok' });
  const r = hook({ JV_SESSION: run.id }, []);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('the guard follows the conversation to its newest run (one JV_SESSION across turns)', () => {
  const first = newRun('step', 'native-guard');
  writeReport(store, first.id, { status: 'progress', summary: 'turn one' });
  assert.equal(hook({ JV_SESSION: first.id }).stdout, '');
  const second = newRun('step', 'native-guard');
  assert.equal(hook({ JV_SESSION: first.id }).stdout.trim(), BLOCK);
  assert.equal(store.getMeta(`report_guard:${second.id}`), '1');
});

test('any error exits 0 with nothing on stdout', () => {
  const r = hook({ JV_SESSION: 'R000000', JV_HOME: guard /* a file, not a folder */ });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
