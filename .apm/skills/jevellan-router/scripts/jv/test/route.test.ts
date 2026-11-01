// Router tests: placement through a fake Jev (no network), ties, ceiling exclusion, effort mapping, the state cap,
// Jev failures (exit 2, nothing written), the provider question, workflow questions, owner rules and the owner's
// placement. Runs against a temporary JV_HOME with its own providers.json, policy and duty skills.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-route-test-'));
process.env.JV_HOME = home;

const R = await import('../src/route.js');
const Pol = await import('../src/policy.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
const { loadProviders, recordProviderAuth } = await import('../src/providers.js');
const { openStore } = await import('../src/store.js');
type Store = import('../src/store.js').Store;
type JevQuestions = import('../src/jev/contract.js').JevQuestions;

after(() => rmSync(home, { recursive: true, force: true }));

const JEV_KEY = 'jev-test-key-value-0123456789';

// ---- fixtures -------------------------------------------------------------------------------------------------

const providersJson = {
  jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-latest', timeoutMs: 4000 },
  providers: [
    {
      name: 'claude-main',
      kind: 'claude-subscription',
      home: '~/.jv/homes/claude-main',
      ceilingPct: 90,
      models: [
        { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'max'] },
        { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] },
      ],
    },
    { name: 'claude-second', kind: 'claude-subscription', home: '~/.jv/homes/claude-second', ceilingPct: 90, models: 'same as claude-main' },
    {
      name: 'codex',
      kind: 'codex-subscription',
      home: '~/.jv/homes/codex',
      ceilingPct: 90,
      models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['low', 'medium', 'high', 'xhigh'] }],
    },
    {
      name: 'deepseek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      keyFile: '~/.jv/secrets/deepseek.key',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek', efforts: ['low', 'medium', 'high'], maxTokens: 8192 }],
    },
  ],
};

const policyFile = join(home, 'skills', 'jevellan-router', 'SKILL.md');
const packagePolicy = readFileSync(join(RUNTIME_ROOT, '..', '..', 'SKILL.md'), 'utf8');

function writeFixtures(): void {
  mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'secrets', 'jev.key'), `${JEV_KEY}\n`, { mode: 0o600 });
  chmodSync(join(home, 'secrets', 'jev.key'), 0o600);
  writeFileSync(join(home, 'secrets', 'deepseek.key'), 'deepseek-test-key-0123456789\n', { mode: 0o600 });
  chmodSync(join(home, 'secrets', 'deepseek.key'), 0o600);
  for (const p of ['claude-main', 'claude-second', 'codex']) mkdirSync(join(home, 'homes', p), { recursive: true });
  writeFileSync(join(home, 'providers.json'), JSON.stringify(providersJson, null, 2));
  mkdirSync(join(home, 'skills', 'jevellan-router'), { recursive: true });
  writeFileSync(policyFile, packagePolicy);
  const duties: Record<string, string> = {
    investigate: 'jv-needs:\n  - repo-read',
    implement: 'jv-needs:\n  - repo-write\n  - shell',
    plan: 'jv-needs:\n  - repo-read',
    document: 'jv-needs:\n  - repo-write',
    answer: 'jv-needs: []',
  };
  for (const [duty, needs] of Object.entries(duties)) {
    mkdirSync(join(home, 'skills', `jevellan-duty-${duty}`), { recursive: true });
    writeFileSync(join(home, 'skills', `jevellan-duty-${duty}`, 'SKILL.md'), `---\nname: jevellan-duty-${duty}\n${needs}\n---\nBody.\n`);
  }
}
writeFixtures();

// ---- fake Jev ---------------------------------------------------------------------------------------------------

interface SeenRequest {
  url: string;
  auth: string | null;
  model: string;
  state: string;
  questions: JevQuestions;
}

type Answerer = (questions: JevQuestions, state: unknown) => Record<string, unknown>;

let seen: SeenRequest[] = [];

let modelsSeen: Array<{ url: string; auth: string | null }> = [];

