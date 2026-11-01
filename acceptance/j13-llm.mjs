#!/usr/bin/env node
// J13 llm (brief section 15, section 6.6): a single answer task runs on the llm runtime with one turn and a parsed
// report; Jev chooses the model.
//
// first   "What does HTTP status 409 mean? One short paragraph." as a single answer task: one run, on llm, one usage
//         event and no tool calls, a report parsed from the reply (status done, no "synthesized" limitation), and a
//         placement decision made by Jev (jev_model set, not an owner row) with probabilities.
// haiku   The brief names claude-main Haiku. When Jev chose another model or provider, a second answer task is
//         created and overridden at once with --model claude-haiku-5-5 --provider claude-main --undo; the same
//         assertions hold for the run on the owner placement, and both are recorded. An llm answer can finish before
//         the override reaches it: then the override is refused (the task is done) and that is recorded instead.
// glm     ~/.jv/secrets/glm.key missing: "skipped: no key", and glm is absent from the placement menu of the first
//         task's decision. With the key file present, the glm part is not run by this script (noted).
//
// Usage: node acceptance/j13-llm.mjs [--tag T] [--note "..."]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, JV_HOME, jvJson, log, queryOne } from './lib.mjs';
import { journey } from './journey.mjs';
import { createTask, err, eventsOf, parse, placementsOf, reportOf, runLine, runRow, runsOf, settle, stateFile } from './task-lib.mjs';

const J = journey(13, 'llm');
const S = stateFile(13, J.tag);
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const TEXT = 'What does HTTP status 409 mean? One short paragraph.';
const rows = [];

/** The llm assertions on one run; returns the run's placement decision. */
function llmRun(label, run) {
  const events = eventsOf(run.id);
  const usage = events.filter((e) => e.kind === 'usage');
  const tools = events.filter((e) => e.kind === 'tool-call');
  check(`${label}: the run is on the llm runtime`, run.runtime === 'llm', runLine(run));
  check(`${label}: one turn (one usage event, no tool calls)`, usage.length === 1 && tools.length === 0, `${usage.length} usage, ${tools.length} tool calls; ${run.input_tokens} in, ${run.output_tokens} out, $${run.cost_usd ?? '?'}`);
  const report = reportOf(run.id);
  check(`${label}: the report was parsed from the reply, not synthesized`, report?.status === 'done' && !/synthesi/i.test(report.limitations ?? ''), `${report?.status}; limitations ${report?.limitations ?? 'none'}; ${oneLine(report?.summary, 240)}`);
  rows.push([label, run.id, run.provider, run.model, run.effort, run.runtime, `${usage.length}`, report?.status ?? 'none', oneLine(report?.summary, 160)]);
  return report;
}

async function first() {
  const c = createTask({ duty: 'answer', title: 'HTTP 409', text: TEXT, request: `acceptance-j13-${J.tag || 'default'}` });
  if (!check('first: jv task create --kind single --duty answer exits 0', c.status === 0, c.status ? err(c) : c.json.task.id)) return undefined;
  const id = c.json.task.id;
  S.set({ first: id });
  check('first: an answer task has no worktree', !c.json.task.worktree_path, c.json.task.worktree_path ?? 'none');
  const t = await settle(id, { timeoutMs: 10 * 60_000 });
  if (!check('first: the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out')) return undefined;
  const runs = runsOf(id);
  check('first: one run', runs.length === 1, runs.map(runLine).join('; '));
  const run = runs[0];
  llmRun('first', run);
  const decision = placementsOf(run.step_id)[0];
  const chosen = parse(decision?.chosen_json, {});
  const state = parse(decision?.state_json, {});
  check('first: Jev chose the placement (a Jev decision row with probabilities)', !!decision && decision.jev_model !== 'none' && chosen.source !== 'owner' && chosen.model === run.model, `${decision?.id} by ${decision?.jev_model}: chosen ${decision?.chosen_json}; outcome ${oneLine(decision?.outcome_json, 200)}`);
  const menu = state.menu ?? {};
  const menuProviders = (menu.providers ?? []).map((p) => p.name);
  log(`first placement ${decision?.id}: menu providers ${menuProviders.join(', ')}; models ${(menu.models ?? []).map((m) => `${m.label ?? m.id}/${m.provider}/${m.runtime}`).join(', ')}`);
  return { run, decision, menuProviders };
}

async function haiku(firstRun) {
  if (firstRun.provider === 'claude-main' && firstRun.model === 'claude-haiku-5-5') {
    log('Jev chose claude-main Haiku: no second task');
    return;
  }
  J.note(`Jev chose ${firstRun.model} ${firstRun.effort} on ${firstRun.provider} (${firstRun.runtime}), not claude-main Haiku; a second answer task was overridden onto claude-haiku-5-5 on claude-main (--undo)`);
  const c = createTask({ duty: 'answer', title: 'HTTP 409 (Haiku)', text: TEXT, request: `acceptance-j13-haiku-${J.tag || 'default'}` });
  if (!check('haiku: jv task create exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; first run ${c.json.start?.session?.id} ${c.json.start?.placement?.model}`)) return;
  const id = c.json.task.id;
  S.set({ haiku: id });
  let o = S.get().override;
  if (!o) {
    const r = jvJson(['task', 'override', id, '--model', 'claude-haiku-5-5', '--provider', 'claude-main', '--undo'], { timeoutMs: 5 * 60_000 });
    o = r.status === 0 ? { ok: true, stopped: r.json.stopped ?? null, session: r.json.session ?? null, decision: r.json.decision, overridden: r.json.overridden ?? null } : { ok: false, error: err(r) };
    S.set({ override: o });
  }
  if (!o.ok) {
    const done = runsOf(id).at(-1);
    J.deviation(`the Haiku override could not reach the second task: ${o.error}; its first run ${done ? runLine(done) : '?'} had already ended (an llm answer takes seconds)`);
    check('haiku: the override was refused only because the answer had already finished', /done/.test(o.error), o.error);
    return;
  }
  log(`haiku override: stopped ${o.stopped}; run ${o.session}; decision ${o.decision}`);
  const t = await settle(id, { timeoutMs: 10 * 60_000 });
  check('haiku: the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const run = runRow(o.session);
  if (!check('haiku: the owner placement ran claude-haiku-5-5 on claude-main', run?.model === 'claude-haiku-5-5' && run.provider === 'claude-main', run ? runLine(run) : 'no run')) return;
  llmRun('haiku', run);
  const owner = queryOne('SELECT * FROM decisions WHERE id = ?', o.decision);
  check('haiku: the placement is an owner decision row', owner?.jev_model === 'none' && parse(owner.chosen_json, {}).source === 'owner', `${owner?.id} ${owner?.jev_model} ${owner?.chosen_json}`);
  if (o.stopped) log(`haiku: Jev's first run ${runLine(runRow(o.stopped))}`);
}

try {
  const f = await first();
  if (f) {
    await haiku(f.run);
    const glmKey = existsSync(join(JV_HOME, 'secrets', 'glm.key'));
    if (glmKey) J.note('glm has a key file; a glm answer task is not part of this script');
    else {
      check('glm: no key file, so glm is absent from the placement menu', !f.menuProviders.includes('glm') && f.menuProviders.length > 0, `menu providers: ${f.menuProviders.join(', ')}`);
      J.note('glm: skipped: no key (~/.jv/secrets/glm.key is missing)');
    }
  }
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
}
J.finish({ tables: rows.length ? [{ title: 'llm runs', columns: ['part', 'run', 'provider', 'model', 'effort', 'runtime', 'usage events', 'report', 'summary'], rows }] : [] });
