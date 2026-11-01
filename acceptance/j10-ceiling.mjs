#!/usr/bin/env node
// J10 Ceiling (brief section 15, sections 6.6 and 7.2): a provider at or over its ceilingPct is not in the menu.
//
// 0. Gate: jv status --json shows no running work (waits until it does).
// 1. The latest provider_usage row of claude-main (the row the ranking reads: the latest by observed_at, any source);
//    when it is older than an hour, jv providers check runs first and the new row is read.
// 2. ~/.jv/providers.json is copied byte for byte to the backup (--backup, mode 600; it holds paths, no secret values),
//    and claude-main.ceilingPct is set below that weekly usage (min(50, weekly - 10), at least 1).
// 3. A small single investigate task: its placement decision's state_json menu has no claude-main (neither in
//    menu.providers nor as the provider of any menu model), the decision's candidates list claude-main as not eligible
//    with reason usage-ceiling at the lowered ceiling, and the chosen provider is another one. The task finishes
//    before the restore, so a retry would be placed under the same config.
// 4. Restore (finally block, and on SIGINT/SIGTERM): the backup is copied back; the checks after it are evidence that
//    providers.json is byte-identical to the backup (cmp) with mode 600.
//
// Usage: node acceptance/j10-ceiling.mjs [--tag T] [--backup FILE] [--note "..."]
// A rerun with the same tag refuses to run once its task exists (use a new tag): the placement is made only once.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, JV_HOME, jvJson, log, queryOne, taskByRequest } from './lib.mjs';
import { arg, journey } from './journey.mjs';
import { createTask, err, parse, placementsOf, reportOf, runLine, runsOf, settle, stateFile, stepsOf, waitQuiet } from './task-lib.mjs';

const J = journey(10, 'Ceiling');
const S = stateFile(10, J.tag);
const PROVIDERS = join(JV_HOME, 'providers.json');
const BACKUP = arg('--backup', join(tmpdir(), 'providers.json.j10'));
const MARKER = `${S.file}.providers-edited`;
const REQUEST = `acceptance-j10-${J.tag || 'default'}`;
const HOUR = 60 * 60_000;
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const latestUsage = () => queryOne("SELECT * FROM provider_usage WHERE provider = 'claude-main' ORDER BY observed_at DESC LIMIT 1");
const usageLine = (u) => (u ? `${u.source} ${u.observed_at}: week ${u.weekly_pct}%, five hours ${u.five_hour_pct == null ? 'unknown' : `${u.five_hour_pct}%`}, week resets ${u.weekly_resets_at}` : 'none');

let edited = false;

