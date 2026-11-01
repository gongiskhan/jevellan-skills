// Evals tests (section 12): the export of decision rows into cases (expected from override, outcome or nothing,
// owner rows skipped, the held-out split, --since, the merge into a cases file, the default file from install.json)
// and the replay of a policy through a fake Jev (questions rebuilt from the current policy, stale and unlabelled
// cases, agreement, RESULTS.md and the threshold exit code). Runs against a temporary JV_HOME; no network.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-evals-test-'));
process.env.JV_HOME = home;

const E = await import('../src/evals.js');
const { run: evalsCommand } = await import('../src/commands/evals.js');
const { parseArgs } = await import('../src/cli.js');
const { JvError } = await import('../src/errors.js');
const { openStore } = await import('../src/store.js');
type Store = import('../src/store.js').Store;
type EvalCase = import('../src/evals.js').EvalCase;
type JevRequest = import('../src/jev/contract.js').JevRequest;
type JevResponse = import('../src/jev/contract.js').JevResponse;
type ProvidersConfig = import('../src/providers.js').ProvidersConfig;

after(() => rmSync(home, { recursive: true, force: true }));

// ---- fixtures -------------------------------------------------------------------------------------------------

let storeCount = 0;
function freshStore(): Store {
  return openStore({ file: join(home, `store-${++storeCount}.sqlite`) });
}

const MENU = [
  { id: 'claude-opus-5-5', label: 'Opus', provider: 'claude-main', runtime: 'claude-sdk', efforts: ['low', 'medium', 'high', 'max'], description: 'old opus text' },
  { id: 'gpt-6-astra', label: 'GPT', provider: 'codex', runtime: 'codex', efforts: ['low', 'medium', 'high', 'xhigh'], description: 'old gpt text' },
];
const MODEL_KEYS = { opus: 'Opus via claude-main (claude-sdk)', gpt: 'GPT via codex (codex)' };

function placementState(attempt = 1): Record<string, unknown> {
  return {
    project: { name: 'demo', guidance: '' },
    task: { id: 'T000001', kind: 'feature', title: 'Demo', text: 'Do the demo thing.', parent: null, visible: false },
    step: { ordinal: 1, duty: 'implement', instructions: '', attempt, previous: [] },
    duty: { needs: ['repo-write', 'shell'], runtimes: ['claude-sdk', 'claude-tmux', 'codex'] },
    menu: { models: structuredClone(MENU), providers: [] },
    history: { recent: [] },
    rules: 'old rules',
  };
}

const placementQuestions = {
  model: { type: 'choice', instructions: 'old model instructions', criteria: { [MODEL_KEYS.opus]: 'old opus text', [MODEL_KEYS.gpt]: 'old gpt text' } },
  effort: { type: 'choice', instructions: 'old effort instructions', criteria: { medium: 'old medium', high: 'old high' } },
};

function placementAnswers(model: 'opus' | 'gpt', effort: string, tie = false): string {
  const other = model === 'opus' ? 'gpt' : 'opus';
  return JSON.stringify({
    model: { type: 'choice', choice: MODEL_KEYS[model], probabilities: { [MODEL_KEYS[model]]: tie ? 0.5 : 0.8, [MODEL_KEYS[other]]: tie ? 0.5 : 0.2 }, confidence: 0.8 },
    effort: { type: 'choice', choice: effort, probabilities: { [effort]: 0.7, [effort === 'high' ? 'medium' : 'high']: 0.3 }, confidence: 0.7 },
  });
}

interface Fixture {
  projectId: string;
  taskId: string;
  stepId: string;
}

function project(store: Store): Fixture {
  const p = store.createProject({ name: `demo-${storeCount}`, path: `/tmp/demo-${storeCount}`, default_branch: 'main' }).row;
  const t = store.createTask({ project_id: p.id, request_id: `req-${Math.random()}`, kind: 'feature', title: 'Demo', task_text: 'Do the demo thing.', workflow_json: '{}' }).row;
  const s = store.createStep({ task_id: t.id, ordinal: 1, duty: 'implement' }).row;
  return { projectId: p.id, taskId: t.id, stepId: s.id };
}

