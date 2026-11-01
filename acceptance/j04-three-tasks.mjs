#!/usr/bin/env node
// J4 The three tasks (brief section 15), on the real sandbox project, through the coordinator (it must be running;
// it is started when it is not):
//
// type    The owner's message, pasted into the coordinator's tmux window as one message (load-buffer, paste-buffer,
//         Enter). The brief's text plus one sentence, "I want to watch the README one in tmux.", so the coordinator
//         passes --visible for J5 (a deviation, recorded).
// tasks   Within 15 minutes the coordinator creates three tasks for the project (kinds as it chose).
// poll    Every 30 s, up to 150 minutes: jv status --json for the project, the three tasks' steps, sessions and
//         landings from the store, and the coordinator's pane (appended to results/J04-coordinator.log when it
//         changes). The owner's questions are answered as the owner: a landing the coordinator routes to the owner
//         gets "Land now" (so main ends with the three changes); any other question is written to
//         results/J04-question.txt and waits for results/J04-answer.txt, which whoever runs the journey writes (the
//         journey records both). For every claude-tmux run of the README task, j05-live.mjs is started detached so
//         J5's live evidence (jv attach, the tmux window, jv tail against the transcript) is taken while it runs.
// assert  Three tasks, three worktrees on jv/ branches, a placement decision with probabilities for every started
//         step (and every run), every step's report in the store, screenshots under the customers task's
//         .jv-evidence/ at desktop and phone widths (PNG widths read from the files), all three landed (route land,
//         or asked with a stated reason and landed on "Land now"), the sandbox main holding the three changes, the
//         checkout clean.
// record  A table per task (steps with duty, runtime, provider, model, effort, top probabilities, attempts, report
//         status; landings with route and reason; elapsed from creation to landed), and Jev's implement choices
//         against Jevellan's of 31 October (README Opus medium, unit test GPT medium, customers empty state GPT high).
//
// --tag T: the three task ids are kept in results/J04-state-<T>.json once the coordinator created them; a rerun with
// the same tag reuses them (nothing is typed again) and goes on polling and asserting.
// Usage: node acceptance/j04-three-tasks.mjs --tag T [--timeout-min 150] [--interval-s 30]
// Writes acceptance/results/J04.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkoutState, git, jvJson, log, onBranch, query, queryOne, SANDBOX, SANDBOX_MAIN, SANDBOX_NAME, sleep } from './lib.mjs';
import { arg, journey, RESULTS_DIR } from './journey.mjs';
import { coordinator, oneLine } from './coord.mjs';

const J = journey(4, 'The three tasks');
const TAG = J.tag;
if (!TAG) {
  process.stderr.write('J4 needs --tag (the three task ids are kept under it)\n');
  process.exit(2);
}
const TIMEOUT_MS = Number(arg('--timeout-min', '150')) * 60_000;
const INTERVAL_MS = Number(arg('--interval-s', '30')) * 1000;
const PROJECT = SANDBOX_NAME;
const BASE = SANDBOX_MAIN;
const STATE_FILE = join(RESULTS_DIR, `J04-state-${TAG}.json`);
const PANE_LOG = join(RESULTS_DIR, 'J04-coordinator.log');
const QUESTION_FILE = join(RESULTS_DIR, 'J04-question.txt');
const ANSWER_FILE = join(RESULTS_DIR, 'J04-answer.txt');
const HERE = new URL('.', import.meta.url).pathname;

const BRIEF_TEXT =
  'Three tasks in parallel: (1) README: add a How to run section listing the commands in package.json; (2) add a unit test for one untested pure function in src; (3) empty-state message on the customers page when there are no customers, with a test.';
const MESSAGE = `${BRIEF_TEXT} I want to watch the README one in tmux.`;
const JEVELLAN_31_OCT = { readme: { label: 'Opus', effort: 'medium' }, unit: { label: 'GPT', effort: 'medium' }, customers: { label: 'GPT', effort: 'high' } };
const ROLE_TITLE = { readme: '(1) README How to run', unit: '(2) unit test for a pure function', customers: '(3) customers empty state' };

