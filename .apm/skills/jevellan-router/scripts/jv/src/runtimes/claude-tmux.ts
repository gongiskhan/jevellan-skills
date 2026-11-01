// The claude-tmux runtime (section 6.2): interactive Claude Code in a tmux session the owner can watch and attach to.
//
// start(): writes the system append and the MCP config (jv-report-mcp for this row plus project.json's servers) under
// ~/.jv/projects/<name>/tasks/<T>/, generates the Claude session id and stores it on the row before anything runs,
// pre-answers the first-run dialogs in the provider home (prepareClaudeInteractiveHome), and starts
//
//   tmux new-session -d -s jv-<R> -x 200 -y 50 -c <cwd> -e PATH=... -e JV_HOME=...
//     <node> <jv.mjs> exec --session <R> -- <claude> --model M --effort E --append-system-prompt-file <file>
//       --permission-mode bypassPermissions --session-id <uuid> --mcp-config <file> --strict-mcp-config --settings <json>
//
// jv exec builds the provider's minimal environment and reads the key files itself (D-007), so no secret is on a
// command line or in tmux. Read-only duties get dontAsk with section 6.1's tool list instead of bypassPermissions
// (D-026, the same tools as claude-sdk). When the TUI shows its prompt (capture-pane polled), the prompt is typed
// (send-keys -l, or a bracketed paste when it has several lines) and Enter is pressed.
//
// The `jv run` process of the row is the watcher: it tails <provider home>/.claude/projects/<cwd slug>/<uuid>.jsonl
// every second with the ported transcript parser, records text, thinking, tool calls and results, waits for the report
// (jv-report-mcp writes it) and the end of the turn, records the turn's usage from the transcript, then returns. A
// turn that ended without a report is asked once more (NO_REPORT_PROMPT, after the Stop hook gave up); still none: a
// `blocked` report is synthesized. The row's pid is the pane's process (`jv exec --session R ...`, whose command line
// names the row), so `jv status` marks the row lost when the window is gone without an end event; a window that
// closes while the watcher runs fails the turn.
//
// resume(): types the message into the live window of the conversation (any earlier row's tmux target that still
// exists), else starts a new window jv-<R> with --resume <uuid>, then watches the turn the same way.
// stop(): tmux kill-session, then the launcher's stopRun (state stopped, end event).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { bootstrapNode } from '../env.js';
import { recordEvent, tailEvents } from '../events.js';
import { processGroup, stopRun } from '../launcher.js';
import { paths, providerHomeProblem } from '../paths.js';
import { NO_REPORT_PROMPT } from '../prompt.js';
import { defaultRedactor, type Redactor } from '../redact.js';
import { REPORT_SERVER_NAME, REPORT_TOOL_QUALIFIED, synthesizeReport } from '../report.js';
import { openStore, type Store } from '../store.js';
import {
  claudeTranscriptPath,
  fileSize,
  findClaudeTranscript,
  nativeRecords,
  readComplete,
  transcriptEvents,
  TurnTracker,
  turnsFromRecords,
  UsageCollector,
} from '../transcript.js';
import type { SessionRow } from '../types.js';
import { EFFORT_LEVELS, READ_ONLY_TOOLS } from './claude-sdk.js';
import { RunFailure, RunStopped, type McpServerSpec, type RuntimeModule, type StartInput, type ToolPolicy, type TurnInput } from './types.js';

export const NO_REPORT_SUMMARY = 'The session ended its turn without jv_report, also after being asked once more (no report).';
export const NO_REPORT_LIMITATIONS = 'synthesized: no report';

/**
 * Settings passed with --settings (flag settings win over the home's): the bypass-permissions confirmation is
 * pre-accepted (it cannot be answered from .claude.json), and transcripts are kept far past Claude Code's default
 * retention so a conversation can always be resumed (Jevellan's CLAUDE_FLAG_SETTINGS).
 */
export const CLAUDE_TMUX_SETTINGS = Object.freeze({ skipDangerousModePermissionPrompt: true, cleanupPeriodDays: 36_500 });

/** The first-run answers an interactive Claude Code needs in its home's .claude.json (Jevellan's CLAUDE_FIRST_RUN_SETTLED). */
/**
 * Only the provider home's user settings (and their memory) load, as claude-sdk's settingSources ['user'] does. Without
 * it Claude Code walks up from the worktree and loads any CLAUDE.md and .claude/rules it finds, which on dev-madrid
 * includes the owner's own ~/.claude/CLAUDE.md and rules (every worktree sits under the owner's home). The project's
 * AGENTS.md reaches the worker through the system append (section 7.4).
 */
