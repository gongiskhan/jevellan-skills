#!/usr/bin/env node
// Phase 4 acceptance (brief sections 7 and 14, phase 4), on a disposable clone of the sandbox registered as its own
// jv project (JV_ACCEPT_CLONE, project JV_ACCEPT_PROJECT, default sandbox-clone). Never the real sandbox.
//
// feature  The feature workflow from task to last step: `jv task create --kind feature` prints the resolved
//          workflow file; the workflow decision answers needs_plan and needs_docs; the task gets a worktree on a jv/
//          branch; every started step has a placement decision and a report; verify reports testsRun passed; the
//          task reaches landing (which runs by itself after the last step; phase5-landing.mjs checks the route).
//          A step that asks the owner (needs-decision) is answered with its first option, at most three times.
// override `jv task override --keep` on the feature task's running step records on the decision row and the run goes
//          on; `--undo` on a second task's running step (a single implement task, landed by phase 5 through
//          ask-owner) stops it and restarts it on the owner placement claude-sonnet-5-5 low, recorded on both rows.
// no-key   In a temporary JV_HOME whose providers.json points jev.keyFile at a missing file (the real key is never
//          moved or copied), `jv task create` exits 2 with "no key configured" and leaves the task queued with its
//          step pending; pointing keyFile back at the real key file, `jv task resume` starts the step, which is
//          then stopped and discarded at once (the check is the start, not the turn).
//
// Usage: JV_ACCEPT_CLONE=<clone> node acceptance/phase4-feature.mjs [--only feature,override,no-key] [--tag v1]
//        [--timeout-min 45]
//   --tag   suffix of the request ids, so a rerun returns the same tasks; a new tag creates new ones.
// Exit 0 when every check passes, 1 otherwise.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  check,
  CLONE,
  CLONE_PROJECT,
  JV,
  JV_HOME,
  jvJson,
  log,
  query,
  queryOne,
  summary,
  taskByRequest,
  waitFor,
} from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const TAG = arg('--tag', 'v1');
const ONLY = new Set(arg('--only', 'feature,override,no-key').split(','));
const TIMEOUT_MS = Number(arg('--timeout-min', '45')) * 60_000;
const OWNER_MODEL = 'claude-sonnet-5-5';
const OWNER_EFFORT = 'low';

export const FEATURE_REQUEST = `acceptance-phase4-feature-${TAG}`;
export const UNDO_REQUEST = `acceptance-phase4-undo-${TAG}`;
const FEATURE = {
  title: 'Invoice count on the invoices page',
  text: 'Show the number of invoices above the invoices table on the invoices page, with a unit or browser test.',
};
const UNDO = {
  title: 'Comment on the customers module',
  text: 'Add a one-line comment at the top of src/customers/index.ts saying what the module stores. Nothing else.',
};
const ENDED = ['done', 'waiting-owner', 'failed', 'stopped'];

const elapsed = (since) => `${Math.round((Date.now() - since) / 1000)} s`;
const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

function create(kind, { title, text }, requestId, extra = []) {
  return jvJson(['task', 'create', '--project', CLONE_PROJECT, '--kind', kind, '--title', title, '--text', text, '--request-id', requestId, ...extra], {
    timeoutMs: 15 * 60_000,
  });
}

/** The task's newest step session in state running. */
async function runningSession(taskId, timeoutMs = 10 * 60_000) {
  return waitFor(() => query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' AND state = 'running' ORDER BY started_at DESC", taskId)[0], {
    timeoutMs,
    intervalMs: 2000,
  });
}

function stepLine(taskId) {
  return query('SELECT ordinal, duty, state, attempts FROM steps WHERE task_id = ? ORDER BY ordinal', taskId)
    .map((s) => `${s.ordinal}.${s.duty}:${s.state}${s.attempts > 1 ? `x${s.attempts}` : ''}`)
    .join(' ');
}

// ---- feature -------------------------------------------------------------------------------------------------

async function featureCreate() {
  const existing = taskByRequest(FEATURE_REQUEST);
  const started = Date.now();
  const r = create('feature', FEATURE, FEATURE_REQUEST);
  if (!check('jv task create --kind feature exits 0', r.status === 0, r.status === 0 ? `${r.json?.task?.id} in ${elapsed(started)}` : `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}`)) return undefined;
  const task = r.json.task;
  const source = r.json.workflow?.source ?? '';
  check(
    'the resolved workflow file is printed (package default, the project has no workflows/feature.json)',
    /jevellan-workflow-feature\/workflow\.json$/.test(source) && existsSync(source),
    source,
  );
  if (existing) log(`the task already existed (rerun of ${FEATURE_REQUEST}): ${task.id} ${task.state}`);
  return task;
}