const project = queryOne('SELECT * FROM projects WHERE name = ?', PROJECT);
const co = coordinator(PROJECT, project.path);
const parse = (s, f = null) => {
  try {
    return s == null ? f : JSON.parse(s);
  } catch {
    return f;
  }
};
const err = (r) => `exit ${r.status}: ${r.json?.error ?? r.stderr.trim().slice(0, 300)}`;
const readState = () => parse(existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : null, null);
/** Writes the state; the live watchers already recorded in the file are kept. */
const writeState = (s) => {
  const known = readState()?.liveWatchers ?? [];
  const merged = { ...s, liveWatchers: [...new Set([...known, ...(s.liveWatchers ?? [])])] };
  writeFileSync(STATE_FILE, `${JSON.stringify(merged, null, 2)}\n`);
};
const projectTasks = () => query('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at', project.id);
const task = (id) => queryOne('SELECT * FROM tasks WHERE id = ?', id);
const steps = (id) => query('SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal', id);
const runs = (id) => query("SELECT * FROM sessions WHERE task_id = ? AND kind = 'step' ORDER BY started_at, id", id);
const landings = (id) => query('SELECT * FROM landings WHERE task_id = ? ORDER BY created_at, id', id);
const FINAL = ['done', 'failed', 'stopped'];

J.deviation(
  'The message typed into the coordinator is the brief\'s J4 text plus one sentence, "I want to watch the README one in tmux.", so the coordinator passes --visible on the README task for J5 (its prompt passes --visible only when the owner asks to watch a task).',
);

/** The role of a task from its title (then its brief): readme, unit, customers. */
function roleOf(t) {
  if (/readme|how to run/i.test(t.title)) return 'readme';
  if (/unit test|pure function/i.test(t.title)) return 'unit';
  if (/customer/i.test(t.title) && /empty/i.test(t.title)) return 'customers';
  const text = `${t.title}\n${t.task_text}`;
  if (/customer/i.test(text) && /empty/i.test(text)) return 'customers';
  if (/readme|how to run/i.test(t.title) || (/readme/i.test(text) && /how to run/i.test(text))) return 'readme';
  if (/unit test|test for|pure function/i.test(text)) return 'unit';
  return undefined;
}