function fakeFetch(answer: Answerer, options: { status?: number; body?: string; models?: string[] } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body === undefined) {
      // GET /v1/models: the reachability check of a placement with nothing to ask.
      modelsSeen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (options.status) return new Response('nope', { status: options.status });
      const models = (options.models ?? ['jev-latest']).map((name) => ({ name, description: '', release_date: '2026-10-01' }));
      return new Response(JSON.stringify({ models }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = JSON.parse(String(init?.body)) as { model: string; state: string; questions: JevQuestions };
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get('authorization'), model: body.model, state: body.state, questions: body.questions });
    if (options.status) return new Response('nope', { status: options.status });
    if (options.body !== undefined) return new Response(options.body, { status: 200 });
    return new Response(
      JSON.stringify({ model: 'jev-test-1', answers: answer(body.questions, JSON.parse(body.state)), usage: { input_tokens: 100, output_tokens: 5 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

/** A choice answer giving `pick` (a predicate over criteria keys) the highest probability. */
function choice(questions: JevQuestions, id: string, pick: (key: string) => boolean, probs?: Record<string, number>) {
  const q = questions[id]!;
  assert.equal(q.type, 'choice');
  const keys = Object.keys(q.criteria as Record<string, string>);
  const chosen = keys.find(pick);
  assert.ok(chosen, `no option of ${id} matches; options: ${keys.join(' | ')}`);
  const probabilities =
    probs ?? Object.fromEntries(keys.map((k) => [k, k === chosen ? 0.7 : Number((0.3 / (keys.length - 1)).toFixed(6))]));
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (!probs && Math.abs(sum - 1) > 0.01) probabilities[chosen] = probabilities[chosen]! + (1 - sum);
  return { type: 'choice', choice: chosen, probabilities, confidence: 0.7 };
}

/** Answers the questions present: model by label, effort by name, provider by name. */
function answers(model: string, effort: string, provider?: string): Answerer {
  return (questions) => {
    const out: Record<string, unknown> = {};
    if (questions.model) out.model = choice(questions, 'model', (k) => k.startsWith(`${model} via `));
    if (questions.effort) out.effort = choice(questions, 'effort', (k) => k === effort);
    if (questions.provider) out.provider = choice(questions, 'provider', (k) => k === (provider ?? Object.keys(questions.provider!.criteria)[0]));
    return out;
  };
}

// ---- store fixtures ---------------------------------------------------------------------------------------------

let store: Store;
let counter = 0;

function freshStore(): Store {
  store?.close();
  const s = openStore({ file: join(home, `store-${++counter}.sqlite`) });
  for (const name of ['claude-main', 'claude-second', 'codex', 'deepseek']) {
    recordProviderAuth(s, name, { auth: 'ready', observedAt: new Date().toISOString() });
  }
  return s;
}

function makeTask(
  s: Store,
  opts: { duty?: string; kind?: 'feature' | 'bug' | 'automation' | 'single'; text?: string; title?: string; visible?: boolean; steps?: Array<{ duty: string; when?: string }> } = {},
) {
  const project = s.getProjectByName('sandbox') ?? s.createProject({ name: 'sandbox', path: home, default_branch: 'main' }).row;
  const task = s.createTask({
    project_id: project.id,
    request_id: `req-${++counter}`,
    kind: opts.kind ?? 'single',
    title: opts.title ?? 'Find where customers are listed',
    task_text: opts.text ?? 'Which file renders the customers page, and where does its data come from?',
    workflow_json: '{}',
    visible: opts.visible ?? false,
  }).row;
  const steps = (opts.steps ?? [{ duty: opts.duty ?? 'investigate' }]).map(
    (st, i) => s.createStep({ task_id: task.id, ordinal: i + 1, duty: st.duty, when_rule: st.when ?? 'always', instructions: `Do ${st.duty}.` }).row,
  );
  return { project, task, steps, step: steps[0]! };
}

const providers = () => loadProviders();

function refusedWith(includes: string) {
  return (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message.includes(includes);
}

beforeEach(() => {
  seen = [];
  modelsSeen = [];
  store = freshStore();
});

// ---- tests ------------------------------------------------------------------------------------------------------

describe('mapEffort and duties', () => {
  test('mapEffort: the lowest supported at or above, else the highest', () => {
    assert.equal(R.mapEffort('xhigh', ['low', 'medium', 'high', 'max']), 'max');
    assert.equal(R.mapEffort('high', ['low', 'medium']), 'medium');
    assert.equal(R.mapEffort('low', ['medium', 'high']), 'medium');
    assert.equal(R.mapEffort('high', ['high', 'low', 'high']), 'high');
    assert.throws(() => R.mapEffort('high', []), refusedWith('no supported effort'));
    assert.throws(() => R.mapEffort('high', ['ultra']), refusedWith('unknown effort ultra'));
  });

  test('needs to runtimes, runtimes to kinds, implied runtime', () => {
    assert.deepEqual(R.dutyRuntimes('answer', []), ['llm']);
    assert.deepEqual(R.dutyRuntimes('converse', ['repo-read']), ['llm']);
    assert.deepEqual(R.dutyRuntimes('implement', ['repo-write', 'shell']), ['claude-sdk', 'claude-tmux', 'codex']);
    assert.throws(() => R.dutyRuntimes('implement', ['teleport']), refusedWith('unknown jv-needs: teleport'));
    assert.deepEqual(R.kindsForRuntimes(['llm']).sort(), ['claude-endpoint', 'claude-subscription', 'openai-compatible']);
    assert.deepEqual(R.kindsForRuntimes(['claude-sdk', 'claude-tmux', 'codex']).sort(), ['claude-endpoint', 'claude-subscription', 'codex-subscription']);
    assert.equal(R.impliedRuntime('claude-subscription', ['claude-sdk', 'claude-tmux', 'codex'], false), 'claude-sdk');
    assert.equal(R.impliedRuntime('claude-endpoint', ['claude-sdk', 'claude-tmux', 'codex'], true), 'claude-tmux');
    assert.equal(R.impliedRuntime('codex-subscription', ['claude-sdk', 'claude-tmux', 'codex'], true), 'codex');
    assert.equal(R.impliedRuntime('claude-subscription', ['llm'], true), 'llm');
    assert.deepEqual(R.loadDutyNeeds('implement'), ['repo-write', 'shell']);
    assert.throws(() => R.loadDutyNeeds('dance'), refusedWith('no duty dance'));
  });
});

describe('placement', () => {
  test('a placement is one decision row with every column, model and effort in one call, then the provider', async () => {
    const { task, step, project } = makeTask(store);
    const placed = await R.placeStep({
      store,
      taskId: task.id,
      stepId: step.id,
      fetch: fakeFetch(answers('Opus', 'xhigh', 'claude-second')),
    });
    assert.deepEqual(
      { runtime: placed.runtime, provider: placed.provider, model: placed.model, effort: placed.effort },
      { runtime: 'claude-sdk', provider: 'claude-second', model: 'claude-opus-5-5', effort: 'max' },
    );
    // Two calls: model + effort, then provider, with the same state; the key travels only in the header.
    assert.equal(seen.length, 2);
    assert.deepEqual(Object.keys(seen[0]!.questions).sort(), ['effort', 'model']);
    assert.deepEqual(Object.keys(seen[1]!.questions), ['provider']);
    assert.equal(seen[0]!.state, seen[1]!.state);
    assert.equal(seen[0]!.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen[0]!.auth, `Bearer ${JEV_KEY}`);
    assert.equal(seen[0]!.model, 'jev-latest');
    assert.ok(!seen[0]!.state.includes(JEV_KEY));

    // Criteria texts as section 7.2 gives them.
    const policy = Pol.loadRouterPolicy();
    const mq = seen[0]!.questions.model!;
    assert.equal(mq.instructions, policy.modelInstructions);
    assert.deepEqual(mq.criteria, {
      'Opus via claude-main (claude-sdk)': policy.modelDescriptions.get('claude-opus-5-5'),
      'Haiku via claude-main (claude-sdk)': policy.modelDescriptions.get('claude-haiku-5-5'),
      'GPT via codex (codex)': policy.modelDescriptions.get('gpt-6-astra'),
    });
    const eq = seen[0]!.questions.effort!;
    assert.equal(eq.instructions, policy.effortInstructions);
    assert.deepEqual(Object.keys(eq.criteria), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal((eq.criteria as Record<string, string>).high, 'Default for implementation, planning and verification.');
    assert.deepEqual(seen[1]!.questions.provider!.criteria, {
      'claude-main': 'claude-main: week unknown of 90%, five hours unknown',
      'claude-second': 'claude-second: week unknown of 90%, five hours unknown',
    });

    // State: exactly the shape of section 7.2.
    const state = JSON.parse(seen[0]!.state);
    assert.deepEqual(Object.keys(state), ['project', 'task', 'step', 'duty', 'menu', 'history', 'rules']);
    assert.deepEqual(state.project, { name: 'sandbox', guidance: '' });
    assert.deepEqual(state.task, { id: task.id, kind: 'single', title: task.title, text: task.task_text, parent: null, visible: false });
    assert.deepEqual(state.step, { ordinal: 1, duty: 'investigate', instructions: 'Do investigate.', attempt: 1, previous: [] });
    assert.deepEqual(state.duty, { needs: ['repo-read'], runtimes: ['claude-sdk', 'claude-tmux', 'codex'] });
    assert.deepEqual(state.menu.models[0], {
      id: 'claude-opus-5-5',
      label: 'Opus',
      provider: 'claude-main',
      runtime: 'claude-sdk',
      efforts: ['low', 'medium', 'high', 'max'],
      description: policy.modelDescriptions.get('claude-opus-5-5'),
    });
    assert.deepEqual(state.menu.providers.map((p: { name: string }) => p.name), ['claude-main', 'claude-second', 'codex']);
    assert.deepEqual(state.menu.providers[0], { name: 'claude-main', weeklyPct: null, fiveHourPct: null, ceilingPct: 90, observedAt: null });
    assert.deepEqual(state.history, { recent: [] });
    assert.equal(state.rules, policy.rules);

    // The decision row.
    const d = store.getDecision(placed.decisionId)!;
    assert.equal(d.kind, 'placement');
    assert.equal(d.project_id, project.id);
    assert.equal(d.task_id, task.id);
    assert.equal(d.step_id, step.id);
    assert.equal(d.skill_name, 'jevellan-router');
    assert.equal(d.skill_hash, policy.policy.hash);
    assert.equal(d.jev_model, 'jev-test-1');
    assert.equal(d.state_json, seen[0]!.state);
    assert.deepEqual(Object.keys(JSON.parse(d.questions_json)).sort(), ['effort', 'model', 'provider']);
    const ans = JSON.parse(d.answers_json);
    assert.equal(ans.model.choice, 'Opus via claude-main (claude-sdk)');
    assert.equal(ans.provider.choice, 'claude-second');
    const chosen = JSON.parse(d.chosen_json);
    assert.equal(chosen.source, 'jev');
    assert.equal(chosen.duty, 'investigate');
    assert.equal(chosen.effortRequested, 'xhigh');
    assert.equal(chosen.effortAfterRules, 'xhigh');
    assert.equal(chosen.effort, 'max');
    assert.equal(chosen.choices.provider.source, 'jev');
    assert.equal(chosen.choices.model.probabilities['Opus via claude-main (claude-sdk)'], 0.7);
    assert.deepEqual(
      chosen.candidates.map((c: { name: string; reason: string }) => [c.name, c.reason]),
      [['claude-main', 'eligible'], ['claude-second', 'eligible'], ['codex', 'eligible'], ['deepseek', 'unsupported']],
    );
    assert.ok(d.latency_ms >= 0);
    const usage = JSON.parse(d.usage_json);
    assert.equal(usage.input_tokens, 200);
    assert.equal(usage.output_tokens, 10);
    assert.equal(usage.calls.length, 2);
    assert.equal(d.override_json, null);
    assert.equal(d.outcome_json, null);
  });

  test('the provider question is asked only when the chosen model has more than one eligible provider', async () => {
    const { task, step } = makeTask(store);
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('GPT', 'high')) });
    assert.equal(seen.length, 1);
    assert.deepEqual({ runtime: placed.runtime, provider: placed.provider, model: placed.model, effort: placed.effort }, {
      runtime: 'codex',
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
    });
    const chosen = JSON.parse(placed.decision.chosen_json);
    assert.deepEqual(chosen.choices.provider, { source: 'only-option', option: 'codex' });
  });

  test('a visible step on a Claude provider runs on claude-tmux; Haiku at high maps to medium', async () => {
    const { task, step } = makeTask(store, { visible: true });
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Haiku', 'high', 'claude-main')) });
    assert.equal(placed.runtime, 'claude-tmux');
    assert.equal(placed.effort, 'medium');
    assert.ok(Object.keys(seen[0]!.questions.model!.criteria).includes('Opus via claude-main (claude-tmux)'));
  });

  test('answer runs on llm: openai-compatible providers join, Codex leaves', async () => {
    const { task, step } = makeTask(store, { duty: 'answer' });
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('DeepSeek', 'low')) });
    assert.deepEqual([placed.runtime, placed.provider, placed.model, placed.effort], ['llm', 'deepseek', 'deepseek-chat', 'low']);
    const keys = Object.keys(seen[0]!.questions.model!.criteria);
    assert.deepEqual(keys.sort(), ['DeepSeek via deepseek (llm)', 'Haiku via claude-main (llm)', 'Opus via claude-main (llm)']);
    const state = JSON.parse(seen[0]!.state);
    assert.deepEqual(state.duty, { needs: [], runtimes: ['llm'] });
  });

  test('ties go to Jev\'s choice; otherwise the first option with the highest probability', async () => {
    const tied: Answerer = (q) => ({
      model: choice(q, 'model', (k) => k.startsWith('GPT'), {
        'Opus via claude-main (claude-sdk)': 0.4,
        'Haiku via claude-main (claude-sdk)': 0.2,
        'GPT via codex (codex)': 0.4,
      }),
      effort: choice(q, 'effort', (k) => k === 'high'),
    });
    const { task, step } = makeTask(store);
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(tied) });
    assert.equal(placed.model, 'gpt-6-astra');

    // Jev's choice within the contract's 0.011 tolerance but below the highest: the highest wins.
    const questions: JevQuestions = { m: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B', c: 'C' } } };
    const response = {
      schema: 'jev-response-v1' as const,
      model: 'jev',
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: { m: { type: 'choice' as const, choice: 'c', probabilities: { a: 0.2, b: 0.405, c: 0.395 }, confidence: 0.5 } },
    };
    assert.equal(R.resolveChoice(questions, response, 'm').option, 'b');
    response.answers.m.probabilities = { a: 0.3, b: 0.35, c: 0.35 };
    assert.equal(R.resolveChoice(questions, response, 'm').option, 'c');
    response.answers.m.choice = 'a';
    response.answers.m.probabilities = { a: 0.2, b: 0.4, c: 0.4 };
    assert.equal(R.resolveChoice(questions, response, 'm').option, 'b');
  });

  test('a provider at its ceiling is not in the menu; another serves the model', async () => {
    const resets = new Date(Date.now() + 3 * 86400_000).toISOString();
    store.recordProviderUsage({ provider: 'claude-main', source: 'probe', weekly_pct: 95, five_hour_pct: 10, weekly_resets_at: resets, five_hour_resets_at: resets });
    store.recordProviderUsage({ provider: 'claude-second', source: 'probe', weekly_pct: 48, five_hour_pct: 12, weekly_resets_at: resets, five_hour_resets_at: resets });
    const { task, step } = makeTask(store);
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high')) });
    assert.equal(placed.provider, 'claude-second');
    assert.equal(seen.length, 1, 'one eligible provider: no provider question');
    const state = JSON.parse(seen[0]!.state);
    assert.deepEqual(state.menu.providers.map((p: { name: string }) => p.name), ['claude-second', 'codex']);
    assert.equal(state.menu.providers[0].weeklyPct, 48);
    assert.equal(state.menu.providers[0].fiveHourPct, 12);
    assert.ok(Object.keys(seen[0]!.questions.model!.criteria).includes('Opus via claude-second (claude-sdk)'));
    const chosen = JSON.parse(placed.decision.chosen_json);
    assert.equal(chosen.candidates.find((c: { name: string }) => c.name === 'claude-main').reason, 'usage-ceiling');
    assert.equal(
      R.providerCriterion({ name: 'claude-second', weeklyPct: 48, fiveHourPct: 12.25, ceilingPct: 90, observedAt: null }),
      'claude-second: week 48% of 90%, five hours 12.3%',
    );
  });

  test('a provider whose last probe is not ready is out of the menu; an empty menu is exit 2', async () => {
    recordProviderAuth(store, 'codex', { auth: 'needs-login', observedAt: new Date().toISOString() });
    const { task, step } = makeTask(store);
    await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high')) });
    assert.ok(!Object.keys(seen[0]!.questions.model!.criteria).some((k) => k.startsWith('GPT')));
    for (const n of ['claude-main', 'claude-second']) recordProviderAuth(store, n, { auth: 'unknown', observedAt: new Date().toISOString() });
    await assert.rejects(
      R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high')) }),
      refusedWith('no provider can run this step'),
    );
  });

  test('a menu model without a description line is exit 2 naming it', async () => {
    const policy = Pol.routerPolicy(Pol.parsePolicy('jevellan-router', packagePolicy.replace(/^gpt-6-astra: .*\n/m, '')));
    const { task, step } = makeTask(store);
    await assert.rejects(
      R.placeStep({ store, taskId: task.id, stepId: step.id, policy, fetch: fakeFetch(answers('Opus', 'high')) }),
      refusedWith('no line in "## model descriptions" for gpt-6-astra'),
    );
    assert.equal(seen.length, 0);
  });

  test('a policy without a required section is exit 2 naming it', async () => {
    writeFileSync(policyFile, packagePolicy.replace('## effort guide', '## effort notes'));
    try {
      const { task, step } = makeTask(store);
      await assert.rejects(R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high')) }), refusedWith('no "## effort guide" section'));
    } finally {
      writeFileSync(policyFile, packagePolicy);
    }
  });

  test('previous steps, attempt, failure and history reach the state', async () => {
    const { task, steps } = makeTask(store, { kind: 'feature', steps: [{ duty: 'plan' }, { duty: 'implement' }] });
    const first = await R.placeStep({ store, taskId: task.id, stepId: steps[0]!.id, fetch: fakeFetch(answers('Opus', 'high', 'claude-main')) });
    store.setStepState(steps[0]!.id, 'running', 'started');
    const session = store.createSession({
      project_id: task.project_id, task_id: task.id, step_id: steps[0]!.id, request_id: `s-${counter}`, kind: 'step',
      runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', cwd: home,
    }).row;
    store.createReport({ session_id: session.id, step_id: steps[0]!.id, task_id: task.id, status: 'done', summary: `Plan written. ${'x'.repeat(800)}` });
    store.setStepState(steps[0]!.id, 'done', 'reported done');
    store.updateDecision(first.decisionId, { outcome_json: JSON.stringify({ status: 'done', attempts: 1, durationMs: 1000, costUsd: 0.1 }) });
    store.updateStep(steps[1]!.id, { attempts: 2 });
    seen = [];
    await R.placeStep({ store, taskId: task.id, stepId: steps[1]!.id, failure: 'verify failed: 2 tests', fetch: fakeFetch(answers('GPT', 'high')) });
    const state = JSON.parse(seen[0]!.state);
    assert.equal(state.step.attempt, 2);
    assert.equal(state.step.failure, 'verify failed: 2 tests');
    assert.equal(state.step.previous.length, 1);
    assert.equal(state.step.previous[0].duty, 'plan');
    assert.equal(state.step.previous[0].status, 'done');
    assert.equal(state.step.previous[0].summary.length, 600);
    assert.deepEqual(state.history.recent, [{ duty: 'plan', model: 'claude-opus-5-5', effort: 'high', outcome: 'done', attempts: 1 }]);
  });
});

describe('a menu with one model and one effort', () => {
  // One provider, one model, one effort: no question has two options, so nothing is asked (D-036).
  const single = () => {
    const c = providers();
    const codex = c.providers.find((p) => p.name === 'codex')!;
    return { ...c, providers: [{ ...codex, models: [{ ...codex.models[0]!, efforts: ['high'] }] }] };
  };

  test('no key: exit 2 "no key configured", no request, no decision row', async () => {
    const { task, step } = makeTask(store);
    const keyFile = join(home, 'secrets', 'jev.key');
    unlinkSync(keyFile);
    try {
      await assert.rejects(
        R.placeStep({ store, taskId: task.id, stepId: step.id, providers: single(), fetch: fakeFetch(answers('GPT', 'high')) }),
        refusedWith('no key configured'),
      );
      assert.equal(seen.length + modelsSeen.length, 0);
      assert.equal(store.listDecisions().length, 0);
    } finally {
      writeFileSync(keyFile, `${JEV_KEY}\n`, { mode: 0o600 });
    }
  });

  test('an auth error or an unlisted Jev model is exit 2 with no row', async () => {
    const { task, step } = makeTask(store);
    await assert.rejects(
      R.placeStep({ store, taskId: task.id, stepId: step.id, providers: single(), fetch: fakeFetch(answers('GPT', 'high'), { status: 401 }) }),
      refusedWith('Jev: authentication failed'),
    );
    await assert.rejects(
      R.placeStep({ store, taskId: task.id, stepId: step.id, providers: single(), fetch: fakeFetch(answers('GPT', 'high'), { models: ['jev-other'] }) }),
      refusedWith('configured model jev-latest is not listed'),
    );
    assert.equal(seen.length, 0);
    assert.equal(store.listDecisions().length, 0);
  });

  test('Jev reachable: one GET /v1/models, no decide call, the row records the check', async () => {
    const { task, step } = makeTask(store);
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, providers: single(), fetch: fakeFetch(answers('GPT', 'high')) });
    assert.deepEqual([placed.runtime, placed.provider, placed.model, placed.effort], ['codex', 'codex', 'gpt-6-astra', 'high']);
    assert.equal(seen.length, 0);
    assert.equal(modelsSeen.length, 1);
    assert.ok(modelsSeen[0]!.url.endsWith('/v1/models'));
    assert.equal(modelsSeen[0]!.auth, `Bearer ${JEV_KEY}`);
    const d = placed.decision;
    assert.equal(d.questions_json, '{}');
    assert.equal(d.answers_json, '{}');
    assert.ok(d.latency_ms >= 0);
    const usage = JSON.parse(d.usage_json);
    assert.equal(usage.calls.length, 1);
    assert.equal(usage.calls[0].check, 'GET /v1/models');
    assert.deepEqual(usage.calls[0].questions, []);
    const chosen = JSON.parse(d.chosen_json);
    assert.equal(chosen.choices.model.source, 'only-option');
    assert.equal(chosen.choices.effort.source, 'only-option');
    assert.equal(chosen.choices.provider.source, 'only-option');
    assert.ok(!d.usage_json.includes(JEV_KEY) && !d.state_json.includes(JEV_KEY));
  });
});

