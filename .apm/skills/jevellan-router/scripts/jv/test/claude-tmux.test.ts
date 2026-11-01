// The claude-tmux runtime against a fake tmux binary on PATH (it logs every call and keeps a set of session names)
// and fake transcript lines written where Claude Code writes them: the tmux command line through jv exec, the files,
// the first-run answers, typing, the watcher (events, report, turn end, usage), the no-report backstop, a window that
// closes, resume into the live window or a new one with --resume, and stop. No claude, no model.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-claude-tmux-test-');
process.env.JV_HOME = home;
const tmuxDir = join(home, 'fake-tmux');
const binDir = join(tmuxDir, 'bin');
mkdirSync(join(tmuxDir, 'sessions'), { recursive: true });
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, 'tmux'),
  `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_TMUX_DIR;
const args = process.argv.slice(2);
let input = '';
if (args[0] === 'load-buffer') { try { input = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ args, input }) + '\\n');
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const name = (t) => (t || '').replace(/^=/, '').replace(/:.*$/, '');
const file = (n) => path.join(dir, 'sessions', n);
switch (args[0]) {
  case 'new-session': fs.writeFileSync(file(flag('-s')), ''); break;
  case 'has-session': process.exit(fs.existsSync(file(name(flag('-t')))) ? 0 : 1);
  case 'kill-session': fs.rmSync(file(name(flag('-t'))), { force: true }); break;
  case 'list-panes': process.stdout.write((process.env.FAKE_TMUX_PANE_PID || '0') + '\\n'); break;
  case 'capture-pane': {
    const n = name(flag('-t'));
    const screen = path.join(dir, 'screen-' + n);
    if (!fs.existsSync(file(n))) process.exit(1);
    process.stdout.write(fs.existsSync(screen) ? fs.readFileSync(screen, 'utf8') : 'Claude Code\\n' + '─'.repeat(40) + '\\n❯ \\n' + '─'.repeat(40) + '\\n');
    break;
  }
  default: break;
}
`,
);
chmodSync(join(binDir, 'tmux'), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
process.env.FAKE_TMUX_DIR = tmuxDir;
// The "pane": a process of this test in its own process group, so stopRun's signals reach nothing else.
const pane = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
pane.unref();
process.env.FAKE_TMUX_PANE_PID = String(pane.pid);
after(() => {
  try {
    process.kill(-pane.pid!, 'SIGKILL');
  } catch {
    // already gone
  }
});

const tmuxRt = await import('../src/runtimes/claude-tmux.js');
const { RunFailure, RunStopped } = await import('../src/runtimes/types.js');
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const { claudeTranscriptPath } = await import('../src/transcript.js');
const { NO_REPORT_PROMPT } = await import('../src/prompt.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);
execFileSync('git', ['init', '-q', '-b', 'main', seeded.repo]);
const providerHome = join(home, 'homes', 'claude-main');

let n = 0;
function newRun(native?: string) {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-tmux-${n}`,
    kind: 'step',
    runtime: 'claude-tmux',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
    ...(native ? { native_session_id: native } : {}),
  }).row;
}

const turn = (mode: 'write' | 'read-only' = 'write') => ({
  systemAppend: 'RULES\n\nDUTY\n\nTASK',
  env: { HOME: providerHome, PATH: '/usr/bin', JV_SESSION: 'x', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
  tools: { mode },
  mcp: {
    servers: { pw: { type: 'stdio' as const, command: 'npx', args: ['playwright-mcp'] } },
    report: { type: 'stdio' as const, command: '/node', args: ['report-mcp.js', '--session', 'x'], env: { JV_HOME: home } },
  },
});

interface Call {
  args: string[];
  input: string;
}
function calls(): Call[] {
  const file = join(tmuxDir, 'log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Call);
}
const callsSince = (k: number) => calls().slice(k);

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const fast = {
  openStore: () => store,
  pollMs: 15,
  readyPollMs: 2,
  quietMs: 40,
  noReportGraceMs: 120,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 10))),
  claude: '/opt/claude/bin/claude',
};
const runtime = tmuxRt.createClaudeTmuxRuntime(fast);

const rec = (v: unknown) => `${JSON.stringify(v)}\n`;
const userLine = rec({ type: 'user', message: { role: 'user', content: 'Start the step now. End with jv_report.' } });
const workLines = [
  rec({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Reading the entry point.' }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 50 } } }),
  rec({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/index.ts' } }], usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 50 } } }),
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export {}' }] } }),
];
const endLine = rec({ type: 'assistant', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reported.' }], usage: { input_tokens: 1, output_tokens: 3 } } });

function typedEnter(k: number): boolean {
  return callsSince(k).some((c) => c.args[0] === 'send-keys' && c.args.at(-1) === 'Enter');
}

test('start: tmux through jv exec, files, first-run answers, typing, events, report, turn end and usage', async () => {
  const s = newRun();
  const k = calls().length;
  const done = runtime.start(s, { prompt: 'Start the step now. End with jv_report.', ...turn() });
  await until(() => typedEnter(k));
  const row = store.requireSession(s.id);
  assert.match(row.native_session_id ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(row.tmux_target, `jv-${s.id}`);
  assert.equal(row.pid, pane.pid);
  const transcript = claudeTranscriptPath(providerHome, seeded.repo, row.native_session_id!);
  mkdirSync(join(transcript, '..'), { recursive: true });
  appendFileSync(transcript, userLine + workLines.join(''));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writeReport(store, s.id, { status: 'done', summary: 'The app starts in src/index.ts.' }).outcome, 'recorded');
  appendFileSync(transcript, endLine);
  const result = await done;
  assert.equal(result.tmuxTarget, `jv-${s.id}`);
  assert.equal(result.nativeSessionId, row.native_session_id);

  const mine = callsSince(k);
  const created = mine.find((c) => c.args[0] === 'new-session')!;
  const a = created.args;
  assert.deepEqual(a.slice(0, 10), ['new-session', '-d', '-s', `jv-${s.id}`, '-x', '200', '-y', '50', '-c', seeded.repo]);
  assert.ok(a.includes(`JV_HOME=${home}`));
  const execAt = a.indexOf('exec');
  assert.ok(a[execAt - 1]!.endsWith(join('runtime', 'bin', 'jv.mjs')));
  assert.deepEqual(a.slice(execAt, execAt + 4), ['exec', '--session', s.id, '--']);
  const claude = a.slice(execAt + 4);
  const appendFile = claude[claude.indexOf('--append-system-prompt-file') + 1]!;
  const mcpFile = claude[claude.indexOf('--mcp-config') + 1]!;
  assert.deepEqual(claude, [
    '/opt/claude/bin/claude',
    '--model',
    'model-strong',
    '--effort',
    'high',
    '--append-system-prompt-file',
    appendFile,
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    row.native_session_id!,
    '--mcp-config',
    mcpFile,
    '--strict-mcp-config',
    '--settings',
    JSON.stringify({ skipDangerousModePermissionPrompt: true, cleanupPeriodDays: 36500 }),
    // The owner's own ~/.claude memory above the worktree must not load (project memory is off, as in claude-sdk).
    '--setting-sources',
    'user',
  ]);
  assert.equal(appendFile, join(home, 'projects', 'sandbox', 'tasks', seeded.taskId, `${s.id}.append.md`));
  assert.equal(readFileSync(appendFile, 'utf8'), 'RULES\n\nDUTY\n\nTASK');
  assert.equal(statSync(appendFile).mode & 0o777, 0o600);
  const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as { mcpServers: Record<string, { command: string }> };
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['jv', 'pw']);
  assert.equal(mcp.mcpServers.jv!.command, '/node');
  // No secret on any tmux command line.
  assert.ok(!JSON.stringify(mine).includes(FAKE_TOKEN));
  // Typed with send-keys -l, then Enter.
  const typed = mine.find((c) => c.args[0] === 'send-keys' && c.args.includes('-l'))!;
  assert.deepEqual(typed.args, ['send-keys', '-t', `=jv-${s.id}:`, '-l', 'Start the step now. End with jv_report.']);
  // First-run answers in the provider home.
  const prefs = JSON.parse(readFileSync(join(providerHome, '.claude.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(prefs.hasCompletedOnboarding, true);
  assert.equal((prefs.projects as Record<string, { hasTrustDialogAccepted: boolean }>)[seeded.repo]!.hasTrustDialogAccepted, true);

  const events = store.listEvents(s.id);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['text', 'tool-call', 'tool-result', 'report', 'text', 'usage'],
  );
  const usage = JSON.parse(events.at(-1)!.payload) as Record<string, number>;
  assert.equal(usage.inputTokens, 6);
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.cacheReadTokens, 50);
  const after = store.requireSession(s.id);
  assert.equal(after.input_tokens, 6);
  assert.equal(after.output_tokens, 7);
});

test('a prompt of several lines is pasted (bracketed), then Enter', async () => {
  const s = newRun();
  const k = calls().length;
  const done = runtime.start(s, { prompt: 'Start the step now.\n\nFrom the owner: use the blue one', ...turn() });
  await until(() => typedEnter(k));
  const row = store.requireSession(s.id);
  const transcript = claudeTranscriptPath(providerHome, seeded.repo, row.native_session_id!);
  appendFileSync(transcript, userLine);
  writeReport(store, s.id, { status: 'progress', summary: 'Working.' });
  appendFileSync(transcript, endLine);
  await done;
  const mine = callsSince(k);
  const load = mine.find((c) => c.args[0] === 'load-buffer')!;
  assert.equal(load.input, 'Start the step now.\n\nFrom the owner: use the blue one');
  assert.ok(mine.some((c) => c.args[0] === 'paste-buffer' && c.args.includes('-p') && c.args.includes(`=jv-${s.id}:`)));
  assert.ok(!mine.some((c) => c.args[0] === 'send-keys' && c.args.includes('-l')));
});

test('no report: jv asks once with NO_REPORT_PROMPT, then synthesizes blocked', async () => {
  const s = newRun();
  const k = calls().length;
  const done = runtime.start(s, { prompt: 'Start the step now. End with jv_report.', ...turn() });
  await until(() => typedEnter(k));
  const transcript = claudeTranscriptPath(providerHome, seeded.repo, store.requireSession(s.id).native_session_id!);
  appendFileSync(transcript, userLine + endLine);
  await until(() => callsSince(k).some((c) => c.args.includes(NO_REPORT_PROMPT)));
  appendFileSync(transcript, rec({ type: 'user', message: { role: 'user', content: NO_REPORT_PROMPT } }) + endLine);
  await done;
  const report = store.getReportBySession(s.id)!;
  assert.equal(report.status, 'blocked');
  assert.equal(report.limitations, 'synthesized: no report');
  assert.ok(store.listEvents(s.id).some((e) => e.kind === 'message' && e.payload.includes(NO_REPORT_PROMPT)));
});

test('a window that closes before the turn ended fails the turn', async () => {
  const s = newRun();
  const k = calls().length;
  const done = runtime.start(s, { prompt: 'Start.', ...turn() });
  await until(() => typedEnter(k));
  rmSync(join(tmuxDir, 'sessions', `jv-${s.id}`));
  await assert.rejects(done, (e: unknown) => e instanceof RunFailure && /closed before the turn ended/.test((e as Error).message));
});

test('a start-up screen that waits for a person fails the start and kills the window', async () => {
  const s = newRun();
  writeFileSync(join(tmuxDir, `screen-jv-${s.id}`), 'Choose the text style that looks best\n');
  const rt = tmuxRt.createClaudeTmuxRuntime({ ...fast, readyTimeoutMs: 150 });
  const k = calls().length;
  await assert.rejects(rt.start(s, { prompt: 'Start.', ...turn() }), (e: unknown) => e instanceof RunFailure && /Choose the text style/.test((e as Error).message));
  assert.ok(callsSince(k).some((c) => c.args[0] === 'kill-session'));
  assert.equal(store.requireSession(s.id).native_session_id, null, 'a conversation Claude never created is not kept');
});

test('resume types into the live window of the conversation; without one it starts jv-<R> with --resume', async () => {
  const first = newRun();
  const k0 = calls().length;
  const done = runtime.start(first, { prompt: 'Start.', ...turn() });
  await until(() => typedEnter(k0));
  const native = store.requireSession(first.id).native_session_id!;
  const transcript = claudeTranscriptPath(providerHome, seeded.repo, native);
  appendFileSync(transcript, userLine);
  writeReport(store, first.id, { status: 'progress', summary: 'Halfway.' });
  appendFileSync(transcript, endLine);
  await done;

  // Live window: no new session; typed into jv-<first>.
  const second = newRun(native);
  const k1 = calls().length;
  const resumed = runtime.resume(second, 'Continue.', turn());
  await until(() => typedEnter(k1));
  assert.ok(!callsSince(k1).some((c) => c.args[0] === 'new-session'));
  assert.ok(callsSince(k1).some((c) => c.args[0] === 'send-keys' && c.args.includes(`=jv-${first.id}:`) && c.args.includes('Continue.')));
  assert.equal(store.requireSession(second.id).tmux_target, `jv-${first.id}`);
  appendFileSync(transcript, rec({ type: 'user', message: { role: 'user', content: 'Continue.' } }));
  writeReport(store, second.id, { status: 'done', summary: 'Finished.' });
  appendFileSync(transcript, endLine);
  await resumed;
  // The second row's events are only those after its own prompt.
  assert.deepEqual(store.listEvents(second.id).map((e) => e.kind), ['report', 'text', 'usage']);

  // Window gone: a new window for the third row, --resume the same conversation.
  rmSync(join(tmuxDir, 'sessions', `jv-${first.id}`));
  const third = newRun(native);
  const k2 = calls().length;
  const again = runtime.resume(third, 'From the owner: one more thing', turn());
  await until(() => typedEnter(k2));
  const created = callsSince(k2).find((c) => c.args[0] === 'new-session')!;
  assert.equal(created.args[3], `jv-${third.id}`);
  const claude = created.args.slice(created.args.indexOf('--') + 1);
  assert.equal(claude[claude.indexOf('--resume') + 1], native);
  assert.ok(!claude.includes('--session-id'));
  assert.ok(created.args.includes(third.id));
  appendFileSync(transcript, rec({ type: 'user', message: { role: 'user', content: 'From the owner: one more thing' } }));
  writeReport(store, third.id, { status: 'done', summary: 'Done again.' });
  appendFileSync(transcript, endLine);
  await again;
  assert.equal(store.requireSession(third.id).tmux_target, `jv-${third.id}`);
});

test('a row stopped while the watcher runs ends the turn as stopped; stop() kills the window and writes end', async () => {
  const s = newRun();
  const k = calls().length;
  const done = runtime.start(s, { prompt: 'Start.', ...turn() }).then(
    () => undefined,
    (e: unknown) => e,
  );
  await until(() => typedEnter(k));
  await runtime.stop(store.requireSession(s.id), 'stopped by the owner');
  assert.ok((await done) instanceof RunStopped);
  assert.ok(callsSince(k).some((c) => c.args[0] === 'kill-session' && c.args.includes(`=jv-${s.id}`)));
  const row = store.requireSession(s.id);
  assert.equal(row.state, 'stopped');
  assert.ok(store.lastEvent(s.id, 'end'));
});

test('closeFinishedWindows closes the windows of finished claude-tmux rows of a step, never a live step\'s', () => {
  const sessions = join(tmuxDir, 'sessions');
  const own = seedTask(store, home, { name: 'close-windows', kind: 'single' });
  let k = 0;
  const newRun = () =>
    store.createSession({ project_id: own.projectId, task_id: own.taskId, step_id: own.stepIds[0]!, request_id: `req-close-${++k}`, kind: 'step', runtime: 'claude-tmux', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: own.repo }).row;
  const done = newRun();
  store.setSessionState(done.id, 'done', 'turn ended', { tmux_target: tmuxRt.sessionName(done.id) });
  writeFileSync(join(sessions, tmuxRt.sessionName(done.id)), '');
  const coord = 'jv-coord-sandbox';
  writeFileSync(join(sessions, coord), '');
  const odd = newRun();
  store.setSessionState(odd.id, 'stopped', 'test', { tmux_target: coord });
  const other = newRun();
  store.setSessionState(other.id, 'running', 'turn running', { tmux_target: tmuxRt.sessionName(other.id) });
  writeFileSync(join(sessions, tmuxRt.sessionName(other.id)), '');
  // A live row on the step: nothing of that step closes.
  assert.deepEqual(tmuxRt.closeFinishedWindows(store, { taskId: own.taskId, stepId: own.stepIds[0]! }), []);
  assert.ok(existsSync(join(sessions, tmuxRt.sessionName(done.id))));
  store.setSessionState(other.id, 'stopped', 'test');
  rmSync(join(sessions, tmuxRt.sessionName(other.id)));
  assert.deepEqual(tmuxRt.closeFinishedWindows(store, { taskId: own.taskId }), [tmuxRt.sessionName(done.id)]);
  assert.ok(!existsSync(join(sessions, tmuxRt.sessionName(done.id))));
  assert.ok(existsSync(join(sessions, coord)), 'a window that is not a worker window is never closed');
  assert.deepEqual(tmuxRt.closeFinishedWindows(store, { taskId: own.taskId }), [], 'a second call closes nothing');
  rmSync(join(sessions, coord));
});

test('read-only duties: dontAsk with the read-only tools, the report tool and project servers pre-approved', () => {
  const args = tmuxRt.claudeArgs({
    model: 'm',
    effort: 'turbo',
    appendFile: '/a',
    mcpFile: '/m',
    tools: { mode: 'read-only', writeFiles: ['plan.md'] },
    projectServers: ['pw'],
    sessionId: 'u',
  });
  assert.ok(!args.includes('--effort'), 'an effort Claude Code does not know is not passed');
  const tools = args.slice(args.indexOf('--tools') + 1, args.indexOf('--allowedTools'));
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'Write']);
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--session-id'));
  assert.deepEqual(allowed, ['mcp__jv__jv_report', 'WebSearch', 'WebFetch', 'Write', 'mcp__pw']);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('prepareClaudeInteractiveHome: trust on the main checkout of a worktree, idempotent, other keys kept', () => {
  const repo = join(home, 'repos', 'wt-main');
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(home, 'worktrees', 'sandbox', 'feature-x');
  git('worktree', 'add', '-q', '-b', 'jv/feature-x', wt);
  const h = join(home, 'homes', 'claude-second');
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, '.claude.json'), JSON.stringify({ userID: 'keep-me', projects: { '/elsewhere': { allowedTools: ['x'] } } }));
  assert.equal(tmuxRt.claudeTrustRoot(wt), repo);
  const first = tmuxRt.prepareClaudeInteractiveHome(h, wt);
  assert.equal(first.changed, true);
  const v = JSON.parse(readFileSync(first.file, 'utf8')) as { userID: string; hasCompletedOnboarding: boolean; fullscreenUpsellSeenCount: number; projects: Record<string, Record<string, unknown>> };
  assert.equal(v.userID, 'keep-me');
  assert.equal(v.hasCompletedOnboarding, true);
  assert.equal(v.fullscreenUpsellSeenCount, 100);
  assert.equal(v.projects[repo]!.hasTrustDialogAccepted, true);
  assert.equal(v.projects[wt]!.hasTrustDialogAccepted, true);
  assert.deepEqual(v.projects['/elsewhere'], { allowedTools: ['x'] });
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.equal(tmuxRt.prepareClaudeInteractiveHome(h, wt).changed, false);
  assert.throws(() => tmuxRt.prepareClaudeInteractiveHome(join(home, 'not-a-home'), wt), /not inside/);
});

test('waitForPrompt answers a known dialog on its second sighting, then waits for a steady prompt', async () => {
  const screens = ['Do you trust the files?\n❯ 1. Yes, I trust this folder\n', 'Do you trust the files?\n❯ 1. Yes, I trust this folder\n'];
  const ready = `${'─'.repeat(30)}\n❯ \n`;
  const sent: string[][] = [];
  const fake = (args: readonly string[]) => {
    if (args[0] === 'capture-pane') return { status: 0, stdout: screens.shift() ?? ready, stderr: '' };
    if (args[0] === 'send-keys') sent.push([...args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = await tmuxRt.waitForPrompt(fake, 'jv-RTEST01', { pollMs: 1, timeoutMs: 2000, sleep: () => Promise.resolve() });
  assert.deepEqual(r, { ready: true });
  assert.deepEqual(sent.map((a) => a.at(-1)), ['Down', 'Enter']);
});