export const CLAUDE_SETTING_SOURCES: readonly string[] = Object.freeze(['--setting-sources', 'user']);

export const CLAUDE_FIRST_RUN_SETTLED = Object.freeze({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 100 });

// ---- tmux ---------------------------------------------------------------------------------------------------

export interface TmuxResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one tmux command (no shell); `input` goes to its stdin. */
export type TmuxRunner = (args: readonly string[], input?: string) => TmuxResult;

export const runTmux: TmuxRunner = (args, input) => {
  const r = spawnSync('tmux', [...args], {
    encoding: 'utf8',
    timeout: 15_000,
    ...(input !== undefined ? { input } : { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
};

/** The tmux session name of a run: jv-<R> (AGENTS.md: our names are exactly jv-R<6> and jv-coord-<project>). */
export function sessionName(sessionId: string): string {
  return `jv-${sessionId}`;
}

/** Whether a tmux session with exactly this name exists. */
export function hasSession(tmux: TmuxRunner, name: string): boolean {
  return tmux(['has-session', '-t', `=${name}`]).status === 0;
}

/** The pid of the first pane of a session, or undefined. */
export function panePid(tmux: TmuxRunner, name: string): number | undefined {
  const r = tmux(['list-panes', '-t', `=${name}`, '-F', '#{pane_pid}']);
  const pid = Number(r.stdout.trim().split('\n')[0]);
  return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * The -e options of a tmux session jv starts: the caller's PATH (the tmux server may have been started with another
 * one, where an older claude comes first) and JV_HOME (so jv exec opens this home's store). Neither is a secret.
 */
export function tmuxEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...(env.PATH ? ['-e', `PATH=${env.PATH}`] : []), '-e', `JV_HOME=${paths.home}`];
}

/**
 * The command line that runs `command` through `jv exec` (D-007): the bootstrap Node and the installed jv entry.
 * `homeLogin` passes --home-login (the home's own login instead of the tokenFile; never for workers).
 */
export function jvExecArgv(
  selector: { session: string } | { provider: string },
  command: readonly string[],
  options: { homeLogin?: boolean } = {},
): string[] {
  const sel = 'session' in selector ? ['--session', selector.session] : ['--provider', selector.provider];
  return [
    bootstrapNode(),
    '--disable-warning=ExperimentalWarning',
    join(paths.runtimeDir, 'bin', 'jv.mjs'),
    'exec',
    ...sel,
    ...(options.homeLogin ? ['--home-login'] : []),
    '--',
    ...command,
  ];
}

/** The full path of a command on PATH (the first executable file), or the name itself when not found. */
export function executableOnPath(name: string, path: string = process.env.PATH ?? ''): string {
  if (name.includes('/')) return name;
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // the next folder
    }
  }
  return name;
}

/**
 * Types text into a tmux pane and presses Enter: send-keys -l for one line; a bracketed paste (load-buffer from
 * stdin, paste-buffer -p) for several, because a newline typed with send-keys would submit the prompt early.
 */
export async function typeText(tmux: TmuxRunner, target: string, text: string, sleep: (ms: number) => Promise<void> = delay): Promise<void> {
  const pane = `=${target}:`;
  if (!text.includes('\n')) {
    tmux(['send-keys', '-t', pane, '-l', text]);
  } else {
    const buffer = `${target}-input`;
    tmux(['load-buffer', '-b', buffer, '-'], text);
    tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]);
  }
  await sleep(400);
  tmux(['send-keys', '-t', pane, 'Enter']);
}

