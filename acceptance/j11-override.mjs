#!/usr/bin/env node
// J11 Override (brief section 15, section 7.6): the owner's placement on a running step.
//
// undo  A single implement task (a one-line comment at the top of src/customers/index.ts, committed). While its run
//       is running (native session id, first tool call made, no report yet): jv task override <T> --model
//       claude-fable-5-1 --effort high --undo. The running run is stopped "overridden by the owner", the step starts
//       again on Fable high, Jev's decision row records the override (override_json, override_mode undo) and a new
//       decision row with source owner (jev_model none) is the placement of the new run. The task then finishes.
// keep  After that task has ended (one landing at a time: both tasks add a CHANGELOG.md line), a second single
//       implement task (a one-line comment at the top of src/web/html.ts). While its run is running: jv task override
//       <T2> --model claude-sonnet-5-5 --effort low --keep records the override on the decision row (override_mode
//       keep) and stops nothing: the same run keeps running and no new run row appears. The task then finishes.
//
// Since D-078 a single task whose step committed lands; an asked landing is answered "Land now" as the owner.
// Usage: node acceptance/j11-override.mjs [--tag T] [--only undo,keep] [--note "..."]
// A rerun with the same tag reuses the tasks and does not override twice (results/J11-state-<tag>.json).

import { check, jvJson, log, queryOne } from './lib.mjs';
import { arg, journey } from './journey.mjs';
import { createTask, err, landedCommits, parse, placementsOf, reportOf, runLine, runRow, runsOf, settle, stateFile, stepRow, waitRunning } from './task-lib.mjs';

const J = journey(11, 'Override');
const S = stateFile(11, J.tag);
const ONLY = new Set(arg('--only', 'undo,keep').split(','));
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const decision = (id) => (id ? queryOne('SELECT * FROM decisions WHERE id = ?', id) : undefined);
const tables = [];

