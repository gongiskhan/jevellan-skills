#!/usr/bin/env node
// Phase 3 acceptance (brief section 14, phase 3): placement is a decision row, and no Jev means no placement.
//
// 1. Placement of the phase 2 investigate step through route.ts (placeStep of the installed runtime) against the
//    real Jev, on the real store and providers.json: one decisions row of kind placement with the answers'
//    probabilities, the router policy's hash and the call's latency.
// 2. The same placement in a temporary JV_HOME whose providers.json points jev.keyFile at a missing file, whose
//    secrets folder is empty and whose only provider has an empty home of its own (no secret is copied there): it
//    exits 2 with "no key configured" and writes no decisions row. This half runs in a child process because the
//    runtime resolves JV_HOME once, when paths.js loads. (The jv task create form of this check is phase 4's.)
//
// Usage: node acceptance/phase3-placement.mjs [--task T]
//   --task T   the task whose investigate step is placed (default: the newest task phase2-investigate.mjs created)
// Exit 0 when every check passes, 1 otherwise.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, JV_HOME, readStore, RUNTIME_DIST, runtimeModule, SANDBOX, SANDBOX_NAME, summary } from './lib.mjs';

const CHILD_FLAG = '--no-key-child';
const POLICY_FILE = process.env.JV_ACCEPT_POLICY || join(JV_HOME, 'skills', 'jevellan-router', 'SKILL.md');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The phase 2 task and its investigate step, read only. */
function phase2Step(taskId) {
  const db = readStore();
  try {
    const task = taskId
      ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
      : db.prepare("SELECT * FROM tasks WHERE request_id LIKE 'acceptance-phase2-%' ORDER BY created_at DESC LIMIT 1").get();
    if (!task) return undefined;
    const step = db.prepare("SELECT * FROM steps WHERE task_id = ? AND duty = 'investigate' ORDER BY ordinal LIMIT 1").get(task.id);
    return step ? { task, step } : undefined;
  } finally {
    db.close();
  }
}

// ---- part 1: real Jev ------------------------------------------------------------------------------------------

async function realPlacement(task, step) {
  const { openStore } = await runtimeModule('store.js');
  const { placeStep } = await runtimeModule('route.js');
  const { loadRouterPolicy } = await runtimeModule('policy.js');
  const store = openStore();
  let placement;
  let error;
  const before = store.listDecisions({ step_id: step.id }).length;
  try {
    placement = await placeStep({ store, taskId: task.id, stepId: step.id });
  } catch (e) {
    error = e;
  } finally {
    store.close();
  }
  if (!check('placeStep against the real Jev', placement && !error, error ? `exit ${error.exitCode ?? '?'}: ${error.message}` : placement.decisionId)) return;

  const db = readStore();
  let row;
  let count;
  try {
    row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(placement.decisionId);
    count = db.prepare('SELECT count(*) AS n FROM decisions WHERE step_id = ?').get(step.id).n;
  } finally {
    db.close();
  }
  check('one new decisions row for the step', count === before + 1, `${before} -> ${count}`);
  if (!check('decisions row in the store', !!row, placement.decisionId)) return;
  const chosen = JSON.parse(row.chosen_json);
  const answers = JSON.parse(row.answers_json);
  const questions = JSON.parse(row.questions_json);
  const usage = JSON.parse(row.usage_json);
  const policyHash = loadRouterPolicy(POLICY_FILE).policy.hash;
  const probs = (c) => Object.entries(c?.probabilities ?? {});
  const sumsToOne = (c) => Math.abs(probs(c).reduce((a, [, p]) => a + p, 0) - 1) < 0.05;

  check('kind placement', row.kind === 'placement');
  check('linked to project, task and step', row.task_id === task.id && row.step_id === step.id && row.project_id === task.project_id);
  check('skill_name jevellan-router', row.skill_name === 'jevellan-router', row.skill_name);
  check('skill_hash is the sha256 of the installed router policy body', /^[0-9a-f]{64}$/.test(row.skill_hash) && row.skill_hash === policyHash, row.skill_hash);
  check('jev_model recorded', typeof row.jev_model === 'string' && row.jev_model !== '' && row.jev_model !== 'none', row.jev_model);
  check('latency_ms recorded', Number.isInteger(row.latency_ms) && row.latency_ms > 0, `${row.latency_ms} ms`);
  check('questions model and effort asked', !!questions.model && !!questions.effort, Object.keys(questions).join(', '));
  check('answers carry probabilities', Object.keys(answers).length > 0, JSON.stringify(answers).slice(0, 160));
  check('model probabilities', chosen.choices.model.source === 'only-option' || (probs(chosen.choices.model).length > 1 && sumsToOne(chosen.choices.model)),
    probs(chosen.choices.model).map(([k, p]) => `${k} ${p}`).join(', '));
  check('effort probabilities', chosen.choices.effort.source === 'only-option' || (probs(chosen.choices.effort).length > 1 && sumsToOne(chosen.choices.effort)),
    probs(chosen.choices.effort).map(([k, p]) => `${k} ${p}`).join(', '));
  check('Jev usage recorded', (usage.input_tokens ?? 0) > 0 && Array.isArray(usage.calls) && usage.calls.length > 0,
    `${usage.calls?.length ?? 0} calls, ${usage.input_tokens} in, ${usage.output_tokens} out`);
  check('state_json under 60000 characters', row.state_json.length <= 60_000, `${row.state_json.length} characters`);
  check('placement returned matches the row',
    chosen.runtime === placement.runtime && chosen.provider === placement.provider && chosen.model === placement.model && chosen.effort === placement.effort);
  check('runtime can run investigate', ['claude-sdk', 'claude-tmux', 'codex'].includes(placement.runtime), placement.runtime);

  process.stdout.write(
    `\nPlacement ${row.id}: ${placement.runtime} ${placement.provider} ${placement.model} effort ${placement.effort}` +
      ` (Jev effort ${chosen.effortRequested}, after rules ${chosen.effortAfterRules})\n` +
      `  model:    ${chosen.choices.model.source} ${probs(chosen.choices.model).map(([k, p]) => `${k} ${p}`).join(', ')}\n` +
      `  effort:   ${chosen.choices.effort.source} ${probs(chosen.choices.effort).map(([k, p]) => `${k} ${p}`).join(', ')}\n` +
      `  provider: ${chosen.choices.provider.source} ${probs(chosen.choices.provider).map(([k, p]) => `${k} ${p}`).join(', ')}\n` +
      `  candidates: ${chosen.candidates.map((c) => `${c.name} ${c.reason}`).join(', ')}\n` +
      `  jev ${row.jev_model}, ${row.latency_ms} ms, ${usage.calls.length} calls, ${usage.input_tokens} in / ${usage.output_tokens} out, state ${row.state_json.length} characters\n\n`,
  );
}