describe('state cap', () => {
  test('capped at 60 000 characters: history first, then the task text with the marker', async () => {
    const { task, step } = makeTask(store, { text: `Start. ${'t'.repeat(30000)} End.` });
    const guidance = 'g'.repeat(40000);
    await R.placeStep({ store, taskId: task.id, stepId: step.id, guidance, fetch: fakeFetch(answers('Opus', 'high', 'claude-main')) });
    const text = seen[0]!.state;
    assert.ok(text.length <= R.STATE_LIMIT, `${text.length}`);
    assert.ok(text.length > R.STATE_LIMIT - 20, 'the cut keeps as much text as fits');
    const state = JSON.parse(text);
    assert.ok(state.task.text.startsWith('Start. '));
    assert.ok(state.task.text.endsWith(R.TASK_SHORTENED));
    assert.equal(state.project.guidance, guidance);
  });

  test('stateJson: short states unchanged, history and previous shrink before the text, too large is exit 2', () => {
    const base = {
      project: { name: 'p', guidance: '' },
      task: { id: 'T1', kind: 'feature', title: 't', text: 'short', parent: null, visible: false },
      step: { ordinal: 2, duty: 'implement', instructions: '', attempt: 1, previous: [{ duty: 'plan', status: 'done', summary: 's'.repeat(500) }] },
      duty: { needs: [], runtimes: ['llm' as const] },
      menu: { models: [], providers: [] },
      history: { recent: Array.from({ length: 10 }, () => ({ duty: 'plan', model: 'm', effort: 'high', outcome: 'done', attempts: 1 })) },
      rules: 'r',
    };
    assert.equal(R.stateJson(base), JSON.stringify(base));
    const small = JSON.stringify(base).length;
    const cut = JSON.parse(R.stateJson(base, small - 100));
    assert.equal(cut.task.text, 'short', 'the text is shortened last');
    assert.ok(cut.history.recent.length < 10);
    assert.throws(() => R.stateJson({ ...base, rules: 'r'.repeat(200) }, 150), refusedWith('decision context exceeds the size limit'));
  });
});

