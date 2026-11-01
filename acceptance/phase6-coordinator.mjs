#!/usr/bin/env node
// Phase 6 acceptance (brief sections 9 and 14, phase 6; journeys J3 and the mechanics of J8), on the REAL sandbox
// project. The coordinator is only talked to here: it must not create tasks, and the sandbox checkout must not
// change. Every reply is read from the coordinator's native transcript (its session id is the row's native id), and
// a turn has ended when the transcript is idle and the screen shows no "esc to interrupt".
//
// start     jv coordinator start --project jevellan-live-sandbox: tmux session, ready prompt, the flags on the
//           pane's command line.
// status    "status" typed into the window: the coordinator runs jv status --json and says nothing is running or
//           waiting for the project.
// rules     "what are your rules?": the reply names the jv commands, and no instruction file of the owner's own
//           ~/.claude reached the coordinator (--setting-sources user).
// remote    jv coordinator status shows how Remote Control was verified, or the command the owner runs.
// wake      wake.notifyCoordinator with a harmless [jv] line: the line reaches the window and is answered.
// handoff   jv handoff --project prints the handoff.
// restart   jv coordinator restart: a new session, the handoff typed as its first message, and a reply to it.
// stop      jv coordinator stop: the tmux session is gone and the row stopped.
//
// Usage: node acceptance/phase6-coordinator.mjs [--reply-timeout-min 6]
// Exit 0 when every check passes, 1 otherwise.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { check, checkoutState, JV_HOME, jvJson, log, query, queryOne, runtimeModule, SANDBOX, SANDBOX_NAME, sleep, summary } from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const REPLY_TIMEOUT_MS = Number(arg('--reply-timeout-min', '6')) * 60_000;
const PROJECT = SANDBOX_NAME;
const JV_COMMANDS = ['jv status', 'jv task create', 'jv task show', 'jv task message', 'jv task answer', 'jv task stop', 'jv task resume', 'jv report', 'jv land', 'jv notes write', 'jv handoff', 'jv providers check', 'jv usage'];
const WAKE_TEXT = '[jv] acceptance check: a test wake line, no task is involved. Reply with one short sentence and run nothing.';

const C = await runtimeModule('coordinator.js');
const T = await runtimeModule('transcript.js');
const tmux = C.realTmux;
const NAME = C.coordinatorTmuxName(PROJECT);
const project = queryOne('SELECT * FROM projects WHERE name = ?', PROJECT);
const taskIds = () => query('SELECT id FROM tasks WHERE project_id = ? ORDER BY id', project.id).map((r) => r.id);
const baseline = { tasks: taskIds(), checkout: checkoutState(SANDBOX) };
const err = (r) => `exit ${r.status}: ${r.json?.error ?? r.stderr.trim().slice(0, 300)}`;
const oneLine = (s, max = 600) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

/** Fails the run when the coordinator created a task (and discards it at once). */
function guard(label) {
  const extra = taskIds().filter((id) => !baseline.tasks.includes(id));
  for (const id of extra) jvJson(['task', 'stop', id, '--discard']);
  return check(`${label}: the coordinator created no task`, extra.length === 0, extra.length ? `created and discarded ${extra.join(', ')}` : `${baseline.tasks.length} tasks, unchanged`);
}

function transcriptOf(status) {
  const home = join(JV_HOME, 'homes', status.provider);
  return T.findClaudeTranscript(home, project.path, status.nativeSessionId) ?? T.claudeTranscriptPath(home, project.path, status.nativeSessionId);
}

const size = (file) => (existsSync(file) ? statSync(file).size : 0);

function readFrom(file, offset) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file).subarray(offset).toString('utf8');
  return T.nativeRecords(raw, offset);
}

/** The assistant text and tool calls of the records, and whether a user record holds `needle`. */
function digest(records, needle) {
  const texts = [];
  const tools = [];
  let sawNeedle = needle === undefined;
  for (const { value } of records) {
    const content = value?.message?.content;
    if (value.type === 'user' && needle !== undefined) {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join(' ') : '';
      if (text.includes(needle)) sawNeedle = true;
    }
    if (value.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'text' && part.text) texts.push(part.text);
      if (part?.type === 'tool_use') tools.push({ name: part.name, input: part.input?.command ?? JSON.stringify(part.input ?? {}) });
    }
  }
  return { reply: texts.join('\n'), tools, sawNeedle };
}