function newTask(store: Store, f: Fixture): string {
  return store.createTask({ project_id: f.projectId, request_id: `req-${Math.random()}`, kind: 'feature', title: 'Demo', task_text: 'x', workflow_json: '{}' }).row.id;
}

interface RowInput {
  kind?: 'placement' | 'workflow' | 'landing';
  state?: Record<string, unknown>;
  questions?: Record<string, unknown>;
  answers?: string;
  chosen?: Record<string, unknown>;
  jevModel?: string;
  outcome?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  taskId?: string;
}

function decision(store: Store, f: Fixture, input: RowInput = {}): string {
  const kind = input.kind ?? 'placement';
  const row = store.createDecision({
    kind,
    project_id: f.projectId,
    task_id: input.taskId ?? f.taskId,
    step_id: kind === 'placement' ? f.stepId : null,
    skill_name: kind === 'landing' ? 'jevellan-landing' : 'jevellan-router',
    skill_hash: 'h',
    jev_model: input.jevModel ?? 'jev-1.14.0',
    state_json: JSON.stringify(input.state ?? placementState()),
    questions_json: JSON.stringify(input.questions ?? placementQuestions),
    answers_json: input.answers ?? placementAnswers('opus', 'high'),
    chosen_json: JSON.stringify(input.chosen ?? { source: 'jev', model: 'claude-opus-5-5', effort: 'high' }),
    outcome_json: input.outcome === undefined ? JSON.stringify({ status: 'done', attempts: 1, durationMs: 1000, costUsd: 0.1 }) : input.outcome && JSON.stringify(input.outcome),
    override_json: input.override ? JSON.stringify(input.override) : null,
    override_mode: input.override ? 'undo' : null,
    latency_ms: 10,
    usage_json: '{}',
  });
  return row.id;
}

function byDecision(cases: readonly EvalCase[], id: string): EvalCase {
  const c = cases.find((x) => x.decisionId === id);
  assert.ok(c, `no case for ${id}`);
  return c;
}

// ---- export rules -------------------------------------------------------------------------------------------

