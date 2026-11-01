#!/usr/bin/env node
// Phase 5 acceptance (brief sections 8 and 14, phase 5), on the disposable clone of phase 4 (JV_ACCEPT_CLONE,
// project JV_ACCEPT_PROJECT, default sandbox-clone). Never the real sandbox.
//
// jev      The route Jev chose for the phase 4 feature task (it lands by itself after its last step), end to end:
//          land -> landed on the clone's main; verify-then-land -> one extra verify step placed and run, then landed
//          (a failed verification waits on the owner and is answered "Land now"); ask-owner -> asked, then answered
//          "Land now". The landing decision row records the route.
// force    A second, small single task (implement) lands with `jv land T --force`: no Jev call, no decision row,
//          route land, landed.
// ask      The single task of phase 4's --undo check lands through the owner: a rules.json landing override for
//          single tasks (landingRoute ask-owner) makes `jv land T` ask; the task waits on the owner, the landings row
//          is asked; `jv task answer T "Land now"` lands it (the asked row is closed, reason "answered: Land now"). The
//          rule is disabled again at the end.
// main     The clone's main holds every landed commit; the real sandbox's main has not moved.
//
// Usage: JV_ACCEPT_CLONE=<clone> node acceptance/phase5-landing.mjs [--only jev,force,ask] [--tag v1] [--timeout-min 45]
//   --tag   the tag phase4-feature.mjs ran with (its request ids), also used for this script's own task.
// Exit 0 when every check passes, 1 otherwise.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  CLONE,
  CLONE_PROJECT,
  git,
  JV_HOME,
  jvJson,
  log,
  onBranch,
  query,
  queryOne,
  SANDBOX,
  SANDBOX_MAIN,
  summary,
  taskByRequest,
  waitFor,
} from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const TAG = arg('--tag', 'v1');
const ONLY = new Set(arg('--only', 'jev,force,ask').split(','));
const TIMEOUT_MS = Number(arg('--timeout-min', '45')) * 60_000;
const FEATURE_REQUEST = `acceptance-phase4-feature-${TAG}`;
const UNDO_REQUEST = `acceptance-phase4-undo-${TAG}`;
const FORCE_REQUEST = `acceptance-phase5-force-${TAG}`;
const FORCE = {
  title: 'Comment on the web server',
  text: 'Add a comment at the top of src/web/server.ts saying what the file serves',
};
const RULES_FILE = join(JV_HOME, 'projects', CLONE_PROJECT, 'rules.json');
const RULE_ID = 'R1';
const VERIFY_INSTRUCTIONS = /^Full verification before landing/;
const IN_FLIGHT = ['queued', 'running', 'landing'];
const landed = [];

const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};
const taskRow = (id) => queryOne('SELECT * FROM tasks WHERE id = ?', id);
const landingsOf = (id) => query('SELECT * FROM landings WHERE task_id = ? ORDER BY created_at, rowid', id);
const routes = (id) => landingsOf(id).map((l) => `${l.route}:${l.state}${l.decision_id ? '' : '(no decision)'}`).join(', ');

async function settle(id, timeoutMs, states = IN_FLIGHT) {
  let last = '';
  return waitFor(
    () => {
      jvJson(['status', '--project', CLONE_PROJECT]);
      const t = taskRow(id);
      const line = `${t.state}: ${t.state_reason}`;
      if (line !== last) log(`${id} ${line}`);
      last = line;
      return states.includes(t.state) ? undefined : t;
    },
    { timeoutMs, intervalMs: 15_000 },
  );
}

function answerLandNow(id) {
  const r = jvJson(['task', 'answer', id, 'Land now'], { timeoutMs: 15 * 60_000 });
  check(`jv task answer ${id} "Land now" exits 0`, r.status === 0, r.status ? `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}` : `${r.json?.landing?.state} ${r.json?.landing?.commit ?? ''}`);
  return r;
}

function landedChecks(id, label) {
  const t = taskRow(id);
  const last = landingsOf(id).at(-1);
  const ok = t.state === 'done' && !!t.landed_commit && last?.state === 'landed' && last.commit_sha === t.landed_commit;
  check(`${label}: landed, task done with landed_commit`, ok, `${t.state} ${t.landed_commit ?? 'no commit'}; ${routes(id)}; ${last?.reason ?? ''}`.slice(0, 400));
  if (t.landed_commit) {
    check(`${label}: the clone's main holds the landed commit`, onBranch(CLONE, t.landed_commit, 'refs/heads/main'), t.landed_commit.slice(0, 12));
    landed.push({ id, commit: t.landed_commit });
  }
  return ok;
}

// ---- the route Jev chose for the feature task ----------------------------------------------------------------

