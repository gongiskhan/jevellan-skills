#!/usr/bin/env node
// J3 Coordinator (brief section 15; section 9), on the real sandbox project:
//
// start   jv coordinator start --project jevellan-live-sandbox opens the tmux session jv-coord-<project>, with a ready
//         prompt and the coordinator flags on the pane's command line, and a sessions row (kind coordinator).
// status  "status" is the first message typed into the window (tmux send-keys -l, then Enter): the coordinator runs
//         jv status --json and its reply shows the project with nothing open. The store keeps the finished tasks of
//         earlier phases (it is never pruned): a reply that says nothing is open and mentions that finished work
//         passes, recorded as a deviation.
// remote  jv coordinator status prints how Remote Control was verified, or the command the owner runs.
// rules   "what are your rules?": the reply lists the jv commands (the prompt is applied).
//
// The coordinator is LEFT RUNNING for the next stage. The reply text is read from the coordinator's native
// transcript (its --session-id) and the screen with tmux capture-pane -p -J -S -200 once the turn has settled.
//
// Usage: node acceptance/j03-coordinator.mjs [--tag T] [--reply-timeout-min 6] [--fresh]
//   --fresh  when a coordinator runs already and it is the one an earlier run of this script started (its session
//            id is in results/J03.json), stop it first so "status" is the first message of a new session. Without
//            --fresh, or for any other coordinator, the journey refuses to touch it and fails.
// Writes acceptance/results/J03.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkoutState, JV, JV_HOME, jvJson, log, query, queryOne, runtimeModule, SANDBOX, SANDBOX_NAME, sleep } from './lib.mjs';
import { arg, flag, journey, RESULTS_DIR } from './journey.mjs';

const J = journey(3, 'Coordinator');
const REPLY_TIMEOUT_MS = Number(arg('--reply-timeout-min', '6')) * 60_000;
const PROJECT = SANDBOX_NAME;
const JV_COMMANDS = ['jv status', 'jv task create', 'jv task show', 'jv task message', 'jv task answer', 'jv task stop', 'jv task resume', 'jv report', 'jv land', 'jv notes write', 'jv handoff', 'jv providers check', 'jv usage'];

const C = await runtimeModule('coordinator.js');
const T = await runtimeModule('transcript.js');
const tmux = C.realTmux;
const NAME = C.coordinatorTmuxName(PROJECT);
const TARGET = `=${NAME}:`;
const project = queryOne('SELECT * FROM projects WHERE name = ?', PROJECT);
const taskIds = () => query('SELECT id FROM tasks WHERE project_id = ? ORDER BY id', project.id).map((r) => r.id);
const err = (r) => `exit ${r.status}: ${r.json?.error ?? r.stderr.trim().slice(0, 300)}`;
const oneLine = (s, max = 600) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};
const tm = (args) => spawnSync('tmux', args, { encoding: 'utf8' });

function transcriptOf(status) {
  const home = join(JV_HOME, 'homes', status.provider);
  return T.findClaudeTranscript(home, project.path, status.nativeSessionId) ?? T.claudeTranscriptPath(home, project.path, status.nativeSessionId);
}
const size = (file) => (existsSync(file) ? statSync(file).size : 0);
function readFrom(file, offset) {
  if (!existsSync(file)) return [];
  return T.nativeRecords(readFileSync(file).subarray(offset).toString('utf8'), offset);
}