describe('export rules', () => {
  test('expected comes from the override, else from Jev on a first-attempt success, else null for a failure', () => {
    const store = freshStore();
    try {
      const f = project(store);
      const outcome = decision(store, f, { answers: placementAnswers('gpt', 'medium'), chosen: { source: 'jev', model: 'gpt-6-astra', effort: 'medium' } });
      const override = decision(store, f, { override: { source: 'owner', runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'max' } });
      const failed = decision(store, f, { outcome: { status: 'failed', attempts: 1 } });
      const retried = decision(store, f, { outcome: { status: 'done', attempts: 2 } });
      const retryPlacement = decision(store, f, { state: placementState(2), outcome: { status: 'done', attempts: 2 } });
      const { cases } = E.exportCases(store, 'route');

      const o = byDecision(cases, outcome);
      assert.equal(o.source, 'outcome');
      assert.deepEqual(o.expected, { model: 'gpt-6-astra', effort: 'medium' }, 'the model option maps back to the model id');
      assert.equal(o.kind, 'placement');
      assert.equal(o.id, outcome);
      assert.deepEqual(o.questions, placementQuestions);
      assert.equal((o.state.task as { id: string }).id, 'T000001');

      const v = byDecision(cases, override);
      assert.equal(v.source, 'override');
      assert.deepEqual(v.expected, { model: 'claude-opus-5-5', effort: 'max' }, 'only the questions that were asked');

      assert.deepEqual([byDecision(cases, failed).source, byDecision(cases, failed).expected], ['failed', null]);
      assert.deepEqual([byDecision(cases, retried).source, byDecision(cases, retried).expected], ['failed', null], 'done only after another attempt');
      assert.equal(byDecision(cases, retryPlacement).source, 'outcome', 'a retry placement done on the attempt it was made for');
    } finally {
      store.close();
    }
  });

  test('owner rows, rows that asked nothing, pending and stopped outcomes are skipped', () => {
    const store = freshStore();
    try {
      const f = project(store);
      decision(store, f, { jevModel: 'none', chosen: { source: 'owner', model: 'claude-opus-5-5', effort: 'high' }, questions: {}, answers: '{}' });
      decision(store, f, { chosen: { source: 'owner', model: 'claude-opus-5-5', effort: 'high' } });
      decision(store, f, { questions: {}, answers: '{}' });
      decision(store, f, { outcome: null });
      decision(store, f, { outcome: { status: 'stopped', attempts: 1 } });
      const kept = decision(store, f);
      const { cases, skipped } = E.exportCases(store, 'route');
      assert.deepEqual(cases.map((c) => c.decisionId), [kept]);
      assert.deepEqual(skipped, { owner: 2, 'nothing-asked': 1, pending: 1, stopped: 1, unreadable: 0 });
    } finally {
      store.close();
    }
  });

  test('a tie resolves to Jev\'s choice, as the router does', () => {
    const store = freshStore();
    try {
      const f = project(store);
      const id = decision(store, f, { answers: placementAnswers('gpt', 'high', true) });
      assert.equal(byDecision(E.exportCases(store, 'route').cases, id).expected?.model, 'gpt-6-astra');
    } finally {
      store.close();
    }
  });

  test('workflow rows: Jev\'s noul answers, labelled by the task\'s end; landing rows by the landing', () => {
    const store = freshStore();
    try {
      const f = project(store);
      const wfQuestions = {
        needs_plan: { type: 'noul', instructions: 'old', criteria: { true: 'a', false: 'b' } },
        needs_docs: { type: 'noul', instructions: 'old', criteria: { true: 'a', false: 'b' } },
      };
      const wfAnswers = JSON.stringify({ needs_plan: { type: 'noul', noul: 0.2 }, needs_docs: { type: 'noul', noul: 0.5 } });
      const wfState = { project: { name: 'demo', guidance: '' }, task: { id: 'T', kind: 'feature', title: 'x', text: 'y', parent: null, visible: false }, rules: 'old' };
      const doneTask = newTask(store, f);
      const failedTask = newTask(store, f);
      const runningTask = newTask(store, f);
      store.setTaskState(doneTask, 'done', 'test');
      store.setTaskState(failedTask, 'failed', 'test');
      store.setTaskState(runningTask, 'running', 'test');
      const wf = { kind: 'workflow' as const, state: wfState, questions: wfQuestions, answers: wfAnswers, chosen: { answers: {} }, outcome: null };
      const wfDone = decision(store, f, { ...wf, taskId: doneTask });
      const wfFailed = decision(store, f, { ...wf, taskId: failedTask });
      decision(store, f, { ...wf, taskId: runningTask });

      const route = E.exportCases(store, 'route');
      assert.deepEqual(byDecision(route.cases, wfDone).expected, { needs_plan: false, needs_docs: true }, 'noul is true at 0.5');
      assert.equal(byDecision(route.cases, wfFailed).source, 'failed');
      assert.equal(route.skipped.pending, 1);

      const landQuestions = { landing_route: { type: 'choice', instructions: 'old', criteria: { land: 'a', 'verify-then-land': 'b', 'ask-owner': 'c' } } };
      const landAnswers = JSON.stringify({ landing_route: { type: 'choice', choice: 'land', probabilities: { land: 0.7, 'verify-then-land': 0.2, 'ask-owner': 0.1 }, confidence: 0.7 } });
      const land = { kind: 'landing' as const, state: { title: 'x', rules: 'old' }, questions: landQuestions, answers: landAnswers, chosen: { route: 'land' }, outcome: null };
      const landed = decision(store, f, land);
      const checksFailed = decision(store, f, land);
      const asked = decision(store, f, land);
      const ownerRoute = decision(store, f, { ...land, override: { route: 'ask-owner' } });
      store.setLandingState(store.createLanding({ task_id: f.taskId, decision_id: landed, route: 'land' }).id, 'landed', 'test');
      store.setLandingState(store.createLanding({ task_id: f.taskId, decision_id: checksFailed, route: 'land' }).id, 'failed', 'checks failed');
      store.setLandingState(store.createLanding({ task_id: f.taskId, decision_id: asked, route: 'land' }).id, 'asked', 'test');

      const landing = E.exportCases(store, 'landing');
      assert.deepEqual(byDecision(landing.cases, landed).expected, { landing_route: 'land' });
      assert.equal(byDecision(landing.cases, landed).source, 'outcome');
      assert.equal(byDecision(landing.cases, checksFailed).source, 'failed');
      assert.deepEqual(byDecision(landing.cases, ownerRoute).expected, { landing_route: 'ask-owner' });
      assert.equal(landing.skipped.pending, 1);
      assert.ok(landing.cases.every((c) => c.kind === 'landing'));
      assert.ok(route.cases.every((c) => c.kind !== 'landing'), 'route holds placement and workflow only');
    } finally {
      store.close();
    }
  });
});