/** Dialogs Claude Code shows before its prompt that have a known answer (ported from Jevellan's owner bridge). */
export const DIALOGS: ReadonlyArray<{ text: RegExp; keys: string[] }> = [
  { text: /Yes, I trust this folder/u, keys: ['Down', 'Enter'] },
  { text: /Yes, I accept/u, keys: ['Down', 'Enter'] },
  { text: /I am using this for local development/u, keys: ['Enter'] },
  { text: /keep browser tools off/iu, keys: ['Enter'] },
  { text: /Do you want to use this API key\?/u, keys: ['Down', 'Enter'] },
];
/** Screens that wait for a person; none is answered blind. */
export const STARTUP_SCREENS: readonly RegExp[] = [
  /Choose the text style[^\n]*/u,
  /Security notes[^\n]*/u,
  /Select login method[^\n]*/u,
  /fullscreen renderer[^\n]*/iu,
  /Press Enter to continue[^\n]*/u,
];
/** The prompt: its input box (a selection marker under a full rule). */
export const PROMPT_READY = /^─{20,}\s*\n❯/mu;

export interface WaitPromptOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Consecutive polls that must show the prompt. */
  steadyPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Answers the known start-up dialogs until the prompt shows, for at most timeoutMs (ported from Jevellan's
 * #answerDialogs): a dialog is answered on its second sighting, once it takes input, and not again for 5 s.
 */
export async function waitForPrompt(tmux: TmuxRunner, target: string, options: WaitPromptOptions = {}): Promise<{ ready: boolean; screen?: string; gone?: boolean }> {
  const sleep = options.sleep ?? delay;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  const steady = options.steadyPolls ?? 3;
  let quiet = 0;
  const answered = new Map<RegExp, number>();
  let seen: RegExp | undefined;
  let screen: string | undefined;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { ready: false };
    await sleep(pollMs);
    const captured = tmux(['capture-pane', '-p', '-t', `=${target}:`]);
    if (captured.status !== 0 && !hasSession(tmux, target)) return { ready: false, gone: true };
    const pane = captured.stdout;
    screen = STARTUP_SCREENS.map((text) => text.exec(pane)?.[0]?.trim()).find(Boolean);
    if (screen) {
      quiet = 0;
      continue;
    }
    const dialog = DIALOGS.find((entry) => entry.text.test(pane) && Date.now() - (answered.get(entry.text) ?? 0) >= 5000);
    if (dialog && seen !== dialog.text) {
      seen = dialog.text;
      quiet = 0;
      continue;
    }
    if (dialog) {
      seen = undefined;
      answered.set(dialog.text, Date.now());
      for (const key of dialog.keys) {
        tmux(['send-keys', '-t', `=${target}:`, key]);
        await sleep(300);
      }
      quiet = 0;
      continue;
    }
    if (DIALOGS.some((entry) => entry.text.test(pane))) {
      quiet = 0;
      continue;
    }
    if (PROMPT_READY.test(pane)) {
      quiet++;
      if (quiet >= steady) return { ready: true };
    } else quiet = 0;
  }
  return { ready: false, ...(screen ? { screen } : {}) };
}

// ---- the provider home's first-run answers ------------------------------------------------------------------

function resolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The folder Claude Code keys trust on: the main checkout of a linked worktree, else the folder itself. */
export function claudeTrustRoot(cwd: string): string {
  try {
    const first = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0')[0];
    if (first?.startsWith('worktree ') && isAbsolute(first.slice(9))) return resolved(first.slice(9));
  } catch {
    // not a git folder
  }
  return resolved(cwd);
}

/**
 * Pre-answers the first-run dialogs of an interactive Claude Code in a provider home, idempotently (ported from
 * Jevellan's prepareClaudeInteractiveHome / prepareAccount): <home>/.claude.json gets hasCompletedOnboarding and
 * fullscreenUpsellSeenCount (theme picker, security notes, renderer offer), and trust for the folder (the main
 * checkout of a linked worktree, where Claude Code keys it, and the folder itself). Every other key is kept; the
 * file is written atomically (mode 600) and only when something changes. A home outside $JV_HOME/homes, or a file
 * that is not a JSON object, is refused and left alone. Shared by claude-tmux, jv attach and the coordinator.
 */
