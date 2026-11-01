#!/usr/bin/env node
// J6 Takeover (brief section 15, sections 6.1 to 6.3): jv attach on a claude-sdk session opens the same conversation
// interactively under the provider's HOME; what the owner types there reaches the native transcript and, after
// jv task resume, the store.
//
// 1. jv coordinator stop --project jevellan-live-sandbox, so the coordinator does not answer the task itself (it is
//    started again at the end).
// 2. A single investigate task that reports needs-decision with the options "Keep it" and "Split it". When Jev places
//    it on another runtime than claude-sdk, it is moved at once onto claude-sdk (Sonnet low on claude-main, --undo),
//    recorded as a deviation.
// 3. Once the task waits on the owner: jv attach <run> (not in a terminal it creates the detached tmux session
//    jv-<R> running claude --resume under the provider home and prints the attach command); the run is waiting
//    "attached by owner". The script types "The code word is PELICAN. Reply only with OK." there, waits for the reply
//    in the pane, then types /exit and waits for the window to close.
// 4. jv task resume <T>: the typed line is in the native transcript after the offset jv attach recorded (meta
//    takeover:<R>), the store has the takeover's events on the attached run (a message event with source takeover
//    carrying the line, and the assistant's reply), and a new run row with the same native_session_id continues.
// 5. The task finishes: jv task answer <T> "Keep it" when it waits on the owner again.
//
// Usage: node acceptance/j06-takeover.mjs [--tag T] [--note "..."]
// A rerun with the same tag reuses the task and skips what results/J06-state-<tag>.json says it already did.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { check, jvJson, log, queryOne, runtimeModule, SANDBOX_NAME, sleep } from './lib.mjs';
import { journey } from './journey.mjs';
import { createTask, err, eventsOf, parse, reportOf, runLine, runRow, runsOf, settle, stateFile } from './task-lib.mjs';

const J = journey(6, 'Takeover');
const S = stateFile(6, J.tag);
const C = await runtimeModule('coordinator.js');
const T = await runtimeModule('transcript.js');
const MESSAGE = 'The code word is PELICAN. Reply only with OK.';
const tm = (args) => spawnSync('tmux', args, { encoding: 'utf8' });
const hasSession = (name) => tm(['has-session', '-t', `=${name}`]).status === 0;
const capture = (name) => tm(['capture-pane', '-p', '-J', '-S', '-200', '-t', `=${name}:`]).stdout ?? '';
const oneLine = (s, max = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The interactive claude is at its input prompt: a prompt line, no turn running, no dialog, stable for 3 s. */
async function paneReady(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let since = Date.now();
  for (;;) {
    if (!hasSession(name)) return { ready: false, screen: last, gone: true };
    const s = capture(name);
    if (s !== last) {
      last = s;
      since = Date.now();
    }
    const ok = /^\s*[❯>]\s*$/m.test(s) && !/esc to interrupt/i.test(s) && C.screenState(s) !== 'dialog';
    if (ok && Date.now() - since >= 3000) return { ready: true, screen: s };
    if (Date.now() > deadline) return { ready: false, screen: s };
    await sleep(500);
  }
}

function typeLine(name, text) {
  return tm(['send-keys', '-t', `=${name}:`, '-l', '--', text]).status === 0 && tm(['send-keys', '-t', `=${name}:`, 'Enter']).status === 0;
}

/** Transcript entries from a byte offset: the user lines and the assistant texts. */
function transcriptFrom(file, offset) {
  if (!file || !existsSync(file)) return { users: [], texts: [] };
  const records = T.nativeRecords(readFileSync(file).subarray(offset).toString('utf8'), offset);
  const users = [];
  const texts = [];
  for (const { value } of records) {
    const content = value?.message?.content;
    if (value?.type === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p?.type === 'text' ? p.text ?? '' : '')).join(' ') : '';
      if (text.trim()) users.push({ at: value.timestamp, text });
    }
    if (value?.type === 'assistant' && Array.isArray(content)) for (const p of content) if (p?.type === 'text' && p.text) texts.push({ at: value.timestamp, text: p.text });
  }
  return { users, texts };
}