// ---- held-out ---------------------------------------------------------------------------------------------------

describe('held-out tagging', () => {
  test('every fifth case by creation order is held-out, and --since keeps each decision\'s split', () => {
    const store = freshStore();
    try {
      const f = project(store);
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        if (i === 3) decision(store, f, { jevModel: 'none', chosen: { source: 'owner' } }); // not counted
        ids.push(decision(store, f));
      }
      ids.forEach((id, i) => store.db.prepare('UPDATE decisions SET created_at = ? WHERE id = ?').run(`2026-10-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`, id));
      const all = E.exportCases(store, 'route').cases;
      assert.deepEqual(
        all.filter((c) => c.split === 'held-out').map((c) => c.decisionId),
        [ids[4], ids[9]],
      );
      const since = E.exportCases(store, 'route', { since: '2026-10-18' }).cases;
      assert.deepEqual(since.map((c) => c.decisionId), ids.slice(8));
      assert.deepEqual(since.filter((c) => c.split === 'held-out').map((c) => c.decisionId), [ids[9]]);
    } finally {
      store.close();
    }
  });

  test('splitAt', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(E.splitAt), ['dev', 'dev', 'dev', 'dev', 'held-out', 'dev', 'held-out']);
  });
});

// ---- merge ------------------------------------------------------------------------------------------------------

function mkCase(id: string, over: Partial<EvalCase> = {}): EvalCase {
  return { id, kind: 'placement', state: {}, questions: {}, expected: { effort: 'high' }, source: 'outcome', decisionId: id, split: 'dev', ...over };
}

describe('merge', () => {
  test('hand cases stay, exported cases replace by decisionId, older exports stay, a person\'s label survives', () => {
    const existing = [
      mkCase('hand-1', { source: 'hand', decisionId: null, note: 'kept' }),
      mkCase('D1', { expected: { effort: 'low' } }),
      mkCase('D2', { source: 'failed', expected: { effort: 'max' }, note: 'labelled by the owner' }),
      mkCase('D3'),
    ];
    const exported = [mkCase('D1', { expected: { effort: 'medium' } }), mkCase('D2', { source: 'failed', expected: null }), mkCase('D4', { split: 'held-out' })];
    const merged = E.mergeCases(existing, exported);
    assert.deepEqual(merged.map((c) => c.id), ['hand-1', 'D1', 'D2', 'D3', 'D4']);
    assert.equal(merged[0]!.note, 'kept');
    assert.deepEqual(merged[1]!.expected, { effort: 'medium' });
    assert.deepEqual(merged[2]!.expected, { effort: 'max' });
    assert.equal(merged[2]!.note, 'labelled by the owner');
    assert.equal(merged[4]!.split, 'held-out');
  });

  test('a hand case with the same id is never replaced', () => {
    const merged = E.mergeCases([mkCase('hand-x', { source: 'hand', decisionId: 'D9' })], [mkCase('D9')]);
    assert.deepEqual(merged.map((c) => [c.id, c.source]), [['hand-x', 'hand'], ['D9', 'outcome']]);
  });

  test('readCasesFile refuses an invalid case and a repeated id; a missing file is empty', () => {
    const file = join(home, 'bad-cases.json');
    writeFileSync(file, JSON.stringify({ skill: 'jevellan-router', cases: [mkCase('a'), { ...mkCase('b'), split: 'test' }] }));
    assert.throws(() => E.readCasesFile(file, 'jevellan-router'), /case 2 has split test/);
    writeFileSync(file, JSON.stringify([mkCase('a'), mkCase('a')]));
    assert.throws(() => E.readCasesFile(file, 'jevellan-router'), /a is used twice/);
    assert.deepEqual(E.readCasesFile(join(home, 'missing.json'), 'jevellan-router'), { skill: 'jevellan-router', cases: [] });
  });
});

