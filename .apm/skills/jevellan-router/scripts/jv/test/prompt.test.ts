// What a worker receives (section 7.4): rules with placeholders, the duty body, AGENTS.md (32 KiB cut), the task block.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome, seedTask, writeSkill } from './fixtures/run-fixture.js';

const home = makeHome('jv-prompt-test-');
process.env.JV_HOME = home;
const prompt = await import('../src/prompt.js');
const { openStore } = await import('../src/store.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

const rulesFile = join(home, 'worker-rules.md');

test('placeholders are filled; unknown ones stay as written', () => {
  assert.equal(prompt.fillPlaceholders('{{project}} at {{ cwd }} {{other}}', { project: 'p', cwd: '/w' }), 'p at /w {{other}}');
  const rules = prompt.workerRules({ project: 'sandbox', cwd: '/w', branch: 'jv/x-abc', base: 'main', visible: 'not visible' }, rulesFile);
  assert.match(rules, /in the project "sandbox" at \/w\./);
  assert.match(rules, /branch jv\/x-abc, based on main\. This session is not visible\./);
  assert.throws(() => prompt.workerRules({ project: 'p', cwd: 'c', branch: 'b', base: 'm', visible: 'v' }, join(home, 'missing.md')), /missing/);
});

test('the package rules template: write duties commit, read-only duties change nothing, llm duties use the fenced block', () => {
  const file = join(RUNTIME_ROOT, 'templates', 'worker-rules.md');
  const base = { project: 'sandbox', cwd: '/w', branch: 'jv/x-abc', base: 'main', visible: 'not visible' };
  const rules = (duty: string, needs: string[]) =>
    prompt.workerRules({ ...base, ...prompt.dutyRuleValues(prompt.dutyMode(duty, needs), base.branch, base.base) }, file);
  assert.equal(prompt.dutyMode('implement', ['repo-write', 'shell']), 'write');
  assert.equal(prompt.dutyMode('plan', ['repo-read']), 'plan');
  assert.equal(prompt.dutyMode('investigate', ['repo-read']), 'read-only');
  assert.equal(prompt.dutyMode('answer', []), 'llm');
  assert.equal(prompt.dutyMode('converse', []), 'llm');

  const write = rules('implement', ['repo-write', 'shell']);
  assert.match(write, /Commit your work on this branch/);
  assert.match(write, /\.jv-evidence\//);
  assert.match(write, /End every turn with exactly one jv_report/);
  assert.equal(prompt.workerRules(base, file), write, 'the defaults are the write duties\' rules');

  for (const [duty, extra] of [['investigate', /changes nothing in this worktree/], ['plan', /writes only plan\.md at the worktree root/]] as const) {
    const text = rules(duty, ['repo-read']);
    assert.match(text, extra);
    assert.match(text, /does not commit|no commit/);
    assert.doesNotMatch(text, /Commit your work/);
    assert.doesNotMatch(text, /\.jv-evidence/);
    assert.doesNotMatch(text, /surgical tests/);
    assert.match(text, /jv_report/);
    assert.match(text, /branch jv\/x-abc, based on main/);
  }

  for (const duty of ['answer', 'converse']) {
    const text = rules(duty, []);
    assert.doesNotMatch(text, /Commit|\.jv-evidence|worktree on branch/);
    assert.match(text, /no jv_report tool in this step: end every reply with exactly one fenced json report block/);
    assert.doesNotMatch(text, /End every turn with exactly one jv_report/);
  }
  for (const text of [write, rules('investigate', ['repo-read']), rules('answer', [])]) {
    assert.doesNotMatch(text, /\{\{|\n\n\n|\n\n- (?:Write|Don't|For visual|Run only)/, 'no placeholder or blank line is left in the list');
  }
});

test('frontmatter lists: block, inline and empty', () => {
  assert.deepEqual(prompt.frontmatterList('name: x\njv-needs:\n  - repo-write\n  - shell\njv-version: 1', 'jv-needs'), ['repo-write', 'shell']);
  assert.deepEqual(prompt.frontmatterList('jv-needs: []', 'jv-needs'), []);
  assert.deepEqual(prompt.frontmatterList('jv-needs: [repo-read, "browser"]', 'jv-needs'), ['repo-read', 'browser']);
  assert.equal(prompt.frontmatterList('name: x', 'jv-needs'), undefined);
});

test('the duty skill: body after the frontmatter and its needs', () => {
  const d = prompt.loadDutySkill('implement');
  assert.equal(d.body, 'Follow plan.md.');
  assert.deepEqual(d.needs, ['repo-write', 'shell']);
  assert.equal(prompt.isReadOnly(d.needs), false);
  assert.equal(prompt.isReadOnly(prompt.loadDutySkill('investigate').needs), true);
  writeSkill(home, 'answer', [], 'Answer.');
  assert.deepEqual(prompt.loadDutySkill('answer').needs, []);
  assert.throws(() => prompt.loadDutySkill('nonexistent'), /no duty skill/);
  assert.throws(() => prompt.loadDutySkill('../x'), /unknown duty/);
});

test('AGENTS.md: whole when short, the first 32 KiB with a note when long, at a character boundary', () => {
  const dir = join(home, 'agents');
  rmSync(dir, { recursive: true, force: true });
  assert.equal(prompt.projectInstructions(dir), undefined);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nUse npm.\n');
  assert.equal(prompt.projectInstructions(dir), '# Rules\nUse npm.');
  const long = `${'a'.repeat(32 * 1024 - 1)}é${'b'.repeat(100)}`;
  writeFileSync(join(dir, 'AGENTS.md'), long);
  const cut = prompt.projectInstructions(dir)!;
  assert.ok(cut.endsWith(prompt.AGENTS_CUT_NOTE));
  const kept = cut.slice(0, cut.indexOf('\n\n['));
  assert.equal(kept, 'a'.repeat(32 * 1024 - 1));
  assert.ok(!kept.includes('�'));
});

test('the task block is exactly the shape of 7.4', () => {
  const block = prompt.taskBlock({
    task: { id: 'T3', title: 'Empty state', kind: 'feature', task_text: 'Show a message when there are no customers.' },
    position: 2,
    total: 4,
    duty: 'implement',
    instructions: 'Follow plan.md when it exists.',
    earlier: [{ duty: 'plan', status: 'done', summary: 'Add an empty state to the customers page.' }],
    plan: true,
  });
  assert.equal(
    block,
    [
      'Task T3: Empty state',
      'Kind: feature. Step 2 of 4: implement.',
      '',
      'Show a message when there are no customers.',
      '',
      'Step instructions:',
      'Follow plan.md when it exists.',
      '',
      'Earlier steps of this task:',
      '- plan (done): Add an empty state to the customers page.',
      'Plan: plan.md in the worktree root.',
    ].join('\n'),
  );
  const first = prompt.taskBlock({
    task: { id: 'T1', title: 't', kind: 'single', task_text: 'text' },
    position: 1,
    total: 1,
    duty: 'investigate',
    instructions: '',
    earlier: [],
    plan: false,
  });
  assert.equal(first, 'Task T1: t\nKind: single. Step 1 of 1: investigate.\n\ntext');
  const longSummary = prompt.taskBlock({
    task: { id: 'T1', title: 't', kind: 'bug', task_text: 'x' },
    position: 2,
    total: 2,
    duty: 'verify',
    instructions: '',
    earlier: [{ duty: 'implement', status: 'done', summary: 'z'.repeat(2000) }],
    plan: false,
  });
  const line = longSummary.split('\n').find((l) => l.startsWith('- implement'))!;
  assert.equal(line.length, '- implement (done): '.length + prompt.PREVIOUS_SUMMARY_MAX + 3);
});

test('project settings: the set ones from project.json, as their own part of the task block', () => {
  const file = join(home, 'project-settings.json');
  writeFileSync(file, JSON.stringify({ testCommand: 'npm test', devCommand: ' ', automationDir: 'automations/', guidance: 'x' }));
  const settings = prompt.projectSettings('sandbox', file);
  assert.deepEqual(settings, { testCommand: 'npm test', automationDir: 'automations/' });
  assert.deepEqual(prompt.projectSettings('sandbox', join(home, 'no-such-project.json')), {});
  writeFileSync(file, '{');
  assert.throws(() => prompt.projectSettings('sandbox', file), /not valid JSON/);
  const block = prompt.taskBlock({
    task: { id: 'T2', title: 't', kind: 'bug', task_text: 'text' },
    position: 2,
    total: 2,
    duty: 'verify',
    instructions: 'Run the tests.',
    earlier: [{ duty: 'implement', status: 'done', summary: 'Fixed.' }],
    plan: false,
    settings,
  });
  assert.equal(
    block,
    [
      'Task T2: t',
      'Kind: bug. Step 2 of 2: verify.',
      '',
      'text',
      '',
      'Step instructions:',
      'Run the tests.',
      '',
      'Project settings (project.json):',
      '- testCommand: npm test',
      '- automationDir: automations/',
      '',
      'Earlier steps of this task:',
      '- implement (done): Fixed.',
    ].join('\n'),
  );
});

test('buildSystemAppend: rules, duty body, AGENTS.md and the task block, in that order', () => {
  const store = openStore();
  try {
    const s = seedTask(store, home, { kind: 'feature', duties: ['plan', 'implement'], agents: '# Project rules\nRun npm test.\n' });
    const task = store.updateTask(s.taskId, { branch: 'jv/find-entry-abc123' });
    const plan = store.setStepState(s.stepIds[0]!, 'done', 'report done');
    const run = store.createSession({
      project_id: s.projectId,
      task_id: s.taskId,
      step_id: plan.id,
      request_id: 'req-prompt-plan',
      kind: 'step',
      runtime: 'claude-sdk',
      provider: 'claude-main',
      model: 'model-strong',
      effort: 'high',
      cwd: s.repo,
    }).row;
    const reportRow = store.createReport({ session_id: run.id, step_id: plan.id, task_id: s.taskId, status: 'done', summary: 'The plan: one file.' }).row;
    const step = store.requireStep(s.stepIds[1]!);
    const out = prompt.buildSystemAppend({
      project: store.requireProject(s.projectId),
      task,
      step,
      steps: store.listSteps(s.taskId),
      reports: new Map([[plan.id, reportRow]]),
      cwd: s.repo,
      base: 'main',
      rulesFile,
    });
    assert.equal(out.readOnly, false);
    const i = (needle: string) => out.systemAppend.indexOf(needle);
    assert.ok(i('You are working on one step') === 0);
    assert.ok(i('in the project "sandbox"') > 0);
    assert.ok(i('jv/find-entry-abc123, based on main') > 0);
    assert.ok(i('Follow plan.md.') > i('jv_report'));
    assert.ok(i('# Project rules') > i('Follow plan.md.'));
    assert.ok(i(`Task ${s.taskId}: Find the entry point`) > i('# Project rules'));
    assert.match(out.systemAppend, /Kind: feature\. Step 2 of 2: implement\./);
    assert.match(out.systemAppend, /- plan \(done\): The plan: one file\.\nPlan: plan\.md in the worktree root\.$/);
  } finally {
    store.close();
  }
});

test('the prompts and resume prefixes', () => {
  assert.equal(prompt.START_PROMPT, 'Start the step now. End with jv_report.');
  assert.equal(prompt.NO_REPORT_PROMPT, 'You ended without jv_report. Call it now with the correct status.');
  assert.equal(prompt.resumeMessage('owner', 'Use option 2.'), 'From the owner: Use option 2.');
  assert.equal(prompt.resumeMessage('answer', 'Land now'), 'From the owner: Land now');
  assert.equal(prompt.resumeMessage('coordinator', ' Keep going. '), 'From the coordinator: Keep going.');
});
