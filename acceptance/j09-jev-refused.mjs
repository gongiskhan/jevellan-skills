#!/usr/bin/env node
// J9 Jev refused (brief section 15, sections 7.2 and 9.4): without the Jev key there is no placement and no fallback.
//
// 0. Gate: jv status --json shows no running work (waits until it does). The coordinator must be running: it is the
//    one that receives the wake line. Before the key moves, the owner tells the coordinator (typed into its window)
//    that J9, J10 and J12 change jv's config on purpose and that it must not resume, answer or stop tasks itself
//    meanwhile; that is recorded in the notes.
// 1. ~/.jv/secrets/jev.key is renamed to jev.key.j9-off in the same folder (never copied; mode kept). A marker file
//    next to the journey's state says where it is, so a dead run can be recovered by hand.
// 2. jv task create (a single investigate task) exits 2 and the message contains "no key configured"; the task exists
//    queued with that reason, its step pending with that reason, and it has no run.
// 3. The coordinator receives the wake line: capture-pane of jv-coord-jevellan-live-sandbox shows "[jv] <T> ... not
//    placed", and its transcript has the line as a user record. What it did with it is recorded.
// 4. The key is moved back (in a finally block, and on SIGINT/SIGTERM): the checks after the restore are evidence that
//    it is back with mode 600 and that jv doctor --check jev is OK.
// 5. jv task resume <T> starts the step (a placement decision by Jev and a run), and the task finishes.
//
// Usage: node acceptance/j09-jev-refused.mjs [--tag T] [--note "..."]
// A rerun with a tag whose task was already resumed refuses to run (use a new tag): with the key back, the create
// cannot be refused again for the same request id.

import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, JV_HOME, jvJson, log, query, SANDBOX, SANDBOX_NAME, sleep, taskByRequest } from './lib.mjs';
import { journey } from './journey.mjs';
import { coordinator, oneLine } from './coord.mjs';
import { createTask, err, parse, placementsOf, reportOf, runLine, runsOf, settle, stateFile, stepsOf, taskRow, waitQuiet } from './task-lib.mjs';

const J = journey(9, 'Jev refused');
const chosenOf = (d) => parse(d?.chosen_json, {});
const S = stateFile(9, J.tag);
const KEY = join(JV_HOME, 'secrets', 'jev.key');
const OFF = join(JV_HOME, 'secrets', 'jev.key.j9-off');
const MARKER = `${S.file}.key-moved`;
const REQUEST = `acceptance-j09-${J.tag || 'default'}`;
const OWNER_NOTICE =
  'Owner here. I am about to run acceptance journeys J9, J10 and J12, which change jv config on purpose: J9 removes the Jev key for a minute, J10 lowers a provider ceiling, J12 edits the router policy. Until I say they are over, do not resume, answer, override or stop any task yourself; when a [jv] line arrives, just tell me in one line what it says.';

let moved = false;

/** Moves the key back if this run moved it. Synchronous, so it also runs from a signal handler. */
function restoreKey() {
  if (!moved) return;
  if (existsSync(OFF) && !existsSync(KEY)) renameSync(OFF, KEY);
  moved = false;
  rmSync(MARKER, { force: true });
  log(`key moved back to ${KEY}`);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreKey();
    process.exit(130);
  });
}

