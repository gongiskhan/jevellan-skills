// Report contract tests (section 5): validation, the tool input schema, once-per-row writes, redaction and the row
// a long-lived MCP process writes to (D-006).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-report-test-');
process.env.JV_HOME = home;
const report = await import('../src/report.js');
const { openStore } = await import('../src/store.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);

let n = 0;
function newRun(native?: string) {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-run-${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

test('a minimal done report validates and gets its defaults', () => {
  const r = report.parseReport({ status: 'done', summary: 'All good.' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.report.changedFiles, []);
    assert.deepEqual(r.report.screenshots, []);
  }
});

test('the needs-decision rule, bounds and unknown keys are refused with a reason', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ status: 'needs-decision', summary: 's', options: [{ label: 'a' }, { label: 'b' }] }, /question/],
    [{ status: 'needs-decision', summary: 's', question: 'Which?' }, /options/],
    [{ status: 'needs-decision', summary: 's', question: 'Which?', options: [{ label: 'a' }] }, /options/],
    [{ status: 'needs-decision', summary: 's', question: 'q', options: [1, 2, 3, 4, 5].map((i) => ({ label: `o${i}` })) }, /options/],
    [{ status: 'done', summary: 'x'.repeat(4001) }, /summary/],
    [{ status: 'done', summary: '' }, /summary/],
    [{ status: 'finished', summary: 's' }, /status/],
    [{ status: 'done', summary: 's', extra: 1 }, /extra|Unrecognized/],
    [{ status: 'done', summary: 's', ownerCommands: [{ command: 'sudo x', cwd: 'relative/dir', why: 'w' }] }, /cwd/],
    [{ status: 'done', summary: 's', testsRun: { command: 'npm test', passed: 'yes', summary: '' } }, /testsRun/],
    [{ status: 'done', summary: 's', changedFiles: Array.from({ length: 201 }, (_, i) => `f${i}`) }, /changedFiles/],
  ];
  for (const [input, why] of cases) {
    const r = report.parseReport(input);
    assert.equal(r.ok, false, JSON.stringify(input).slice(0, 80));
    if (!r.ok) assert.match(r.error, why);
  }
  const full = report.parseReport({
    status: 'needs-decision',
    summary: 'Two ways to do it.',
    question: 'Which one?',
    options: [{ label: 'Land now', description: 'short' }, { label: 'Wait' }],
    testsRun: { command: 'npm test', passed: true, summary: '12 passed' },
    changedFiles: ['src/a.ts'],
    screenshots: [{ path: '.jv-evidence/a.png', caption: 'Page A, desktop' }],
    limitations: 'none',
    ownerCommands: [{ command: 'sudo systemctl restart x', cwd: 'worktree', why: 'needs root' }],
  });
  assert.equal(full.ok, true);
});

test('the tool input schema comes from zod and describes section 5', () => {
  const schema = report.reportInputJsonSchema() as {
    type: string;
    properties: Record<string, { enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required.sort(), ['status', 'summary']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.status!.enum, ['progress', 'done', 'blocked', 'needs-decision']);
  for (const k of ['question', 'options', 'testsRun', 'changedFiles', 'screenshots', 'limitations', 'ownerCommands']) {
    assert.ok(schema.properties[k], k);
  }
  assert.ok(!('$schema' in schema));
  assert.match(report.REPORT_TOOL_DESCRIPTION, /exactly once/);
});

test('writeReport records once per row, emits one report event, and a second call changes nothing', () => {
  const run = newRun();
  const first = report.writeReport(store, run.id, {
    status: 'done',
    summary: 'The app starts in src/index.ts line 3.',
    changedFiles: [],
    testsRun: { command: 'npm test', passed: true, summary: 'ok' },
  });
  assert.equal(first.outcome, 'recorded');
  assert.equal(first.text, 'Report recorded. End your turn.');
  const row = store.getReportBySession(run.id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.task_id, seeded.taskId);
  assert.equal(row.step_id, seeded.stepIds[0]);
  assert.equal(JSON.parse(row.tests_json!).passed, true);
  const events = store.listEvents(run.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'report');
  assert.equal(JSON.parse(events[0]!.payload).status, 'done');

  const second = report.writeReport(store, run.id, { status: 'blocked', summary: 'Something else.' });
  assert.equal(second.outcome, 'already-sent');
  assert.equal(second.text, 'Report already sent for this turn.');
  assert.deepEqual(store.getReportBySession(run.id), row);
  assert.equal(store.listEvents(run.id).length, 1);

  const invalidAfter = report.writeReport(store, run.id, { status: 'nope' });
  assert.equal(invalidAfter.outcome, 'already-sent');
});

test('an invalid report writes nothing and says why', () => {
  const run = newRun();
  const r = report.writeReport(store, run.id, { status: 'needs-decision', summary: 'Choose.' });
  assert.equal(r.outcome, 'invalid');
  assert.match(r.text, /question/);
  assert.equal(store.getReportBySession(run.id), undefined);
  assert.equal(store.listEvents(run.id).length, 0);
});

test('known secrets are redacted in the row and the event', () => {
  const run = newRun();
  report.writeReport(store, run.id, { status: 'blocked', summary: `The token ${FAKE_TOKEN} was refused.`, limitations: FAKE_TOKEN });
  const row = store.getReportBySession(run.id)!;
  assert.ok(!row.summary.includes(FAKE_TOKEN));
  assert.match(row.summary, /\[redacted\]/);
  assert.ok(!row.limitations!.includes(FAKE_TOKEN));
  assert.ok(!store.listEvents(run.id)[0]!.payload.includes(FAKE_TOKEN));
});

test('resolveReportSession picks the newest unreported row of the conversation', () => {
  const lone = newRun();
  assert.equal(report.resolveReportSession(store, lone.id).id, lone.id);
  const r1 = newRun('native-conv-1');
  const r2 = newRun('native-conv-1');
  const other = newRun('native-conv-2');
  assert.equal(report.resolveReportSession(store, r1.id).id, r2.id);
  report.writeReport(store, r2.id, { status: 'progress', summary: 'Halfway.' });
  // r1 never reported (an earlier turn that was lost): it is the newest row without a report now.
  assert.equal(report.resolveReportSession(store, r1.id).id, r1.id);
  report.writeReport(store, r1.id, { status: 'progress', summary: 'Old turn.' });
  const r3 = newRun('native-conv-1');
  assert.equal(report.resolveReportSession(store, r1.id).id, r3.id);
  report.writeReport(store, r3.id, { status: 'done', summary: 'Done.' });
  // Every row reported: the newest, where a write answers "already sent".
  assert.equal(report.resolveReportSession(store, r1.id).id, r3.id);
  assert.equal(report.writeReport(store, report.resolveReportSession(store, r1.id).id, { status: 'done', summary: 'x' }).outcome, 'already-sent');
  assert.equal(report.resolveReportSession(store, other.id).id, other.id);
  assert.throws(() => report.resolveReportSession(store, 'RZZZZZZ'), /no session/);
});

test('a synthesized report says so in limitations', () => {
  const run = newRun();
  const r = report.synthesizeReport(store, run.id, { status: 'blocked', summary: 'No report.', limitations: 'synthesized: no report' });
  assert.equal(r.outcome, 'recorded');
  const row = store.getReportBySession(run.id)!;
  assert.equal(row.status, 'blocked');
  assert.equal(row.limitations, 'synthesized: no report');
  const view = report.reportView(row);
  assert.equal(view.sessionId, run.id);
  assert.match(report.formatReport(view), /blocked/);
});