describe('Jev failures: exit 2, nothing written', () => {
  test('missing key file: "no key configured"', async () => {
    const { task, step } = makeTask(store);
    const keyFile = join(home, 'secrets', 'jev.key');
    unlinkSync(keyFile);
    try {
      await assert.rejects(R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high')) }), refusedWith('no key configured'));
      assert.equal(seen.length, 0);
      assert.equal(store.listDecisions().length, 0);
    } finally {
      writeFileSync(keyFile, `${JEV_KEY}\n`, { mode: 0o600 });
    }
  });

  test('invalid response: unknown option, malformed body; auth error', async () => {
    const { task, step } = makeTask(store);
    const bad: Answerer = (q) => ({ model: { type: 'choice', choice: 'Nonexistent', probabilities: Object.fromEntries(Object.keys(q.model!.criteria).map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 1 }, effort: choice(q, 'effort', (k) => k === 'high') });
    await assert.rejects(R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(bad) }), refusedWith('Jev: invalid response'));
    await assert.rejects(R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high'), { body: '{"nope": true}' }) }), refusedWith('invalid response'));
    await assert.rejects(R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('Opus', 'high'), { status: 401 }) }), refusedWith('authentication failed'));
    assert.equal(store.listDecisions().length, 0);
  });

  test('a failure on the provider call writes nothing either', async () => {
    const { task, step } = makeTask(store);
    let calls = 0;
    const f = fakeFetch((q) => {
      calls++;
      if (q.provider) return {};
      return answers('Opus', 'high')(q, undefined);
    });
    await assert.rejects(R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: f }), refusedWith('invalid response'));
    assert.equal(calls, 2);
    assert.equal(store.listDecisions().length, 0);
  });
});