function pngWidth(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return undefined;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// ---- the message and the three tasks -----------------------------------------------------------------------------

async function ensureCoordinator() {
  const s = co.status();
  if (s?.running && co.alive()) {
    check('the coordinator is running before the message', true, `${s.sessionId} ${s.model} ${s.effort} on ${s.provider}; screen ${s.screen}; ${s.attach}`);
    return s;
  }
  log('the coordinator is not running: jv coordinator start');
  const r = jvJson(['coordinator', 'start', '--project', PROJECT], { timeoutMs: 120_000 });
  check('the coordinator is running before the message (started by J4)', r.status === 0 && r.json?.running, r.status ? err(r) : `${r.json.sessionId} started; screen ${r.json.screen}`);
  if (r.status === 0) J.note(`J4 started the coordinator ${r.json.sessionId} (it was not running).`);
  return co.status();
}

async function typeMessage() {
  const before = projectTasks().map((t) => t.id);
  const idle = await co.waitIdle({ quietMs: 3000, timeoutMs: 5 * 60_000 });
  if (!check('the coordinator screen is idle before typing', idle !== undefined, idle ? 'input prompt shown, no turn running' : 'not idle after 5 min')) return undefined;
  const offset = co.size();
  const typedAt = new Date().toISOString();
  const ok = co.type(MESSAGE);
  check('the message is pasted into the coordinator as one message (load-buffer, paste-buffer, Enter)', ok, `${co.target}: ${MESSAGE}`);
  if (!ok) return undefined;
  const state = { tag: TAG, typedAt, transcriptOffset: offset, coordinator: co.status()?.sessionId, before, tasks: [] };
  writeState(state);
  // The three tasks: new tasks of the project after the message. Every second, so a short visible run is watched
  // live from its first moment. When the coordinator goes quiet with fewer than three, its reply is an owner
  // question (results/J04-question.txt, answered through results/J04-answer.txt).
  const deadline = Date.now() + 15 * 60_000;
  let fresh = [];
  let asked = false;
  let quietSince;
  while (Date.now() < deadline) {
    fresh = projectTasks().filter((t) => !before.includes(t.id));
    watchVisibleRuns(fresh.map((t) => t.id));
    if (fresh.length >= 3 && !co.busy()) break;
    const quiet = !co.busy() && co.size() > offset;
    quietSince = quiet ? (quietSince ?? Date.now()) : undefined;
    if (fresh.length < 3 && quietSince && Date.now() - quietSince > 10_000) {
      if (!asked) {
        const said = co.digest(co.recordsFrom(offset)).reply;
        writeFileSync(QUESTION_FILE, `${new Date().toISOString()}\n${fresh.length} tasks so far: ${fresh.map((t) => t.id).join(', ')}\n--- coordinator ---\n${said.slice(-3000)}\n`);
        log(`OWNER-QUESTION (answer in ${ANSWER_FILE}): ${fresh.length} tasks so far; coordinator: ${oneLine(said, 1200)}`);
        asked = true;
      } else if (existsSync(ANSWER_FILE)) {
        const answer = readFileSync(ANSWER_FILE, 'utf8').trim();
        renameSync(ANSWER_FILE, `${ANSWER_FILE}.${Date.now()}.used`);
        const said = co.digest(co.recordsFrom(offset)).reply;
        if (answer) {
          co.type(answer);
          state.answers = [...(state.answers ?? []), { at: new Date().toISOString(), kind: 'other', question: oneLine(said.slice(-1500), 1500), answer, tasks: fresh.map((t) => t.id) }];
          writeState(state);
          log(`owner answered (other): ${answer}`);
        }
        asked = false;
        quietSince = undefined;
      }
    }
    await sleep(1000);
  }
  // Let the coordinator finish its turn before reading what it said.
  await co.waitIdle({ quietMs: 8000, timeoutMs: 10 * 60_000 });
  fresh = projectTasks().filter((t) => !before.includes(t.id));
  state.tasks = fresh.map((t) => t.id);
  state.createdReply = co.digest(co.recordsFrom(offset)).reply;
  state.createdTools = co.digest(co.recordsFrom(offset)).tools.map((t) => oneLine(t.input, 400));
  writeState(state);
  return state;
}

// ---- owner questions -------------------------------------------------------------------------------------------

const answered = []; // {at, kind, question, answer, tasks}

function recordAnswer(kind, question, answer, tasks) {
  const entry = { at: new Date().toISOString(), kind, question: oneLine(question, 1500), answer, tasks };
  answered.push(entry);
  const s = readState();
  s.answers = [...(s.answers ?? []), entry];
  writeState(s);
  log(`owner answered (${kind}): ${answer}`);
}

let lastPane = '';
function logPane() {
  const pane = co.screen();
  if (pane === lastPane) return;
  lastPane = pane;
  const tailLines = pane.split('\n').filter((l) => l.trim() !== '').slice(-40).join('\n');
  appendFileSync(PANE_LOG, `\n===== ${new Date().toISOString()} =====\n${tailLines}\n`);
}

let processedOffset = 0;
const handledLandings = new Set();
let pendingQuestion; // {question, offsetEnd}

async function ownerTurn(ids) {
  if (co.busy()) return;
  const end = co.size();
  const fresh = co.digest(co.recordsFrom(processedOffset));
  // Landings Jev routed to the owner (or a landing that asked again): "Land now", once per asked landing row.
  const asked = ids.flatMap((id) => {
    const last = landings(id).at(-1);
    return last && last.state === 'asked' && !handledLandings.has(last.id) ? [{ id, landing: last }] : [];
  });
  if (asked.length) {
    const idle = await co.waitIdle({ quietMs: 8000, timeoutMs: 60_000 });
    if (idle === undefined) return;
    const said = co.digest(co.recordsFrom(processedOffset)).reply;
    if (!/land now/i.test(said)) return; // the coordinator has not asked yet
    const question = said.slice(-1500);
    const answer = asked.length === 1 ? 'Land now' : `Land now, all ${asked.length}: ${asked.map((a) => a.id).join(', ')}`;
    for (const a of asked) handledLandings.add(a.landing.id);
    const r = await co.say(answer);
    recordAnswer('landing', `${asked.map((a) => `${a.id}: ${a.landing.route} ${a.landing.state}: ${a.landing.reason}`).join(' | ')} || coordinator: ${question}`, answer, asked.map((a) => a.id));
    log(`coordinator after "${answer}": ${oneLine(r.digest.reply, 800)}`);
    processedOffset = co.size();
    return;
  }
  // Any other question: the coordinator's reply since the last processed point ends with a question, or one of the
  // tasks waits on the owner for something other than a landing.
  const waiting = ids.map(task).filter((t) => t.state === 'waiting-owner' && landings(t.id).at(-1)?.state !== 'asked');
  const reply = fresh.reply;
  const asks = /\?\s*$/.test(reply.trim().slice(-300)) || /\n\s*1[.)]\s.*(\?|option|Land now|Leave it)/i.test(reply.slice(-1500));
  if (pendingQuestion) {
    if (existsSync(ANSWER_FILE)) {
      const answer = readFileSync(ANSWER_FILE, 'utf8').trim();
      renameSync(ANSWER_FILE, `${ANSWER_FILE}.${Date.now()}.used`);
      if (answer) {
        const r = await co.say(answer);
        recordAnswer('other', pendingQuestion.question, answer, pendingQuestion.tasks);
        log(`coordinator after the answer: ${oneLine(r.digest.reply, 800)}`);
      }
      pendingQuestion = undefined;
      processedOffset = co.size();
    }
    return;
  }
  if ((asks && reply.trim()) || waiting.length) {
    const idle = await co.waitIdle({ quietMs: 8000, timeoutMs: 60_000 });
    if (idle === undefined) return;
    const said = co.digest(co.recordsFrom(processedOffset)).reply;
    const text = `${waiting.map((t) => `${t.id} waiting-owner: ${t.state_reason}`).join('\n')}\n--- coordinator ---\n${said.slice(-3000)}`;
    pendingQuestion = { question: text, tasks: waiting.map((t) => t.id) };
    writeFileSync(QUESTION_FILE, `${new Date().toISOString()}\n${text}\n`);
    log(`OWNER-QUESTION (answer in ${ANSWER_FILE}): ${oneLine(text, 1200)}`);
    return;
  }
  processedOffset = end;
}

