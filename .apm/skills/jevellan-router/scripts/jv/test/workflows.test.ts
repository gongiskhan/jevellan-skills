// Workflows: resolution (single, project override, package default), validation, the steps rows, the stored
// workflow's visible flags, and the package's own workflow files.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-workflows-test-'));
process.env.JV_HOME = home;
const W = await import('../src/workflows.js');
const { JvError } = await import('../src/errors.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

const skills = join(home, 'skills');
for (const duty of ['plan', 'implement', 'verify', 'document', 'automate', 'investigate', 'answer']) {
  mkdirSync(join(skills, `jevellan-duty-${duty}`), { recursive: true });
  writeFileSync(join(skills, `jevellan-duty-${duty}`, 'SKILL.md'), `---\nname: jevellan-duty-${duty}\njv-needs: []\n---\nBody.\n`);
}
const packageSkills = join(RUNTIME_ROOT, '..', '..', '..');
for (const kind of ['feature', 'bug', 'automation']) {
  mkdirSync(join(skills, `jevellan-workflow-${kind}`), { recursive: true });
  writeFileSync(
    join(skills, `jevellan-workflow-${kind}`, 'workflow.json'),
    readFileSync(join(packageSkills, `jevellan-workflow-${kind}`, 'workflow.json'), 'utf8'),
  );
}

const refusedWith = (re: RegExp) => (e: unknown) => e instanceof JvError && e.exitCode === 2 && re.test(e.message);

test('the package workflows parse and match section 7.7', () => {
  const feature = W.resolveWorkflow({ project: 'sandbox', kind: 'feature' });
  assert.equal(feature.source, join(skills, 'jevellan-workflow-feature', 'workflow.json'));
  assert.deepEqual(feature.workflow.steps.map((s) => [s.duty, s.when]), [
    ['plan', 'jev:needs_plan'],
    ['implement', 'always'],
    ['verify', 'always'],
    ['document', 'jev:needs_docs'],
  ]);
  assert.deepEqual(feature.workflow.steps[2]!.onFail, { goto: 'implement', maxLoops: 2 });
  const bug = W.resolveWorkflow({ project: 'sandbox', kind: 'bug' });
  assert.deepEqual(bug.workflow.steps.map((s) => s.duty), ['implement', 'verify']);
  const automation = W.resolveWorkflow({ project: 'sandbox', kind: 'automation' });
  assert.deepEqual(automation.workflow.steps.map((s) => s.duty), ['plan', 'automate', 'verify']);
  assert.equal(automation.workflow.steps[2]!.onFail?.goto, 'automate');
});

test('single is one step with --duty; other kinds take no --duty', () => {
  const single = W.resolveWorkflow({ project: 'sandbox', kind: 'single', duty: 'investigate' });
  assert.equal(single.source, 'single');
  assert.deepEqual(single.workflow.steps, [{ duty: 'investigate', when: 'always', instructions: '' }]);
  assert.throws(() => W.resolveWorkflow({ project: 'sandbox', kind: 'single' }), refusedWith(/needs --duty/));
  assert.throws(() => W.resolveWorkflow({ project: 'sandbox', kind: 'single', duty: 'review' }), refusedWith(/no duty skill/));
  assert.throws(() => W.resolveWorkflow({ project: 'sandbox', kind: 'feature', duty: 'plan' }), refusedWith(/--duty is for --kind single/));
  assert.throws(() => W.resolveWorkflow({ project: 'sandbox', kind: 'chore' }), refusedWith(/unknown kind/));
});

test('a project workflow overrides the package default and may mark a step visible', () => {
  const dir = join(home, 'projects', 'sandbox', 'workflows');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'bug.json');
  writeFileSync(
    file,
    JSON.stringify({
      name: 'bug',
      steps: [
        { duty: 'implement', instructions: 'Fix it.', visible: true },
        { duty: 'verify', onFail: { goto: 'implement' } },
      ],
    }),
  );
  const r = W.resolveWorkflow({ project: 'sandbox', kind: 'bug' });
  assert.equal(r.source, file);
  assert.equal(r.workflow.steps[1]!.onFail?.maxLoops, 2, 'maxLoops defaults to 2');
  const rows = W.workflowSteps('T1234567', r.workflow);
  assert.deepEqual(
    rows.map((s) => [s.ordinal, s.duty, s.when_rule, s.on_fail_json, s.instructions]),
    [
      [1, 'implement', 'always', null, 'Fix it.'],
      [2, 'verify', 'always', '{"goto":"implement","maxLoops":2}', ''],
    ],
  );
  const stored = JSON.stringify({ ...r.workflow, source: r.source });
  assert.equal(W.stepVisible(stored, 1), true);
  assert.equal(W.stepVisible(stored, 2), false);
  assert.equal(W.storedWorkflow(stored)?.name, 'bug');
  assert.deepEqual(W.parseOnFail(rows[1]!.on_fail_json ?? null), { goto: 'implement', maxLoops: 2 });
  assert.equal(W.parseOnFail(null), undefined);
});

test('invalid workflow files are refused with the file and the problem', () => {
  const file = join(home, 'wf.json');
  assert.throws(() => W.parseWorkflow({ name: 'x', steps: [{ duty: 'implement', onfail: {} }] }, file), refusedWith(/wf\.json: steps\.0/));
  assert.throws(() => W.parseWorkflow({ name: 'x', steps: [{ duty: 'implement', when: 'sometimes' }] }, file), refusedWith(/when/));
  assert.throws(() => W.parseWorkflow({ name: 'x', steps: [] }, file), refusedWith(/steps/));
  assert.throws(
    () => W.parseWorkflow({ name: 'x', steps: [{ duty: 'verify', onFail: { goto: 'implement' } }, { duty: 'implement' }] }, file),
    refusedWith(/not this step or an earlier one/),
  );
  const dir = join(home, 'projects', 'broken', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feature.json'), '{ not json');
  assert.throws(() => W.resolveWorkflow({ project: 'broken', kind: 'feature' }), refusedWith(/not valid JSON/));
});