describe('workflow questions', () => {
  test('one call, a noul question per jev: rule, false skips with "Jev: not needed"', async () => {
    const { task, steps } = makeTask(store, {
      kind: 'feature',
      steps: [{ duty: 'plan', when: 'jev:needs_plan' }, { duty: 'implement' }, { duty: 'document', when: 'jev:needs_docs' }],
    });
    const f = fakeFetch(() => ({ needs_plan: { type: 'noul', noul: 0.2 }, needs_docs: { type: 'noul', noul: 0.5 } }));
    const out = await R.askWorkflowQuestions({ store, taskId: task.id, fetch: f });
    assert.equal(seen.length, 1);
    const policy = Pol.loadRouterPolicy();
    assert.deepEqual(seen[0]!.questions, {
      needs_plan: { type: 'noul', instructions: policy.questions.get('needs_plan')!.question, criteria: { true: policy.questions.get('needs_plan')!.true, false: policy.questions.get('needs_plan')!.false } },
      needs_docs: { type: 'noul', instructions: 'Does this change need documentation written for people?', criteria: { true: 'It changes how someone runs, configures or uses the project.', false: 'Internal change, tests, or a fix with no user-visible behaviour change.' } },
    });
    const state = JSON.parse(seen[0]!.state);
    assert.deepEqual(Object.keys(state), ['project', 'task', 'rules']);
    assert.deepEqual(out.answers, { needs_plan: { value: false, probability: 0.2 }, needs_docs: { value: true, probability: 0.5 } });
    assert.deepEqual(out.skip, [{ stepId: steps[0]!.id, ordinal: 1, duty: 'plan', question: 'needs_plan', reason: 'Jev: not needed' }]);
    const d = out.decision!;
    assert.equal(d.kind, 'workflow');
    assert.equal(d.task_id, task.id);
    assert.equal(d.step_id, null);
    assert.equal(JSON.parse(d.chosen_json).skip[0].duty, 'plan');
  });

  test('no jev: rule: no call, no row; an unknown question id is exit 2', async () => {
    const { task } = makeTask(store, { kind: 'bug', steps: [{ duty: 'implement' }] });
    const out = await R.askWorkflowQuestions({ store, taskId: task.id, fetch: fakeFetch(() => ({})) });
    assert.deepEqual(out, { answers: {}, skip: [] });
    assert.equal(seen.length, 0);
    const other = makeTask(store, { kind: 'feature', steps: [{ duty: 'plan', when: 'jev:needs_magic' }] });
    await assert.rejects(R.askWorkflowQuestions({ store, taskId: other.task.id, fetch: fakeFetch(() => ({})) }), refusedWith('no needs_magic line'));
  });
});

