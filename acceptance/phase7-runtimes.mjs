#!/usr/bin/env node
// Phase 7 acceptance (brief sections 6.2, 6.3, 6.5, 6.6 and 14, phase 7), on the disposable clone of the sandbox
// (JV_ACCEPT_CLONE, project JV_ACCEPT_PROJECT, default sandbox-clone). Every task here is read-only and small.
//
// providers  jv providers check: claude-main and claude-second ready with weekly percentages, codex ready or "needs
//            login" with the exact command, Jev reachable with its model listed; provider_usage rows (source probe)
//            written by this check.
// llm        A single answer task runs on the llm runtime in one turn with a parsed report; providers without a key
//            file (glm) are absent from the placement menu ("skipped: no key").
// codex      A single investigate task, created and at once overridden onto Codex (--undo), runs on the codex
//            runtime and reports through jv-report-mcp.
// tmux       A single investigate task created with --visible runs on claude-tmux; every tool call reaches the store
//            (jv tail) within 5 s of appearing in the native transcript (wall clock, polled every 250 ms); the report
//            arrives through jv-report-mcp; jv attach prints the tmux target.
// lost       A single investigate task on claude-sdk: its run's process group is killed (SIGKILL) once it is running;
//            jv status shows it lost within 10 s; jv task resume continues the same native session (new run row, same
//            native_session_id) and the step finishes.
//
// Usage: JV_ACCEPT_CLONE=<clone> node acceptance/phase7-runtimes.mjs [--only providers,llm,codex,tmux,lost] [--tag v1]
//        [--timeout-min 20]
// The checks run one after another (the latency measurement needs an idle event loop). Exit 0 when every check
// passes, 1 otherwise.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  CLONE,
  CLONE_PROJECT,
  JV_HOME,
  jvJson,
  log,
  query,
  queryOne,
  runtimeModule,
  sleep,
  summary,
} from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const TAG = arg('--tag', 'v1');
const ONLY = new Set(arg('--only', 'providers,llm,codex,tmux,lost').split(','));
const TIMEOUT_MS = Number(arg('--timeout-min', '20')) * 60_000;
const IN_FLIGHT = ['queued', 'running', 'landing'];
const LIVE = ['queued', 'starting', 'running'];
const created = [];

const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};
const taskRow = (id) => queryOne('SELECT * FROM tasks WHERE id = ?', id);
const runRow = (id) => queryOne('SELECT * FROM sessions WHERE id = ?', id);
const runsOf = (taskId) => query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' ORDER BY started_at, rowid", taskId);
const eventsOf = (runId) => query('SELECT seq, at, kind, payload FROM events WHERE session_id = ? ORDER BY seq', runId);
const reportOf = (runId) => queryOne('SELECT * FROM reports WHERE session_id = ?', runId);
const err = (r) => `exit ${r.status}: ${r.json?.error ?? r.stderr.trim().slice(0, 300)}`;
const providerHome = (name) => join(JV_HOME, 'homes', name);

function createTask({ kind = 'single', duty, title, text, request, visible = false }) {
  const args = ['task', 'create', '--project', CLONE_PROJECT, '--kind', kind, '--duty', duty, '--title', title, '--text', text, '--request-id', request];
  if (visible) args.push('--visible');
  const r = jvJson(args, { timeoutMs: 10 * 60_000 });
  if (r.status === 0) created.push(r.json.task.id);
  return r;
}

async function settle(id, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    jvJson(['status', '--project', CLONE_PROJECT]);
    const t = taskRow(id);
    const line = `${t.state}: ${t.state_reason}`;
    if (line !== last) log(`${id} ${line}`);
    last = line;
    if (!IN_FLIGHT.includes(t.state)) return t;
    if (Date.now() > deadline) return undefined;
    await sleep(5000);
  }
}