// ---- jv evals ---------------------------------------------------------------------------------------------------

interface Captured {
  data?: unknown;
  text?: string;
}

function captureIo(json: boolean): { io: import('../src/command.js').CommandIo; out: Captured } {
  const out: Captured = {};
  return {
    out,
    io: {
      json,
      result(data, text) {
        out.data = data;
        out.text = typeof text === 'function' ? text() : text;
      },
      info() {},
      warn() {},
      write() {},
    },
  };
}

describe('jv evals', () => {
  const pkg = join(home, 'pkg', '.apm', 'skills');
  const casesFile = join(pkg, 'jevellan-router', 'evals', 'cases.json');

  test('writes the package cases file found from install.json, merging with the hand cases', async () => {
    mkdirSync(join(pkg, 'jevellan-router', 'scripts', 'jv'), { recursive: true });
    writeFileSync(join(pkg, 'jevellan-router', 'SKILL.md'), '---\nname: jevellan-router\n---\n');
    writeFileSync(join(home, 'install.json'), JSON.stringify({ source: join(pkg, 'jevellan-router', 'scripts', 'jv') }));
    mkdirSync(join(pkg, 'jevellan-router', 'evals'), { recursive: true });
    writeFileSync(casesFile, JSON.stringify({ skill: 'jevellan-router', cases: [mkCase('hand-1', { source: 'hand', decisionId: null })] }));

    const store = openStore();
    let ok: string;
    try {
      const f = project(store);
      ok = decision(store, f);
      decision(store, f, { outcome: { status: 'failed', attempts: 1 } });
      decision(store, f, { jevModel: 'none', chosen: { source: 'owner' } });
    } finally {
      store.close();
    }
    const { io, out } = captureIo(false);
    assert.equal(await evalsCommand(parseArgs(['evals', 'route']), io), 0);
    const written = E.readCasesFile(casesFile, 'jevellan-router');
    assert.deepEqual(written.cases.map((c) => c.source), ['hand', 'outcome', 'failed']);
    assert.equal(written.cases[1]!.decisionId, ok);
    assert.match(out.text!, /2 cases exported/);
    assert.match(out.text!, /outcome +1 +\(dev 1, held-out 0\)/);
    assert.match(out.text!, /failed +1 +\(dev 1, held-out 0\)/);
    assert.match(out.text!, /skipped: owner 1/);
    assert.match(out.text!, /3 cases \(2 labelled\)/);

    // Again with --json: the same decisions replace themselves, nothing is added.
    const j = captureIo(true);
    await evalsCommand(parseArgs(['evals', 'route', '--json']), j.io);
    const data = j.out.data as { exported: number; total: number; file: string; totalBySource: Record<string, { dev: number }> };
    assert.equal(data.file, casesFile);
    assert.equal(data.exported, 2);
    assert.equal(data.total, 3);
    assert.equal(data.totalBySource.hand!.dev, 1);
  });

  test('--out, and the refusals', async () => {
    const out = join(home, 'out', 'landing-cases.json');
    const c = captureIo(false);
    assert.equal(await evalsCommand(parseArgs(['evals', 'landing', '--out', out, '--since', '2026-11-01']), c.io), 0);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { skill: 'jevellan-landing', cases: [] });
    await assert.rejects(evalsCommand(parseArgs(['evals', 'placement']), c.io), (e: unknown) => e instanceof JvError && e.exitCode === 2);
    await assert.rejects(evalsCommand(parseArgs(['evals', 'route', '--since', 'yesterday']), c.io), /--since needs a date/);
    writeFileSync(join(home, 'install.json'), JSON.stringify({ version: '0.1.0' }));
    await assert.rejects(evalsCommand(parseArgs(['evals', 'route']), c.io), /pass --out FILE/);
  });
});