function workflowDecision(task) {
  const d = queryOne("SELECT * FROM decisions WHERE task_id = ? AND kind = 'workflow' ORDER BY created_at", task.id);
  if (!check('a workflow decision row for the task', !!d, d?.id ?? 'none')) return;
  const questions = parse(d.questions_json, {});
  const answers = parse(d.answers_json, {});
  const keys = ['needs_plan', 'needs_docs'];
  check(
    'the workflow decision asks and answers needs_plan and needs_docs',
    keys.every((k) => k in questions && k in answers),
    keys.map((k) => `${k}=${JSON.stringify(answers[k]?.noul ?? answers[k])}`).join(', '),
  );
  const steps = query('SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal', task.id);
  for (const s of steps.filter((x) => x.when_rule.startsWith('jev:'))) {
    const q = s.when_rule.slice(4);
    const skipped = s.state === 'skipped';
    check(`step ${s.ordinal} ${s.duty} (${s.when_rule}) follows the answer`, !skipped || /^Jev: not needed/.test(s.state_reason), `${s.state}${skipped ? ` (${s.state_reason})` : ''}; ${q}=${JSON.stringify(answers[q]?.noul ?? answers[q])}`);
  }
}

function worktreeCheck(task) {
  const row = queryOne('SELECT * FROM tasks WHERE id = ?', task.id);
  check('the task branch is a jv/ branch', /^jv\//.test(row.branch ?? ''), row.branch ?? 'none');
  const list = spawnSync('git', ['-C', CLONE, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout ?? '';
  const blocks = list.split('\n\n').map((b) => b.trim());
  const entry = blocks.find((b) => b.split('\n').includes(`worktree ${row.worktree_path}`));
  check('the worktree is registered in the clone on that branch', !!entry && entry.includes(`branch refs/heads/${row.branch}`), row.worktree_path ?? 'none');
  check('task.md holds the task text', readFileSync(join(JV_HOME, 'projects', CLONE_PROJECT, 'tasks', task.id, 'task.md'), 'utf8') === `${FEATURE.text}\n`);
}

/** Answers a step waiting on the owner with its first option. Returns true when it answered. */
function answerStep(task) {
  const report = queryOne('SELECT * FROM reports WHERE task_id = ? ORDER BY created_at DESC', task.id);
  const landing = queryOne('SELECT * FROM landings WHERE task_id = ? ORDER BY created_at DESC', task.id);
  if (landing || !report || report.status !== 'needs-decision') return false;
  const options = parse(report.options_json, []);
  const label = options[0]?.label;
  if (!label) return false;
  log(`${task.id} asks: ${report.question} -> answering "${label}"`);
  const r = jvJson(['task', 'answer', task.id, label]);
  log(`jv task answer exit ${r.status}${r.status ? `: ${r.json?.error ?? r.stderr.trim()}` : ''}`);
  return r.status === 0;
}

async function followFeature(task, since) {
  let answers = 0;
  let last = '';
  for (;;) {
    const ended = await waitFor(
      () => {
        jvJson(['status', '--project', CLONE_PROJECT]); // marks lost runs at read time
        const row = queryOne('SELECT * FROM tasks WHERE id = ?', task.id);
        const line = `${row.state} | ${stepLine(task.id)} | ${row.state_reason}`;
        if (line !== last) log(`${task.id} ${line}`);
        last = line;
        return ENDED.includes(row.state) ? row : undefined;
      },
      { timeoutMs: Math.max(0, since + TIMEOUT_MS - Date.now()), intervalMs: 20_000 },
    );
    if (!ended) return queryOne('SELECT * FROM tasks WHERE id = ?', task.id);
    if (ended.state === 'waiting-owner' && answers < 3 && answerStep(ended)) {
      answers++;
      continue;
    }
    return ended;
  }
}

function featureSteps(task) {
  const steps = query('SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal', task.id);
  for (const s of steps) {
    if (s.state === 'skipped') continue;
    const sessions = query("SELECT * FROM sessions WHERE step_id = ? AND kind = 'step' ORDER BY started_at", s.id);
    const placements = query("SELECT * FROM decisions WHERE step_id = ? AND kind = 'placement' ORDER BY created_at", s.id);
    const reports = query('SELECT * FROM reports WHERE step_id = ? ORDER BY created_at', s.id);
    const placed = placements.map((p) => {
      const c = parse(p.chosen_json, {});
      return `${c.model ?? c.choices?.model?.option ?? '?'} ${c.effort ?? c.choices?.effort?.option ?? '?'} (${p.jev_model}, ${p.latency_ms} ms)`;
    });
    check(`step ${s.ordinal} ${s.duty}: ${s.state}`, s.state === 'done', `${s.state_reason}; attempts ${s.attempts}`);
    check(`step ${s.ordinal} ${s.duty}: placement decisions`, placements.length >= 1, `${placements.length} for ${s.attempts} attempt(s): ${placed.join('; ')}`);
    const runIds = new Set(sessions.map((r) => r.id));
    check(`step ${s.ordinal} ${s.duty}: each placement names one of its runs`, placements.every((p) => p.session_id && runIds.has(p.session_id)), placements.map((p) => `${p.id}->${p.session_id}`).join(', '));
    check(`step ${s.ordinal} ${s.duty}: its report is in the store`, reports.length >= 1 && reports.at(-1).status === 'done', reports.map((r) => `${r.session_id}:${r.status}`).join(', '));
    for (const run of sessions.filter((r) => ['done', 'failed'].includes(r.state))) {
      const kinds = new Set(query('SELECT kind FROM events WHERE session_id = ?', run.id).map((e) => e.kind));
      if (!kinds.has('start') || !kinds.has('end')) check(`run ${run.id} has start and end events`, false, [...kinds].join(','));
    }
    if (s.duty === 'verify' && reports.length) {
      const tests = parse(reports.at(-1).tests_json, null);
      check(`step ${s.ordinal} verify: testsRun passed`, tests?.passed === true, tests ? `${tests.command}: ${tests.summary ?? ''}`.slice(0, 300) : 'no testsRun');
    }
    if (s.duty === 'plan') {
      const row = queryOne('SELECT worktree_path FROM tasks WHERE id = ?', task.id);
      check('plan.md is in the worktree', existsSync(join(row.worktree_path, 'plan.md')));
    }
  }
}

async function feature() {
  const since = Date.now();
  const task = await featureCreate();
  if (!task) return;
  workflowDecision(task);
  worktreeCheck(task);
  return { task, since };
}

async function featureFinish({ task, since }) {
  const row = await followFeature(task, since);
  log(`${task.id} ended the follow at ${row.state} after ${elapsed(since)}: ${row.state_reason}`);
  featureSteps(task);
  const landings = query('SELECT * FROM landings WHERE task_id = ? ORDER BY created_at', task.id);
  const decision = queryOne("SELECT * FROM decisions WHERE task_id = ? AND kind = 'landing' ORDER BY created_at", task.id);
  check(
    'the task reached landing after its last step',
    landings.length > 0 || (decision && row.state === 'waiting-owner'),
    `${row.state}; landings ${landings.map((l) => `${l.route}:${l.state}`).join(', ') || 'none'}; route ${parse(decision?.chosen_json, {})?.route ?? 'no decision'}`,
  );
  log(`feature task ${task.id}: branch ${row.branch}, elapsed ${elapsed(since)}`);
}

// ---- override ------------------------------------------------------------------------------------------------

async function overrideKeep(task) {
  const run = await runningSession(task.id);
  if (!check('--keep: the feature task has a running step', !!run, run?.id ?? 'none running within 10 min')) return;
  const r = jvJson(['task', 'override', task.id, '--model', OWNER_MODEL, '--effort', OWNER_EFFORT, '--keep']);
  if (!check('jv task override --keep exits 0', r.status === 0, r.status ? `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}` : `on ${run.id}`)) return;
  const d = queryOne('SELECT * FROM decisions WHERE id = ?', r.json.overridden);
  const o = parse(d?.override_json, {});
  check('--keep is recorded on the placement decision', d?.override_mode === 'keep' && JSON.stringify(o).includes(OWNER_MODEL), `${d?.id}: ${d?.override_mode} ${d?.override_json}`);
  await new Promise((res) => setTimeout(res, 5000));
  const after = queryOne('SELECT * FROM sessions WHERE id = ?', run.id);
  check('--keep leaves the run going', after.state !== 'stopped', `${run.id} ${after.state}: ${after.state_reason}`);
}

async function overrideUndo() {
  const since = Date.now();
  const r = create('single', UNDO, UNDO_REQUEST, ['--duty', 'implement']);
  if (!check('jv task create --kind single --duty implement exits 0', r.status === 0, r.status ? `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}` : r.json.task.id)) return;
  const task = r.json.task;
  let row = queryOne('SELECT * FROM tasks WHERE id = ?', task.id);
  if (row.state === 'done') {
    log(`${task.id} is already done (a rerun): the --undo checks ran before`);
    return task;
  }
  const already = queryOne("SELECT * FROM decisions WHERE task_id = ? AND override_mode = 'undo'", task.id);
  if (!already) {
    const run = await runningSession(task.id);
    if (!check('--undo: the task has a running step', !!run, run?.id ?? 'none')) return task;
    const placed = queryOne('SELECT * FROM decisions WHERE session_id = ?', run.id);
    const o = jvJson(['task', 'override', task.id, '--model', OWNER_MODEL, '--effort', OWNER_EFFORT, '--undo'], { timeoutMs: 5 * 60_000 });
    if (!check('jv task override --undo exits 0', o.status === 0, o.status ? `exit ${o.status}: ${o.json?.error ?? o.stderr.trim()}` : `stopped ${o.json.stopped}, new ${o.json.session}`)) return task;
    const old = queryOne('SELECT * FROM sessions WHERE id = ?', run.id);
    check('--undo stops the running session', o.json.stopped === run.id && old.state === 'stopped' && /overridden by the owner/.test(old.state_reason), `${old.id} ${old.state}: ${old.state_reason}`);
    const fresh = queryOne('SELECT * FROM sessions WHERE id = ?', o.json.session);
    check('--undo restarts the step on the owner placement', fresh?.model === OWNER_MODEL && fresh?.effort === OWNER_EFFORT, `${fresh?.id} ${fresh?.provider} ${fresh?.model} ${fresh?.effort} (was ${run.model} ${run.effort})`);
    const overridden = queryOne('SELECT * FROM decisions WHERE id = ?', o.json.overridden);
    check(
      '--undo is recorded on the Jev placement decision',
      overridden?.id === placed?.id && overridden?.override_mode === 'undo' && (overridden?.override_json ?? '').includes(OWNER_MODEL),
      `${overridden?.id}: ${overridden?.override_mode} ${overridden?.override_json}`,
    );
    const owner = queryOne('SELECT * FROM decisions WHERE id = ?', o.json.decision);
    check('the owner placement is its own decision row: jev_model none, source owner', owner?.jev_model === 'none' && parse(owner?.chosen_json, {}).source === 'owner' && owner?.session_id === fresh?.id, `${owner?.id} ${owner?.jev_model} ${owner?.chosen_json?.slice(0, 160)}`);
  }
  row = await waitFor(() => {
    const t = queryOne('SELECT * FROM tasks WHERE id = ?', task.id);
    return ENDED.includes(t.state) ? t : undefined;
  }, { timeoutMs: 25 * 60_000, intervalMs: 10_000 });
  check('the overridden single task finishes its step (done)', row?.state === 'done', `${row?.state ?? 'timeout'}: ${row?.state_reason ?? ''} after ${elapsed(since)}`);
  return task;
}

// ---- no key --------------------------------------------------------------------------------------------------

function noKey() {
  const tmp = mkdtempSync(join(dirname(CLONE), 'jv-nokey-home-'));
  const env = { JV_HOME: tmp };
  mkdirSync(join(tmp, 'secrets'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'homes', 'claude-main'), { recursive: true });
  // The installed runtime and skills, linked: nothing is built, nothing secret is copied.
  symlinkSync(resolve(JV_HOME, readlinkSync(join(JV_HOME, 'runtime'))), join(tmp, 'runtime'));
  symlinkSync(resolve(JV_HOME, readlinkSync(join(JV_HOME, 'skills'))), join(tmp, 'skills'));
  copyFileSync(join(JV_HOME, 'install.json'), join(tmp, 'install.json'));
  const real = JSON.parse(readFileSync(join(JV_HOME, 'providers.json'), 'utf8'));
  const main = real.providers.find((p) => p.name === 'claude-main');
  const realKey = join(JV_HOME, 'secrets', 'jev.key');
  const providers = (keyFile) => ({
    jev: { ...real.jev, keyFile },
    providers: [{ ...main, home: join(tmp, 'homes', 'claude-main'), tokenFile: join(JV_HOME, 'secrets', 'claude-main.token') }],
  });
  const writeProviders = (keyFile) => writeFileSync(join(tmp, 'providers.json'), `${JSON.stringify(providers(keyFile), null, 2)}\n`, { mode: 0o600 });
  writeProviders(join(tmp, 'secrets', 'jev.key'));
  log(`no-key JV_HOME ${tmp}`);

  const add = jvJson(['project', 'add', CLONE, '--name', CLONE_PROJECT], { env });
  if (!check('no-key home: jv project add', add.status === 0, add.status ? add.json?.error ?? add.stderr.trim() : add.json.project.id)) return;
  const projectJson = join(JV_HOME, 'projects', CLONE_PROJECT, 'project.json');
  copyFileSync(projectJson, join(tmp, 'projects', CLONE_PROJECT, 'project.json'));

  const c = jvJson(
    ['task', 'create', '--project', CLONE_PROJECT, '--kind', 'single', '--duty', 'investigate', '--title', 'Where the server starts', '--text', 'Which file starts the web server? Answer with the path only.', '--request-id', `acceptance-phase4-nokey-${TAG}`],
    { env, timeoutMs: 10 * 60_000 },
  );
  check('jv task create without a Jev key exits 2', c.status === 2, `exit ${c.status}`);
  check('the error says no key configured', /no key configured/.test(c.json?.error ?? c.stderr), c.json?.error ?? c.stderr.trim());
  const db = (sql, ...p) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const conn = new DatabaseSync(join(tmp, 'store.sqlite'), { readOnly: true });
    try {
      return conn.prepare(sql).all(...p);
    } finally {
      conn.close();
    }
  };
  const task = db('SELECT * FROM tasks WHERE request_id = ?', `acceptance-phase4-nokey-${TAG}`)[0];
  if (!check('the task was created and stays queued', task?.state === 'queued', task ? `${task.id} ${task.state}: ${task.state_reason}` : 'no task row')) return;
  const step = db('SELECT * FROM steps WHERE task_id = ?', task.id)[0];
  check('its step stays pending with the Jev message', step?.state === 'pending' && /no key configured/.test(step.state_reason), `${step?.state}: ${step?.state_reason}`);
  check('no session and no placement were written', db('SELECT id FROM sessions WHERE task_id = ?', task.id).length === 0 && db("SELECT id FROM decisions WHERE task_id = ? AND kind = 'placement'", task.id).length === 0);

  writeProviders(realKey); // pointing back at the real key file, read where it is
  const r = jvJson(['task', 'resume', task.id], { env, timeoutMs: 10 * 60_000 });
  const session = db("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step'", task.id)[0];
  const placement = db("SELECT * FROM decisions WHERE task_id = ? AND kind = 'placement'", task.id)[0];
  check('jv task resume with the key back starts the step', r.status === 0 && !!session && !!placement, r.status ? `exit ${r.status}: ${r.json?.error ?? r.stderr.trim()}` : `${r.json?.how} ${session?.id} ${session?.model} ${session?.effort}, decision ${placement?.id} (${placement?.jev_model})`);
  const s = jvJson(['task', 'stop', task.id, '--discard'], { env, timeoutMs: 2 * 60_000 });
  const after = db("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step'", task.id);
  check('the started step is stopped again (no turn spent on it)', s.status === 0 && after.every((x) => ['stopped', 'done', 'failed'].includes(x.state)), after.map((x) => `${x.id}:${x.state}`).join(', '));
}

// ---- main ----------------------------------------------------------------------------------------------------

async function main() {
  if (!CLONE || !existsSync(join(CLONE, '.git'))) {
    process.stderr.write('JV_ACCEPT_CLONE must name the disposable clone of the sandbox\n');
    return 2;
  }
  log(`phase 4 acceptance; JV_HOME ${JV_HOME}; jv ${JV}; project ${CLONE_PROJECT} at ${CLONE}; tag ${TAG}`);
  let followed;
  if (ONLY.has('feature')) followed = await feature();
  if (ONLY.has('override') && followed) await overrideKeep(followed.task);
  const work = [];
  if (ONLY.has('override')) work.push(overrideUndo());
  if (ONLY.has('no-key')) noKey();
  if (followed) work.push(featureFinish(followed));
  await Promise.all(work);
  const live = query("SELECT id, task_id, state FROM sessions WHERE kind = 'step' AND state IN ('queued','starting','running') AND project_id = (SELECT id FROM projects WHERE name = ?)", CLONE_PROJECT);
  log(`live sessions of ${CLONE_PROJECT} at the end: ${live.map((x) => `${x.id}(${x.task_id}):${x.state}`).join(', ') || 'none'}`);
  return summary();
}

process.exitCode = await main();