function reportChecks(label, run) {
  const report = reportOf(run.id);
  const events = eventsOf(run.id);
  const reportCall = events.find((e) => e.kind === 'tool-call' && /jv_report/.test(parse(e.payload, {}).name ?? ''));
  check(`${label}: a report row for ${run.id}`, !!report, report ? `${report.status}: ${report.summary.replace(/\s+/g, ' ').slice(0, 200)}` : 'none');
  return { report, events, reportCall };
}

// ---- providers -------------------------------------------------------------------------------------------------

async function providers() {
  const since = new Date().toISOString();
  const r = jvJson(['providers', 'check'], { timeoutMs: 5 * 60_000 });
  if (!check('jv providers check exits 0', r.status === 0 && r.json, r.status ? err(r) : '')) return;
  const by = new Map(r.json.providers.map((p) => [p.name, p]));
  for (const name of ['claude-main', 'claude-second']) {
    const p = by.get(name);
    check(`${name} ready with a weekly percentage`, p?.auth === 'ready' && typeof p.usage?.weeklyPct === 'number', p ? `${p.auth}; week ${p.usage?.weeklyPct ?? '?'}% (resets ${p.usage?.weeklyResetsAt ?? '?'}), five hours ${p.usage?.fiveHourPct ?? 'unknown'}; ${p.detail}` : 'missing');
  }
  const codex = by.get('codex');
  check(
    'codex ready, or needs login with the exact command',
    codex?.auth === 'ready' || (codex?.auth === 'needs-login' && codex.fix === 'jv providers login codex'),
    codex ? `${codex.auth}; ${codex.detail}${codex.usage ? `; week ${codex.usage.weeklyPct}%` : ''}${codex.models ? `; models ${codex.models.ids.join(', ')}` : ''}${codex.fix ? `; fix: ${codex.fix}` : ''}` : 'missing',
  );
  check('Jev reachable with its model listed', r.json.jev.reachable && r.json.jev.listed, `${r.json.jev.model}: ${r.json.jev.detail}`);
  for (const p of r.json.providers.filter((x) => !['claude-main', 'claude-second', 'codex'].includes(x.name))) {
    log(`provider ${p.name}: ${p.auth}; ${p.detail}${p.fix ? `; fix: ${p.fix}` : ''}`);
  }
  const ready = r.json.providers.filter((p) => p.auth === 'ready' && ['claude-subscription', 'codex-subscription'].includes(p.kind)).map((p) => p.name);
  const rows = query("SELECT provider, observed_at, weekly_pct, five_hour_pct FROM provider_usage WHERE source = 'probe' AND observed_at >= ? ORDER BY observed_at", since);
  const withRows = new Set(rows.map((x) => x.provider));
  check('provider_usage rows with source probe for every ready subscription', ready.length > 0 && ready.every((n) => withRows.has(n)), rows.map((x) => `${x.provider} ${x.weekly_pct}% @${x.observed_at}`).join(', '));
}

// ---- llm -------------------------------------------------------------------------------------------------------

