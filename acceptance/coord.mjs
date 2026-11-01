// The coordinator as the owner sees it, for the journeys that talk to it through tmux (J4 onwards): its tmux
// window (jv-coord-<project>), its native transcript (the claude-main home, its --session-id), typing the way the
// owner would (send-keys -l for one line, load-buffer and paste-buffer for a long message, then Enter), and reading
// what it said since a point in its transcript. Plain ESM; imports the installed runtime's coordinator.js and
// transcript.js through lib.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JV_HOME, jvJson, runtimeModule, sleep } from './lib.mjs';

const C = await runtimeModule('coordinator.js');
const T = await runtimeModule('transcript.js');

const tm = (args, input) => spawnSync('tmux', args, { encoding: 'utf8', ...(input !== undefined ? { input } : {}) });

export function oneLine(s, max = 600) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** The coordinator of one project: tmux name and target, its status, its transcript. */
export function coordinator(project, projectPath) {
  const name = C.coordinatorTmuxName(project);
  const target = `=${name}:`;

  function status() {
    return jvJson(['coordinator', 'status', '--project', project]).json;
  }

  function transcript() {
    const s = status();
    if (!s?.nativeSessionId) return undefined;
    const home = join(JV_HOME, 'homes', s.provider);
    return T.findClaudeTranscript(home, projectPath, s.nativeSessionId) ?? T.claudeTranscriptPath(home, projectPath, s.nativeSessionId);
  }

  function size(file = transcript()) {
    return file && existsSync(file) ? statSync(file).size : 0;
  }

  /** The transcript records from a byte offset: [{id, value}]. */
  function recordsFrom(offset, file = transcript()) {
    if (!file || !existsSync(file)) return [];
    return T.nativeRecords(readFileSync(file).subarray(offset).toString('utf8'), offset);
  }

  /** What the records hold: the assistant text, the tool calls (Bash commands), the user texts, the last timestamp. */
  function digest(records) {
    const texts = [];
    const tools = [];
    const users = [];
    let lastAt;
    for (const { value } of records) {
      if (value?.timestamp) lastAt = value.timestamp;
      const content = value?.message?.content;
      if (value.type === 'user') {
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p?.type === 'text' ? p.text ?? '' : '')).join(' ') : '';
        if (text.trim()) users.push({ at: value.timestamp, text });
      }
      if (value.type !== 'assistant' || !Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === 'text' && part.text) texts.push({ at: value.timestamp, text: part.text });
        if (part?.type === 'tool_use') tools.push({ at: value.timestamp, name: part.name, input: part.input?.command ?? JSON.stringify(part.input ?? {}) });
      }
    }
    return { texts, tools, users, lastAt, reply: texts.map((t) => t.text).join('\n') };
  }

  function screen() {
    return tm(['capture-pane', '-p', '-J', '-S', '-200', '-t', target]).stdout ?? '';
  }

  function alive() {
    return C.hasSession(C.realTmux, name);
  }

  /** Busy: a turn is running (the spinner's "esc to interrupt"), or the screen is not the input prompt. */
  function busy(text = screen()) {
    return /esc to interrupt/i.test(text) || C.screenState(text) !== 'ready';
  }

  /**
   * Idle: not busy, and the transcript has not grown for `quietMs`. Returns the screen when idle, undefined after
   * `timeoutMs`.
   */
  async function waitIdle({ quietMs = 8000, timeoutMs = 10 * 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSize = size();
    let since = Date.now();
    for (;;) {
      const s = screen();
      const now = size();
      if (now !== lastSize) {
        lastSize = now;
        since = Date.now();
      }
      if (!busy(s) && Date.now() - since >= quietMs) return s;
      if (Date.now() > deadline) return undefined;
      await sleep(1000);
    }
  }

  /** Types text as the owner: one short line with send-keys -l, anything longer through a paste buffer; then Enter. */
  function type(text) {
    if (text.length <= 200 && !text.includes('\n')) {
      return tm(['send-keys', '-t', target, '-l', '--', text]).status === 0 && tm(['send-keys', '-t', target, 'Enter']).status === 0;
    }
    const buffer = `jv-accept-${process.pid}-${Date.now()}`;
    if (tm(['load-buffer', '-b', buffer, '-'], text).status !== 0) return false;
    if (tm(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]).status !== 0) return false;
    // Claude Code shows a long paste as "[Pasted text]" and needs a moment before Enter submits it.
    spawnSync('sleep', ['1']);
    return tm(['send-keys', '-t', target, 'Enter']).status === 0;
  }

  /**
   * Types `text` once the coordinator is idle, then waits for its turn to end (the typed text is in the transcript,
   * and it is idle again). Returns {offset, typedAt, records, digest, screen, ms, timedOut}.
   */
  async function say(text, { timeoutMs = 15 * 60_000 } = {}) {
    await waitIdle({ quietMs: 3000, timeoutMs: 10 * 60_000 });
    const offset = size();
    const started = Date.now();
    const typedAt = new Date().toISOString();
    const ok = type(text);
    let records = [];
    let timedOut = true;
    const needle = text.slice(0, 60);
    while (ok && Date.now() - started < timeoutMs) {
      await sleep(2000);
      records = recordsFrom(offset);
      const d = digest(records);
      if (d.users.some((u) => u.text.includes(needle)) && d.texts.length && (await waitIdle({ quietMs: 8000, timeoutMs: 30_000 })) !== undefined) {
        timedOut = false;
        break;
      }
    }
    records = recordsFrom(offset);
    return { ok, offset, typedAt, records, digest: digest(records), screen: screen(), ms: Date.now() - started, timedOut };
  }

  return { name, target, status, transcript, size, recordsFrom, digest, screen, alive, busy, waitIdle, type, say };
}