export function prepareClaudeInteractiveHome(home: string, cwd: string): { file: string; changed: boolean } {
  const problem = providerHomeProblem(home);
  if (problem) throw new RunFailure(`cannot prepare the Claude home: ${problem}`);
  const file = join(home, '.claude.json');
  let value: Record<string, unknown> = {};
  if (existsSync(file)) {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 4_000_000) throw new RunFailure(`${file} is not a regular file of a sensible size`);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      value = parsed as Record<string, unknown>;
    } catch {
      throw new RunFailure(`${file} is not a JSON object; it was left as it is`);
    }
  }
  const projects =
    value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects)
      ? { ...(value.projects as Record<string, Record<string, unknown>>) }
      : {};
  let changed = false;
  for (const [k, v] of Object.entries(CLAUDE_FIRST_RUN_SETTLED)) {
    const current = value[k];
    if (k === 'fullscreenUpsellSeenCount' ? !(typeof current === 'number' && current >= (v as number)) : current !== v) {
      value[k] = v;
      changed = true;
    }
  }
  for (const folder of new Set([claudeTrustRoot(cwd), resolved(cwd)])) {
    const entry = projects[folder] && typeof projects[folder] === 'object' ? projects[folder] : {};
    if (entry.hasTrustDialogAccepted !== true) {
      projects[folder] = { ...entry, hasTrustDialogAccepted: true };
      changed = true;
    }
  }
  if (!changed) return { file, changed: false };
  value.projects = projects;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.jv-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return { file, changed: true };
}

// ---- the claude command line --------------------------------------------------------------------------------

export interface ClaudeArgsInput {
  model: string;
  effort: string;
  appendFile: string;
  mcpFile: string;
  tools: ToolPolicy;
  /** Project MCP server names (read-only duties pre-approve them). */
  projectServers: readonly string[];
  /** A new conversation: --session-id; a continued one: --resume. */
  sessionId?: string;
  resume?: string;
}

/** The arguments of `claude` for a claude-tmux window. */
export function claudeArgs(i: ClaudeArgsInput): string[] {
  const effort = (EFFORT_LEVELS as readonly string[]).includes(i.effort) ? ['--effort', i.effort] : [];
  const writes = i.tools.writeFiles?.length ? ['Write'] : [];
  const permission =
    i.tools.mode === 'write'
      ? ['--permission-mode', 'bypassPermissions']
      : [
          '--permission-mode',
          'dontAsk',
          '--tools',
          ...READ_ONLY_TOOLS,
          ...writes,
          '--allowedTools',
          REPORT_TOOL_QUALIFIED,
          'WebSearch',
          'WebFetch',
          ...writes,
          ...i.projectServers.map((name) => `mcp__${name}`),
        ];
  const conversation = i.sessionId ? ['--session-id', i.sessionId] : i.resume ? ['--resume', i.resume] : [];
  return [
    '--model',
    i.model,
    ...effort,
    '--append-system-prompt-file',
    i.appendFile,
    ...permission,
    ...conversation,
    '--mcp-config',
    i.mcpFile,
    '--strict-mcp-config',
    '--settings',
    JSON.stringify(CLAUDE_TMUX_SETTINGS),
    ...CLAUDE_SETTING_SOURCES,
  ];
}

/** The --mcp-config document: the report server of this row plus the project's servers. Holds no secret of jv's. */
export function mcpConfig(input: Pick<TurnInput, 'mcp'>): { mcpServers: Record<string, McpServerSpec> } {
  const servers = Object.fromEntries(Object.entries(input.mcp.servers).filter(([name]) => name !== REPORT_SERVER_NAME));
  return { mcpServers: { ...servers, [REPORT_SERVER_NAME]: input.mcp.report } };
}

// ---- the runtime --------------------------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ClaudeTmuxDeps {
  openStore?: () => Store;
  tmux?: TmuxRunner;
  sleep?: (ms: number) => Promise<void>;
  redactor?: Redactor;
  /** The claude executable (default: `claude` resolved on PATH). */
  claude?: string;
  /** Transcript poll interval (default 1000 ms). */
  pollMs?: number;
  /** How long the TUI may take to show its prompt (default 90 s). */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  /** Quiet time after the turn's last record before it counts as ended (default 1500 ms). */
  quietMs?: number;
  /** How long an ended turn without a report waits (Stop hook blocks, the MCP write) before jv asks once (default 8 s). */
  noReportGraceMs?: number;
  /** A reported turn whose end is never seen finishes after this much transcript silence (default 30 s). */
  reportQuietMs?: number;
  /** The typed prompt must reach the transcript within this time (default 120 s). */
  transcriptTimeoutMs?: number;
  /** Enter is pressed again once when the prompt has not reached the transcript after this (default 15 s). */
  resubmitMs?: number;
}

interface Window {
  target: string;
  /** Provider home (the session's HOME). */
  home: string;
  /** The transcript file (expected path until it exists). */
  transcript: string;
  /** Byte offset where this turn's records start. */
  offset: number;
}