/** Copies the backup back if this run edited providers.json. Synchronous, so it also runs from a signal handler. */
function restore() {
  if (!edited) return;
  copyFileSync(BACKUP, PROVIDERS);
  chmodSync(PROVIDERS, 0o600);
  edited = false;
  rmSync(MARKER, { force: true });
  log(`providers.json restored from ${BACKUP}`);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

function verifyRestore(label) {
  const same = spawnSync('cmp', [BACKUP, PROVIDERS], { encoding: 'utf8' });
  const mode = (statSync(PROVIDERS).mode & 0o777).toString(8);
  const ceiling = parse(readFileSync(PROVIDERS, 'utf8'), {}).providers?.find((p) => p.name === 'claude-main')?.ceilingPct;
  check(`${label}: providers.json is byte-identical to the backup (cmp) with mode 600`, same.status === 0 && mode === '600', `cmp exit ${same.status}${same.stdout ? ` (${same.stdout.trim()})` : ''}; mode ${mode}; claude-main.ceilingPct ${ceiling}`);
}

async function main() {
  if (taskByRequest(REQUEST)) {
    log(`tag ${J.tag || 'default'} already has its task (${taskByRequest(REQUEST).id}); use a new --tag`);
    process.exit(2);
  }
  const gate = await waitQuiet();
  if (!check('gate: jv status shows no running work', gate.quiet, `${gate.evidence}; waited ${gate.waitedMs} ms`)) return;

  // 1. Current usage.
  let usage = latestUsage();
  if (!usage || Date.now() - Date.parse(usage.observed_at) > HOUR) {
    log(`latest claude-main usage is ${usage ? usage.observed_at : 'missing'}; running jv providers check`);
    const p = jvJson(['providers', 'check'], { timeoutMs: 5 * 60_000 });
    J.note(`jv providers check ran first (the latest row was ${usage ? `from ${usage.observed_at}` : 'missing'}): exit ${p.status}`);
    usage = latestUsage();
  }
  if (!check('claude-main has a weekly usage row from the last hour', usage?.weekly_pct != null && Date.now() - Date.parse(usage.observed_at) <= HOUR, usageLine(usage))) return;
  const weekly = usage.weekly_pct;
  const ceiling = Math.max(1, Math.min(50, Math.floor(weekly) - 10));
  if (!check('the new ceiling is below the current weekly usage', ceiling < weekly, `weekly ${weekly}% -> ceilingPct ${ceiling}`)) return;

  // 2. Backup and edit.
  const original = readFileSync(PROVIDERS, 'utf8');
  const config = JSON.parse(original);
  const main = config.providers.find((p) => p.name === 'claude-main');
  if (!check('providers.json has claude-main', !!main, `ceilingPct ${main?.ceilingPct}`)) return;
  copyFileSync(PROVIDERS, BACKUP);
  chmodSync(BACKUP, 0o600);
  check('backup written byte for byte, mode 600', spawnSync('cmp', [PROVIDERS, BACKUP]).status === 0 && (statSync(BACKUP).mode & 0o777) === 0o600, `${BACKUP}, ${statSync(BACKUP).size} bytes`);
  writeFileSync(MARKER, `providers.json edited by J10; restore with: cp ${BACKUP} ${PROVIDERS} && chmod 600 ${PROVIDERS}\n`);
  edited = true;
  main.ceilingPct = ceiling;
  writeFileSync(PROVIDERS, `${JSON.stringify(config, null, 2)}\n`);
  S.set({ ceiling, weekly, usage: usageLine(usage), editedAt: new Date().toISOString() });
  log(`claude-main.ceilingPct ${parse(original, {}).providers.find((p) => p.name === 'claude-main').ceilingPct} -> ${ceiling}`);

  // 3. The task.
  J.start('task');
  const c = createTask({
    duty: 'investigate',
    title: 'Where the invoice total is computed',
    text: 'Which function computes an invoice total, and in which file? One sentence with the file and line.',
    request: REQUEST,
  });
  if (!check('jv task create exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; ${c.json.start?.placement?.model} ${c.json.start?.placement?.effort} on ${c.json.start?.placement?.provider} (${c.json.start?.placement?.runtime})`)) return;
  const id = c.json.task.id;
  S.set({ task: id });
  const t = await settle(id, { timeoutMs: 15 * 60_000 });
  J.stop('task');
  check('the task finishes (before the restore)', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');

  const [step] = stepsOf(id);
  const decisions = placementsOf(step.id);
  const decision = decisions[0];
  const state = parse(decision?.state_json, {});
  const chosen = parse(decision?.chosen_json, {});
  const menuProviders = (state.menu?.providers ?? []).map((p) => p.name);
  const menuModels = (state.menu?.models ?? []).map((m) => `${m.label ?? m.id}/${m.provider}/${m.runtime}`);
  if (!check('a Jev placement decision exists for the step', !!decision && decision.jev_model !== 'none', decision ? `${decision.id} by ${decision.jev_model} at ${decision.created_at}; ${decisions.length} placement(s)` : 'none')) return;
  check('state_json menu.providers has no claude-main', menuProviders.length > 0 && !menuProviders.includes('claude-main'), `menu providers: ${menuProviders.join(', ')}`);
  check('state_json menu.models has no claude-main model', menuModels.length > 0 && !(state.menu?.models ?? []).some((m) => m.provider === 'claude-main'), `menu models: ${menuModels.join(', ')}`);
  const cand = (chosen.candidates ?? []).find((x) => x.name === 'claude-main');
  check('the decision candidates list claude-main as excluded by usage-ceiling at the lowered ceiling', cand && cand.eligible === false && cand.reason === 'usage-ceiling' && cand.ceilingPct === ceiling, cand ? JSON.stringify(cand) : 'no claude-main candidate');
  check('the chosen provider is not claude-main', !!chosen.provider && chosen.provider !== 'claude-main', `chosen ${chosen.model} ${chosen.effort} on ${chosen.provider} (${chosen.runtime})`);
  const runs = runsOf(id);
  check('every run of the task is off claude-main', runs.length > 0 && runs.every((r) => r.provider !== 'claude-main'), runs.map(runLine).join('; '));
  const report = reportOf(runs.at(-1)?.id);
  check('the step reported', !!report, report ? `${report.status}: ${oneLine(report.summary, 240)}` : 'none');
  J.note(`claude-main weekly ${weekly}% (${usageLine(usage)}); ceilingPct set to ${ceiling} for the task; Jev chose ${chosen.model} ${chosen.effort} on ${chosen.provider}`);
}

try {
  await main();
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (edited) {
    restore();
    verifyRestore('after the restore');
  } else if (existsSync(BACKUP) && S.get().editedAt) {
    verifyRestore('providers.json');
  }
}
J.finish();
