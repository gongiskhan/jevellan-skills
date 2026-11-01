#!/usr/bin/env node
// J7 Lost and resumed (brief section 15, sections 6.4 and 7): a running implement session's process group is killed
// by hand; within 10 seconds jv status shows the run lost; jv task resume continues the same native session (a new
// run row with the same native_session_id) and the step finishes.
//
// The task is a single implement task: "Add a one-line comment at the top of src/invoices/index.ts saying what the
// module computes. Commit it." Once its run is running with a native session id and has made its first tool call
// (and has not reported), the script sends SIGKILL to the run's process group (kill -KILL -<pgid>), then polls
// jv status --json every second for the run to be lost. Since D-078 a single task whose step committed lands like a
// workflow task, so after the step is done the task goes to landing; an asked landing is answered "Land now" as the
// owner and recorded.
//
// Usage: node acceptance/j07-lost.mjs [--tag T] [--note "..."]
// A rerun with the same tag reuses the task and does not kill twice (results/J07-state-<tag>.json).

import { check, jvJson, log, SANDBOX, SANDBOX_NAME, sleep, onBranch } from './lib.mjs';
import { journey } from './journey.mjs';
import { createTask, err, landedCommits, landingsOf, reportOf, runLine, runRow, runsOf, settle, stateFile, stepRow, taskRow, waitRunning } from './task-lib.mjs';

const J = journey(7, 'Lost and resumed');
const S = stateFile(7, J.tag);
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function main() {
  J.start('total');
  const c = createTask({
    duty: 'implement',
    title: 'Comment at the top of src/invoices/index.ts',
    text: 'Add a one-line comment at the top of src/invoices/index.ts saying what the module computes. Commit it.',
    request: `acceptance-j07-${J.tag || 'default'}`,
  });
  const p = c.json?.start?.placement;
  if (!check('jv task create (single implement) exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; run ${c.json.start?.session?.id}: ${p?.model} ${p?.effort} on ${p?.provider} (${p?.runtime})`)) return;
  const id = c.json.task.id;
  S.set({ task: id });

  let killed = S.get().killed;
  if (!killed) {
    const runId = c.json.start?.session?.id ?? runsOf(id).at(-1)?.id;
    const { run, tools } = await waitRunning(runId, { minTools: 1 });
    const ok = run.state === 'running' && !!run.native_session_id && !!run.pgid && tools >= 1 && !reportOf(runId);
    if (!check('the implement run is running with a native session id and its first tool calls, before the kill', ok, `${runLine(run)}; native ${run.native_session_id}; pgid ${run.pgid}; ${tools} tool calls`)) return;
    process.kill(-run.pgid, 'SIGKILL');
    const killedAt = Date.now();
    killed = { run: run.id, native: run.native_session_id, pgid: run.pgid, at: new Date(killedAt).toISOString(), tools };
    S.set({ killed });
    log(`SIGKILL to process group ${run.pgid} of ${run.id} after ${tools} tool calls`);
    let seenMs;
    let seenLine = '';
    while (Date.now() - killedAt < 30_000) {
      const s = jvJson(['status', '--project', SANDBOX_NAME]);
      const task = (s.json?.tasks ?? []).find((x) => x.id === id);
      if (task?.lost || task?.run?.state === 'lost') {
        seenMs = Date.now() - killedAt;
        seenLine = `task ${id} lost=${task.lost}, run ${task.run?.id} ${task.run?.state}`;
        break;
      }
      await sleep(1000);
    }
    const after = runRow(run.id);
    check('jv status shows the run lost within 10 s', seenMs !== undefined && seenMs <= 10_000, seenMs === undefined ? `not lost after 30 s: ${after.state}: ${after.state_reason}` : `${seenMs} ms: ${seenLine}; row ${after.state}: ${after.state_reason}`);
    J.set('lostSeenMs', seenMs ?? null);
  } else log(`an earlier run of this tag killed ${killed.run} at ${killed.at}`);

  let resumed = S.get().resumed;
  if (!resumed) {
    const r = jvJson(['task', 'resume', id], { timeoutMs: 5 * 60_000 });
    if (!check('jv task resume exits 0 and continues natively', r.status === 0 && r.json?.how === 'native', r.status ? err(r) : `${r.json.how} as ${r.json.session}`)) return;
    resumed = r.json.session;
    S.set({ resumed });
  }
  const next = runRow(resumed);
  check('the resume is a new run row with the same native_session_id', !!next && next.id !== killed.run && next.native_session_id === killed.native, `${killed.run} ${killed.native} -> ${next?.id} ${next?.native_session_id}; ${next?.state_reason}`);

  const answers = [];
  const t = await settle(id, { timeoutMs: 20 * 60_000, answerLanding: true, onAnswer: (a) => answers.push(a) });
  for (const a of answers) J.note(`landing ${a.landing} was asked (${a.reason}); answered "Land now" as the owner: ${a.result}`);
  const killedRun = runRow(killed.run);
  const step = stepRow(killedRun.step_id);
  check('the implement step finishes done', step.state === 'done', `step ${step.ordinal} ${step.duty}: ${step.state}: ${step.state_reason}`);
  const rep = reportOf(resumed) ?? reportOf(runsOf(id).filter((s) => s.step_id === step.id).at(-1).id);
  check('the resumed conversation reports done', rep?.status === 'done', `${rep?.session_id} ${rep?.status}: ${oneLine(rep?.summary)}`);
  log(`runs: ${runsOf(id).map(runLine).join('; ')}`);
  check('the task ends done', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const landed = landedCommits(id);
  const task = taskRow(id);
  if (landed.length) {
    J.deviation(`the brief's "single tasks do not land; its branch stays for gc" no longer holds since D-078: the step committed, so the task landed (${landed.join(', ')})`);
    check('the landed commit is on sandbox main', !!task.landed_commit && onBranch(SANDBOX, task.landed_commit, 'main'), `${task.landed_commit}`);
  } else log(`landings: ${landingsOf(id).map((l) => `${l.id} ${l.route} ${l.state}`).join(', ') || 'none'}`);
  J.stop('total');
}

try {
  await main();
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
}
J.finish();