async function finishTask(label, id) {
  const answers = [];
  const t = await settle(id, { timeoutMs: 25 * 60_000, answerLanding: true, onAnswer: (a) => answers.push(a) });
  for (const a of answers) J.note(`${label}: landing ${a.landing} was asked (${a.reason}); answered "Land now" as the owner: ${a.result}`);
  check(`${label}: the task finishes`, t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const landed = landedCommits(id);
  if (landed.length) J.deviation(`single implement tasks land since D-078 (their step commits); J11's tasks landed on sandbox main`);
  log(`${label}: runs ${runsOf(id).map(runLine).join('; ')}; landed ${landed.join(', ') || 'nothing'}`);
  return t;
}

/** Waits for the task's live run to be running with a tool call; returns it (or a failed check). */
async function running(label, id, first) {
  const runId = first ?? runsOf(id).at(-1)?.id;
  const { run, tools } = await waitRunning(runId, { minTools: 1 });
  const ok = run.state === 'running' && tools >= 1 && !reportOf(run.id);
  check(`${label}: the step's run is running (tool calls made, no report) before the override`, ok, `${runLine(run)}; ${tools} tool calls`);
  return ok ? run : undefined;
}

async function undo() {
  const c = createTask({
    duty: 'implement',
    title: 'Comment at the top of src/customers/index.ts',
    text: 'Add a one-line comment at the top of src/customers/index.ts saying what the module does. Commit it.',
    request: `acceptance-j11-undo-${J.tag || 'default'}`,
  });
  const p = c.json?.start?.placement;
  if (!check('undo: jv task create (single implement) exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; ${c.json.start?.session?.id}: ${p?.model} ${p?.effort} on ${p?.provider} (${p?.runtime})`)) return;
  const id = c.json.task.id;
  S.set({ undoTask: id });
  let o = S.get().undo;
  if (!o) {
    const run = await running('undo', id, c.json.start?.session?.id);
    if (!run) return;
    J.start('undoOverride');
    const r = jvJson(['task', 'override', id, '--model', 'claude-fable-5-1', '--effort', 'high', '--undo'], { timeoutMs: 5 * 60_000 });
    J.stop('undoOverride');
    if (!check('undo: jv task override --model claude-fable-5-1 --effort high --undo exits 0', r.status === 0, r.status ? err(r) : `stopped ${r.json.stopped}; new run ${r.json.session}; ${r.json.placement.model} ${r.json.placement.effort} on ${r.json.placement.provider} (${r.json.placement.runtime}); decision ${r.json.decision}, overridden ${r.json.overridden}`)) return;
    o = { ...r.json, start: undefined, before: run.id };
    S.set({ undo: o });
  }
  const before = runRow(o.before);
  check('undo: the running run was stopped "overridden by the owner"', o.stopped === before.id && before.state === 'stopped' && /overridden by the owner/.test(before.state_reason), runLine(before));
  const next = runRow(o.session);
  check('undo: the step restarted on Fable high in a new run', !!next && next.id !== before.id && next.step_id === before.step_id && next.model === 'claude-fable-5-1' && next.effort === 'high', next ? runLine(next) : 'no new run');
  const jevDecision = decision(o.overridden);
  const ov = parse(jevDecision?.override_json, {});
  check("undo: Jev's decision row records the override (override_json, override_mode undo)", jevDecision?.override_mode === 'undo' && ov.model === 'claude-fable-5-1' && ov.effort === 'high', `${jevDecision?.id} jev_model ${jevDecision?.jev_model}: override_mode ${jevDecision?.override_mode}, override_json ${jevDecision?.override_json}`);
  const owner = decision(o.decision);
  const chosen = parse(owner?.chosen_json, {});
  check('undo: the new placement is an owner decision row (source owner, no Jev call)', owner?.jev_model === 'none' && chosen.source === 'owner' && chosen.model === 'claude-fable-5-1' && chosen.overrides === o.overridden, `${owner?.id} jev_model ${owner?.jev_model}; chosen ${owner?.chosen_json}`);
  const rows = placementsOf(before.step_id);
  tables.push({
    title: `Placement decisions of the undo task's step (${id})`,
    columns: ['decision', 'jev_model', 'chosen', 'override_mode', 'override_json'],
    rows: rows.map((d) => {
      const ch = parse(d.chosen_json, {});
      return [d.id, d.jev_model, `${ch.model ?? '?'} ${ch.effort ?? ''} on ${ch.provider ?? '?'}${ch.source ? ` (${ch.source})` : ''}`, d.override_mode ?? '', d.override_json ?? ''];
    }),
  });
  await finishTask('undo', id);
  const step = stepRow(before.step_id);
  check('undo: the step finished on the owner placement', step.state === 'done' && runsOf(id).filter((s) => s.step_id === step.id).at(-1)?.model === 'claude-fable-5-1', `${step.state}: ${step.state_reason}`);
}

async function keep() {
  const c = createTask({
    duty: 'implement',
    title: 'Comment at the top of src/web/html.ts',
    text: 'Add a one-line comment at the top of src/web/html.ts saying what the module does. Commit it.',
    request: `acceptance-j11-keep-${J.tag || 'default'}`,
  });
  const p = c.json?.start?.placement;
  if (!check('keep: jv task create (single implement) exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; ${c.json.start?.session?.id}: ${p?.model} ${p?.effort} on ${p?.provider} (${p?.runtime})`)) return;
  const id = c.json.task.id;
  S.set({ keepTask: id });
  let o = S.get().keep;
  if (!o) {
    const run = await running('keep', id, c.json.start?.session?.id);
    if (!run) return;
    const runsBefore = runsOf(id).length;
    const r = jvJson(['task', 'override', id, '--model', 'claude-sonnet-5-5', '--effort', 'low', '--keep'], { timeoutMs: 5 * 60_000 });
    const after = runRow(run.id);
    const runsAfter = runsOf(id).length;
    if (!check('keep: jv task override --model claude-sonnet-5-5 --effort low --keep exits 0', r.status === 0, r.status ? err(r) : `mode ${r.json.mode}; overridden ${r.json.overridden}; stopped ${r.json.stopped ?? 'nothing'}; session ${r.json.session ?? 'none'}`)) return;
    o = { ...r.json, run: run.id, stateAfter: after.state, runsBefore, runsAfter };
    S.set({ keep: o });
  }
  check('keep: nothing was stopped and no new run started', !o.stopped && !o.session && o.runsBefore === o.runsAfter && ['running', 'done'].includes(o.stateAfter), `run ${o.run} ${o.stateAfter} right after; runs ${o.runsBefore} -> ${o.runsAfter}`);
  const d = decision(o.overridden);
  const ov = parse(d?.override_json, {});
  check('keep: the decision row records the override (override_mode keep)', d?.override_mode === 'keep' && ov.model === 'claude-sonnet-5-5' && ov.effort === 'low' && d.session_id === o.run, `${d?.id} (run ${d?.session_id}): override_mode ${d?.override_mode}, override_json ${d?.override_json}`);
  await finishTask('keep', id);
  const run = runRow(o.run);
  const stepRuns = runsOf(id).filter((s) => s.step_id === run.step_id);
  check('keep: the same run carried on and finished the step', run.state === 'done' && stepRow(run.step_id).state === 'done' && stepRuns[0]?.id === run.id, `${runLine(run)}; step runs ${stepRuns.map((s) => s.id).join(', ')}`);
}

for (const [name, fn] of [['undo', undo], ['keep', keep]]) {
  if (!ONLY.has(name)) continue;
  try {
    await fn();
  } catch (error) {
    check(`${name}: no exception`, false, error instanceof Error ? error.stack : String(error));
  }
}
J.finish({ tables });
