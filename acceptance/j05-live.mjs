#!/usr/bin/env node
// J5's live part (brief section 15, J5): what can only be seen while a claude-tmux run is running. J4 starts this
// script, detached, for every claude-tmux run of the visible README task the moment it sees the run; it can also be
// started by hand for a run that is live. Until the run ends (or --max-min), every 250 ms it:
//
// - reads the run's native transcript (the provider home's ~/.claude/projects/<cwd>/<native id>.jsonl) and notes
//   the wall clock at which each entry first appears (assistant text, tool calls by tool_use id);
// - reads `jv tail <run> --follow --json` (a child process started at once) and notes the wall clock at which each
//   event line arrives;
// - once, while the run is running: `jv attach <run>` (not in a terminal, it prints the tmux command), tmux
//   has-session on the run's window, and capture-pane -p -J -S -200 of it; then capture-pane once a second until a
//   capture shows the Claude UI (paneUi), since the window is blank for its first moments.
//
// Writes acceptance/results/J05-live-<run>.json: {run, startedAt, endedAt, attach, hasSession, pane, transcript:
// [{key, kind, name, at, seenWall}], tail: [{seq, kind, at, key, arrivedWall}], runRow}. j05-visibility.mjs reads
// these files. Usage: node acceptance/j05-live.mjs --run R [--max-min 90]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { JV, JV_HOME, jvJson, log, queryOne, runtimeModule, sleep } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const RUN = arg('--run');
const MAX_MS = Number(arg('--max-min', '90')) * 60_000;
if (!RUN) {
  process.stderr.write('usage: j05-live.mjs --run R\n');
  process.exit(2);
}
const OUT = join(HERE, 'results', `J05-live-${RUN}.json`);
mkdirSync(dirname(OUT), { recursive: true });
const LIVE = ['queued', 'starting', 'running'];
const T = await runtimeModule('transcript.js');
const row = () => queryOne('SELECT * FROM sessions WHERE id = ?', RUN);
const parse = (s, f = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};
const textKey = (t) => `text:${String(t).replace(/\s+/g, ' ').trim().slice(0, 120)}`;

const out = { run: RUN, startedAt: new Date().toISOString(), endedAt: null, attach: null, hasSession: null, pane: null, paneUi: null, transcriptFile: null, transcript: [], tail: [], runRow: null };
const seenT = new Map();
const save = () => writeFileSync(OUT, `${JSON.stringify({ ...out, transcript: [...seenT.values()] }, null, 2)}\n`);

// jv tail --follow --json: one JSON object per event line.
const tail = spawn(JV, ['tail', RUN, '--follow', '--json'], { env: { ...process.env, JV_HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
createInterface({ input: tail.stdout }).on('line', (line) => {
  const arrivedWall = Date.now();
  const e = parse(line, null);
  if (!e) return;
  const p = typeof e.payload === 'string' ? parse(e.payload) : e.payload ?? {};
  const key = e.kind === 'tool-call' && p.id ? `tool:${p.id}` : e.kind === 'text' && p.text ? textKey(p.text) : undefined;
  out.tail.push({ seq: e.seq, kind: e.kind, at: e.at, key, arrivedWall });
});
let tailExit;
tail.on('exit', (code) => {
  tailExit = code;
});

log(`J5 live: watching ${RUN}; writing ${OUT}`);
const t0 = Date.now();
let lastPaneAt = 0;
for (;;) {
  const r = row();
  const now = Date.now();
  if (r && !out.transcriptFile && r.native_session_id) {
    const f = T.findClaudeTranscript(join(JV_HOME, 'homes', r.provider), r.cwd, r.native_session_id);
    if (f) out.transcriptFile = f;
  }
  if (out.transcriptFile && existsSync(out.transcriptFile)) {
    for (const line of readFileSync(out.transcriptFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const v = parse(line, null);
      const content = v?.message?.content;
      if (v?.type !== 'assistant' || !Array.isArray(content)) continue;
      for (const part of content) {
        const key = part?.type === 'tool_use' && part.id ? `tool:${part.id}` : part?.type === 'text' && part.text ? textKey(part.text) : undefined;
        if (key && !seenT.has(key)) seenT.set(key, { key, kind: part.type, name: part.name, at: v.timestamp, seenWall: now });
      }
    }
  }
  // The pane while the run is live, once a second: the first capture that shows the Claude UI is kept (the window
  // is blank for its first second or two, and it closes when the step ends).
  if (r && out.attach && !out.paneUi && r.state === 'running' && now - lastPaneAt >= 1000) {
    lastPaneAt = now;
    const session = r.tmux_target.replace(/^=/, '').replace(/:.*$/, '');
    const pane = spawnSync('tmux', ['capture-pane', '-p', '-J', '-S', '-200', '-t', `=${session}:`], { encoding: 'utf8' }).stdout ?? '';
    if (/bypass permissions|esc to interrupt|Claude Code|^\s*[❯>]/m.test(pane)) {
      out.paneUi = { at: new Date().toISOString(), pane };
      log(`capture-pane shows the Claude UI at ${out.paneUi.at}`);
      save();
    }
  }
  if (r && !out.attach && r.state === 'running' && r.tmux_target) {
    const a = jvJson(['attach', RUN], { timeoutMs: 30_000 });
    const plain = spawnSync(JV, ['attach', RUN], { encoding: 'utf8', timeout: 30_000 });
    const session = r.tmux_target.replace(/^=/, '').replace(/:.*$/, '');
    const has = spawnSync('tmux', ['has-session', '-t', `=${session}`]).status === 0;
    const pane = spawnSync('tmux', ['capture-pane', '-p', '-J', '-S', '-200', '-t', `=${session}:`], { encoding: 'utf8' }).stdout ?? '';
    const ls = (spawnSync('tmux', ['ls', '-F', '#{session_name} #{session_created}'], { encoding: 'utf8' }).stdout ?? '').split('\n').find((l) => l.startsWith(`${session} `));
    out.attach = { status: a.status, json: a.json ?? null, text: plain.stdout?.trim() ?? '', stderr: (a.stderr || plain.stderr || '').trim().slice(0, 500), at: new Date().toISOString() };
    out.hasSession = { session, has, listed: ls ?? null };
    out.pane = pane;
    log(`attach: exit ${a.status}; ${out.attach.text.slice(0, 200)}; has-session ${has}`);
    save();
  }
  if (!r || !LIVE.includes(r.state) || now - t0 > MAX_MS) break;
  await sleep(250);
}
// Let jv tail --follow see the end event and exit by itself.
for (let i = 0; i < 40 && tailExit === undefined; i++) await sleep(250);
if (tailExit === undefined) tail.kill('SIGTERM');
out.runRow = row();
out.endedAt = new Date().toISOString();
out.tailExit = tailExit ?? 'killed';
save();
log(`J5 live: ${RUN} ${out.runRow?.state}; ${seenT.size} transcript entries, ${out.tail.length} tail events; wrote ${OUT}`);
