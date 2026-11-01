#!/usr/bin/env node
// J5 Visibility (brief section 15), on the README task J4's coordinator created with --visible:
//
// runtime  The task is visible and every run of its steps is on claude-tmux.
// attach   jv attach <run> (not in a terminal, it prints the tmux command), tmux has-session on the run's window and
//          capture-pane of it showing the Claude UI: taken while the run was live by j05-live.mjs (J4 starts it for
//          every claude-tmux run of the README task), read here from results/J05-live-<run>.json.
// tail     Events appear in jv tail within 5 s of the transcript lines: for every assistant entry of the run's
//          native transcript (tool calls by tool_use id, text by its first 120 characters) the matching event's `at`
//          (when jv stored it; for claude-tmux runs the time it was read, not the transcript's) minus the time the
//          line appeared in the file (the watcher reads it every 250 ms), the wall clock from there to the line
//          arriving on `jv tail --follow --json`, and, as evidence, `at` minus the entry's own `timestamp` (Claude
//          Code stamps a message when it starts and writes the line when it is complete).
// viewer   jv ui on loopback 127.0.0.1:7071 (started by this script when nothing listens there, stopped at the end):
//          Playwright headless loads /task/<T> (the task, its steps, the placement decision with probabilities) and
//          /session/<R> (the event stream), at desktop width, screenshots to the journey-shots folder.
//
// The loopback viewer it starts is left running (pid in results/J05.json elapsed.viewerPid) for J16, which stops it.
// Usage: node acceptance/j05-visibility.mjs [--tag T] [--j4-tag j4c] [--ask "<owner text>"] [--shots DIR]
// Writes acceptance/results/J05.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, JV, query, queryOne, SANDBOX_NAME, sleep } from './lib.mjs';
import { arg, journey, RESULTS_DIR } from './journey.mjs';
import { coordinator, oneLine } from './coord.mjs';
import { defaultBrowsersPath, loadPlaywright } from './viewer-lib.mjs';

const J = journey(5, 'Visibility');
const HERE = dirname(fileURLToPath(import.meta.url));
const J4_TAG = arg('--j4-tag', 'j4c');
const SHOTS = arg('--shots', '/tmp/claude-1001/-home-ggomes-dev-jevellan-skills/286eb47c-c709-4c16-8549-52f13f67d750/scratchpad/journey-shots');
const UI = 'http://127.0.0.1:7071';
const parse = (s, f = null) => {
  try {
    return s == null ? f : JSON.parse(s);
  } catch {
    return f;
  }
};

