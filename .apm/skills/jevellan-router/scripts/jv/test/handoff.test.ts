// The handoff (section 9.5) and the notes: every part of the handoff built from store rows (open tasks with their
// step and last report cut to 300, questions with options and landings asked, landed in 24 h, failed, Jev refusals,
// latest usage per provider, notes.md), the text form, and `jv notes write` (replace, archive, refuse empty).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-handoff-test-');
process.env.JV_HOME = home;
const h = await import('../src/handoff.js');
const notes = await import('../src/notes.js');
const { openStore } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');
const { paths } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());

const repo = join(home, 'repos', 'sandbox');
mkdirSync(repo, { recursive: true });
const project = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;
const other = store.createProject({ name: 'other', path: join(home, 'repos', 'other'), default_branch: 'main' }).row;

let n = 0;
function task(title: string, kind: 'feature' | 'bug' | 'single' = 'feature', projectId = project.id) {
  n++;
  return store.createTask({ project_id: projectId, request_id: `req-${n}`, kind, title, task_text: `Text of ${title}`, workflow_json: '{"steps":[]}' }).row;
}
function step(taskId: string, ordinal: number, duty: string) {
  return store.createStep({ task_id: taskId, ordinal, duty }).row;
}
function report(taskId: string, stepId: string, status: 'progress' | 'done' | 'blocked' | 'needs-decision', summary: string, extra: { question?: string; options?: unknown } = {}) {
  n++;
  const s = store.createSession({
    request_id: `req-s-${n}`,
    project_id: project.id,
    task_id: taskId,
    step_id: stepId,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: repo,
  }).row;
  store.createReport({
    session_id: s.id,
    task_id: taskId,
    step_id: stepId,
    status,
    summary,
    ...(extra.question ? { question: extra.question } : {}),
    ...(extra.options ? { options_json: JSON.stringify(extra.options) } : {}),
  });
  return s;
}

// A running feature on its second step, with a long report on the first.
const running = task('Customers empty state');
const r1 = step(running.id, 1, 'plan');
const r2 = step(running.id, 2, 'implement');
step(running.id, 3, 'verify');
report(running.id, r1.id, 'done', `Plan written. ${'detail '.repeat(100)}`);
store.setStepState(r1.id, 'done', 'report done');
store.setStepState(r2.id, 'running', 'started');
store.setTaskState(running.id, 'running', 'step 2 of 3 (implement)', { current_step: 2 });

// Waiting on the owner with a needs-decision.
const asking = task('Export format', 'bug');
const a1 = step(asking.id, 1, 'implement');
const askingSession = report(asking.id, a1.id, 'needs-decision', 'Two export formats are possible.', {
  question: 'Keep the old CSV columns?',
  options: [{ label: 'Keep the old export format' }, { label: 'Switch to the new columns', description: 'breaks the importer' }],
});
store.setTaskState(asking.id, 'waiting-owner', 'needs-decision');

// Landing routed to the owner.
const toLand = task('Billing labels');
store.setTaskState(toLand.id, 'waiting-owner', 'Jev routed the landing to the owner');
store.createLanding({ task_id: toLand.id, route: 'ask-owner', state: 'asked', reason: 'Touches a risky area: billing.' });

// Landed just now.
const landed = task('README how to run');
store.setTaskState(landed.id, 'done', 'landed', { landed_commit: 'abc123def4567890' });
store.createLanding({ task_id: landed.id, route: 'land', state: 'landed', reason: 'landed', commit_sha: 'abc123def4567890' });

// Failed.
const failed = task('Flaky test');
store.setTaskState(failed.id, 'failed', 'verify failed twice: 2 tests fail in src/invoices');

// Queued, its first step refused by Jev.
const refused = task('Unit test for totals', 'single');
const q1 = step(refused.id, 1, 'implement');
store.setStepState(q1.id, 'pending', 'Jev: no key configured');

// Another project's task never appears.
task('Elsewhere', 'feature', other.id);

store.recordProviderUsage({ provider: 'claude-main', source: 'probe', weekly_pct: 40, five_hour_pct: 10, observed_at: '2026-11-01T10:00:00.000Z' });
store.recordProviderUsage({ provider: 'claude-main', source: 'stream', weekly_pct: 48, five_hour_pct: 12, observed_at: '2026-11-01T11:00:00.000Z' });
store.recordProviderUsage({ provider: 'deepseek', source: 'local', local_week: '2026-W44', local_input_tokens: 1200, local_output_tokens: 300, local_cost_usd: 0.04, observed_at: '2026-11-01T09:00:00.000Z' });