async function jevRoute() {
  const feature = taskByRequest(FEATURE_REQUEST);
  if (!check('the phase 4 feature task exists', !!feature, feature?.id ?? `run phase4-feature.mjs --tag ${TAG} first`)) return;
  let t = await settle(feature.id, TIMEOUT_MS);
  if (!check('the feature task leaves running and landing', !!t, t ? `${t.state}` : 'timed out')) return;
  const decision = queryOne("SELECT * FROM decisions WHERE task_id = ? AND kind = 'landing' ORDER BY created_at", feature.id);
  if (!check('a landing decision row records the route', !!decision, decision?.id ?? 'none')) return;
  const chosen = parse(decision.chosen_json, {});
  const answers = parse(decision.answers_json, {});
  const probs = answers.landing_route?.probabilities ?? chosen.probabilities ?? {};
  log(`Jev landing route for ${feature.id}: ${chosen.jevRoute} -> ${chosen.route}${chosen.ruleReason ? ` (${chosen.ruleReason})` : ''}; probabilities ${JSON.stringify(probs)}; ${decision.jev_model}, ${decision.latency_ms} ms`);
  check('the decision names a route and Jev answered', ['land', 'verify-then-land', 'ask-owner'].includes(chosen.route) && decision.jev_model !== 'none', `${chosen.route} (${decision.jev_model})`);
  const first = landingsOf(feature.id)[0];
  check('the landings row carries that decision and route', first?.decision_id === decision.id && first?.route === chosen.route, routes(feature.id));

  if (chosen.route === 'verify-then-land') {
    const extra = query('SELECT * FROM steps WHERE task_id = ? AND duty = ? ORDER BY ordinal', feature.id, 'verify').filter((s) => VERIFY_INSTRUCTIONS.test(s.instructions));
    check('verify-then-land: one extra verify step', extra.length === 1, extra.map((s) => `${s.ordinal}:${s.state}`).join(', '));
    const placed = extra[0] ? query("SELECT * FROM decisions WHERE step_id = ? AND kind = 'placement'", extra[0].id) : [];
    check('verify-then-land: the extra step was placed by Jev', placed.length >= 1 && placed[0].jev_model !== 'none', placed.map((p) => `${p.id} ${p.jev_model}`).join(', '));
    const report = extra[0] ? queryOne('SELECT * FROM reports WHERE step_id = ? ORDER BY created_at DESC', extra[0].id) : undefined;
    log(`extra verify ${extra[0]?.id}: ${report?.status} ${report?.tests_json ?? ''}`);
    if (t.state === 'waiting-owner') {
      log(`the landing verification did not pass: ${t.state_reason}; the owner answers Land now`);
      answerLandNow(feature.id);
      t = taskRow(feature.id);
    }
  } else if (chosen.route === 'ask-owner') {
    check('ask-owner: the landing is asked and the task waits on the owner', first?.state === 'asked' && t.state === 'waiting-owner', `${first?.state}; ${t.state}: ${t.state_reason}`);
    answerLandNow(feature.id);
  } else if (t.state === 'waiting-owner') {
    log(`the land route did not land: ${t.state_reason}`);
  }
  landedChecks(feature.id, `feature ${feature.id} (route ${chosen.route})`);
}

// ---- force ---------------------------------------------------------------------------------------------------