// ---- part 2: no key, in a temporary JV_HOME --------------------------------------------------------------------

function noKeyHome(task) {
  const tmp = mkdtempSync(join(tmpdir(), 'jv-accept-nokey-'));
  mkdirSync(join(tmp, 'secrets'), { mode: 0o700 });
  mkdirSync(join(tmp, 'homes', 'claude-main'), { recursive: true });
  // The real claude-main entry's models only (labels, ids, efforts); no tokenFile, a home of its own, nothing copied.
  const real = JSON.parse(readFileSync(join(JV_HOME, 'providers.json'), 'utf8'));
  const main = real.providers.find((p) => p.name === 'claude-main');
  const providers = {
    jev: { keyFile: join(tmp, 'secrets', 'jev.key'), model: real.jev?.model ?? 'jev-latest', timeoutMs: 4000 },
    providers: [
      { name: 'claude-main', kind: 'claude-subscription', home: join(tmp, 'homes', 'claude-main'), ceilingPct: 90, models: main.models },
    ],
  };
  writeFileSync(join(tmp, 'providers.json'), `${JSON.stringify(providers, null, 2)}\n`, { mode: 0o600 });
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), CHILD_FLAG], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      JV_HOME: tmp,
      JV_ACCEPT_RUNTIME_DIST: RUNTIME_DIST,
      JV_ACCEPT_POLICY: POLICY_FILE,
      JV_ACCEPT_TASK: JSON.stringify({ title: task.title, text: task.task_text, workflow: task.workflow_json }),
    },
  });
  let result = {};
  try {
    result = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}');
  } catch {
    // reported below
  }
  check('temporary JV_HOME has an empty secrets folder', readdirSync(join(tmp, 'secrets')).length === 0);
  check('placement without the Jev key exits 2', child.status === 2, `exit ${child.status}`);
  check('the refusal says "no key configured"', /no key configured/.test(child.stderr), child.stderr.trim());
  check('the provider was eligible (the refusal is the key, not the menu)', result.menuModels > 0, `${result.menuModels ?? 0} models in the menu`);
  check('no decisions row written', result.decisions === 0, `${result.decisions ?? '?'} rows`);
  rmSync(tmp, { recursive: true, force: true });
}

/** The child: builds the task in the temporary store and places its step. Exit code is the JvError's. */
async function noKeyChild() {
  const { openStore } = await runtimeModule('store.js');
  const { placeStep, placementContext } = await runtimeModule('route.js');
  const { loadRouterPolicy } = await runtimeModule('policy.js');
  const t = JSON.parse(process.env.JV_ACCEPT_TASK);
  const store = openStore();
  const out = { decisions: -1, menuModels: 0 };
  let code = 0;
  try {
    const project = store.createProject({ name: SANDBOX_NAME, path: SANDBOX, default_branch: 'main' }).row;
    const task = store.createTask({
      project_id: project.id, request_id: 'acceptance-phase3-nokey', kind: 'single', title: t.title, task_text: t.text, workflow_json: t.workflow,
    }).row;
    const step = store.createStep({ task_id: task.id, ordinal: 1, duty: 'investigate' }).row;
    store.setMeta('provider_auth:claude-main', JSON.stringify({ auth: 'ready', observedAt: new Date().toISOString(), detail: 'acceptance fixture' }));
    const input = { store, taskId: task.id, stepId: step.id, policy: loadRouterPolicy(process.env.JV_ACCEPT_POLICY), needs: ['repo-read'], rules: [], guidance: '' };
    out.menuModels = placementContext(input).menu.models.length;
    try {
      await placeStep(input);
      process.stderr.write('placement succeeded without a key\n');
      code = 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      code = typeof error.exitCode === 'number' ? error.exitCode : 1;
    }
    out.decisions = store.listDecisions({}).length;
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return code;
}

async function main() {
  if (process.argv.includes(CHILD_FLAG)) return noKeyChild();
  process.stdout.write(`phase 3 acceptance\nJV_HOME ${JV_HOME}\npolicy ${POLICY_FILE}\n\n`);
  const found = phase2Step(arg('--task'));
  if (!check('the phase 2 investigate step', !!found, found ? `task ${found.task.id} step ${found.step.id}` : 'run acceptance/phase2-investigate.mjs first')) {
    return summary();
  }
  await realPlacement(found.task, found.step);
  noKeyHome(found.task);
  return summary();
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`phase 3 acceptance crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