async function llm() {
  const c = createTask({ duty: 'answer', title: 'HTTP 409', text: 'What does HTTP status 409 mean? One paragraph.', request: `acceptance-phase7-llm-${TAG}` });
  if (!check('llm: jv task create --kind single --duty answer exits 0', c.status === 0, c.status ? err(c) : c.json.task.id)) return;
  const id = c.json.task.id;
  check('llm: an answer task has no worktree', !c.json.task.worktree_path, c.json.task.worktree_path ?? 'none');
  const t = await settle(id, 10 * 60_000);
  if (!check('llm: the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out')) return;
  const runs = runsOf(id);
  const run = runs[0];
  check('llm: one run, on the llm runtime', runs.length === 1 && run.runtime === 'llm', runs.map((x) => `${x.id} ${x.runtime} ${x.provider} ${x.model} ${x.effort} ${x.state}`).join(', '));
  const { report, events } = reportChecks('llm', run);
  const usage = events.filter((e) => e.kind === 'usage');
  const tools = events.filter((e) => e.kind === 'tool-call');
  check('llm: one turn (one usage event, no tool calls)', usage.length === 1 && tools.length === 0, `${usage.length} usage, ${tools.length} tool calls; ${run.input_tokens} in, ${run.output_tokens} out, $${run.cost_usd ?? '?'}`);
  check('llm: the report was parsed, not synthesized', report?.status === 'done' && !/synthesized/.test(report.limitations ?? ''), `${report?.status}; limitations ${report?.limitations ?? 'none'}`);
  const decision = queryOne("SELECT * FROM decisions WHERE step_id = ? AND kind = 'placement' ORDER BY created_at", run.step_id);
  const menu = parse(decision?.state_json, {}).menu ?? {};
  const menuProviders = (menu.providers ?? []).map((p) => p.name);
  const models = (menu.models ?? []).map((m) => `${m.label}/${m.provider}/${m.runtime}`);
  log(`llm placement ${decision?.id}: ${run.model} ${run.effort} on ${run.provider}; menu ${models.join(', ')}`);
  const glmKey = existsSync(join(JV_HOME, 'secrets', 'glm.key'));
  if (glmKey) log('llm: glm has a key file; a second answer task on glm is not part of this script');
  else check('llm: glm skipped: no key (absent from the placement menu)', !menuProviders.includes('glm'), `menu providers ${menuProviders.join(', ')}`);
}

// ---- codex -----------------------------------------------------------------------------------------------------