async function main() {
  if (S.get().resumed) {
    log(`tag ${J.tag || 'default'} already ran to the resume (${S.get().task}); use a new --tag`);
    process.exit(2);
  }
  const gate = await waitQuiet();
  if (!check('gate: jv status shows no running work', gate.quiet, `${gate.evidence}; waited ${gate.waitedMs} ms`)) return;
  const project = jvJson(['project', 'list']).json?.projects?.find((p) => p.name === SANDBOX_NAME) ?? { path: SANDBOX };
  const co = coordinator(SANDBOX_NAME, project.path ?? SANDBOX);
  const cs = co.status();
  if (!check('the coordinator is running (it receives the wake line)', cs?.running === true, `${cs?.sessionId} ${cs?.sessionState}, screen ${cs?.screen}`)) return;

  if (!S.get().told) {
    const said = await co.say(OWNER_NOTICE, { timeoutMs: 5 * 60_000 });
    S.set({ told: { at: said.typedAt, reply: oneLine(said.digest.reply, 400) } });
    log(`owner notice typed; coordinator: ${oneLine(said.digest.reply, 300)}`);
  }
  J.deviation(`the brief does not script this: the owner told the coordinator to only report wake lines during J9, J10 and J12, so its reaction to the wake line was shaped by that notice`);
  J.note(`owner notice typed into the coordinator before J9 (${S.get().told.at}): "${OWNER_NOTICE}" It replied: ${S.get().told.reply}`);

  // 1. Move the key (same folder, mode kept).
  let task = taskByRequest(REQUEST);
  if (!task) {
    if (!check('the Jev key file exists before the journey', existsSync(KEY) && !existsSync(OFF), `${KEY}: ${existsSync(KEY)}; ${OFF}: ${existsSync(OFF)}`)) return;
    const modeBefore = (statSync(KEY).mode & 0o777).toString(8);
    writeFileSync(MARKER, `${OFF} was ${KEY}; move it back with: mv ${OFF} ${KEY}\n`);
    renameSync(KEY, OFF);
    moved = true;
    const modeOff = (statSync(OFF).mode & 0o777).toString(8);
    check('the key was renamed in place (not copied), mode kept', !existsSync(KEY) && existsSync(OFF) && modeOff === modeBefore, `${KEY} -> ${OFF}; mode ${modeBefore} -> ${modeOff}`);

    // 2. The refused create.
    const coordOffset = co.size();
    J.start('create');
    const c = createTask({
      duty: 'investigate',
      title: 'Default port of the server',
      text: 'Which port does the server listen on by default, and where is it set? One sentence with the file and line.',
      request: REQUEST,
    });
    J.stop('create');
    const message = c.json?.error ?? c.stderr.trim();
    check('jv task create exits 2 with "no key configured"', c.status === 2 && /no key configured/.test(message), `exit ${c.status}: ${message}`);
    task = taskByRequest(REQUEST);
    if (!check('the task exists', !!task, task ? `${task.id} (request ${REQUEST})` : 'no task row for the request id')) return;
    S.set({ task: task.id, refused: message, coordOffset });
  } else {
    log(`task ${task.id} exists from an earlier run of this tag; continuing from the store`);
  }
  const id = task.id;
  task = taskRow(id);
  check('the task is queued with the Jev reason', task.state === 'queued' && /no key configured/.test(task.state_reason ?? ''), `${task.state}: ${task.state_reason}`);
  const [step] = stepsOf(id);
  check('its step is pending with that reason', step?.state === 'pending' && /no key configured/.test(step.state_reason ?? ''), step ? `step ${step.ordinal} ${step.duty} ${step.state}: ${step.state_reason}` : 'no step');
  check('no run was started and no placement written', runsOf(id).length === 0 && placementsOf(step?.id).length === 0, `${runsOf(id).length} runs, ${placementsOf(step?.id).length} placement decisions`);

  // 3. The wake line.
  const needle = `[jv] ${id}`;
  let screen = '';
  const seen = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      screen = co.screen();
      if (screen.includes(needle)) return true;
      if (Date.now() > deadline) return false;
      await sleep(500);
    }
  })();
  const line = screen.split('\n').find((l) => l.includes(needle)) ?? '';
  check('capture-pane of the coordinator shows the [jv] wake line', seen && /not placed/.test(line), seen ? oneLine(line.replace(/^[^[]*/, ''), 300) : `no "${needle}" on the screen in 30 s`);
  const idle = await co.waitIdle({ quietMs: 8000, timeoutMs: 5 * 60_000 });
  const d = co.digest(co.recordsFrom(S.get().coordOffset ?? 0));
  const wakeUser = d.users.find((u) => u.text.includes(needle));
  check('the coordinator transcript has the wake line as a user record', !!wakeUser, wakeUser ? `${wakeUser.at}: ${oneLine(wakeUser.text, 300)}` : 'not in the transcript');
  const said = wakeUser ? d.texts.filter((x) => x.at >= wakeUser.at).map((x) => x.text).join('\n') : '';
  const ran = wakeUser ? d.tools.filter((x) => x.at >= wakeUser.at).map((x) => oneLine(x.input, 160)) : [];
  J.note(`the coordinator, on the wake line, ran: ${ran.join(' ; ') || 'nothing'}; said: ${oneLine(said, 500)}${idle === undefined ? ' (still busy after 5 minutes)' : ''}`);

  // 4. Restore, then verify by evidence.
  restoreKey();
  S.set({ restoredAt: new Date().toISOString() });
  const mode = existsSync(KEY) ? (statSync(KEY).mode & 0o777).toString(8) : 'missing';
  check('after the restore: the key is back with mode 600 and jev.key.j9-off is gone', mode === '600' && !existsSync(OFF), `${KEY} mode ${mode}; ${OFF} exists: ${existsSync(OFF)}`);
  const doc = jvJson(['doctor', '--check', 'jev'], { timeoutMs: 60_000 });
  const jevCheck = doc.json?.checks?.find((x) => x.name === 'jev');
  check('after the restore: jv doctor --check jev is OK', jevCheck?.status === 'OK', jevCheck ? `${jevCheck.status}: ${jevCheck.detail}` : err(doc));

  // 5. Resume.
  const before = taskRow(id);
  if (before.state !== 'queued') J.deviation(`the task was ${before.state} (${before.state_reason}) before jv task resume: something else resumed it after the restore`);
  J.start('resume');
  const r = jvJson(['task', 'resume', id], { timeoutMs: 10 * 60_000 });
  S.set({ resumed: true });
  let runId = r.json?.session;
  if (r.status === 4 && /already running/.test(r.json?.error ?? '')) {
    runId = runsOf(id).at(-1)?.id;
    J.deviation(`jv task resume exited 4 (${r.json.error}): the coordinator resumed the task first; the journey follows ${runId}`);
  } else {
    check('jv task resume starts the step (placed by Jev)', r.status === 0 && r.json?.how === 'placed' && !!runId, r.status ? err(r) : `how ${r.json.how}; run ${runId}; ${r.json.start?.placement?.model} ${r.json.start?.placement?.effort} on ${r.json.start?.placement?.provider} (${r.json.start?.placement?.runtime})`);
  }
  const t = await settle(id, { timeoutMs: 15 * 60_000 });
  J.stop('resume');
  check('the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const runs = runsOf(id);
  const decision = placementsOf(step.id)[0];
  check('the step has one Jev placement decision and a run on it', !!decision && decision.jev_model !== 'none' && runs.some((x) => x.id === decision.session_id) && chosenOf(decision).model === runs.at(-1)?.model, `${decision?.id} by ${decision?.jev_model} for ${decision?.session_id}: ${chosenOf(decision).model} ${chosenOf(decision).effort} on ${chosenOf(decision).provider}; runs ${runs.map(runLine).join('; ')}`);
  const report = reportOf(runs.at(-1)?.id);
  check('the step reported', !!report, report ? `${report.status}: ${oneLine(report.summary, 240)}` : 'no report');
  const wakes = query("SELECT key, value FROM meta WHERE key LIKE 'wake:%'");
  log(`wake meta: ${wakes.map((w) => `${w.key} ${oneLine(w.value, 200)}`).join('; ')}`);
}

try {
  await main();
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (moved) {
    restoreKey();
    const mode = existsSync(KEY) ? (statSync(KEY).mode & 0o777).toString(8) : 'missing';
    check('finally: the key is back with mode 600', mode === '600' && !existsSync(OFF), `${KEY} mode ${mode}`);
  }
}
J.finish();
