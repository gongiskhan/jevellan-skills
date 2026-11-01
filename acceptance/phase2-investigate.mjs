#!/usr/bin/env node
// Phase 2 acceptance (brief section 14, phase 2): a `single` task with duty investigate runs end to end on the
// sandbox on the claude-sdk runtime, and its report lands in the store.
//
// Task creation proper is phase 4, so this script plays its part through the installed runtime's own modules
// (dist/store.js, dist/launcher.js): it creates the task, its one step and the run row with an explicit owner
// placement (claude-sdk, claude-main, claude-sonnet-5-5, effort low, cwd the sandbox checkout: investigate is
// read-only), moves the step and the task to running, starts the run with spawnRun and polls the store until the run
// ends (10 minutes at most). Then it asserts on the store (node:sqlite, read only) and on `jv report` / `jv tail`.
//
// Usage: node acceptance/phase2-investigate.mjs        (JV_HOME and JV_SANDBOX override the defaults)
// Exit 0 when every check passes, 1 otherwise. Prints the task, step and run ids for phase3-placement.mjs.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  checkoutState,
  JV_HOME,
  jv,
  readStore,
  runtimeModule,
  SANDBOX,
  SANDBOX_NAME,
  secretLeaks,
  sleep,
  stamp,
  STORE_FILE,
  summary,
} from './lib.mjs';

const TASK_TEXT = 'Which pure functions in src/ have no unit test? Name each with its file and line.';
const TITLE = 'Pure functions in src/ without a unit test';
const PLACEMENT = { runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-sonnet-5-5', effort: 'low' };
const TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 250;
const REQUIRED_EVENTS = ['start', 'text', 'tool-call', 'tool-result', 'usage', 'report', 'end'];
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'mcp__jv__jv_report']);