async function listening(url) {
  try {
    const r = await fetch(`${url}/api/overview`, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** jv ui --port 7071 on loopback, detached (its output in results/J05-ui.log), so it outlives this script for J16. */
async function startUi() {
  const fd = openSync(join(RESULTS_DIR, 'J05-ui.log'), 'a');
  const child = spawn(JV, ['ui', '--port', '7071'], { stdio: ['ignore', fd, fd], detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await listening(UI)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    // gone already
  }
  return undefined;
}

/**
 * --ask "<text>": the owner asks the coordinator for one more README change it wants to watch in tmux (typed into
 * the coordinator's window); the new visible task is kept in results/J05-state-<tag>.json, every claude-tmux run of
 * it gets a j05-live.mjs watcher from its first second, and the journey waits until the task has ended. A rerun with
 * the same tag reuses the task and types nothing.
 */
async function askVisible(text) {
  const stateFile = join(RESULTS_DIR, `J05-state-${J.tag || 'default'}.json`);
  let st = parse(existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null);
  const project = queryOne('SELECT * FROM projects WHERE name = ?', SANDBOX_NAME);
  const co = coordinator(SANDBOX_NAME, project.path);
  if (!st?.task) {
    const before = query('SELECT id FROM tasks WHERE project_id = ?', project.id).map((r) => r.id);
    await co.waitIdle({ quietMs: 3000, timeoutMs: 5 * 60_000 });
    const typedAt = new Date().toISOString();
    check('the owner asks the coordinator for a README change to watch in tmux', co.type(text), text);
    st = { tag: J.tag, typedAt, text, task: null, watchers: [] };
    writeFileSync(stateFile, `${JSON.stringify(st, null, 2)}\n`);
    for (const until = Date.now() + 10 * 60_000; Date.now() < until && !st.task; ) {
      const t = query('SELECT * FROM tasks WHERE project_id = ? AND visible = 1 ORDER BY created_at', project.id).find((x) => !before.includes(x.id));
      if (t) st.task = t.id;
      else await sleep(500);
    }
    writeFileSync(stateFile, `${JSON.stringify(st, null, 2)}\n`);
  }
  if (!check('the coordinator created the visible README task', !!st.task, st.task ?? 'no visible task within 10 minutes')) return undefined;
  const live = ['queued', 'starting', 'running'];
  for (const until = Date.now() + 60 * 60_000; Date.now() < until; ) {
    for (const r of query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' AND runtime = 'claude-tmux'", st.task)) {
      if (st.watchers.includes(r.id) || !live.includes(r.state)) continue;
      st.watchers.push(r.id);
      writeFileSync(stateFile, `${JSON.stringify(st, null, 2)}\n`);
      const fd = openSync(join(RESULTS_DIR, `J05-live-${r.id}.log`), 'a');
      spawn(process.execPath, ['--no-warnings', join(HERE, 'j05-live.mjs'), '--run', r.id], { detached: true, stdio: ['ignore', fd, fd] }).unref();
    }
    const t = queryOne('SELECT * FROM tasks WHERE id = ?', st.task);
    if (['done', 'failed', 'stopped', 'waiting-owner'].includes(t.state)) break;
    await sleep(1000);
  }
  // The watchers write their files when their run ends.
  for (let i = 0; i < 60 && !st.watchers.every((id) => parse(existsSync(join(RESULTS_DIR, `J05-live-${id}.json`)) ? readFileSync(join(RESULTS_DIR, `J05-live-${id}.json`), 'utf8') : null)?.endedAt); i++) await sleep(1000);
  await co.waitIdle({ quietMs: 8000, timeoutMs: 5 * 60_000 });
  const t = queryOne('SELECT * FROM tasks WHERE id = ?', st.task);
  J.note(`J5 asked the coordinator at ${st.typedAt}: "${st.text}"; it created ${t.id} "${t.title}" (${t.kind}, visible), which ended ${t.state}: ${t.state_reason}`);
  return t;
}

async function main() {
  let readme;
  const ask = arg('--ask');
  if (ask) {
    J.deviation('J5 ran on a second visible README task the coordinator created on the owner\'s request ("--ask"), not on J4\'s README task TC2SEC1: TC2SEC1\'s only run lasted 17 s and its window closed before the live watcher\'s one capture showed the Claude UI (the capture at the attach was blank); the watcher now captures until the UI shows.');
    readme = await askVisible(ask);
    if (!readme) return;
  } else {
    const state = parse(existsSync(join(RESULTS_DIR, `J04-state-${J4_TAG}.json`)) ? readFileSync(join(RESULTS_DIR, `J04-state-${J4_TAG}.json`), 'utf8') : null);
    if (!check('J4 state with its three tasks', state?.tasks?.length === 3, state ? state.tasks.join(', ') : `no results/J04-state-${J4_TAG}.json`)) return;
    const tasks = state.tasks.map((id) => queryOne('SELECT * FROM tasks WHERE id = ?', id));
    readme = tasks.find((t) => t.visible === 1);
  }
  if (!check('the README task is the visible one', !!readme && readme.visible === 1 && /readme|how to run/i.test(`${readme.title} ${readme.task_text}`), readme ? `${readme.id} "${readme.title}" visible ${readme.visible}` : 'none')) return;
  const runs = query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' ORDER BY started_at", readme.id);
  check('every run of the README task is on claude-tmux', runs.length > 0 && runs.every((r) => r.runtime === 'claude-tmux' && /jv-R[0-9A-Z]{6}/.test(r.tmux_target ?? '')), runs.map((r) => `${r.id} ${r.runtime} ${r.provider} ${r.model} ${r.effort} ${r.tmux_target} ${r.state}`).join('; '));

  // ---- the live evidence
  const live = runs.map((r) => ({ r, file: join(RESULTS_DIR, `J05-live-${r.id}.json`) })).filter((x) => existsSync(x.file)).map((x) => ({ ...x, d: parse(readFileSync(x.file, 'utf8'), {}) }));
  check('a live watcher recorded every run', live.length === runs.length, `${live.length} of ${runs.length} runs: ${live.map((l) => l.r.id).join(', ')}`);
  const attached = live.filter((l) => l.d.attach);
  const att = attached[0];
  check(
    'jv attach <run> while it runs: exit 0, prints the tmux command (not in a terminal)',
    attached.length > 0 && attached.every((l) => l.d.attach.status === 0 && /tmux (attach|switch-client)/.test(`${l.d.attach.text} ${JSON.stringify(l.d.attach.json)}`) && `${l.d.attach.text}${JSON.stringify(l.d.attach.json)}`.includes(`jv-${l.r.id}`)),
    attached.map((l) => `${l.r.id} at ${l.d.attach.at}: exit ${l.d.attach.status}: ${oneLine(l.d.attach.text, 200)}`).join('; ') || 'no run was seen running',
  );
  check('the tmux session exists while the run is live', attached.length > 0 && attached.every((l) => l.d.hasSession?.has), attached.map((l) => `${l.d.hasSession?.session}: has-session ${l.d.hasSession?.has}; ${l.d.hasSession?.listed}`).join('; '));
  const ui = (pane) => /bypass permissions/i.test(pane ?? '') && /^\s*[❯>]/m.test(pane ?? '');
  const shows = (l) => [l.d.paneUi?.pane, l.d.pane].find((p) => ui(p) || /Claude Code|esc to interrupt/.test(p ?? ''));
  const withUi = attached.filter((l) => shows(l));
  const paneText = (l) => oneLine((shows(l) ?? l.d.pane ?? '').split('\n').filter((x) => x.trim()).slice(-12).join(' / '), 900);
  check('capture-pane of the live window shows the Claude UI', withUi.length > 0, attached.map((l) => `${l.r.id}${l.d.paneUi ? ` at ${l.d.paneUi.at}` : ' (first capture only)'}: ${paneText(l) || 'blank'}`).join('; ') || 'none');
  for (const l of attached) J.note(`capture-pane of ${l.d.hasSession.session} while ${l.r.id} ran: ${paneText(l) || 'blank (captured at the attach, before Claude drew its screen)'}`);

  // ---- jv tail against the transcript
  const lags = [];
  const missing = [];
  for (const l of live) {
    const events = query('SELECT seq, at, kind, payload FROM events WHERE session_id = ? ORDER BY seq', l.r.id);
    const byKey = new Map();
    for (const e of events) {
      const p = parse(e.payload, {});
      const key = e.kind === 'tool-call' && p.id ? `tool:${p.id}` : e.kind === 'text' && p.text ? `text:${String(p.text).replace(/\s+/g, ' ').trim().slice(0, 120)}` : undefined;
      if (key && !byKey.has(key)) byKey.set(key, e);
    }
    const arrived = new Map((l.d.tail ?? []).filter((t) => t.key).map((t) => [t.key, t]));
    for (const t of l.d.transcript ?? []) {
      const e = byKey.get(t.key);
      if (!e) {
        missing.push(`${l.r.id} ${t.key.slice(0, 60)}`);
        continue;
      }
      const a = arrived.get(t.key);
      lags.push({ run: l.r.id, key: t.key, kind: t.kind, name: t.name, stampLagMs: Date.parse(e.at) - Date.parse(t.at), writeLagMs: t.seenWall - Date.parse(t.at), afterWriteMs: Date.parse(e.at) - t.seenWall, wallLagMs: a ? a.arrivedWall - t.seenWall : null });
    }
  }
  const stamp = lags.map((x) => x.stampLagMs);
  const after = lags.map((x) => x.afterWriteMs);
  const wall = lags.map((x) => x.wallLagMs).filter((x) => x !== null);
  const max = (xs) => (xs.length ? Math.max(...xs) : null);
  const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  J.set('transcriptEntries', lags.length + missing.length);
  J.set('maxEventAtMinusTranscriptTimestampMs', max(stamp));
  J.set('maxEventAtMinusLineWrittenMs', max(after));
  J.set('maxTailArrivalAfterLineWrittenMs', max(wall));
  // When the line is in the transcript file: the watcher reads the file every 250 ms, so "written" is known to 250 ms.
  check(
    'every transcript line is a jv event within 5 s of being written to the transcript (event at minus the time the line appeared in the file)',
    lags.length > 0 && missing.length === 0 && max(after) <= 5000,
    `${lags.length} entries matched (${lags.filter((x) => x.kind === 'tool_use').length} tool calls, ${lags.filter((x) => x.kind === 'text').length} texts); max ${max(after)} ms, median ${median(after)} ms${missing.length ? `; missing ${missing.slice(0, 5).join(', ')}` : ''}`,
  );
  check(
    'jv tail --follow delivered each of them within 5 s of the line being written (wall clock)',
    wall.length > 0 && wall.length === lags.length && max(wall) <= 5000,
    `${wall.length} of ${lags.length} seen on jv tail --follow; max ${max(wall)} ms; tail exits ${live.map((l) => l.d.tailExit).join(', ')}`,
  );
  // The comparison the task text asks for, event at minus the entry's own timestamp, as evidence: Claude Code stamps
  // an assistant entry when the message starts and writes the line when it is complete, so for a long message the
  // line reaches the file seconds after its timestamp, before any reader can see it.
  const late = lags.filter((x) => x.stampLagMs > 5000);
  J.note(
    `event at minus the transcript entry's own timestamp (the comparison the task text names; evidence, see the deviation when over 5 s): max ${max(stamp)} ms, median ${median(stamp)} ms; over 5 s: ${late.map((x) => `${x.run} ${x.name ?? x.kind}: timestamp to event ${x.stampLagMs} ms, of which ${x.writeLagMs} ms before the line was in the file`).join('; ') || 'none'}`,
  );
  if (late.length) {
    J.deviation(
      `Event at minus the transcript entry's timestamp is over 5 s for ${late.length} of ${lags.length} entries (${late.map((x) => `${x.name ?? x.kind} ${x.stampLagMs} ms`).join(', ')}). For each, Claude Code wrote the line to the transcript ${late.map((x) => `${x.writeLagMs} ms`).join(', ')} after the timestamp it carries (the time the message started); jv stored the event within ${max(late.map((x) => x.afterWriteMs))} ms of the line being written. jv reads the transcript file, so no event can precede the write; the 5 s bound is asserted from the write.`,
    );
  }
  const worst = [...lags].sort((p, q) => q.stampLagMs - p.stampLagMs).slice(0, 5);
  J.note(`slowest entries (timestamp to event; timestamp to line written; line written to event; line written to jv tail): ${worst.map((w) => `${w.run} ${w.name ?? w.kind} ${w.stampLagMs}; ${w.writeLagMs}; ${w.afterWriteMs}; ${w.wallLagMs} ms`).join(' | ')}`);

  // ---- the viewer
  defaultBrowsersPath();
  mkdirSync(SHOTS, { recursive: true });
  let child;
  if (await listening(UI)) J.note(`a viewer was already listening on ${UI}; it is used and left as it was`);
  else child = await startUi();
  if (!check('jv ui serves on loopback 127.0.0.1:7071', await listening(UI), child ? `started jv ui --port 7071 (pid ${child.pid})` : 'already running')) return;
  const api = await (await fetch(`${UI}/api/task/${readme.id}`)).json();
  const { pw } = loadPlaywright();
  const browser = await pw.chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${UI}/task/${readme.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main .page-head h1', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const seen = await page.evaluate(() => ({
      h1: document.querySelector('main h1')?.textContent ?? '',
      steps: document.querySelectorAll('.timeline > li').length,
      sessions: [...document.querySelectorAll('a[href^="/session/"]')].map((a) => a.getAttribute('href')),
      placement: [...document.querySelectorAll('.decision')].filter((d) => /placement|where/i.test(d.textContent ?? '') && d.querySelector('.prob')).length,
      probs: document.querySelectorAll('.prob .pv').length,
      text: document.querySelector('main')?.textContent ?? '',
    }));
    const taskShot = join(SHOTS, `j05-task-${readme.id}-1280.png`);
    await page.screenshot({ path: taskShot, fullPage: true });
    check('the viewer task page shows the task', seen.h1.includes(readme.title), `heading "${seen.h1.trim()}"; ${taskShot}`);
    check('the viewer task page shows its steps', seen.steps === api.steps.length && api.steps.length > 0, `${seen.steps} timeline items, ${api.steps.length} steps`);
    check('the viewer task page shows the placement decision with probabilities', seen.placement > 0 && seen.probs > 0 && runs.every((r) => seen.text.includes(r.model) || seen.text.includes(r.id)), `${seen.placement} placement cards, ${seen.probs} probability rows`);
    const run = runs[0];
    await page.goto(`${UI}/session/${run.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main h1', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const stream = await page.evaluate(() => ({ items: document.querySelectorAll('.stream > li').length, tools: document.querySelectorAll('details.tool').length, h1: document.querySelector('main h1')?.textContent ?? '' }));
    const events = queryOne('SELECT count(*) n FROM events WHERE session_id = ?', run.id).n;
    const sessionShot = join(SHOTS, `j05-session-${run.id}-1280.png`);
    await page.screenshot({ path: sessionShot, fullPage: true });
    check('the viewer session page shows the event stream', stream.items > 0 && stream.tools > 0 && seen.sessions.includes(`/session/${run.id}`), `${run.id}: ${stream.items} stream items (${stream.tools} tool calls) of ${events} events; linked from the task page; ${sessionShot}`);
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
    await context.close();
  } finally {
    await browser.close().catch(() => undefined);
    if (child) {
      J.set('viewerPid', child.pid);
      J.note(`J5 left its loopback viewer jv ui --port 7071 (pid ${child.pid}) running; J16 stops it`);
    }
  }
}

await main();
J.finish();