describe('owner rules', () => {
  const rulesFile = join(home, 'projects', 'sandbox', 'rules.json');
  const writeRules = (rules: unknown) => {
    mkdirSync(join(home, 'projects', 'sandbox'), { recursive: true });
    writeFileSync(rulesFile, JSON.stringify({ rules }));
  };

  test('a floor applies after Jev and is reported in the decision row', async () => {
    writeRules([
      { id: 'R1', when: { duty: 'investigate', keywords: ['customers'] }, set: { minEffort: 'xhigh' }, note: 'customer data' },
      { id: 'R2', when: { kind: 'bug' }, set: { maxEffort: 'low' } },
    ]);
    try {
      const { task, step } = makeTask(store);
      const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('GPT', 'medium')) });
      assert.equal(placed.effort, 'xhigh');
      const chosen = JSON.parse(placed.decision.chosen_json);
      assert.equal(chosen.effortRequested, 'medium');
      assert.equal(chosen.effortAfterRules, 'xhigh');
      assert.deepEqual(chosen.rules.applied, ['R1']);
      assert.equal(chosen.rules.reason, 'R1 raised effort from medium to xhigh (customer data).');
    } finally {
      rmSync(rulesFile);
    }
  });

  test('bounds, specificity and landing routes (ported semantics)', () => {
    const rules = [
      { id: 'R1', when: {}, set: { maxEffort: 'high' as const }, note: '', enabled: true },
      { id: 'R2', when: { duty: 'implement', keywords: ['migration'] }, set: { minEffort: 'xhigh' as const }, note: '', enabled: true },
      { id: 'R3', when: { kind: 'feature' as const }, set: { landingRoute: 'verify-then-land' as const }, note: '', enabled: true },
      { id: 'R4', when: { kind: 'feature' as const, keywords: ['auth'] }, set: { landingRoute: 'ask-owner' as const }, note: 'auth', enabled: true },
      { id: 'R5', when: {}, set: { minEffort: 'max' as const }, note: '', enabled: false },
    ];
    // R2 (two fields) beats R1 (none) when the floor is above the ceiling.
    const ctx = { kind: 'feature', duty: 'implement', text: 'Add a migration' };
    assert.deepEqual(R.applyEffortRules('medium', rules, ctx).effort, 'xhigh');
    assert.deepEqual(R.applyEffortRules('max', rules, { ...ctx, text: 'no keyword' }), {
      effort: 'high', minimum: 'low', maximum: 'high', rulesApplied: ['R1'], ignored: [], reason: 'R1 lowered effort from max to high.',
    });
    assert.equal(R.boundedEffort('xhigh', ['low', 'medium', 'high', 'max'], { minimum: 'low', maximum: 'high' }), 'high');
    assert.deepEqual(R.applyRouteRules('land', rules, { kind: 'feature', text: 'touches auth' }), {
      route: 'ask-owner', rulesApplied: ['R4'], reason: 'R4 changed the landing route from land to ask-owner (auth).',
    });
    assert.equal(R.applyRouteRules('land', rules, { kind: 'feature', text: 'x' }).route, 'verify-then-land');
    assert.deepEqual(R.applyRouteRules('land', rules, { kind: 'bug', text: 'x' }), { route: 'land', rulesApplied: [], reason: '' });
  });

  test('an invalid rules.json is exit 2', () => {
    writeRules([{ id: 'X1', set: { minEffort: 'high' } }]);
    try {
      assert.throws(() => R.loadOwnerRules('sandbox'), refusedWith('is not valid'));
      writeRules([{ id: 'R1', set: {} }]);
      assert.throws(() => R.loadOwnerRules('sandbox'), refusedWith('set needs minEffort'));
      writeRules([{ id: 'R1', set: { minEffort: 'high' } }, { id: 'R1', set: { maxEffort: 'high' } }]);
      assert.throws(() => R.loadOwnerRules('sandbox'), refusedWith('R1 is written twice'));
    } finally {
      rmSync(rulesFile);
    }
    assert.deepEqual(R.loadOwnerRules('sandbox'), []);
  });
});

