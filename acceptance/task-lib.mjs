// Task helpers of the journeys that create tasks directly with jv task create on the real sandbox (J6 onwards):
// create with a request id (so a rerun with the same --tag gets the same task back), the store rows of a task and
// its runs, waiting for a task to settle (answering an asked landing as the owner when the journey says so), waiting
// for a run to be running with tool calls, and a small per-journey state file (results/JNN-state-<tag>.json) that
// records what a journey already did by hand (an attach, a kill, an override) so a rerun does not do it twice.
// Plain ESM; reads the store read-only through lib.mjs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jvJson, log, query, queryOne, SANDBOX_NAME, sleep } from './lib.mjs';
import { RESULTS_DIR } from './journey.mjs';

export const IN_FLIGHT = ['queued', 'running', 'landing'];
export const LIVE = ['queued', 'starting', 'running'];

export const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};
export const err = (r) => `exit ${r.status}: ${r.json?.error ?? r.stderr.trim().slice(0, 300)}`;
export const taskRow = (id) => queryOne('SELECT * FROM tasks WHERE id = ?', id);
export const stepRow = (id) => queryOne('SELECT * FROM steps WHERE id = ?', id);
export const stepsOf = (taskId) => query('SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal', taskId);
export const runRow = (id) => queryOne('SELECT * FROM sessions WHERE id = ?', id);
export const runsOf = (taskId) => query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' ORDER BY started_at, rowid", taskId);
export const eventsOf = (runId) => query('SELECT seq, at, kind, payload FROM events WHERE session_id = ? ORDER BY seq', runId);
export const reportOf = (runId) => queryOne('SELECT * FROM reports WHERE session_id = ?', runId);
export const landingsOf = (taskId) => query('SELECT * FROM landings WHERE task_id = ? ORDER BY created_at, rowid', taskId);
export const placementsOf = (stepId) => query("SELECT * FROM decisions WHERE step_id = ? AND kind = 'placement' ORDER BY created_at, rowid", stepId);
export const runLine = (s) => `${s.id} ${s.runtime} ${s.provider} ${s.model} ${s.effort} ${s.state}${s.state_reason ? ` (${s.state_reason.replace(/\s+/g, ' ').slice(0, 160)})` : ''}`;

/** jv task create --project jevellan-live-sandbox ... --request-id <request> --json. */
export function createTask({ kind = 'single', duty, title, text, request, visible = false }) {
  const args = ['task', 'create', '--project', SANDBOX_NAME, '--kind', kind, '--title', title, '--text', text, '--request-id', request];
  if (duty) args.push('--duty', duty);
  if (visible) args.push('--visible');
  return jvJson(args, { timeoutMs: 10 * 60_000 });
}

/** The journey's state file: what it did by hand, kept across reruns with the same tag. */
export function stateFile(number, tag) {
  const file = join(RESULTS_DIR, `J${String(number).padStart(2, '0')}-state-${tag || 'default'}.json`);
  let value = parse(existsSync(file) ? readFileSync(file, 'utf8') : null, {}) ?? {};
  return {
    file,
    get: () => value,
    set(patch) {
      value = { ...value, ...patch };
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      return value;
    },
  };
}

/**
 * Waits until the task is out of queued/running/landing (jv status runs each round, so lost runs are marked). With
 * `answerLanding`, a landing Jev asked the owner about is answered "Land now" (once per landing row) and the answer
 * is passed to onAnswer. `until(task)` may end the wait earlier. Returns the task row, undefined on timeout.
 */
export async function settle(id, { timeoutMs = 20 * 60_000, answerLanding = false, onAnswer, until } = {}) {
  const deadline = Date.now() + timeoutMs;
  const answered = new Set();
  let last = '';
  for (;;) {
    jvJson(['status', '--project', SANDBOX_NAME]);
    const t = taskRow(id);
    const line = `${t.state}: ${t.state_reason}`;
    if (line !== last) log(`${id} ${line}`);
    last = line;
    if (until?.(t)) return t;
    const asked = landingsOf(id).filter((l) => l.state === 'asked').at(-1);
    if (t.state === 'waiting-owner' && asked && answerLanding && !answered.has(asked.id)) {
      answered.add(asked.id);
      const a = jvJson(['task', 'answer', id, 'Land now'], { timeoutMs: 15 * 60_000 });
      onAnswer?.({ landing: asked.id, reason: t.state_reason, status: a.status, result: a.status === 0 ? 'ok' : err(a) });
      continue;
    }
    if (!IN_FLIGHT.includes(t.state)) return t;
    if (Date.now() > deadline) return undefined;
    await sleep(5000);
  }
}

/** Waits until a run is running with a native session id, a pgid and at least `minTools` tool calls. */
export async function waitRunning(runId, { minTools = 1, timeoutMs = 5 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = runRow(runId);
    const n = queryOne("SELECT count(*) AS n FROM events WHERE session_id = ? AND kind = 'tool-call'", runId).n;
    if (run.state === 'running' && run.native_session_id && run.pgid && n >= minTools) return { run, tools: n };
    if (!LIVE.includes(run.state) || Date.now() > deadline) return { run, tools: n };
    await sleep(250);
  }
}

/** The tasks' landed commits on the sandbox (landings rows landed), for the journeys' notes. */
export function landedCommits(taskId) {
  return landingsOf(taskId).filter((l) => l.state === 'landed').map((l) => `${l.id} ${l.route} ${l.commit_sha ?? ''}`.trim());
}

/**
 * The gate of the journeys that change global config (J9, J10, J12): waits until jv status --json shows no running
 * work: no task queued, running or landing, and no step session queued, starting or running (the coordinator's own
 * session is not work). Returns {quiet, waitedMs, evidence}.
 */
export async function waitQuiet({ timeoutMs = 30 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = jvJson(['status']).json ?? {};
    const tasks = (s.tasks ?? []).filter((t) => IN_FLIGHT.includes(t.state));
    const runs = (s.sessions ?? []).filter((x) => x.kind !== 'coordinator' && LIVE.includes(x.state));
    const evidence = `jv status --json: ${tasks.length} tasks in flight${tasks.length ? ` (${tasks.map((t) => `${t.id} ${t.state}`).join(', ')})` : ''}, ${runs.length} live step runs${runs.length ? ` (${runs.map((r) => r.id).join(', ')})` : ''}; not-done tasks ${(s.tasks ?? []).map((t) => `${t.id} ${t.state}`).join(', ') || 'none'}`;
    if (!tasks.length && !runs.length) return { quiet: true, waitedMs: Date.now() - t0, evidence };
    if (Date.now() - t0 > timeoutMs) return { quiet: false, waitedMs: Date.now() - t0, evidence };
    log(`waiting for quiet: ${evidence}`);
    await sleep(10_000);
  }
}