function homeOf(input: TurnInput, session: SessionRow): string {
  const home = input.env.HOME;
  if (!home) throw new RunFailure(`session ${session.id} has no provider HOME in its environment`);
  return home;
}

export function createClaudeTmuxRuntime(deps: ClaudeTmuxDeps = {}): RuntimeModule {
  const open = deps.openStore ?? (() => openStore());
  const tmux = deps.tmux ?? runTmux;
  const sleep = deps.sleep ?? delay;
  const pollMs = deps.pollMs ?? 1000;

  function sessionFiles(store: Store, session: SessionRow): { appendFile: string; mcpFile: string } {
    const project = store.getProject(session.project_id);
    if (!project || !session.task_id) throw new RunFailure(`session ${session.id} has no project and task to keep its files under`);
    const dir = paths.taskDir(project.name, session.task_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { appendFile: join(dir, `${session.id}.append.md`), mcpFile: join(dir, `${session.id}.mcp.json`) };
  }

  /** Starts a window for this row (a new conversation, or --resume of `resume`) and waits for its prompt. */
  async function launch(store: Store, session: SessionRow, input: TurnInput, conversation: { sessionId?: string; resume?: string }): Promise<Window> {
    const home = homeOf(input, session);
    const target = sessionName(session.id);
    if (hasSession(tmux, target)) throw new RunFailure(`a tmux session ${target} already exists`);
    const { appendFile, mcpFile } = sessionFiles(store, session);
    writeFileSync(appendFile, input.systemAppend, { mode: 0o600 });
    writeFileSync(mcpFile, `${JSON.stringify(mcpConfig(input), null, 2)}\n`, { mode: 0o600 });
    prepareClaudeInteractiveHome(home, session.cwd);
    const claude = deps.claude ?? executableOnPath('claude');
    const args = claudeArgs({
      model: session.model,
      effort: session.effort,
      appendFile,
      mcpFile,
      tools: input.tools,
      projectServers: Object.keys(input.mcp.servers).filter((n) => n !== REPORT_SERVER_NAME),
      ...conversation,
    });
    const started = tmux([
      'new-session',
      '-d',
      '-s',
      target,
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      session.cwd,
      ...tmuxEnvArgs(),
      ...jvExecArgv({ session: session.id }, [claude, ...args]),
    ]);
    if (started.status !== 0) throw new RunFailure(`tmux could not start ${target}: ${started.stderr.trim().split('\n')[0] ?? ''}`);
    const pid = panePid(tmux, target);
    store.updateSession(session.id, {
      tmux_target: target,
      ...(pid !== undefined ? { pid, pgid: processGroup(pid) ?? pid } : {}),
    });
    const native = conversation.sessionId ?? conversation.resume!;
    const ready = await waitForPrompt(tmux, target, {
      ...(deps.readyTimeoutMs !== undefined ? { timeoutMs: deps.readyTimeoutMs } : {}),
      ...(deps.readyPollMs !== undefined ? { pollMs: deps.readyPollMs } : {}),
      sleep,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) {
      tmux(['kill-session', '-t', `=${target}`]);
      throw new RunStopped();
    }
    if (!ready.ready) {
      tmux(['kill-session', '-t', `=${target}`]);
      throw new RunFailure(
        ready.gone
          ? `the tmux session ${target} ended before Claude Code showed its prompt`
          : `Claude Code did not show its prompt in ${target}${ready.screen ? ` (held at "${ready.screen}")` : ''}`,
      );
    }
    const transcript = findClaudeTranscript(home, session.cwd, native) ?? claudeTranscriptPath(home, session.cwd, native);
    return { target, home, transcript, offset: fileSize(transcript) };
  }

  /** Watches one turn in a window until it ended with its report (or a synthesized one). */
  async function watch(store: Store, session: SessionRow, window: Window, prompt: string, input: TurnInput): Promise<void> {
    const redactor = deps.redactor ?? defaultRedactor();
    const emit = (kind: Parameters<typeof recordEvent>[2], payload: unknown) => recordEvent(store, session.id, kind, payload, { redactor });
    const quietMs = deps.quietMs ?? 1500;
    const graceMs = deps.noReportGraceMs ?? 8000;
    const reportQuietMs = deps.reportQuietMs ?? 30_000;
    const transcriptTimeoutMs = deps.transcriptTimeoutMs ?? 120_000;
    const resubmitMs = deps.resubmitMs ?? 15_000;
    const native = store.requireSession(session.id).native_session_id!;
    const tracker = new TurnTracker('claude');
    const usage = new UsageCollector();
    let file = window.transcript;
    let offset = window.offset;
    let typedAt = Date.now();
    let lastGrowth = typedAt;
    let resubmitted = false;
    let nudged = false;
    let endedSince: number | undefined;

    const finishUsage = () => {
      const u = usage.total();
      if (u.calls > 0) {
        emit('usage', {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          apiCalls: u.calls,
          source: 'transcript',
        });
      }
    };

    await typeText(tmux, window.target, prompt, sleep);
    typedAt = Date.now();
    lastGrowth = typedAt;
    for (;;) {
      if (input.signal?.aborted) {
        tmux(['kill-session', '-t', `=${window.target}`]);
        throw new RunStopped();
      }
      const row = store.getSession(session.id);
      if (!row || row.state === 'stopped') throw new RunStopped(row?.state_reason || 'stopped');

      if (!existsSync(file)) file = findClaudeTranscript(window.home, session.cwd, native) ?? file;
      const chunk = readComplete(file, offset);
      const now = Date.now();
      if (chunk.text !== '') {
        const records = nativeRecords(chunk.text, chunk.start);
        offset = chunk.next;
        lastGrowth = now;
        tracker.feed(records, now);
        usage.feed(records);
        for (const e of transcriptEvents(turnsFromRecords(records, 'claude'))) emit(e.kind, e.payload);
      } else offset = chunk.next;

      const report = store.getReportBySession(session.id);
      const alive = hasSession(tmux, window.target);
      if (!alive) {
        if (report) break;
        throw new RunFailure(`the tmux session ${window.target} closed before the turn ended`);
      }
      if (!tracker.sawUser) {
        if (!resubmitted && now - typedAt > resubmitMs) {
          tmux(['send-keys', '-t', `=${window.target}:`, 'Enter']);
          resubmitted = true;
        }
        if (now - typedAt > transcriptTimeoutMs) throw new RunFailure(`the prompt never reached the transcript ${file}`);
      }
      const ended = tracker.sawUser && tracker.ended(now) && now - lastGrowth >= quietMs;
      if (report && (ended || now - lastGrowth >= reportQuietMs)) break;
      if (ended && !report) {
        endedSince ??= now;
        if (now - endedSince >= graceMs) {
          if (!nudged) {
            nudged = true;
            endedSince = undefined;
            emit('message', { from: 'jv', text: NO_REPORT_PROMPT });
            await typeText(tmux, window.target, NO_REPORT_PROMPT, sleep);
            tracker.reset(Date.now());
            lastGrowth = Date.now();
          } else {
            synthesizeReport(store, session.id, { status: 'blocked', summary: NO_REPORT_SUMMARY, limitations: NO_REPORT_LIMITATIONS }, { redactor });
            break;
          }
        }
      } else endedSince = undefined;
      await sleep(pollMs);
    }
    finishUsage();
  }

  /** The newest live window among the rows of a conversation. */
  function liveWindow(store: Store, session: SessionRow): string | undefined {
    const rows = session.native_session_id ? store.listSessions({ native_session_id: session.native_session_id }) : [session];
    for (const r of [...rows].reverse()) if (r.tmux_target && hasSession(tmux, r.tmux_target)) return r.tmux_target;
    return undefined;
  }

  return {
    async start(session: SessionRow, input: StartInput) {
      const store = open();
      try {
        const { prompt, ...turn } = input;
        if (input.signal?.aborted) throw new RunStopped();
        const uuid = session.native_session_id ?? randomUUID();
        if (!session.native_session_id) store.updateSession(session.id, { native_session_id: uuid });
        let window: Window;
        try {
          window = await launch(store, store.requireSession(session.id), turn, { sessionId: uuid });
        } catch (error) {
          // Claude never created this conversation: a later resume must start afresh, not --resume an unknown id.
          if (!session.native_session_id) store.updateSession(session.id, { native_session_id: null });
          throw error;
        }
        await watch(store, store.requireSession(session.id), window, prompt, turn);
        const row = store.requireSession(session.id);
        return { nativeSessionId: uuid, pid: row.pid ?? process.pid, pgid: row.pgid ?? row.pid ?? process.pid, tmuxTarget: window.target };
      } finally {
        if (!deps.openStore) store.close();
      }
    },

    async resume(session: SessionRow, message: string, input?: TurnInput) {
      if (!session.native_session_id) throw new RunFailure(`session ${session.id} has no native session to resume`);
      const turn = input ?? (await (await import('../run.js')).prepareRun(session.id)).turn;
      const store = open();
      try {
        const live = liveWindow(store, session);
        let window: Window;
        if (live) {
          store.updateSession(session.id, { tmux_target: live });
          const home = homeOf(turn, session);
          const transcript = findClaudeTranscript(home, session.cwd, session.native_session_id) ?? claudeTranscriptPath(home, session.cwd, session.native_session_id);
          window = { target: live, home, transcript, offset: fileSize(transcript) };
        } else {
          window = await launch(store, session, turn, { resume: session.native_session_id });
        }
        await watch(store, store.requireSession(session.id), window, message, turn);
      } finally {
        if (!deps.openStore) store.close();
      }
    },

    async stop(session: SessionRow, reason: string) {
      const store = open();
      try {
        const row = store.getSession(session.id) ?? session;
        if (row.tmux_target && hasSession(tmux, row.tmux_target)) tmux(['kill-session', '-t', `=${row.tmux_target}`]);
        await stopRun(store, session.id, reason);
      } finally {
        if (!deps.openStore) store.close();
      }
    },

    async *tail(session: SessionRow, sinceSeq: number) {
      const store = open();
      try {
        yield* tailEvents(store, session.id, sinceSeq, { follow: true });
      } finally {
        if (!deps.openStore) store.close();
      }
    },
  };
}

/**
 * Types a message into the live window of a claude-tmux conversation (D-006: owner and coordinator messages for a
 * claude-tmux task are typed at once). Returns the target typed into, or undefined when no window of the
 * conversation is alive.
 */
export async function typeIntoConversation(store: Store, sessionId: string, text: string, tmux: TmuxRunner = runTmux): Promise<string | undefined> {
  const session = store.requireSession(sessionId);
  const rows = session.native_session_id ? store.listSessions({ native_session_id: session.native_session_id }) : [session];
  for (const r of [...rows].reverse()) {
    if (r.tmux_target && hasSession(tmux, r.tmux_target)) {
      await typeText(tmux, r.tmux_target, text);
      return r.tmux_target;
    }
  }
  return undefined;
}

/** The tmux name of a worker window (sessionName): only these are ever closed by closeFinishedWindows. */
const WORKER_WINDOW = /^jv-R[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * Closes the windows of claude-tmux conversations that are over: the task's step rows (or one step's) with a tmux
 * target, grouped by step, where no row of the step is queued, starting or running. A finished step, or a task that
 * ended, leaves no interactive claude behind; a later `jv task resume` starts the window again with --resume. Returns
 * the targets it closed. Rows of other runtimes are never looked at, so tmux is not called for them.
 */
export function closeFinishedWindows(store: Store, scope: { taskId: string; stepId?: string }, tmux: TmuxRunner = runTmux): string[] {
  const rows = store
    .listSessions({ task_id: scope.taskId, kind: 'step', ...(scope.stepId ? { step_id: scope.stepId } : {}) })
    .filter((r) => r.step_id !== null);
  const byStep = new Map<string, SessionRow[]>();
  for (const r of rows) byStep.set(r.step_id!, [...(byStep.get(r.step_id!) ?? []), r]);
  const closed: string[] = [];
  for (const group of byStep.values()) {
    if (group.some((r) => ['queued', 'starting', 'running'].includes(r.state))) continue;
    for (const r of group) {
      if (r.runtime !== 'claude-tmux' || !r.tmux_target || !WORKER_WINDOW.test(r.tmux_target) || closed.includes(r.tmux_target)) continue;
      if (!hasSession(tmux, r.tmux_target)) continue;
      tmux(['kill-session', '-t', `=${r.tmux_target}`]);
      closed.push(r.tmux_target);
    }
  }
  return closed;
}

const runtime = createClaudeTmuxRuntime();
export const start = runtime.start;
export const resume = runtime.resume;
export const stop = runtime.stop;
export const tail = runtime.tail;