// ---- replay -------------------------------------------------------------------------------------------------------

const ROUTER_SKILL = `---
name: jevellan-router
---

# Policy

## model
New model instructions.

## model descriptions
claude-opus-5-5: New opus text.
gpt-6-astra: New gpt text.

## effort
New effort instructions.

## effort guide
low: New low.
medium: New medium.
high: New high.

## questions
needs_plan: Plan? true: Big. false: Small.

## rules
New rules.
`;

const LANDING_SKILL = `---
name: jevellan-landing
---

## landing_route
New landing instructions.

## routes
land: Safe.
verify-then-land: Unsure.
ask-owner: Risky.

## rules
New landing rules.
`;

const providers: ProvidersConfig = { file: join(home, 'providers.json'), jev: { keyFile: join(home, 'jev.key'), model: 'jev-latest', timeoutMs: 1000 }, providers: [] };

/** A fake Jev that records each request and answers with `answer(questionId, options)`. */
function fakeJev(answer: (id: string, options: string[], state: Record<string, unknown>) => string | number) {
  const requests: JevRequest[] = [];
  return {
    requests,
    client: {
      async decide(input: JevRequest): Promise<JevResponse> {
        requests.push(input);
        const state = JSON.parse(input.state) as Record<string, unknown>;
        const answers: JevResponse['answers'] = {};
        for (const [id, q] of Object.entries(input.questions)) {
          if (q.type === 'noul') answers[id] = { type: 'noul', noul: answer(id, ['true', 'false'], state) as number };
          else if (q.type === 'choice') {
            const options = Object.keys(q.criteria);
            const pick = answer(id, options, state) as string;
            answers[id] = { type: 'choice', choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 0.7 : 0.3 / (options.length - 1)])), confidence: 0.7 };
          }
        }
        return { schema: 'jev-response-v1', model: 'jev-test-1', answers, usage: { input_tokens: 100, output_tokens: 10 } };
      },
      async models() {
        return { schema: 'jev-models-v1' as const, models: [] };
      },
    },
  };
}

function skillDir(name: string, text: string, cases: EvalCase[], threshold?: number): string {
  const dir = join(home, 'skills-under-test', name);
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
  writeFileSync(join(dir, 'evals', 'cases.json'), JSON.stringify({ skill: name, cases }));
  if (threshold !== undefined) writeFileSync(join(dir, 'evals', 'threshold.json'), JSON.stringify({ heldOut: threshold }));
  return dir;
}