// ---- J5 live watchers --------------------------------------------------------------------------------------------

let watched;
/** Starts j05-live.mjs for every claude-tmux run of the visible tasks among `ids` that has not ended. */
function watchVisibleRuns(ids) {
  // A rerun of the tag goes on from the watchers an earlier run started.
  watched ??= new Set(readState()?.liveWatchers ?? []);
  const visible = ids.map(task).filter((t) => t?.visible === 1);
  for (const r of visible.flatMap((t) => runs(t.id))) {
    if (r.runtime !== 'claude-tmux' || watched.has(r.id) || !['queued', 'starting', 'running'].includes(r.state)) continue;
    watched.add(r.id);
    const logFile = join(RESULTS_DIR, `J05-live-${r.id}.log`);
    const fd = openSync(logFile, 'a');
    const child = spawn(process.execPath, ['--no-warnings', join(HERE, 'j05-live.mjs'), '--run', r.id], { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    log(`J5 live watcher for ${r.id} (${r.state}, ${r.tmux_target}) started: pid ${child.pid}, log ${logFile}`);
    const s = readState();
    if (s) {
      s.liveWatchers = [...new Set([...(s.liveWatchers ?? []), r.id])];
      writeState(s);
    }
  }
}

// ---- the poll ----------------------------------------------------------------------------------------------------

function line(id) {
  const t = task(id);
  const st = steps(id).map((s) => `${s.ordinal}.${s.duty}:${s.state}${s.attempts > 1 ? `x${s.attempts}` : ''}`).join(' ');
  const live = runs(id).filter((r) => ['queued', 'starting', 'running', 'waiting'].includes(r.state)).map((r) => `${r.id} ${r.runtime} ${r.model} ${r.effort} ${r.state}`).join(', ');
  const l = landings(id).at(-1);
  return `${id} ${t.state} [${st}]${live ? ` live ${live}` : ''}${l ? ` landing ${l.route}/${l.state}` : ''}`;
}

async function poll(ids, readmeId) {
  const started = Date.now();
  processedOffset = readState()?.processedOffset ?? co.size();
  for (;;) {
    const st = jvJson(['status', '--project', PROJECT]);
    logPane();
    watchVisibleRuns(ids);
    log(`poll: ${ids.map(line).join(' | ')}; status ${st.status === 0 ? `${st.json.tasks.length} open` : err(st)}`);
    await ownerTurn(ids);
    const s = readState();
    s.processedOffset = processedOffset;
    writeState(s);
    if (ids.every((id) => FINAL.includes(task(id).state))) break;
    if (Date.now() - started > TIMEOUT_MS) {
      log('poll: timed out');
      break;
    }
    // Between polls, look for a new run of the README task every 2 s, so even a short claude-tmux run is watched live.
    for (const until = Date.now() + INTERVAL_MS; Date.now() < until; ) {
      await sleep(2000);
      watchVisibleRuns(ids);
    }
  }
  // A last moment for the watchers and the coordinator's own replies to the landed wake lines.
  await co.waitIdle({ quietMs: 8000, timeoutMs: 5 * 60_000 });
  logPane();
}

// ---- assertions and tables ---------------------------------------------------------------------------------------

function topProbs(probs, n = 3) {
  return Object.entries(probs ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k.replace(/ via .*$/, '')} ${v}`)
    .join(', ');
}

/**
 * The placement a run ran under: the decision linked to it, or, for a run that continues the same native session
 * of its step (a message or an answer delivered at a turn boundary, "Continue." after progress: no new Jev call,
 * section 7.6), the decision linked to the earlier run of that conversation.
 */
function placementOf(run) {
  const own = queryOne("SELECT * FROM decisions WHERE kind = 'placement' AND session_id = ? ORDER BY created_at DESC", run.id);
  if (own || !run.native_session_id) return own ?? undefined;
  return (
    queryOne(
      `SELECT d.* FROM decisions d JOIN sessions s ON s.id = d.session_id
       WHERE d.kind = 'placement' AND d.step_id = ? AND s.native_session_id = ? AND s.started_at <= ? ORDER BY d.created_at DESC`,
      run.step_id,
      run.native_session_id,
      run.started_at,
    ) ?? undefined
  );
}

function assertAll(ids, byRole) {
  const tables = [];
  const comparison = [];
  // tasks
  const ts = ids.map(task);
  check('three tasks for the three requests', ts.length === 3 && ['readme', 'unit', 'customers'].every((r) => byRole[r]), ts.map((t) => `${t.id} ${t.kind} "${t.title}" (${roleOf(t) ?? 'no role'})`).join('; '));
  check('kinds as the coordinator chose (feature, bug, automation or single)', ts.every((t) => ['feature', 'bug', 'automation', 'single'].includes(t.kind)), ts.map((t) => `${t.id} ${t.kind}`).join(', '));
  const readme = byRole.readme && task(byRole.readme);
  check('the README task was created with --visible, the others without', readme?.visible === 1 && ts.filter((t) => t.id !== readme?.id).every((t) => t.visible === 0), ts.map((t) => `${t.id} visible ${t.visible}`).join(', '));

  // worktrees
  const wl = git(SANDBOX, ['worktree', 'list', '--porcelain']);
  const wts = ts.map((t) => ({ t, ok: !!t.worktree_path && /^jv\//.test(t.branch ?? '') && wl.includes(`worktree ${t.worktree_path}`) && wl.includes(`branch refs/heads/${t.branch}`) && existsSync(t.worktree_path) }));
  check('three worktrees on jv/ branches, registered in the sandbox', wts.length === 3 && wts.every((w) => w.ok), wts.map((w) => `${w.t.id} ${w.t.branch} at ${w.t.worktree_path}${w.ok ? '' : ' (MISSING)'}`).join('; '));

  // placements and reports
  const missingPlacement = [];
  const missingReport = [];
  const runMissing = [];
  for (const t of ts) {
    for (const s of steps(t.id)) {
      if (s.state === 'pending' || s.state === 'skipped') continue;
      const ds = query("SELECT * FROM decisions WHERE kind = 'placement' AND step_id = ?", s.id);
      const withProbs = ds.filter((d) => {
        const c = parse(d.chosen_json, {});
        return c.source === 'owner' || (Object.keys(c.choices?.model?.probabilities ?? {}).length > 0 && Object.keys(c.choices?.effort?.probabilities ?? {}).length > 0);
      });
      if (!withProbs.length) missingPlacement.push(`${t.id} step ${s.ordinal} ${s.duty}`);
      const reps = query('SELECT status FROM reports WHERE step_id = ?', s.id);
      if (!reps.length || (s.state === 'done' && !reps.some((r) => r.status === 'done'))) missingReport.push(`${t.id} step ${s.ordinal} ${s.duty} (${s.state}; reports ${reps.map((r) => r.status).join(',') || 'none'})`);
    }
    for (const r of runs(t.id)) if (!placementOf(r)) runMissing.push(`${r.id}`);
  }
  const started = ts.flatMap((t) => steps(t.id).filter((s) => s.state !== 'pending' && s.state !== 'skipped'));
  check('a placement decision with probabilities for every started step', started.length > 0 && missingPlacement.length === 0, missingPlacement.length ? `missing: ${missingPlacement.join(', ')}` : `${started.length} started steps, each with a Jev placement (model and effort probabilities)`);
  const continued = ts.flatMap((t) => runs(t.id)).filter((r) => !queryOne("SELECT id FROM decisions WHERE kind = 'placement' AND session_id = ?", r.id)).map((r) => `${r.id} continues ${placementOf(r)?.session_id ?? '?'} under ${placementOf(r)?.id ?? '?'} (${r.request_id})`);
  check('every run ran under a placement decision (its own, or its conversation\'s for a continuation)', runMissing.length === 0, runMissing.length ? `runs without a decision: ${runMissing.join(', ')}` : `${ts.flatMap((t) => runs(t.id)).length} runs${continued.length ? `; continuations: ${continued.join('; ')}` : ''}`);
  check("every step's report is in the store", missingReport.length === 0, missingReport.length ? missingReport.join('; ') : `${started.length} steps with reports; done steps have a done report`);
  const skipped = ts.flatMap((t) => steps(t.id).filter((s) => s.state === 'skipped').map((s) => `${t.id} ${s.duty}: ${s.state_reason}`));
  if (skipped.length) J.note(`skipped steps (workflow questions): ${skipped.join('; ')}`);

  // screenshots
  const cust = byRole.customers && task(byRole.customers);
  if (cust) {
    const ev = join(cust.worktree_path, '.jv-evidence');
    const pngs = listFiles(ev).filter((f) => /\.png$/i.test(f)).map((f) => ({ f, size: pngWidth(f) }));
    const desktop = pngs.filter((p) => p.size && p.size.width >= 1024);
    const phone = pngs.filter((p) => p.size && p.size.width <= 480);
    check(
      "screenshots under the customers task's .jv-evidence/ at desktop and phone widths",
      desktop.length > 0 && phone.length > 0,
      `${pngs.length} PNG files in ${ev}: ${pngs.map((p) => `${p.f.slice(ev.length + 1)} ${p.size ? `${p.size.width}x${p.size.height}` : '?'}`).join(', ')}`,
    );
    const listed = query('SELECT screenshots_json FROM reports WHERE task_id = ?', cust.id).flatMap((r) => parse(r.screenshots_json, []));
    check("the customers task's reports list its screenshots", listed.length > 0, listed.map((s) => (typeof s === 'string' ? s : `${s.path ?? s.file ?? '?'}: ${s.caption ?? ''}`)).join('; ').slice(0, 800) || 'none');
  } else check("screenshots under the customers task's .jv-evidence/ at desktop and phone widths", false, 'no customers task');

  // landing
  const landed = ts.map((t) => {
    const rows = landings(t.id);
    const last = rows.at(-1);
    const asks = rows.filter((r) => r.route === 'ask-owner');
    const okRoute = last?.state === 'landed' && (rows.every((r) => r.route === 'land') || asks.every((a) => a.reason && a.reason !== '') );
    return { t, rows, last, okRoute, ok: t.state === 'done' && !!t.landed_commit && last?.state === 'landed' };
  });
  check(
    'all three landed (route land, or asked with a stated reason and landed on "Land now")',
    landed.every((l) => l.ok && l.okRoute),
    landed.map((l) => `${l.t.id} ${l.t.state} ${l.t.landed_commit?.slice(0, 12) ?? '-'}: ${l.rows.map((r) => `${r.route}/${r.state} (${oneLine(r.reason, 160)})`).join(' -> ') || 'no landing'}`).join('; '),
  );
  for (const l of landed) {
    if (l.rows.some((r) => r.route === 'verify-then-land')) J.deviation(`${l.t.id}: Jev routed the landing verify-then-land; the brief expects land or ask-owner. It landed after the extra verify step.`);
    const asks = l.rows.filter((r) => r.route === 'ask-owner');
    if (asks.length) J.note(`${l.t.id} landing asked the owner: ${asks.map((a) => oneLine(a.reason, 300)).join(' | ')}`);
  }
  const answeredLand = answered.filter((a) => a.kind === 'landing');
  const allAnswers = readState()?.answers ?? [];
  for (const a of allAnswers) J.note(`owner question (${a.kind}) at ${a.at} for ${a.tasks.join(', ') || 'no task'}: ${oneLine(a.question, 600)} -> answered "${a.answer}"`);
  J.set('ownerAnswers', allAnswers.length);
  void answeredLand;

  // the sandbox main
  const logLines = git(SANDBOX, ['log', '--oneline', `${BASE}..main`]);
  const onMain = ts.map((t) => ({ t, ok: !!t.landed_commit && onBranch(SANDBOX, t.landed_commit, 'main') }));
  check('the sandbox main has the three landed changes', onMain.every((o) => o.ok) && logLines !== '', `git log --oneline 61fc71a..main: ${logLines.split('\n').length} commits; ${onMain.map((o) => `${o.t.id} ${o.t.landed_commit?.slice(0, 12) ?? '-'} on main: ${o.ok}`).join(', ')}`);
  J.note(`git -C ${SANDBOX} log --oneline 61fc71a..main:\n${logLines}`);
  const diffNames = git(SANDBOX, ['diff', '--name-status', `${BASE}..main`]);
  const readmeText = existsSync(join(SANDBOX, 'README.md')) ? readFileSync(join(SANDBOX, 'README.md'), 'utf8') : '';
  const pkg = parse(readFileSync(join(SANDBOX, 'package.json'), 'utf8'), {});
  const scripts = Object.keys(pkg.scripts ?? {});
  const howTo = /^#+\s*How to run/im.test(readmeText);
  const listedScripts = scripts.filter((s) => readmeText.includes(`npm run ${s}`) || (s === 'test' && /npm (run )?test/.test(readmeText)) || (s === 'start' && /npm (run )?start/.test(readmeText)));
  check('main: README has a How to run section listing the package.json commands', howTo && listedScripts.length === scripts.length, `How to run heading: ${howTo}; scripts named ${listedScripts.length}/${scripts.length}: ${listedScripts.join(', ')}`);
  const tests = diffNames.split('\n').filter((l) => /\.test\.ts$/.test(l));
  check('main: a new or changed unit test file', tests.length > 0, tests.join('; ') || diffNames);
  const custChanged = diffNames.split('\n').filter((l) => /src\/(web|customers)\//.test(l) && !/\.test\.ts$/.test(l));
  check('main: the customers page code changed (the empty state)', custChanged.length > 0, custChanged.join('; ') || 'none');
  J.note(`git diff --name-status 61fc71a..main:\n${diffNames}`);
  const now = checkoutState(SANDBOX);
  check('the sandbox checkout is clean, on main', now.branch === 'main' && now.status === '', `${now.branch} ${now.head.slice(0, 12)}; status ${now.status ? oneLine(now.status, 300) : 'clean'}`);

  // tables
  for (const role of ['readme', 'unit', 'customers']) {
    const id = byRole[role];
    if (!id) continue;
    const t = task(id);
    const rows = [];
    for (const s of steps(id)) {
      const rs = runs(id).filter((r) => r.step_id === s.id);
      if (!rs.length) rows.push([String(s.ordinal), s.duty, s.state, '-', '-', '-', '-', '-', String(s.attempts), oneLine(s.state_reason, 80)]);
      for (const r of rs) {
        const d = placementOf(r);
        const c = parse(d?.chosen_json, {});
        const rep = queryOne('SELECT status FROM reports WHERE session_id = ?', r.id);
        rows.push([
          String(s.ordinal),
          s.duty,
          `${s.state} (run ${r.id} ${r.state})`,
          r.runtime,
          r.provider,
          r.model,
          r.effort,
          c.source === 'owner' ? 'owner placement' : `model: ${topProbs(c.choices?.model?.probabilities)}; effort: ${topProbs(c.choices?.effort?.probabilities)}${c.choices?.provider ? `; provider: ${topProbs(c.choices.provider.probabilities, 2)}` : ''}`,
          String(s.attempts),
          rep?.status ?? 'none',
        ]);
      }
    }
    const lrows = landings(id).map((l) => {
      const d = l.decision_id ? queryOne('SELECT chosen_json FROM decisions WHERE id = ?', l.decision_id) : undefined;
      const c = parse(d?.chosen_json, {});
      return [l.id, l.route, l.state, c.probabilities ? topProbs(c.probabilities) : l.decision_id ? '' : 'no Jev call (forced)', oneLine(l.reason, 400)];
    });
    const end = t.ended_at ?? landings(id).at(-1)?.ended_at;
    const elapsedMs = end ? Date.parse(end) - Date.parse(t.created_at) : null;
    J.set(`${role}TaskId`, id);
    J.set(`${role}CreatedToLandedMs`, elapsedMs);
    tables.push({
      title: `${ROLE_TITLE[role]}: ${id} "${t.title}", kind ${t.kind}${t.visible ? ', visible' : ''}, ${t.state}${t.landed_commit ? ` at ${t.landed_commit.slice(0, 12)}` : ''}; created ${t.created_at}, ended ${end ?? '-'} (${elapsedMs != null ? `${(elapsedMs / 60000).toFixed(1)} min` : 'not landed'})`,
      columns: ['#', 'Duty', 'State', 'Runtime', 'Provider', 'Model', 'Effort', 'Top probabilities', 'Attempts', 'Report'],
      rows,
    });
    tables.push({ title: `${id} landings`, columns: ['Landing', 'Route', 'State', 'Route probabilities', 'Reason'], rows: lrows });
    const impl = steps(id).find((s) => s.duty === 'implement' || s.duty === 'document' || s.duty === 'automate');
    const firstRun = impl && runs(id).find((r) => r.step_id === impl.id);
    const c = parse(firstRun && placementOf(firstRun)?.chosen_json, {});
    const jv = c.label ? `${c.label} ${c.effort}` : '-';
    const jl = JEVELLAN_31_OCT[role];
    comparison.push([ROLE_TITLE[role], id, impl ? `${impl.duty} (step ${impl.ordinal})` : '-', jv, `${c.provider ?? '-'} / ${firstRun?.runtime ?? '-'}`, `${jl.label} ${jl.effort}`, c.label ? (c.label === jl.label ? (c.effort === jl.effort ? 'same' : 'same model, other effort') : c.effort === jl.effort ? 'other model, same effort' : 'different') : '-']);
  }
  tables.push({ title: "Jev's implement choice against Jevellan's choices of 31 October", columns: ['Task', 'Id', 'Step', 'Jev (jv)', 'Provider / runtime', 'Jevellan 31 Oct', 'Agreement'], rows: comparison });
  return tables;
}

// ---- main --------------------------------------------------------------------------------------------------------

async function main() {
  let state = readState();
  await ensureCoordinator();
  if (state?.tasks?.length === 3) {
    log(`rerun of tag ${TAG}: reusing ${state.tasks.join(', ')} (typed ${state.typedAt}); nothing is typed again`);
    J.note(`rerun with tag ${TAG}: the tasks ${state.tasks.join(', ')} the first run's message created are reused; the message was typed at ${state.typedAt}.`);
  } else {
    if (state) log(`tag ${TAG}: an earlier run typed the message but found ${state.tasks?.length ?? 0} tasks; typing is not repeated`);
    state = state ?? (await typeMessage());
    if (!state) return [];
    if (state.tasks.length !== 3) {
      // An earlier run of the tag that found fewer: look again.
      state.tasks = projectTasks().filter((t) => !state.before.includes(t.id)).map((t) => t.id);
      writeState(state);
    }
  }
  J.set('typedAt', state.typedAt);
  const ids = state.tasks;
  const ts = ids.map(task);
  check('the coordinator created three tasks within 15 minutes', ids.length === 3 && ts.every((t) => Date.parse(t.created_at) - Date.parse(state.typedAt) < 15 * 60_000), ts.map((t) => `${t.id} ${t.kind} "${t.title}" at ${t.created_at}`).join('; '));
  J.note(`coordinator's reply to the message: ${oneLine(state.createdReply, 2000)}`);
  J.note(`coordinator's commands for the message: ${(state.createdTools ?? []).join(' | ')}`);
  if (ids.length !== 3) return [];
  const byRole = {};
  for (const t of ts) {
    const r = roleOf(t);
    if (r && !byRole[r]) byRole[r] = t.id;
  }
  log(`roles: ${JSON.stringify(byRole)}`);
  J.start('poll');
  await poll(ids, byRole.readme);
  J.stop('poll');
  J.set('firstCreatedToLastLandedMs', (() => {
    const ends = ids.map((id) => task(id).ended_at).filter(Boolean).map(Date.parse);
    return ends.length === 3 ? Math.max(...ends) - Math.min(...ts.map((t) => Date.parse(t.created_at))) : null;
  })());
  const tables = assertAll(ids, byRole);
  const end = co.status();
  check('the coordinator is left running', end?.running === true && co.alive(), `${end?.sessionId} ${end?.sessionState}; screen ${end?.screen}`);
  return tables;
}

const tables = await main();
J.finish({ tables });