/** The assistant text and tool calls of the records, and whether a user record holds `needle`. */
function digest(records, needle) {
  const texts = [];
  const tools = [];
  let sawNeedle = false;
  for (const { value } of records) {
    const content = value?.message?.content;
    if (value.type === 'user') {
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

/** Types one line the way the owner would: send-keys -l, then Enter. */
function type(text) {
  return tm(['send-keys', '-t', TARGET, '-l', '--', text]).status === 0 && tm(['send-keys', '-t', TARGET, 'Enter']).status === 0;
}

/** Types `text` and waits for that turn to end and the screen to settle; returns reply, tools, screen, elapsed. */
async function ask(label, text) {
  const status = jvJson(['coordinator', 'status', '--project', PROJECT]).json;
  const ready = await C.waitForScreen(tmux, NAME, { timeoutMs: 60_000 });
  if (!check(`${label}: the coordinator screen is ready before typing`, ready.state === 'ready', ready.state)) return undefined;
  const file = transcriptOf(status);
  const offset = size(file);
  const started = Date.now();
  if (!check(`${label}: typed into ${TARGET}`, type(text), text)) return undefined;
  const tracker = new T.TurnTracker('claude');
  let records = [];
  let result;
  while (Date.now() - started < REPLY_TIMEOUT_MS) {
    await sleep(1000);
    const fresh = readFrom(file, offset);
    tracker.feed(fresh.slice(records.length), Date.now());
    records = fresh;
    const screen = C.capturePane(tmux, NAME) ?? '';
    const d = digest(records, text);
    if (d.sawNeedle && tracker.sawUser && tracker.ended(Date.now()) && d.reply && !/esc to interrupt/i.test(screen)) {
      result = { ...d, ms: Date.now() - started };
      break;
    }
  }
  result ??= { ...digest(records, text), ms: Date.now() - started, timedOut: true };
  // The screen once the reply has settled: two captures 2 s apart that agree.
  let screen = '';
  for (let i = 0; i < 10; i++) {
    const a = tm(['capture-pane', '-p', '-J', '-S', '-200', '-t', TARGET]).stdout;
    await sleep(2000);
    screen = tm(['capture-pane', '-p', '-J', '-S', '-200', '-t', TARGET]).stdout;
    if (a === screen) break;
  }
  result.screen = screen;
  J.set(`${label}ReplyMs`, result.ms);
  log(`${label}: reply after ${result.ms} ms${result.timedOut ? ' (timed out)' : ''}; tools ${result.tools.map((t) => `${t.name}: ${oneLine(t.input, 120)}`).join(' | ') || 'none'}`);
  log(`${label}: reply: ${oneLine(result.reply, 2000)}`);
  return result;
}

/** The part of the captured screen from the typed line to the next input prompt. */
function screenReply(screen, text) {
  const lines = screen.split('\n');
  let i = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k].includes(`> ${text}`) || lines[k].includes(`❯ ${text}`)) { i = k; break; }
  return (i >= 0 ? lines.slice(i) : lines.slice(-60)).join('\n').trim();
}

const baseline = { tasks: taskIds(), checkout: checkoutState(SANDBOX) };
function guard(label) {
  const extra = taskIds().filter((id) => !baseline.tasks.includes(id));
  for (const id of extra) jvJson(['task', 'stop', id, '--discard']);
  return check(`${label}: the coordinator created no task`, extra.length === 0, extra.length ? `created and discarded ${extra.join(', ')}` : `${baseline.tasks.length} tasks in the store for the project, unchanged`);
}

async function main() {
  log(`J3; JV_HOME ${JV_HOME}; project ${PROJECT} (${project.id}) at ${project.path}`);

  // ---- an existing coordinator: only one this script started, and only with --fresh
  if (C.hasSession(tmux, NAME)) {
    const cur = jvJson(['coordinator', 'status', '--project', PROJECT]).json;
    let mine;
    try {
      mine = JSON.parse(readFileSync(join(RESULTS_DIR, 'J03.json'), 'utf8')).elapsed?.coordinatorSessionId;
    } catch {
      mine = undefined;
    }
    if (flag('--fresh') && cur?.running && mine && cur.sessionId === mine) {
      const stop = jvJson(['coordinator', 'stop', '--project', PROJECT], { timeoutMs: 120_000 });
      log(`--fresh: stopped the coordinator ${mine} an earlier J3 run started: ${stop.status ? err(stop) : stop.json?.reason}`);
      J.note(`rerun with --fresh: stopped the coordinator ${mine} the previous J3 run had started`);
    } else {
      check('no coordinator runs before J3, or it is the one an earlier J3 run started and --fresh was given', false, `${NAME} exists (session ${cur?.sessionId}); J3 started ${mine ?? 'none'}; the journey does not touch a coordinator it did not start`);
      return;
    }
  }

  // ---- start
  J.start('start');
  const s = jvJson(['coordinator', 'start', '--project', PROJECT], { timeoutMs: 120_000 });
  J.stop('start');
  if (!check('jv coordinator start exits 0 with a ready prompt', s.status === 0 && s.json?.running && s.json?.screen === 'ready', s.status ? err(s) : `${s.json.sessionId} ${s.json.model} ${s.json.effort} on ${s.json.provider}; screen ${s.json.screen}`)) return;
  J.set('coordinatorSessionId', s.json.sessionId);
  J.set('nativeSessionId', s.json.nativeSessionId);
  const has = tm(['has-session', '-t', `=${NAME}`]).status === 0;
  const listed = tm(['ls', '-F', '#{session_name} #{session_windows} #{session_created}']).stdout.split('\n').find((l) => l.startsWith(`${NAME} `));
  check('the tmux session jv-coord-jevellan-live-sandbox is open, in the project checkout', has && tm(['display-message', '-p', '-t', TARGET, '#{pane_current_path}']).stdout.trim() === project.path, `${listed ?? 'not listed'}; cwd ${tm(['display-message', '-p', '-t', TARGET, '#{pane_current_path}']).stdout.trim()}`);
  const pid = C.panePid(tmux, NAME);
  const cmd = pid ? spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() : '';
  const flags = ['--model claude-opus-5-5', '--effort high', '--append-system-prompt-file', '--permission-mode bypassPermissions', '--session-id', `exec --session ${s.json.sessionId}`];
  check('the pane runs claude with the coordinator flags (Opus, high, the prompt file)', flags.every((f) => cmd.includes(f)) && !/TOKEN=|API_KEY=|sk-ant-/.test(cmd), flags.filter((f) => !cmd.includes(f)).join(', ') || `all present; no secret on the command line`);
  const row = queryOne('SELECT * FROM sessions WHERE id = ?', s.json.sessionId);
  check('the coordinator sessions row', row?.kind === 'coordinator' && row.runtime === 'claude-tmux' && row.native_session_id === s.json.nativeSessionId && row.tmux_target === TARGET && ['starting', 'running'].includes(row.state), `${row?.id} ${row?.kind} ${row?.runtime} ${row?.state} ${row?.provider} ${row?.model} ${row?.effort} ${row?.tmux_target}`);
  const prompt = readFileSync(s.json.promptFile, 'utf8');
  check('the prompt file is the coordinator skill filled for the project', prompt.includes(`"${PROJECT}"`) && prompt.includes(SANDBOX) && !/\{\{\w+\}\}/.test(prompt) && JV_COMMANDS.every((c) => prompt.includes(c)), `${s.json.promptFile}, ${prompt.length} characters, all 13 jv commands named`);

  // ---- status, the first message
  const store = jvJson(['status', '--project', PROJECT]).json;
  const openSessions = (store?.sessions ?? []).filter((x) => x.kind !== 'coordinator');
  check('the store: no open task and no running step for the project', Array.isArray(store?.tasks) && store.tasks.length === 0 && openSessions.length === 0, `tasks ${store?.tasks?.length}; sessions ${(store?.sessions ?? []).map((x) => `${x.id} ${x.kind}`).join(', ') || 'none'}; recent finished ${(store?.recent ?? []).map((x) => `${x.id} ${x.title}`).join('; ')}`);
  const st = await ask('status', 'status');
  if (st) {
    check('status: the coordinator ran jv status --json', st.tools.some((t) => /jv status\b.*--json/.test(t.input)), st.tools.map((t) => oneLine(t.input, 120)).join(' | ') || 'no tool call');
    const nothingOpen = /nothing (is )?(open|running|waiting|in flight|under way|queued|active|pending)|no (open|running|active|pending|queued|live)\b|no tasks?\b|(is|are) (idle|quiet|empty)|nothing (to|on) |nothing's|idle|quiet/i.test(st.reply);
    // "The project": the status the coordinator read is this project's (its jv status call is scoped to it, or the
    // reply names it); whether the reply names the project is in the evidence.
    const scoped = st.tools.some((t) => /jv status\b.*--project[ =]jevellan-live-sandbox\b/.test(t.input));
    const named = /jevellan-live-sandbox/.test(st.reply);
    check('status: the first reply shows the project with nothing open', !st.timedOut && nothingOpen && (scoped || named), `status scoped to the project: ${scoped ? 'yes' : 'no'}; reply names the project: ${named ? 'yes' : 'no'}; ${oneLine(st.reply, 500)}`);
    const recent = (store?.recent ?? []).map((x) => x.id);
    const mentionsFinished = recent.some((id) => st.reply.includes(id)) || /finished|completed|recent|earlier|landed|done|ended/i.test(st.reply);
    if (mentionsFinished) {
      J.deviation(`The first "status" reply says nothing is open and also mentions recent finished work (${recent.join(', ')}: the finished single tasks earlier phases left in the store, which is never pruned), where the brief expects "the project with no tasks".`);
    }
    J.note(`first reply to "status" (transcript): ${oneLine(st.reply, 1500)}`);
    J.note(`screen after the status reply (capture-pane -p -J -S -200, from the typed line): ${oneLine(screenReply(st.screen, 'status'), 1500)}`);
    J.note('On the captured screen, a "❯ <text>" line after the reply (in the input box) is Claude Code\'s prompt suggestion shown as ghost text, not input: the journey types only "status" and "what are your rules?".');
  }
  guard('status');

  // ---- remote control
  const cs = jvJson(['coordinator', 'status', '--project', PROJECT]);
  const rc = cs.json?.remoteControl;
  const text = spawnSync(JV, ['coordinator', 'status', '--project', PROJECT], { encoding: 'utf8' }).stdout;
  const startRc = s.json.remoteControl;
  check(
    'remote control: jv coordinator status prints how it was verified, or the manual command',
    cs.status === 0 && !!rc && (rc.state === 'seen' || ((rc.state === 'unavailable' || rc.state === 'requested') && rc.ownerCommand.length > 0 && text.includes(rc.ownerCommand))),
    rc ? `${rc.state}; requested ${rc.requested}; owner command: ${rc.ownerCommand}; ${oneLine(rc.detail, 300)}` : err(cs),
  );
  if (rc?.state !== 'seen') {
    check('remote control: without a full login it names jv providers login claude-main, and --remote-control is not passed', rc?.ownerCommand === 'jv providers login claude-main' && !startRc?.requested && !cmd.includes('--remote-control'), `owner command "${rc?.ownerCommand}"; requested ${startRc?.requested}`);
    J.deviation(`Remote Control is not on: claude-main signs in with a long-lived token, which Claude Code refuses for Remote Control (D-054). jv coordinator status prints the manual command "${rc?.ownerCommand}" (then jv coordinator restart --project ${PROJECT}); the owner's sign-in is needed to turn it on.`);
  }
  J.note(`jv coordinator status (text): ${oneLine(text, 1500)}`);

  // ---- rules
  const ru = await ask('rules', 'what are your rules?');
  if (ru) {
    const named = JV_COMMANDS.filter((c) => {
      const sub = c.replace(/^jv /, '');
      if (ru.reply.includes(sub)) return true;
      // "jv task create|show|message" style groups.
      const [group, word] = sub.split(' ');
      return word !== undefined && new RegExp(`${group}\\s+[a-z|/, ]*\\b${word}\\b`).test(ru.reply);
    });
    check('rules: the reply lists the jv commands', !ru.timedOut && named.length >= 6, `${named.length}/${JV_COMMANDS.length}: ${named.join(', ')}; missing ${JV_COMMANDS.filter((c) => !named.includes(c)).join(', ') || 'none'}`);
    // The prompt's own rules, beyond the command list: words of the coordinator prompt's rule text (each asserted to
    // be in the prompt file) that the reply restates. The reply's wording varies from run to run, so it is the share
    // of these, not one phrase, that counts.
    const phrases = ['Jev', 'Land now', 'deploy', 'production', 'notes', 'parallel', 'decision'];
    const inPrompt = phrases.filter((p) => prompt.includes(p));
    const inReply = inPrompt.filter((p) => ru.reply.includes(p));
    check("rules: the prompt is applied (the reply carries the prompt file's own rules)", inPrompt.length === phrases.length && inReply.length >= 4, `${inReply.length}/${inPrompt.length} of the prompt's phrases in the reply: ${inReply.join(', ')}; missing ${inPrompt.filter((p) => !inReply.includes(p)).join(', ') || 'none'}`);
    J.note(`reply to "what are your rules?": ${oneLine(ru.reply, 2500)}`);
  }
  guard('rules');

  // ---- left running for the next stage
  const end = jvJson(['coordinator', 'status', '--project', PROJECT]).json;
  check('the coordinator is left running', end?.running === true && end.sessionId === s.json.sessionId && C.hasSession(tmux, NAME), `${end?.sessionId} ${end?.sessionState}; screen ${end?.screen}; ${end?.attach}`);
  const now = checkoutState(SANDBOX);
  check('the sandbox checkout is unchanged', now.head === baseline.checkout.head && now.branch === baseline.checkout.branch && now.status === baseline.checkout.status, `${now.branch} ${now.head.slice(0, 12)}; status ${now.status ? oneLine(now.status, 200) : 'clean'}`);
}

await main();
J.finish();