/** Waits for the turn that starts at `offset` of `file` to end; returns its reply and tool calls. */
async function awaitTurn(file, offset, needle) {
  const started = Date.now();
  const tracker = new T.TurnTracker('claude');
  let records = [];
  while (Date.now() - started < REPLY_TIMEOUT_MS) {
    await sleep(1000);
    const fresh = readFrom(file, offset);
    tracker.feed(fresh.slice(records.length), Date.now());
    records = fresh;
    const screen = C.capturePane(tmux, NAME) ?? '';
    const d = digest(records, needle);
    if (d.sawNeedle && tracker.sawUser && tracker.ended(Date.now()) && d.reply && !/esc to interrupt/i.test(screen)) return { ...d, ms: Date.now() - started };
  }
  return { ...digest(records, needle), ms: Date.now() - started, timedOut: true };
}

async function ask(label, text) {
  const status = jvJson(['coordinator', 'status', '--project', PROJECT]).json;
  const ready = await C.waitForScreen(tmux, NAME, { timeoutMs: 60_000 });
  if (!check(`${label}: the coordinator screen is ready`, ready.state === 'ready', ready.state)) return undefined;
  const file = transcriptOf(status);
  const offset = size(file);
  C.typeLine(tmux, NAME, text);
  const turn = await awaitTurn(file, offset, text);
  log(`${label}: reply after ${turn.ms} ms${turn.timedOut ? ' (timed out)' : ''}; tools ${turn.tools.map((t) => `${t.name}: ${oneLine(t.input, 120)}`).join(' | ') || 'none'}`);
  log(`${label}: reply: ${oneLine(turn.reply, 1500)}`);
  return turn;
}

