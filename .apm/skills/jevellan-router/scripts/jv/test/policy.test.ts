// Policy tests: section parsing, the body hash, required sections (exit 2 naming the section), "id: text" lines,
// questions, routes, frontmatter lists, and the package's own router policy against the providers template.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-policy-test-'));
process.env.JV_HOME = home;

const P = await import('../src/policy.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
const { loadProviders, allModelIds } = await import('../src/providers.js');

after(() => rmSync(home, { recursive: true, force: true }));

function refusedWith(includes: string) {
  return (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message.includes(includes);
}

const FRONT = '---\nname: jevellan-router\ndescription: "x"\njv-needs:\n  - repo-read\n  - shell\n---\n';

function policyText(sections: Record<string, string>, prose = 'Prose for people.\n'): string {
  return `${FRONT}\n# Title\n\n${prose}\n${Object.entries(sections)
    .map(([k, v]) => `## ${k}\n${v}\n`)
    .join('\n')}`;
}

const ROUTER: Record<string, string> = {
  model: 'Choose the model.',
  'model descriptions': 'claude-opus-5-5: Strong default.\nqwen3:8b: A small local model.',
  effort: 'Choose the effort.',
  'effort guide': 'low: Short.\nhigh: Default.',
  questions:
    'needs_plan: Does this task need a written plan before implementation? true: The work spans several parts. false: A small, clear change.',
  rules: 'Rule one.\nRule two.',
};

describe('sections and hash', () => {
  test('frontmatter split, sha256 of the body, level-2 sections only', () => {
    const text = policyText(ROUTER);
    const p = P.parsePolicy('jevellan-router', text, '/x/SKILL.md');
    const body = text.slice(FRONT.length);
    assert.equal(p.body, body);
    assert.equal(p.hash, createHash('sha256').update(body).digest('hex'));
    assert.deepEqual([...p.sections.keys()], Object.keys(ROUTER));
    assert.equal(p.sections.get('rules'), 'Rule one.\nRule two.');
    assert.equal(p.sections.get('model'), 'Choose the model.');
  });

  test('headings in fenced code, level-3 headings and level-1 headings', () => {
    const body = [
      '## model',
      'Choose.',
      '```md',
      '## rules',
      'not a section',
      '```',
      '### sub heading stays in the section',
      'more',
      '# A new level-1 heading ends the section',
      'ignored prose',
      '## Effort   Guide',
      'low: x',
    ].join('\n');
    const { sections, duplicates } = P.parseSections(body);
    assert.deepEqual([...sections.keys()], ['model', 'effort guide']);
    assert.match(sections.get('model')!, /## rules\nnot a section/);
    assert.match(sections.get('model')!, /### sub heading stays in the section\nmore$/);
    assert.equal(sections.get('effort guide'), 'low: x');
    assert.deepEqual(duplicates, []);
  });

  test('the hash changes with any change to the body and not with the frontmatter', () => {
    const a = P.parsePolicy('r', policyText(ROUTER));
    const b = P.parsePolicy('r', policyText(ROUTER).replace('Rule two.', 'Rule two!'));
    const c = P.parsePolicy('r', policyText(ROUTER).replace('description: "x"', 'description: "y"'));
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.hash, c.hash);
  });
});

describe('required sections', () => {
  for (const missing of P.ROUTER_SECTIONS) {
    test(`a missing "## ${missing}" is exit 2 naming it`, () => {
      const sections = { ...ROUTER };
      delete sections[missing];
      const p = P.parsePolicy('jevellan-router', policyText(sections), '/x/SKILL.md');
      assert.throws(() => P.routerPolicy(p), refusedWith(`no "## ${missing}" section`));
    });
  }

  test('an empty or doubled section is exit 2', () => {
    const empty = P.parsePolicy('r', policyText({ ...ROUTER, effort: '' }));
    assert.throws(() => P.routerPolicy(empty), refusedWith('empty "## effort" section'));
    const doubled = P.parsePolicy('r', `${policyText(ROUTER)}\n## rules\nagain\n`);
    assert.throws(() => P.routerPolicy(doubled), refusedWith('"## rules" more than once'));
  });

  test('loadPolicy: a missing file is exit 2', () => {
    assert.throws(() => P.loadPolicy('jevellan-router'), refusedWith('is not installed'));
    assert.throws(() => P.loadRouterPolicy(join(home, 'nope.md')), refusedWith('is not installed'));
  });
});