async function main() {
  const st = S.get();
  // 1. The coordinator stops for the journey.
  if (!st.coordinatorStopped) {
    const before = jvJson(['coordinator', 'status', '--project', SANDBOX_NAME]).json;
    const stop = jvJson(['coordinator', 'stop', '--project', SANDBOX_NAME], { timeoutMs: 90_000 });
    check('jv coordinator stop exits 0', stop.status === 0, stop.status ? err(stop) : `${before?.sessionId ?? '?'}: ${stop.json?.reason}`);
    S.set({ coordinatorStopped: true, coordinatorWas: before?.sessionId ?? null });
  } else log(`the coordinator was stopped by an earlier run of this tag (${st.coordinatorWas})`);

  // 2. The task.
  J.start('toWaitingOwner');
  const c = createTask({
    duty: 'investigate',
    title: 'Split the page rendering out of server.ts?',
    text: "Read src/web/server.ts and ask the owner, as a needs-decision report with the options 'Keep it' and 'Split it', whether the page rendering should be split out of it. Do not decide it yourself.",
    request: `acceptance-j06-${J.tag || 'default'}`,
  });
  if (!check('jv task create (single investigate) exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; ${c.json.start?.placement?.model} ${c.json.start?.placement?.effort} on ${c.json.start?.placement?.provider} (${c.json.start?.placement?.runtime})`)) return;
  const id = c.json.task.id;
  S.set({ task: id });
  const p = c.json.start?.placement;
  if (p && p.runtime !== 'claude-sdk' && !S.get().movedToSdk) {
    J.deviation(`Jev placed the step on ${p.runtime} (${p.model} ${p.effort}); J6 is about a claude-sdk session, so it was moved at once with jv task override --model claude-sonnet-5-5 --effort low --provider claude-main --undo`);
    const o = jvJson(['task', 'override', id, '--model', 'claude-sonnet-5-5', '--effort', 'low', '--provider', 'claude-main', '--undo'], { timeoutMs: 5 * 60_000 });
    check('override onto claude-sdk exits 0', o.status === 0, o.status ? err(o) : `stopped ${o.json.stopped}; run ${o.json.session}`);
    S.set({ movedToSdk: true });
  }

  let t = await settle(id, { timeoutMs: 15 * 60_000, until: (x) => x.state === 'waiting-owner' || S.get().attached });
  J.stop('toWaitingOwner');
  const runs = runsOf(id);
  const attachedId = S.get().attached ?? runs.at(-1)?.id;
  const R = runRow(attachedId);
  log(`runs: ${runs.map(runLine).join('; ')}`);
  if (!check('the task waits on the owner with a needs-decision report', S.get().attached || (t?.state === 'waiting-owner' && reportOf(R.id)?.status === 'needs-decision'), t ? `${t.state}: ${t.state_reason}` : 'timed out')) return;
  const report = reportOf(R.id);
  const options = (parse(report?.options_json, []) ?? []).map((o) => o.label);
  check("the report's options are 'Keep it' and 'Split it'", ['Keep it', 'Split it'].every((o) => options.some((x) => x.toLowerCase() === o.toLowerCase())), `question: ${oneLine(report?.question, 200)}; options ${options.join(' | ')}`);
  if (!check('the waiting run is claude-sdk with a native session id', R.runtime === 'claude-sdk' && !!R.native_session_id, runLine(R))) return;

  // 3. jv attach and the owner's turn in the takeover window.
  let window = S.get().window;
  if (!S.get().attached) {
    J.start('takeover');
    const a = jvJson(['attach', R.id], { timeoutMs: 60_000 });
    if (!check('jv attach <run> exits 0 and creates the takeover window', a.status === 0 && a.json?.created === true && a.json?.waiting === R.id, a.status ? err(a) : `created ${a.json.created}, target ${a.json.tmuxTarget}, waiting ${a.json.waiting}; prints: ${a.json.command.join(' ')}`)) return;
    window = a.json.tmuxTarget;
    S.set({ attached: R.id, window, attachCommand: a.json.command.join(' ') });
  }
  const meta = parse(queryOne('SELECT value FROM meta WHERE key = ?', `takeover:${R.id}`)?.value, {});
  const marked = runRow(R.id);
  check('the run is waiting "attached by owner"', marked.state === 'waiting' && marked.state_reason.startsWith('attached by owner') || S.get().resumed, `${marked.state}: ${marked.state_reason}`);
  check('jv attach recorded where the transcript ended (meta takeover:<R>)', typeof meta.offset === 'number' && !!meta.file, `${meta.file} at ${meta.offset} (${meta.at})`);

  if (!S.get().typedAt) {
    const pane = tm(['list-panes', '-t', `=${window}:`, '-F', '#{pane_pid} #{pane_current_command}']).stdout.trim();
    const ps = spawnSync('ps', ['-o', 'args=', '--ppid', pane.split(' ')[0] ?? '0'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ').trim();
    log(`takeover pane: ${pane}; child: ${ps.slice(0, 300)}`);
    const ready = await paneReady(window);
    check('the takeover window shows claude at its prompt', ready.ready, oneLine(ready.screen.split('\n').filter((l) => l.trim()).slice(-12).join(' / '), 500));
    if (!ready.ready) return;
    const env = spawnSync('tmux', ['show-environment', '-t', `=${window}`, 'HOME'], { encoding: 'utf8' }).stdout.trim();
    log(`takeover tmux HOME: ${env || '(not set in the tmux environment; jv exec sets it for the child)'}`);
    const typedAt = new Date().toISOString();
    check('typed the owner line into the takeover window', typeLine(window, MESSAGE), MESSAGE);
    S.set({ typedAt });
    // The reply: an assistant text after the typed line in the transcript, and the pane idle again.
    const deadline = Date.now() + 3 * 60_000;
    let seen;
    while (Date.now() < deadline) {
      await sleep(1000);
      const tr = transcriptFrom(meta.file, meta.offset);
      const u = tr.users.find((x) => x.text.includes('PELICAN'));
      const reply = u ? tr.texts.find((x) => x.at >= u.at) : undefined;
      if (reply && !/esc to interrupt/i.test(capture(window))) {
        seen = reply;
        break;
      }
    }
    const screen = capture(window);
    const shown = screen.split('\n').filter((l) => l.trim()).slice(-14).join(' / ');
    check('claude replied in the takeover window', !!seen && /PELICAN/.test(screen), `reply "${oneLine(seen?.text, 80)}" at ${seen?.at}; pane: ${oneLine(shown, 600)}`);
    S.set({ reply: seen?.text ?? null, paneAfterReply: oneLine(shown, 1200) });
    typeLine(window, '/exit');
    const gone = Date.now() + 60_000;
    while (Date.now() < gone && hasSession(window)) await sleep(500);
    check('/exit closes the takeover window', !hasSession(window), hasSession(window) ? `${window} still open` : `${window} gone`);
    J.stop('takeover');
  }

  // 4. jv task resume imports the takeover and continues the same conversation.
  const tr = transcriptFrom(meta.file, meta.offset);
  const typed = tr.users.find((x) => x.text.includes('PELICAN'));
  check('the typed line is in the native transcript after the attach offset', !!typed, typed ? `${typed.at}: "${oneLine(typed.text, 120)}" in ${meta.file}` : 'not found');
  check('the reply is in the native transcript after it', !!typed && tr.texts.some((x) => x.at >= typed.at && /\bOK\b/i.test(x.text)), tr.texts.map((x) => `"${oneLine(x.text, 60)}"`).join(', '));
  let resumed = S.get().resumed;
  if (!resumed) {
    J.start('resume');
    const r = jvJson(['task', 'resume', id], { timeoutMs: 5 * 60_000 });
    if (!check('jv task resume exits 0 and continues natively', r.status === 0 && r.json?.how === 'native', r.status ? err(r) : `${r.json.how} as ${r.json.session}`)) return;
    resumed = r.json.session;
    S.set({ resumed });
  }
  const after = runRow(R.id);
  check('the attached run ends with the takeover imported', after.state === 'done' && /takeover/.test(after.state_reason), `${after.state}: ${after.state_reason}`);
  const takeoverEvents = eventsOf(R.id).filter((e) => parse(e.payload, {}).source === 'takeover');
  const typedEvent = takeoverEvents.find((e) => e.kind === 'message' && JSON.stringify(parse(e.payload, {})).includes('PELICAN'));
  check('the store holds the typed line as a takeover message event of the attached run', !!typedEvent, typedEvent ? `seq ${typedEvent.seq} ${typedEvent.at}: ${oneLine(typedEvent.payload, 240)}` : `${takeoverEvents.length} takeover events: ${takeoverEvents.map((e) => e.kind).join(', ')}`);
  const replyEvent = takeoverEvents.find((e) => e.kind === 'text' && typedEvent && e.seq > typedEvent.seq);
  check("the store holds claude's takeover reply after it", !!replyEvent, replyEvent ? `seq ${replyEvent.seq}: ${oneLine(replyEvent.payload, 200)}` : 'none');
  const next = runRow(resumed);
  check('a new run row with the same native_session_id continues', !!next && next.id !== R.id && next.native_session_id === R.native_session_id && next.runtime === 'claude-sdk', `${R.id} ${R.native_session_id} -> ${next?.id} ${next?.native_session_id} (${next?.runtime})`);
  J.set('takeoverEvents', takeoverEvents.length);

  // 5. The task finishes.
  J.start('toDone');
  t = await settle(id, { timeoutMs: 15 * 60_000 });
  if (t?.state === 'waiting-owner') {
    const r2 = reportOf(runsOf(id).at(-1).id);
    log(`after resume: ${r2?.status}: ${oneLine(r2?.question ?? r2?.summary, 300)}`);
    const a = jvJson(['task', 'answer', id, 'Keep it'], { timeoutMs: 5 * 60_000 });
    check('jv task answer <T> "Keep it" exits 0', a.status === 0, a.status ? err(a) : `${a.json.answer} -> ${a.json.session}`);
    S.set({ answered: 'Keep it' });
    t = await settle(id, { timeoutMs: 15 * 60_000 });
  } else if (t?.state === 'done' && !S.get().answered) {
    J.deviation('after jv task resume ("Continue.") the run finished without asking again, so no jv task answer was needed');
  }
  J.stop('toDone');
  check('the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const final = runsOf(id);
  log(`runs at the end: ${final.map(runLine).join('; ')}`);
  const last = reportOf(final.at(-1).id);
  if (last) J.note(`last report (${final.at(-1).id}): ${last.status}: ${oneLine(last.summary, 400)}`);
  check('no run of the task is live and no takeover window is left', final.every((s) => !['queued', 'starting', 'running', 'waiting'].includes(s.state)) && !hasSession(window), final.map((s) => `${s.id}:${s.state}`).join(', '));
}

try {
  await main();
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
}
// The coordinator starts again whatever happened above.
const st = S.get();
if (st.coordinatorStopped && !st.coordinatorStarted) {
  const s = jvJson(['coordinator', 'start', '--project', SANDBOX_NAME], { timeoutMs: 5 * 60_000 });
  check('jv coordinator start exits 0 after the journey', s.status === 0, s.status ? err(s) : `${s.json?.sessionId} screen ${s.json?.screen}`);
  if (s.status === 0) S.set({ coordinatorStarted: s.json?.sessionId ?? true });
}
J.note(`owner actions: typed "${MESSAGE}" and /exit in the takeover window${S.get().answered ? `; answered "${S.get().answered}"` : ''}`);
J.finish();