async function main() {
  log(`phase 6 acceptance; JV_HOME ${JV_HOME}; runtime ${spawnSync('readlink', [join(JV_HOME, 'runtime')], { encoding: 'utf8' }).stdout.trim()}; project ${PROJECT} (${project.id})`);
  if (C.hasSession(tmux, NAME)) {
    check('no coordinator session runs before the check', false, `${NAME} exists; stop it first (jv coordinator stop --project ${PROJECT})`);
    return summary();
  }
  try {
    // ---- start
    const t0 = Date.now();
    const s = jvJson(['coordinator', 'start', '--project', PROJECT], { timeoutMs: 120_000 });
    if (!check('jv coordinator start exits 0 with a ready prompt', s.status === 0 && s.json?.running && s.json?.screen === 'ready', s.status ? err(s) : `${s.json.sessionId} ${s.json.model} ${s.json.effort} on ${s.json.provider}; screen ${s.json.screen}; ${Date.now() - t0} ms`)) return summary();
    const pid = C.panePid(tmux, NAME);
    const cmd = pid ? spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() : '';
    log(`pane process: ${cmd}`);
    const flags = ['--model claude-opus-5-5', '--effort high', '--append-system-prompt-file', '--permission-mode bypassPermissions', '--session-id', '--setting-sources user', `exec --session ${s.json.sessionId}`];
    check('the pane runs claude through jv exec with the coordinator flags', flags.every((f) => cmd.includes(f)), flags.filter((f) => !cmd.includes(f)).join(', ') || 'all present');
    const startRc = s.json.remoteControl;
    if (startRc?.requested) {
      const rcFlags = [`--remote-control ${C.remoteControlName(PROJECT)}`, ...(startRc.homeLogin ? ['--home-login'] : [])];
      check('Remote Control: the pane has --remote-control jv-<project> (and --home-login on the own login)', rcFlags.every((f) => cmd.includes(f)), rcFlags.filter((f) => !cmd.includes(f)).join(', ') || 'all present');
    } else {
      check('Remote Control: not asked for on a token login, and the owner command is jv providers login claude-main', !cmd.includes('--remote-control') && !cmd.includes('--home-login') && startRc?.ownerCommand === 'jv providers login claude-main', `${startRc?.state}; owner: ${startRc?.ownerCommand}`);
    }
    check('no secret on the pane command line', !/TOKEN=|API_KEY=|sk-ant-/.test(cmd));
    const row = queryOne('SELECT * FROM sessions WHERE id = ?', s.json.sessionId);
    check('the coordinator sessions row', row?.kind === 'coordinator' && row.runtime === 'claude-tmux' && row.native_session_id === s.json.nativeSessionId && row.tmux_target === `=${NAME}:`, `${row?.kind} ${row?.runtime} ${row?.state} ${row?.native_session_id} ${row?.tmux_target}`);
    const prompt = readFileSync(s.json.promptFile, 'utf8');
    check('the prompt file names the project and has no unfilled placeholder', prompt.includes(PROJECT) && prompt.includes(SANDBOX) && !/\{\{\w+\}\}/.test(prompt), `${s.json.promptFile}, ${prompt.length} characters`);
    if (existsSync(join(SANDBOX, 'AGENTS.md'))) {
      check("the prompt carries the project's AGENTS.md (the coordinator loads no project instructions itself)", prompt.includes("# This project's AGENTS.md"), `${prompt.length} characters`);
    }

    // ---- status
    const st = await ask('status', 'status');
    if (st) {
      check('status: the coordinator ran jv status --json', st.tools.some((t) => /jv status\b.*--json/.test(t.input)), st.tools.map((t) => oneLine(t.input, 100)).join(' | ') || 'no tool call');
      check('status: the reply says nothing is running or waiting', !st.timedOut && /nothing|no (open|running|active|pending|tasks?)|idle|empty|none|zero|quiet/i.test(st.reply), oneLine(st.reply, 300));
    }
    guard('status');

    // ---- rules
    const ru = await ask('rules', 'what are your rules?');
    if (ru) {
      const named = JV_COMMANDS.filter((c) => ru.reply.includes(c.replace(/^jv /, '')) || ru.reply.includes(c));
      check('rules: the reply names the jv commands', !ru.timedOut && named.length >= 6, `${named.length}/${JV_COMMANDS.length}: ${named.join(', ')}`);
      check('rules: the prompt is applied (the reply names the project or its role)', /coordinat|delegat|jevellan-live-sandbox/i.test(ru.reply), oneLine(ru.reply, 200));
      // --setting-sources user: no CLAUDE.md or .claude/rules of the owner's home reach the coordinator.
      const owner = homedir();
      const file = transcriptOf(jvJson(['coordinator', 'status', '--project', PROJECT]).json);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const leaked = [join(owner, '.claude', 'CLAUDE.md'), join(owner, '.claude', 'rules')].filter((p) => text.includes(p));
      check("rules: the owner's own ~/.claude instructions are not loaded", text !== '' && leaked.length === 0, leaked.join(', ') || 'none in the transcript');
    }
    guard('rules');

    // ---- remote control
    const cs = jvJson(['coordinator', 'status', '--project', PROJECT]);
    const rc = cs.json?.remoteControl;
    check(
      'jv coordinator status shows how Remote Control was verified, or the owner command',
      cs.status === 0 && !!rc && (rc.state === 'seen' || ((rc.state === 'unavailable' || rc.state === 'requested') && rc.ownerCommand.length > 0)),
      rc ? `${rc.state}; ${oneLine(rc.detail, 400)}; owner: ${oneLine(rc.ownerCommand, 400)}` : err(cs),
    );
    log(`coordinator status text:\n${jvJson(['coordinator', 'status', '--project', PROJECT]).json ? spawnSync(join(JV_HOME, 'bin', 'jv'), ['coordinator', 'status', '--project', PROJECT], { encoding: 'utf8' }).stdout : ''}`);

    // ---- wake
    {
      const ready = await C.waitForScreen(tmux, NAME, { timeoutMs: 60_000 });
      check('wake: the screen is ready before the wake line', ready.state === 'ready', ready.state);
      const status = cs.json;
      const file = transcriptOf(status);
      const offset = size(file);
      const { openStore } = await runtimeModule('store.js');
      const W = await runtimeModule('wake.js');
      const store = openStore();
      let outcome;
      try {
        outcome = await W.wake(store, { projectId: project.id, line: WAKE_TEXT });
      } finally {
        store.close();
      }
      log(`wake outcome: ${JSON.stringify(outcome)}`);
      const turn = await awaitTurn(file, offset, '[jv] acceptance check');
      log(`wake: reply after ${turn.ms} ms: ${oneLine(turn.reply, 600)}; tools ${turn.tools.map((t) => oneLine(t.input, 100)).join(' | ') || 'none'}`);
      check('wake: the [jv] line reaches the window and is answered', turn.sawNeedle && !turn.timedOut && turn.reply.length > 0, `${outcome?.action}; ${oneLine(turn.reply, 200)}`);
      const meta = queryOne('SELECT value FROM meta WHERE key = ?', `wake:${project.id}`);
      log(`wake meta: ${meta?.value}`);
      guard('wake');
    }

    // ---- handoff
    const h = spawnSync(join(JV_HOME, 'bin', 'jv'), ['handoff', '--project', PROJECT], { encoding: 'utf8' });
    check('jv handoff prints the handoff', h.status === 0 && h.stdout.length > 0, `${h.stdout.length} characters; ${oneLine(h.stdout, 400)}`);

    // ---- restart
    const before = jvJson(['coordinator', 'status', '--project', PROJECT]).json;
    const r = jvJson(['coordinator', 'restart', '--project', PROJECT], { timeoutMs: 180_000 });
    if (check('jv coordinator restart exits 0, a new session, the handoff typed', r.status === 0 && r.json?.sessionId && r.json.sessionId !== before.sessionId && r.json.handoffTyped, r.status ? err(r) : `${before.sessionId} -> ${r.json.sessionId}; stop: ${r.json.stop?.reason}; handoff typed ${r.json.handoffTyped}`)) {
      const old = queryOne('SELECT state, state_reason FROM sessions WHERE id = ?', before.sessionId);
      check('restart: the previous coordinator row is stopped', old?.state === 'stopped', `${old?.state}: ${old?.state_reason}`);
      const file = transcriptOf(r.json);
      const turn = await awaitTurn(file, 0, C.HANDOFF_PREFIX);
      log(`restart: first reply after ${turn.ms} ms: ${oneLine(turn.reply, 1500)}; tools ${turn.tools.map((t) => oneLine(t.input, 100)).join(' | ') || 'none'}`);
      check('restart: the new session answers the handoff', turn.sawNeedle && !turn.timedOut && turn.reply.length > 0, oneLine(turn.reply, 300));
      guard('restart');
    }
  } finally {
    // ---- stop
    const status = jvJson(['coordinator', 'status', '--project', PROJECT]).json;
    const stop = jvJson(['coordinator', 'stop', '--project', PROJECT], { timeoutMs: 120_000 });
    const gone = !C.hasSession(tmux, NAME);
    const row = status?.sessionId ? queryOne('SELECT state, state_reason FROM sessions WHERE id = ?', status.sessionId) : undefined;
    check('jv coordinator stop: the tmux session is gone and the row stopped', stop.status === 0 && gone && row?.state === 'stopped', `${stop.status ? err(stop) : stop.json?.reason}; tmux ${gone ? 'gone' : 'still there'}; row ${row?.state}: ${row?.state_reason}`);
  }
  guard('end');
  const now = checkoutState(SANDBOX);
  check('the sandbox checkout is unchanged', now.head === baseline.checkout.head && now.branch === baseline.checkout.branch && now.status === baseline.checkout.status, `${now.branch} ${now.head.slice(0, 12)}; status ${now.status ? oneLine(now.status, 200) : 'clean'}`);
  const coords = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.startsWith('jv-coord-'));
  check('no jv-coord-* tmux session is left', coords.length === 0, coords.join(', ') || 'none');
  return summary();
}

process.exitCode = await main();