describe('replay', () => {
  const placementCase = (id: string, expected: EvalCase['expected'], split: 'dev' | 'held-out' = 'dev', questions: Record<string, unknown> = placementQuestions): EvalCase => ({
    id, kind: 'placement', state: placementState(), questions, expected, source: 'hand', decisionId: null, split,
  });

  test('questions and state are rebuilt from the current policy; stale and unlabelled cases are listed, not scored', async () => {
    const withProvider = {
      ...placementQuestions,
      provider: { type: 'choice', instructions: 'old', criteria: { 'claude-main': 'claude-main: week 85% of 90%', 'claude-second': 'claude-second: week 10% of 90%' } },
    };
    const staleState = placementState();
    (staleState.menu as { models: unknown[] }).models.push({ id: 'gpt-old', label: 'Old', provider: 'codex', runtime: 'codex', efforts: ['low'] });
    const cases: EvalCase[] = [
      placementCase('p-agree', { model: 'claude-opus-5-5', effort: 'high', provider: 'claude-second' }, 'dev', withProvider),
      placementCase('p-disagree', { model: 'gpt-6-astra', effort: 'medium' }, 'held-out'),
      { ...placementCase('p-stale', { model: 'claude-opus-5-5' }), state: staleState, questions: { model: { type: 'choice', instructions: 'x', criteria: { [MODEL_KEYS.opus]: 'a', 'Old via codex (codex)': 'b' } } } },
      placementCase('p-unlabelled', null),
      { id: 'w-1', kind: 'workflow', state: { project: { name: 'd', guidance: '' }, task: { id: 'T', kind: 'feature', title: 't', text: 'x', parent: null, visible: false }, rules: 'old' }, questions: { needs_plan: {} }, expected: { needs_plan: true }, source: 'outcome', decisionId: 'D1', split: 'held-out' },
      { id: 'w-gone', kind: 'workflow', state: { rules: 'old' }, questions: { needs_review: {} }, expected: { needs_review: true }, source: 'hand', decisionId: null, split: 'dev' },
    ];
    const dir = skillDir('jevellan-router', ROUTER_SKILL, cases);
    const jev = fakeJev((id, options) => {
      if (id === 'model') return MODEL_KEYS.opus;
      if (id === 'effort') return 'high';
      if (id === 'provider') return 'claude-second';
      if (id === 'needs_plan') return 0.8;
      return options[0]!;
    });
    const run = await E.runEvals({ skillDir: dir, providers, client: jev.client, now: new Date('2026-11-01T12:00:00Z'), concurrency: 1 });

    // What Jev was sent: the current policy text, the current rules, the provider question in a second call.
    const first = jev.requests[0]!;
    assert.equal(first.model, 'jev-latest');
    assert.deepEqual(Object.keys(first.questions), ['model', 'effort']);
    const model = first.questions.model as { instructions: string; criteria: Record<string, string> };
    assert.equal(model.instructions, 'New model instructions.');
    assert.deepEqual(model.criteria, { [MODEL_KEYS.opus]: 'New opus text.', [MODEL_KEYS.gpt]: 'New gpt text.' });
    assert.deepEqual((first.questions.effort as { criteria: Record<string, string> }).criteria, { medium: 'New medium.', high: 'New high.' });
    const sent = JSON.parse(first.state) as { rules: string; menu: { models: Array<{ description: string }> } };
    assert.equal(sent.rules, 'New rules.');
    assert.deepEqual(sent.menu.models.map((m) => m.description), ['New opus text.', 'New gpt text.']);
    assert.deepEqual(Object.keys(jev.requests[1]!.questions), ['provider']);
    const wfRequest = jev.requests.find((r) => 'needs_plan' in r.questions)!;
    assert.deepEqual(wfRequest.questions.needs_plan, { type: 'noul', instructions: 'Plan?', criteria: { true: 'Big.', false: 'Small.' } });

    const status = Object.fromEntries(run.cases.map((c) => [c.id, c.status]));
    assert.deepEqual(status, { 'p-agree': 'scored', 'p-disagree': 'scored', 'p-stale': 'stale', 'p-unlabelled': 'unlabelled', 'w-1': 'scored', 'w-gone': 'stale' });
    assert.match(run.cases.find((c) => c.id === 'p-stale')!.reason!, /no line for gpt-old/);
    assert.match(run.cases.find((c) => c.id === 'w-gone')!.reason!, /no needs_review/);
    assert.deepEqual(run.agreement.model, { dev: { agreed: 1, total: 1 }, 'held-out': { agreed: 0, total: 1 }, all: { agreed: 1, total: 2 } });
    assert.deepEqual(run.agreement.all!['held-out'], { agreed: 1, total: 3 });
    assert.equal(run.heldOut.rate, 1 / 3);
    assert.equal(run.heldOut.pass, false);
    const dis = run.cases.find((c) => c.id === 'p-disagree')!.results.find((r) => r.question === 'model')!;
    assert.deepEqual([dis.expected, dis.got], ['gpt-6-astra', 'claude-opus-5-5']);
    assert.equal(dis.probabilities['claude-opus-5-5'], 0.7, 'probabilities are keyed by model id');
    assert.deepEqual(run.answeredBy, ['jev-test-1']);
    assert.equal(run.usage.calls, 4);

    const md = E.resultsMarkdown(run);
    assert.match(md, new RegExp(`Skill hash: \`${run.hash}\``));
    assert.match(md, /Date: 2026-11-01T12:00:00.000Z/);
    assert.match(md, /\| model \| 1\/1 \(100%\) \| 0\/1 \(0%\) \| 1\/2 \(50%\) \|/);
    assert.match(md, /p-disagree \(held-out, hand\) model: expected gpt-6-astra, Jev claude-opus-5-5 \[claude-opus-5-5 0.70, gpt-6-astra 0.30\]/);
    assert.match(md, /## Unlabelled\n\n- p-unlabelled/);
    assert.match(md, /p-stale: the policy's "## model descriptions" has no line for gpt-old/);
  });

  test('--split, RESULTS.md and the threshold exit code', async () => {
    const cases: EvalCase[] = [placementCase('a', { effort: 'high' }), placementCase('b', { effort: 'medium' }, 'held-out')];
    const dir = skillDir('jevellan-router', ROUTER_SKILL, cases, 0.6);
    const quiet = { out() {}, err() {} };
    const answers = (effort: string) => fakeJev((id) => (id === 'model' ? MODEL_KEYS.opus : effort)).client;
    const results = join(dir, 'evals', 'RESULTS.md');

    assert.equal(await E.runEvalsMain(dir, [], { providers, client: answers('high'), io: quiet }), 1, 'held-out 0% < 60%');
    assert.match(readFileSync(results, 'utf8'), /Held-out agreement: 0% \(threshold 60%\): FAIL/);
    assert.equal(await E.runEvalsMain(dir, [], { providers, client: answers('medium'), io: quiet }), 0);
    assert.match(readFileSync(results, 'utf8'), /Held-out agreement: 100% \(threshold 60%\): pass/);

    let printed = '';
    const code = await E.runEvalsMain(dir, ['--split', 'dev', '--json', '--results', join(home, 'r.md')], { providers, client: answers('medium'), io: { out: (t) => (printed += t), err() {} } });
    assert.equal(code, 0, 'no held-out case ran: nothing to fail');
    const json = JSON.parse(printed) as { cases: unknown[]; heldOut: { rate: null } };
    assert.equal(json.cases.length, 1);
    assert.equal(json.heldOut.rate, null);

    let err = '';
    assert.equal(await E.runEvalsMain(dir, ['--split', 'test'], { providers, client: answers('high'), io: { out() {}, err: (t) => (err += t) } }), 2);
    assert.match(err, /--split is held-out, dev \(tuning\) or all/);
  });

  test('landing cases are asked landing_route with the current routes and rules', async () => {
    const cases: EvalCase[] = [
      { id: 'l-1', kind: 'landing', state: { title: 'x', files: [], rules: 'old' }, questions: { landing_route: {} }, expected: { landing_route: 'ask-owner' }, source: 'hand', decisionId: null, split: 'held-out' },
      { id: 'l-2', kind: 'landing', state: { title: 'y' }, questions: { landing_route: {} }, expected: { landing_route: 'merge-anyway' }, source: 'hand', decisionId: null, split: 'dev' },
      placementCase('p-1', { effort: 'high' }),
    ];
    const dir = skillDir('jevellan-landing', LANDING_SKILL, cases);
    const jev = fakeJev(() => 'ask-owner');
    const run = await E.runEvals({ skillDir: dir, providers, client: jev.client });
    assert.equal(jev.requests.length, 1);
    assert.deepEqual(jev.requests[0]!.questions, {
      landing_route: { type: 'choice', instructions: 'New landing instructions.', criteria: { land: 'Safe.', 'verify-then-land': 'Unsure.', 'ask-owner': 'Risky.' } },
    });
    assert.equal((JSON.parse(jev.requests[0]!.state) as { rules: string }).rules, 'New landing rules.');
    assert.deepEqual(run.cases.map((c) => c.status), ['scored', 'stale', 'stale']);
    assert.equal(run.heldOut.rate, 1);
    assert.equal(run.skill, 'jevellan-landing');
  });

  test('a Jev failure stops the run with exit 2', async () => {
    const dir = skillDir('jevellan-router', ROUTER_SKILL, [placementCase('a', { effort: 'high' })]);
    let err = '';
    const failing = { async decide(): Promise<JevResponse> { throw new (await import('../src/jev/contract.js')).JevError('auth'); }, async models() { return { schema: 'jev-models-v1' as const, models: [] }; } };
    assert.equal(await E.runEvalsMain(dir, [], { providers, client: failing, io: { out() {}, err: (t) => (err += t) } }), 2);
    assert.match(err, /Jev: authentication failed/);
  });
});