async function main() {
  const id = `acceptance-phase2-${stamp()}`;
  process.stdout.write(`phase 2 acceptance ${id}\nJV_HOME ${JV_HOME}\nsandbox ${SANDBOX}\n\n`);

  // 1. The project (jv project add is idempotent: the same name and path return the row).
  const added = jv(['project', 'add', SANDBOX, '--json']);
  if (!check('jv project add', added.status === 0 && added.json?.project?.id, added.status === 0 ? added.json.project.id : added.stderr.trim())) {
    return summary();
  }
  const projectId = added.json.project.id;
  const before = checkoutState(SANDBOX);

  // 2. Task, step and run through the runtime's modules (what jv task create does in phase 4).
  const { openStore } = await runtimeModule('store.js');
  const { createRun, spawnRun, markLost } = await runtimeModule('launcher.js');
  const store = openStore();
  let task;
  let step;
  let run;
  let spawned;
  try {
    task = store.createTask({
      project_id: projectId,
      request_id: id,
      kind: 'single',
      title: TITLE,
      task_text: TASK_TEXT,
      workflow_json: JSON.stringify({ name: 'single', steps: [{ duty: 'investigate', instructions: '' }] }),
      state_reason: 'created by acceptance/phase2-investigate.mjs',
    }).row;
    step = store.createStep({ task_id: task.id, ordinal: 1, duty: 'investigate', state_reason: 'created with the task' }).row;
    run = createRun(store, {
      requestId: `${id}-run1`,
      projectId,
      taskId: task.id,
      stepId: step.id,
      kind: 'step',
      ...PLACEMENT,
      cwd: SANDBOX,
      stateReason: 'queued with the owner placement of the phase 2 acceptance',
    }).row;
    store.tx(() => {
      store.incrementStepAttempts(step.id);
      store.setStepState(step.id, 'running', `attempt 1 on run ${run.id}`);
      store.setTaskState(task.id, 'running', `step 1 investigate running (${run.id})`, { current_step: 1 });
    });
    spawned = spawnRun(store, run.id);
  } finally {
    store.close();
  }
  process.stdout.write(`task ${task.id} step ${step.id} run ${run.id} pid ${spawned.pid}\nlog ${spawned.log}\n\n`);

  // 3. Poll until the run ends. The native id must be on the row by the time any text event is visible.
  const started = Date.now();
  let nativeBeforeText = true;
  let firstTextSeen = false;
  let session;
  const db = readStore();
  try {
    const sessionQuery = db.prepare('SELECT * FROM sessions WHERE id = ?');
    const textQuery = db.prepare("SELECT seq FROM events WHERE session_id = ? AND kind = 'text' ORDER BY seq LIMIT 1");
    for (let poll = 1; ; poll++) {
      // read the native id first, then the text events: a text row seen after a null id would be a real violation
      session = sessionQuery.get(run.id);
      const text = textQuery.get(run.id);
      if (text && !firstTextSeen) {
        firstTextSeen = true;
        const again = sessionQuery.get(run.id);
        if (!session.native_session_id && !again.native_session_id) nativeBeforeText = false;
      }
      if (['done', 'failed', 'lost', 'stopped'].includes(session.state)) break;
      if (Date.now() - started > TIMEOUT_MS) break;
      if (poll % 20 === 0) {
        const s = openStore();
        try {
          markLost(s);
        } finally {
          s.close();
        }
      }
      await sleep(POLL_MS);
    }
    session = sessionQuery.get(run.id);
  } finally {
    db.close();
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`run ended after ${elapsed}s: ${session.state} (${session.state_reason})\n\n`);

  // 4. Assertions.
  const db2 = readStore();
  try {
    const events = db2.prepare('SELECT seq, kind, payload FROM events WHERE session_id = ? ORDER BY seq').all(run.id);
    const kinds = new Set(events.map((e) => e.kind));
    const stepRow = db2.prepare('SELECT * FROM steps WHERE id = ?').get(step.id);
    const taskRow = db2.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    const reportRow = db2.prepare('SELECT * FROM reports WHERE session_id = ?').get(run.id);
    const toolNames = events
      .filter((e) => e.kind === 'tool-call')
      .map((e) => JSON.parse(e.payload).name);

    check('run ended within 10 minutes', elapsed * 1000 <= TIMEOUT_MS + 5000, `${elapsed}s`);
    check('session done', session.state === 'done', `${session.state}: ${session.state_reason}`);
    check('placement on the row', ['runtime', 'provider', 'model', 'effort'].every((k) => session[k] === PLACEMENT[k]),
      `${session.runtime} ${session.provider} ${session.model} ${session.effort}`);
    check('native_session_id set', /^[0-9a-f-]{36}$/.test(session.native_session_id ?? ''), session.native_session_id ?? 'null');
    check('native_session_id set before the first text event', firstTextSeen && nativeBeforeText,
      firstTextSeen ? 'set when the first text event was visible' : 'no text event seen while polling');
    const transcript = join(
      JV_HOME, 'homes', PLACEMENT.provider, '.claude', 'projects', SANDBOX.replace(/[^A-Za-z0-9]/g, '-'), `${session.native_session_id}.jsonl`,
    );
    check('native transcript under the provider home', existsSync(transcript), transcript);
    for (const kind of REQUIRED_EVENTS) check(`event ${kind}`, kinds.has(kind), `${events.filter((e) => e.kind === kind).length}`);
    const offList = toolNames.filter((n) => !READ_ONLY_TOOLS.has(n));
    check('only read-only tools and jv_report were called', offList.length === 0, [...new Set(toolNames)].join(', '));
    check('reports row status done', reportRow?.status === 'done', reportRow ? `${reportRow.id} ${reportRow.status}` : 'no report row');
    check('report linked to the step and task', reportRow?.step_id === step.id && reportRow?.task_id === task.id);
    check('report not synthesized', !(reportRow?.limitations ?? '').startsWith('synthesized'), reportRow?.limitations ?? '');
    check('step done', stepRow.state === 'done', `${stepRow.state}: ${stepRow.state_reason}`);
    check('task done', taskRow.state === 'done', `${taskRow.state}: ${taskRow.state_reason}`);
    check('token counters non-zero', session.input_tokens + session.cache_read_tokens + session.cache_write_tokens > 0 && session.output_tokens > 0,
      `in ${session.input_tokens} out ${session.output_tokens} cache read ${session.cache_read_tokens} write ${session.cache_write_tokens} cost ${session.cost_usd}`);
    check('log file exists', existsSync(spawned.log) && statSync(spawned.log).isFile(), `${spawned.log} (${existsSync(spawned.log) ? statSync(spawned.log).size : 0} bytes)`);

    const viaCli = jv(['report', run.id, '--json']);
    check('jv report --json', viaCli.status === 0 && viaCli.json?.status === 'done', viaCli.status === 0 ? viaCli.json.id : viaCli.stderr.trim());
    const tail = jv(['tail', run.id, '--json']);
    const tailLines = tail.stdout.split('\n').filter(Boolean);
    check('jv tail --json lists every event', tail.status === 0 && tailLines.length === events.length, `${tailLines.length} lines, ${events.length} events`);

    const leaks = secretLeaks([STORE_FILE, `${STORE_FILE}-wal`, spawned.log]);
    check('secrets checked', leaks.secrets > 0, `${leaks.secrets} key files against ${leaks.checked.join(', ')}`);
    check('no secret value in the store or the log', leaks.leaks.length === 0,
      leaks.leaks.map((l) => `${l.secret} in ${l.target}${l.error ? ` (${l.error})` : ''}`).join('; '));

    const after = checkoutState(SANDBOX);
    check('sandbox main checkout untouched', after.head === before.head && after.branch === before.branch && after.status === before.status,
      `${after.branch} ${after.head.slice(0, 8)}, ${after.status === '' ? 'clean' : 'status changed'}`);

    if (reportRow) {
      process.stdout.write(`\nReport ${reportRow.id} (${reportRow.status}):\n${reportRow.summary}\n`);
      if (reportRow.limitations) process.stdout.write(`Limitations: ${reportRow.limitations}\n`);
    } else {
      process.stdout.write(`\nNo report. Last lines of the log:\n${readFileSync(spawned.log, 'utf8').split('\n').slice(-30).join('\n')}\n`);
    }
    process.stdout.write(`\nids: project ${projectId} task ${task.id} step ${step.id} run ${run.id}\n`);
  } finally {
    db2.close();
  }
  return summary();
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`phase 2 acceptance crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