describe('owner placement (jv task override)', () => {
  test('undo records the override and writes a source owner decision; keep only records', async () => {
    const { task, step } = makeTask(store);
    const placed = await R.placeStep({ store, taskId: task.id, stepId: step.id, fetch: fakeFetch(answers('GPT', 'medium')) });
    seen = [];
    const undo = R.ownerPlacement({ store, taskId: task.id, model: 'claude-opus-5-5', effort: 'high', mode: 'undo' });
    assert.equal(seen.length, 0, 'no Jev call');
    assert.deepEqual(undo.placement, { runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high' });
    assert.equal(undo.overridden!.id, placed.decisionId);
    assert.equal(undo.overridden!.override_mode, 'undo');
    assert.equal(JSON.parse(undo.overridden!.override_json!).model, 'claude-opus-5-5');
    const chosen = JSON.parse(undo.decision!.chosen_json);
    assert.equal(chosen.source, 'owner');
    assert.equal(chosen.overrides, placed.decisionId);
    assert.equal(undo.decision!.kind, 'placement');
    assert.equal(undo.decision!.latency_ms, 0);

    const keep = R.ownerPlacement({ store, taskId: task.id, stepId: step.id, model: 'claude-haiku-5-5', provider: 'claude-second', mode: 'keep' });
    assert.equal(keep.decision, undefined);
    assert.equal(keep.overridden!.id, undo.decision!.id);
    assert.equal(keep.overridden!.override_mode, 'keep');
    assert.deepEqual(keep.placement, { runtime: 'claude-sdk', provider: 'claude-second', model: 'claude-haiku-5-5', effort: 'medium' });
    assert.equal(store.listDecisions().length, 2);

    assert.throws(() => R.ownerPlacement({ store, taskId: task.id, model: 'deepseek-chat', mode: 'undo' }), refusedWith('no provider in'));
    assert.throws(() => R.ownerPlacement({ store, taskId: task.id, model: 'gpt-6-astra', provider: 'claude-main', mode: 'undo' }), refusedWith('model-not-served'));
    assert.throws(() => R.ownerPlacement({ store, taskId: task.id, model: 'gpt-6-astra', effort: 'ultra', mode: 'undo' }), refusedWith('unknown effort ultra'));
  });
});

describe('askJev (generic, for landing)', () => {
  test('policy hash, state, answers, and the row', async () => {
    const landing = join(home, 'skills', 'jevellan-landing');
    mkdirSync(landing, { recursive: true });
    writeFileSync(join(landing, 'SKILL.md'), '---\nname: jevellan-landing\n---\n## landing_route\nChoose.\n## routes\nland: Small.\nask-owner: Risky.\n## rules\nr\n');
    const questions: JevQuestions = { landing_route: { type: 'choice', instructions: 'Choose.', criteria: { land: 'Small.', 'ask-owner': 'Risky.' } } };
    const ex = await R.askJev('jevellan-landing', { title: 't' }, questions, {
      fetch: fakeFetch((q) => ({ landing_route: choice(q, 'landing_route', (k) => k === 'land') })),
    });
    assert.equal(ex.policy.name, 'jevellan-landing');
    assert.equal(ex.state, '{"title":"t"}');
    assert.equal(R.resolveChoice(ex.questions, ex.response, 'landing_route').option, 'land');
    const { project } = makeTask(store);
    const row = R.recordDecision(store, ex, { kind: 'landing', projectId: project.id, chosen: { route: 'land' } });
    assert.equal(row.kind, 'landing');
    assert.equal(row.skill_name, 'jevellan-landing');
    assert.equal(row.skill_hash, ex.policy.hash);
    assert.equal(JSON.parse(row.usage_json).calls.length, 1);
    await assert.rejects(R.askJev('jevellan-landing', 'x'.repeat(R.STATE_LIMIT + 1), questions, { fetch: fakeFetch(() => ({})) }), refusedWith('exceeds the size limit'));
  });
});