test('the handoff has every part of section 9.5', () => {
  const ho = h.buildHandoff(store, 'sandbox');
  assert.equal(ho.project.name, 'sandbox');

  const open = new Map(ho.open.map((t) => [t.id, t]));
  assert.deepEqual([...open.keys()].sort(), [running.id, asking.id, toLand.id, refused.id].sort());
  const run = open.get(running.id)!;
  assert.deepEqual(run.step, { ordinal: 2, total: 3, duty: 'implement', state: 'running', stateReason: 'started' });
  assert.equal(run.kind, 'feature');
  assert.equal(run.lastReport!.status, 'done');
  assert.ok([...run.lastReport!.summary].length <= h.HANDOFF_SUMMARY_MAX);
  assert.ok(run.lastReport!.summary.endsWith('...'));

  const q = new Map(ho.questions.map((x) => [x.taskId, x]));
  assert.equal(q.size, 2);
  const decision = q.get(asking.id)!;
  assert.equal(decision.kind, 'decision');
  assert.equal(decision.question, 'Keep the old CSV columns?');
  assert.equal(decision.sessionId, askingSession.id);
  assert.deepEqual(decision.options.map((o) => o.label), ['Keep the old export format', 'Switch to the new columns']);
  const landing = q.get(toLand.id)!;
  assert.equal(landing.kind, 'landing');
  assert.match(landing.question, /risky area: billing/);
  assert.deepEqual(landing.options.map((o) => o.label), ['Land now', 'Leave it']);
  assert.equal(landing.options[0]!.description, `jv land ${toLand.id} --force`);

  assert.deepEqual(ho.landed.map((l) => l.id), [landed.id]);
  assert.equal(ho.landed[0]!.commit, 'abc123def4567890');
  assert.deepEqual(ho.failed.map((f) => [f.id, f.reason]), [[failed.id, 'verify failed twice: 2 tests fail in src/invoices']]);
  assert.deepEqual(ho.jevRefusals.map((r) => [r.taskId, r.duty, r.reason]), [[refused.id, 'implement', 'Jev: no key configured']]);

  const usage = new Map(ho.usage.map((u) => [u.provider, u]));
  assert.equal(usage.get('claude-main')!.weeklyPct, 48, 'the latest row, whatever its source');
  assert.equal(usage.get('claude-main')!.source, 'stream');
  assert.equal(usage.get('deepseek')!.localInputTokens, 1200);
  assert.equal(ho.notes, '');
});

test('landed and failed windows: 24 hours and 7 days', () => {
  const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const ho = h.buildHandoff(store, project.id, { now: later });
  assert.deepEqual(ho.landed, []);
  assert.equal(ho.failed.length, 1);
  const muchLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.deepEqual(h.buildHandoff(store, project.id, { now: muchLater }).failed, []);
});

test('the text form names every part and lists the questions numbered with options', () => {
  notes.writeNotes('sandbox', 'Owner: ask before billing changes.\n');
  const text = h.formatHandoff(h.buildHandoff(store, 'sandbox'));
  assert.match(text, /^Handoff for the project "sandbox"/);
  assert.match(text, new RegExp(`- ${running.id} "Customers empty state" \\(feature\\): running, step 2 of 3 implement \\(running\\)`));
  assert.match(text, /Questions waiting on the owner \(2\):\n1\. /);
  assert.match(text, /   - Keep the old export format\n   - Switch to the new columns: breaks the importer/);
  assert.match(text, /   - Land now: jv land T\w{6} --force/);
  assert.match(text, /Landed in the last 24 hours \(1\):\n- T\w{6} "README how to run" at abc123def456/);
  assert.match(text, /Failed tasks \(1\):/);
  assert.match(text, /Jev refusals \(1\):\n- T\w{6} "Unit test for totals" step 1 implement waits: Jev: no key configured/);
  assert.match(text, /- claude-main: week 48%, five hours 12% \(stream/);
  assert.match(text, /Notes \(notes\.md\):\nOwner: ask before billing changes\.$/);
  assert.ok(!text.includes('Elsewhere'));
});

test('an unknown project is exit 3', () => {
  assert.throws(() => h.buildHandoff(store, 'nope'), (e: unknown) => e instanceof JvError && e.exitCode === 3);
});

test('notes write replaces the file, archives the previous version, refuses empty text', () => {
  const file = paths.projectNotes('other');
  const first = notes.writeNotes('other', 'one');
  assert.equal(first.unchanged, false);
  assert.equal(first.archived, undefined);
  assert.equal(readFileSync(file, 'utf8'), 'one\n');
  const same = notes.writeNotes('other', 'one\n');
  assert.equal(same.unchanged, true);
  const second = notes.writeNotes('other', 'two\n');
  assert.ok(second.archived && existsSync(second.archived));
  assert.equal(readFileSync(second.archived!, 'utf8'), 'one\n');
  assert.equal(readFileSync(file, 'utf8'), 'two\n');
  assert.equal(readdirSync(join(paths.projectArchiveDir('other'), 'notes')).length, 1);
  assert.throws(() => notes.writeNotes('other', '  \n'), (e: unknown) => e instanceof JvError && e.exitCode === 2);
  assert.equal(readFileSync(file, 'utf8'), 'two\n');
});

const cliUrl = new URL('../src/cli.js', import.meta.url).href;
function jv(argv: string[], input?: string) {
  return spawnSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(${JSON.stringify(argv)});`,
    ],
    { env: { ...process.env, JV_HOME: home }, encoding: 'utf8', ...(input !== undefined ? { input } : {}) },
  );
}

test('jv notes write and jv handoff through the CLI', () => {
  const w = jv(['notes', 'write', '--project', 'sandbox', '--json'], 'Standing: never touch billing.\n');
  assert.equal(w.status, 0, w.stderr);
  assert.equal(JSON.parse(w.stdout).project, 'sandbox');
  assert.equal(readFileSync(paths.projectNotes('sandbox'), 'utf8'), 'Standing: never touch billing.\n');
  const empty = jv(['notes', 'write', '--project', 'sandbox'], '');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /no text on stdin/);
  const show = jv(['notes', 'show', '--project', 'sandbox']);
  assert.equal(show.stdout, 'Standing: never touch billing.\n');

  const text = jv(['handoff', '--project', 'sandbox']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Standing: never touch billing\./);
  const json = jv(['handoff', '--project', 'sandbox', '--json']);
  const data = JSON.parse(json.stdout);
  assert.equal(data.questions.length, 2);
  assert.equal(data.notes, 'Standing: never touch billing.\n');
  assert.equal(jv(['handoff', '--project', 'nope']).status, 3);
});