describe('line sections', () => {
  test('id lines: ids with a colon, blank lines skipped', () => {
    const m = P.parseIdLines('claude-opus-5-5: Strong.\n\nqwen3:8b: Small: local.\n');
    assert.deepEqual([...m], [
      ['claude-opus-5-5', 'Strong.'],
      ['qwen3:8b', 'Small: local.'],
    ]);
  });

  test('a malformed line or a repeated id is exit 2 naming the section', () => {
    assert.throws(() => P.parseIdLines('just prose', '"## model descriptions"'), refusedWith('"## model descriptions": the line "just prose"'));
    assert.throws(() => P.parseIdLines('a: x\na: y', 'S'), refusedWith('a has more than one line'));
  });

  test('questions: "<id>: <question> true: ... false: ..."', () => {
    const q = P.parseQuestionLines(ROUTER.questions!);
    assert.deepEqual(q.get('needs_plan'), {
      question: 'Does this task need a written plan before implementation?',
      true: 'The work spans several parts.',
      false: 'A small, clear change.',
    });
    assert.throws(() => P.parseQuestionLines('needs_x: A question with no criteria?'), refusedWith('needs the form'));
  });

  test('routerPolicy reads every section', () => {
    const r = P.routerPolicy(P.parsePolicy('jevellan-router', policyText(ROUTER)));
    assert.equal(r.modelInstructions, 'Choose the model.');
    assert.equal(r.effortInstructions, 'Choose the effort.');
    assert.equal(r.modelDescriptions.get('qwen3:8b'), 'A small local model.');
    assert.deepEqual([...r.effortGuide.keys()], ['low', 'high']);
    assert.equal(r.rules, 'Rule one.\nRule two.');
    assert.ok(r.questions.has('needs_plan'));
  });

  test('routes of a landing policy', () => {
    const p = P.parsePolicy('jevellan-landing', policyText({ landing_route: 'Choose.', routes: 'land: Small.\nask-owner: Risky.' }));
    assert.deepEqual([...P.parseRoutes(p)], [
      ['land', 'Small.'],
      ['ask-owner', 'Risky.'],
    ]);
    const none = P.parsePolicy('jevellan-landing', policyText({ landing_route: 'Choose.' }));
    assert.throws(() => P.parseRoutes(none), refusedWith('no "## routes" section'));
  });

  test('frontmatter lists: block, inline, empty, absent', () => {
    assert.deepEqual(P.frontmatterList(FRONT, 'jv-needs'), ['repo-read', 'shell']);
    assert.deepEqual(P.frontmatterList('---\njv-needs: []\n---\n', 'jv-needs'), []);
    assert.deepEqual(P.frontmatterList('---\njv-needs: [repo-write, "shell"]\n---\n', 'jv-needs'), ['repo-write', 'shell']);
    assert.equal(P.frontmatterList('---\nname: x\n---\n', 'jv-needs'), undefined);
  });
});

describe('the package router policy', () => {
  const file = join(RUNTIME_ROOT, '..', '..', 'SKILL.md');
  const text = readFileSync(file, 'utf8');

  test('parses, keeps its frontmatter, declares the eval runner', () => {
    const r = P.routerPolicy(P.parsePolicy('jevellan-router', text, file));
    assert.match(text, /^---\nname: jevellan-router\n/);
    assert.match(text, /\ndisable-model-invocation: true\n/);
    assert.match(text, /\njv-eval-runner: evals\/run\.mjs\n/);
    assert.deepEqual([...r.effortGuide.keys()], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([...r.questions.keys()], ['needs_plan', 'needs_docs']);
    assert.ok(!text.includes('\u2014'), 'no em dash');
  });

  test('describes every model id of the providers template', () => {
    const r = P.routerPolicy(P.parsePolicy('jevellan-router', text, file));
    const ids = allModelIds(loadProviders(join(RUNTIME_ROOT, 'templates', 'providers.json')));
    const missing = ids.filter((id) => !r.modelDescriptions.has(id));
    assert.deepEqual(missing, []);
  });

  test('the brief texts are verbatim', () => {
    const r = P.routerPolicy(P.parsePolicy('jevellan-router', text, file));
    assert.equal(r.effortGuide.get('xhigh'), 'Features across many files, architecture, hard debugging, all UI work on Claude.');
    assert.equal(r.questions.get('needs_docs')!.false, 'Internal change, tests, or a fix with no user-visible behaviour change.');
    assert.match(r.rules, /^The owner builds TypeScript and JavaScript web apps and agent platforms\.\n/);
    assert.match(r.rules, /A provider above 80% of its weekly ceiling is a last resort; above the ceiling it is not in the menu\.$/);
  });

  test('loadPolicy reads ~/.jv/skills/<name>/SKILL.md', () => {
    const dir = join(home, 'skills', 'jevellan-router');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), text);
    assert.equal(P.loadRouterPolicy().policy.hash, P.parsePolicy('jevellan-router', text).hash);
  });
});