async function forced() {
  const c = jvJson(['task', 'create', '--project', CLONE_PROJECT, '--kind', 'single', '--duty', 'implement', '--title', FORCE.title, '--text', FORCE.text, '--request-id', FORCE_REQUEST], { timeoutMs: 15 * 60_000 });
  if (!check('jv task create --kind single --duty implement (force) exits 0', c.status === 0, c.status ? `exit ${c.status}: ${c.json?.error ?? c.stderr.trim()}` : c.json.task.id)) return;
  const id = c.json.task.id;
  const t = await settle(id, 25 * 60_000, ['queued', 'running']);
  if (!check('the single task finishes its step', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out')) return;
  if (!t.landed_commit) {
    const r = jvJson(['land', id, '--force'], { timeoutMs: 15 * 60_000 });
    check(`jv land ${id} --force exits 0`, r.status === 0, r.status ? `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}` : `${r.json.state}: ${r.json.reason}`);
  }
  const rows = landingsOf(id);
  check('--force: one landings row, route land, no decision', rows.length === 1 && rows[0].route === 'land' && rows[0].decision_id === null, routes(id));
  check('--force: no landing decision row (no Jev call)', query("SELECT id FROM decisions WHERE task_id = ? AND kind = 'landing'", id).length === 0);
  landedChecks(id, `forced ${id}`);
  const head = git(CLONE, ['show', `${taskRow(id).landed_commit}:src/web/server.ts`]).split('\n')[0] ?? '';
  check('the forced change is the comment at the top of src/web/server.ts', /^\s*(\/\/|\/\*)/.test(head), head.slice(0, 160));
}

// ---- ask-owner through rules.json -----------------------------------------------------------------------------

function writeRule(enabled) {
  const current = existsSync(RULES_FILE) ? JSON.parse(readFileSync(RULES_FILE, 'utf8')) : { rules: [] };
  const others = (current.rules ?? []).filter((r) => r.id !== RULE_ID);
  const rule = { id: RULE_ID, when: { kind: 'single' }, set: { landingRoute: 'ask-owner' }, note: 'acceptance phase 5: single tasks land through the owner', enabled };
  writeFileSync(RULES_FILE, `${JSON.stringify({ ...current, rules: [rule, ...others] }, null, 2)}\n`);
}

async function askOwner() {
  const task = taskByRequest(UNDO_REQUEST);
  if (!check('the phase 4 --undo task exists', !!task, task?.id ?? `run phase4-feature.mjs --tag ${TAG} first`)) return;
  const t = await settle(task.id, 25 * 60_000, ['queued', 'running']);
  if (!check('the --undo task is done with its step', t?.state === 'done' || t?.landed_commit, t ? `${t.state}: ${t.state_reason}` : 'timed out')) return;
  if (!t.landed_commit) {
    writeRule(true);
    try {
      const r = jvJson(['land', task.id], { timeoutMs: 15 * 60_000 });
      check(`jv land ${task.id} exits 0 (asked)`, r.status === 0 && r.json?.state === 'asked', r.status ? `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}` : `${r.json.state}: ${r.json.reason}`);
      const decision = queryOne("SELECT * FROM decisions WHERE task_id = ? AND kind = 'landing' ORDER BY created_at DESC", task.id);
      const chosen = parse(decision?.chosen_json, {});
      check('the rules.json override is applied after Jev and recorded', chosen.route === 'ask-owner' && (chosen.rulesApplied ?? []).some((x) => JSON.stringify(x).includes(RULE_ID)), `Jev ${chosen.jevRoute} -> ${chosen.route}; ${JSON.stringify(chosen.rulesApplied)}; ${chosen.ruleReason ?? ''}`);
      const asked = taskRow(task.id);
      check('ask-owner: task waiting-owner, landings row asked', asked.state === 'waiting-owner' && landingsOf(task.id).at(-1)?.state === 'asked', `${asked.state}: ${asked.state_reason}; ${routes(task.id)}`);
    } finally {
      writeRule(false);
    }
    answerLandNow(task.id);
  }
  const rows = landingsOf(task.id);
  check(
    'ask-owner then Land now: the asked row closed as answered, then land landed without a decision',
    rows.length === 2 && rows[0].route === 'ask-owner' && rows[0].state === 'failed' && rows[0].reason.startsWith('answered: Land now') && rows[1].route === 'land' && rows[1].state === 'landed' && rows[1].decision_id === null,
    `${routes(task.id)}; ${rows[0]?.reason ?? ''}`,
  );
  landedChecks(task.id, `asked ${task.id}`);
}

// ---- main ----------------------------------------------------------------------------------------------------

async function main() {
  if (!CLONE || !existsSync(join(CLONE, '.git'))) {
    process.stderr.write('JV_ACCEPT_CLONE must name the disposable clone of the sandbox\n');
    return 2;
  }
  log(`phase 5 acceptance; JV_HOME ${JV_HOME}; project ${CLONE_PROJECT} at ${CLONE}; tag ${TAG}`);
  const work = [];
  if (ONLY.has('force')) work.push(forced());
  if (ONLY.has('ask')) work.push(askOwner());
  if (ONLY.has('jev')) work.push(jevRoute());
  await Promise.all(work);

  const main = git(CLONE, ['log', '--oneline', '-15', 'main']);
  log(`clone main:\n${main}`);
  check(`the clone's main holds all ${landed.length} landed commits`, landed.length > 0 && landed.every((l) => onBranch(CLONE, l.commit, 'refs/heads/main')), landed.map((l) => `${l.id}@${l.commit.slice(0, 12)}`).join(', '));
  const real = git(SANDBOX, ['rev-parse', 'main']);
  check('the real sandbox main is unchanged', real === SANDBOX_MAIN, real);
  const status = jvJson(['status', '--project', CLONE_PROJECT]);
  const live = (status.json?.sessions ?? []).filter((s) => ['queued', 'starting', 'running'].includes(s.state));
  check('jv status shows no running work for the project', status.status === 0 && live.length === 0, live.map((s) => `${s.id}:${s.state}`).join(', ') || 'none');
  return summary();
}

process.exitCode = await main();