async function codex() {
  const c = createTask({ duty: 'investigate', title: 'Test runner of the project', text: "Name the test runner this project's package.json uses, in one sentence.", request: `acceptance-phase7-codex-${TAG}` });
  if (!check('codex: jv task create exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; first placement ${c.json.start?.placement?.model} ${c.json.start?.placement?.effort} on ${c.json.start?.placement?.provider}`)) return;
  const id = c.json.task.id;
  const first = c.json.start?.session?.id;
  const o = jvJson(['task', 'override', id, '--model', 'gpt-6-astra', '--effort', 'low', '--provider', 'codex', '--undo'], { timeoutMs: 5 * 60_000 });
  if (!check('codex: jv task override --provider codex --undo exits 0', o.status === 0, o.status ? err(o) : `stopped ${o.json.stopped ?? 'nothing'}; ${o.json.placement.runtime} ${o.json.placement.model} ${o.json.placement.effort}; decision ${o.json.decision}; run ${o.json.session}`)) {
    if (/login/i.test(o.json?.error ?? o.stderr)) log(`codex needs login: ${o.json?.error ?? o.stderr.trim()}`);
    return;
  }
  if (first) {
    const f = runRow(first);
    check('codex: the first run stopped "overridden by the owner"', f.state === 'stopped' && /overridden by the owner/.test(f.state_reason), `${f.id} ${f.runtime} ${f.model}: ${f.state}: ${f.state_reason}`);
  }
  const t = await settle(id, 15 * 60_000);
  const run = o.json.session ? runRow(o.json.session) : undefined;
  if (!check('codex: the overridden run exists on the codex runtime', run?.runtime === 'codex' && run.provider === 'codex', run ? `${run.id} ${run.runtime} ${run.provider} ${run.model} ${run.effort}` : 'none')) return;
  check('codex: the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  check('codex: the run has a thread id', !!run.native_session_id, run.native_session_id ?? 'none');
  const { report, events, reportCall } = reportChecks('codex', run);
  check('codex: the report came through jv-report-mcp (a jv_report tool call)', !!report && !!reportCall, reportCall ? parse(reportCall.payload, {}).name : 'no jv_report tool call');
  const start = parse(events.find((e) => e.kind === 'start')?.payload, {});
  check('codex: the start event names codex', start.runtime === 'codex' && start.provider === 'codex', JSON.stringify(start).slice(0, 200));
  const usage = events.filter((e) => e.kind === 'usage').map((e) => parse(e.payload, {}));
  log(`codex usage events: ${JSON.stringify(usage)}; row ${run.input_tokens} in, ${run.output_tokens} out, cache read ${run.cache_read_tokens}`);
  const decision = queryOne('SELECT * FROM decisions WHERE id = ?', o.json.decision);
  const chosen = parse(decision?.chosen_json, {});
  const overridden = chosen.overrides ? queryOne('SELECT * FROM decisions WHERE id = ?', chosen.overrides) : undefined;
  check(
    "codex: the owner decision has source owner and no Jev model; Jev's decision records the undo",
    decision?.jev_model === 'none' && chosen.source === 'owner' && overridden?.override_mode === 'undo' && parse(overridden.override_json, {}).provider === 'codex',
    `${decision?.id} ${decision?.jev_model} ${chosen.source} ${chosen.model}; ${overridden?.id} ${overridden?.override_mode} ${overridden?.override_json}`,
  );
}

// ---- tmux ------------------------------------------------------------------------------------------------------

function transcriptToolIds(file) {
  const ids = [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return ids;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row?.message?.content;
    if (row.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const part of content) if (part?.type === 'tool_use' && part.id) ids.push({ id: part.id, name: part.name, at: row.timestamp });
  }
  return ids;
}

async function tmux() {
  const c = createTask({ duty: 'investigate', title: 'Where the server listens', text: 'Which file in src/ starts the HTTP server, and on which port? Two sentences.', request: `acceptance-phase7-tmux-${TAG}`, visible: true });
  if (!check('tmux: jv task create --visible exits 0', c.status === 0, c.status ? err(c) : c.json.task.id)) return;
  const id = c.json.task.id;
  const runId = c.json.start?.session?.id;
  const p = c.json.start?.placement;
  if (!check('tmux: the visible step runs on claude-tmux', p?.runtime === 'claude-tmux', p ? `${runId}: ${p.model} ${p.effort} on ${p.provider} (${p.runtime}), decision ${p.decisionId}` : JSON.stringify(c.json.start ?? {}).slice(0, 300))) return;
  const { findClaudeTranscript } = await runtimeModule('transcript.js');

  const seenInTranscript = new Map();
  const seenInStore = new Map();
  let transcript;
  let attach;
  let paneCmd = '';
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const run = runRow(runId);
    const now = Date.now();
    if (!transcript && run.native_session_id) transcript = findClaudeTranscript(providerHome(run.provider), run.cwd, run.native_session_id);
    if (transcript) for (const t of transcriptToolIds(transcript)) if (!seenInTranscript.has(t.id)) seenInTranscript.set(t.id, { ...t, wall: now });
    for (const e of query("SELECT at, payload FROM events WHERE session_id = ? AND kind = 'tool-call'", runId)) {
      const pid = parse(e.payload, {}).id;
      if (pid && !seenInStore.has(pid)) seenInStore.set(pid, { wall: now, at: e.at });
    }
    if (!attach && run.tmux_target && run.state === 'running') {
      attach = jvJson(['attach', runId], { timeoutMs: 30_000 });
      if (run.pid) paneCmd = spawnSync('ps', ['-o', 'args=', '-p', String(run.pid)], { encoding: 'utf8' }).stdout.trim();
    }
    if (!LIVE.includes(run.state) || now > deadline) break;
    await sleep(250);
  }
  const run = runRow(runId);
  log(`tmux run ${run.id}: ${run.state}: ${run.state_reason}; tmux_target ${run.tmux_target}; native ${run.native_session_id}`);
  log(`tmux pane process: ${paneCmd.replace(/\s+/g, ' ').slice(0, 600)}`);
  check('tmux: the row has a tmux target jv-R... and a native session id', /jv-R[0-9A-Z]{6}/.test(run.tmux_target ?? '') && !!run.native_session_id, `${run.tmux_target} ${run.native_session_id}`);
  check('tmux: the native transcript exists under the provider home', !!transcript && transcript.endsWith(`${run.native_session_id}.jsonl`), transcript ?? 'not found');
  check('tmux: jv attach prints the tmux target', attach?.status === 0 && JSON.stringify(attach.json ?? attach.stdout).includes(run.id), attach ? (attach.status ? err(attach) : JSON.stringify(attach.json ?? attach.stdout).slice(0, 300)) : 'never ran (the run was not running)');
  const lags = [];
  for (const [toolId, t] of seenInTranscript) {
    const s = seenInStore.get(toolId);
    lags.push({ toolId, name: t.name, lagMs: s ? s.wall - t.wall : null, stampLagMs: s ? Date.parse(s.at) - Date.parse(t.at) : null });
  }
  const missing = lags.filter((l) => l.lagMs === null);
  const max = Math.max(0, ...lags.filter((l) => l.lagMs !== null).map((l) => l.lagMs));
  log(`tmux tool calls, transcript -> store lag (wall clock, ms): ${lags.map((l) => `${l.name} ${l.lagMs}`).join(', ')}`);
  check('tmux: every transcript tool call is in the store within 5 s', lags.length > 0 && missing.length === 0 && max <= 5000, `${lags.length} tool calls, max lag ${max} ms${missing.length ? `, missing ${missing.map((m) => m.name).join(', ')}` : ''}`);
  const tail = jvJson(['tail', runId], { timeoutMs: 30_000 });
  const tailLines = tail.stdout.split('\n').filter(Boolean).map((l) => parse(l, {}));
  check('tmux: jv tail shows the stream (start, tool calls, report, end)', ['start', 'tool-call', 'report', 'end'].every((k) => tailLines.some((l) => l.kind === k)), `${tailLines.length} events: ${[...new Set(tailLines.map((l) => l.kind))].join(', ')}`);
  const { report, reportCall } = reportChecks('tmux', run);
  check('tmux: the report came through jv-report-mcp (mcp__jv__jv_report)', !!report && !!reportCall && !/synthesized/.test(report.limitations ?? ''), reportCall ? parse(reportCall.payload, {}).name : 'no jv_report tool call');
  const t = await settle(id, 5 * 60_000);
  check('tmux: the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const alive = spawnSync('tmux', ['has-session', '-t', `=${run.tmux_target}`]).status === 0;
  check('tmux: the window is closed once the task is done', !alive, alive ? `${run.tmux_target} still running` : `${run.tmux_target} gone`);
}

// ---- lost ------------------------------------------------------------------------------------------------------

async function lost() {
  const c = createTask({ duty: 'investigate', title: 'Exported customer functions', text: 'List every exported function in src/customers/ with its file and a one-line description.', request: `acceptance-phase7-lost-${TAG}` });
  if (!check('lost: jv task create exits 0', c.status === 0, c.status ? err(c) : c.json.task.id)) return;
  const id = c.json.task.id;
  let runId = c.json.start?.session?.id;
  let p = c.json.start?.placement;
  log(`lost: run ${runId}: ${p?.model} ${p?.effort} on ${p?.provider} (${p?.runtime}), Jev's placement`);
  if (p?.runtime !== 'claude-sdk') {
    // J7 is about the default runtime: an owner placement moves the step onto claude-sdk (Sonnet low) first.
    const o = jvJson(['task', 'override', id, '--model', 'claude-sonnet-5-5', '--effort', 'low', '--provider', 'claude-main', '--undo'], { timeoutMs: 5 * 60_000 });
    if (!check('lost: override onto claude-sdk exits 0', o.status === 0, o.status ? err(o) : `stopped ${o.json.stopped}; run ${o.json.session}`)) return;
    runId = o.json.session;
    p = o.json.placement;
  }
  if (!check('lost: the run is on claude-sdk', p?.runtime === 'claude-sdk', `${runId}: ${p?.model} ${p?.effort} on ${p?.provider} (${p?.runtime})`)) return;
  let run;
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    run = runRow(runId);
    const n = queryOne("SELECT count(*) AS n FROM events WHERE session_id = ? AND kind IN ('text','tool-call')", runId).n;
    if (run.state === 'running' && run.native_session_id && run.pgid && n > 0) break;
    if (!LIVE.includes(run.state) || Date.now() > deadline) break;
    await sleep(250);
  }
  if (!check('lost: the run is running with a native session id before the kill', run.state === 'running' && !!run.native_session_id && !reportOf(runId), `${run.state}; native ${run.native_session_id}; pgid ${run.pgid}`)) return;
  process.kill(-run.pgid, 'SIGKILL');
  const killedAt = Date.now();
  log(`lost: SIGKILL to process group ${run.pgid} of ${runId}`);
  let seen;
  while (Date.now() - killedAt < 30_000) {
    const s = jvJson(['status', '--project', CLONE_PROJECT]);
    const task = (s.json?.tasks ?? []).find((x) => x.id === id);
    if (task?.lost || (s.json?.lost ?? []).includes(runId)) {
      seen = Date.now() - killedAt;
      break;
    }
    await sleep(1000);
  }
  check('lost: jv status shows the run lost within 10 s', seen !== undefined && seen <= 10_000, seen === undefined ? `not lost after 30 s: ${runRow(runId).state}` : `${seen} ms; ${runRow(runId).state}: ${runRow(runId).state_reason}`);
  const r = jvJson(['task', 'resume', id], { timeoutMs: 5 * 60_000 });
  if (!check('lost: jv task resume exits 0', r.status === 0, r.status ? err(r) : `${r.json.how} as ${r.json.session}`)) return;
  const next = runRow(r.json.session);
  check('lost: resume is a new run row with the same native_session_id', next && next.id !== runId && next.native_session_id === run.native_session_id, `${runId} ${run.native_session_id} -> ${next?.id} ${next?.native_session_id} (${r.json.how})`);
  const t = await settle(id, 15 * 60_000);
  const step = queryOne('SELECT * FROM steps WHERE id = ?', run.step_id);
  check('lost: the step finishes', step.state === 'done' && t?.state === 'done', `step ${step.state}: ${step.state_reason}; task ${t?.state}`);
  const resumed = reportOf(next.id);
  log(`lost: report of ${next.id}: ${resumed?.status}: ${resumed?.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ---- main ------------------------------------------------------------------------------------------------------

async function main() {
  if (!CLONE || !existsSync(join(CLONE, '.git'))) {
    process.stderr.write('JV_ACCEPT_CLONE must name the disposable clone of the sandbox\n');
    return 2;
  }
  log(`phase 7 acceptance; JV_HOME ${JV_HOME}; runtime ${spawnSync('readlink', [join(JV_HOME, 'runtime')], { encoding: 'utf8' }).stdout.trim()}; project ${CLONE_PROJECT}; tag ${TAG}`);
  for (const [name, fn] of [['providers', providers], ['llm', llm], ['codex', codex], ['tmux', tmux], ['lost', lost]]) {
    if (!ONLY.has(name)) continue;
    log(`---- ${name}`);
    try {
      await fn();
    } catch (error) {
      check(`${name}: no exception`, false, error instanceof Error ? error.stack : String(error));
    }
  }
  const live = created.flatMap((id) => runsOf(id)).filter((s) => LIVE.includes(s.state));
  check('no live run of this script is left', live.length === 0, live.map((s) => `${s.id}:${s.state}`).join(', ') || 'none');
  const windows = created.flatMap((id) => runsOf(id)).filter((s) => s.tmux_target && spawnSync('tmux', ['has-session', '-t', `=${s.tmux_target}`]).status === 0);
  check('no tmux window of this script is left', windows.length === 0, windows.map((s) => s.tmux_target).join(', ') || 'none');
  return summary();
}

process.exitCode = await main();
