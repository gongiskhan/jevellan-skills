// The coordinator (section 9.1): one interactive Claude Code session per project, in the tmux session
// jv-coord-<project>, started, stopped and inspected by `jv coordinator start|stop|restart|status --project N`.
//
// Start:
// 1. Refuses when a tmux session of that name exists and is not ours (ours: meta `coordinator:<project id>` names a
//    session row that is starting or running, and the pane's process is `jv exec --session <that row>`). Ours and
//    alive: start is a no-op that reports the status. Ours in the store but gone from tmux: the row becomes lost.
// 2. Checks providers.json lists the coordinator's model and effort under its provider (claude-main, Opus, high:
//    section 9.1) and that `claude` and the installed `jv` exist.
// 3. Pre-accepts the first-run dialogs in the provider home, found on dev-madrid (docs/findings.md): the folder trust
//    dialog (<home>/.claude.json projects["<checkout>"].hasTrustDialogAccepted) and the bypass-permissions warning
//    (<home>/.claude/settings.json skipDangerousModePermissionPrompt), plus hasCompletedOnboarding. Idempotent,
//    every other key kept, written before claude starts.
// 4. Writes ~/.jv/projects/<name>/coordinator-prompt.md: the jevellan-coordinator skill body with {{project}},
//    {{path}}, {{default_branch}} and {{jv}} filled (the body carries the project block), then the handoff (9.5).
// 5. Creates the sessions row (kind coordinator, runtime claude-tmux, native_session_id = the uuid passed to
//    --session-id) and starts, in tmux:
//      <jv> exec --session <R> --project <name> -- <claude> [--remote-control jv-coord-<name>] --model <model>
//        --effort <effort> --append-system-prompt-file <prompt> --permission-mode bypassPermissions --session-id <uuid>
//    so HOME, the token and JV_SESSION/JV_PROJECT reach claude through jv exec's environment, never argv (D-007).
//    --remote-control is passed only when the provider's login can use it: Claude Code refuses Remote Control for
//    a long-lived token (tokenFile, D-003), and `jv coordinator status` then says so with the exact refusal.
// 6. Records the tmux target on the row and in meta, and waits (up to 60 s) for the input prompt.
//
// Stop types /exit, waits up to 30 s for the session to end, then kills the tmux session (only ours). Restart is
// stop, start, then the handoff typed as the first message, prefixed "Handoff from your previous session:" (pasted
// through a tmux buffer, then Enter).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { notFound, refused } from './errors.js';
import { buildHandoff, formatHandoff } from './handoff.js';
import { isAlive } from './launcher.js';
import { paths } from './paths.js';
import { fillPlaceholders, splitFrontmatter } from './prompt.js';
import { findProvider, loadProviders, type Provider, type ProvidersConfig } from './providers.js';
import { redact } from './redact.js';
import type { Store } from './store.js';
import type { ProjectRow, SessionRow } from './types.js';

export const COORDINATOR_PROVIDER = 'claude-main';
export const COORDINATOR_MODEL = 'claude-opus-5-5';
export const COORDINATOR_EFFORT = 'high';
export const COORDINATOR_SKILL = 'jevellan-coordinator';
export const COORDINATOR_META_PREFIX = 'coordinator:';
export const HANDOFF_PREFIX = 'Handoff from your previous session:';
export const READY_TIMEOUT_MS = 60_000;
export const STOP_WAIT_MS = 30_000;
/** What Claude Code 2.1.316 answers /remote-control with when the login is a setup token (dev-madrid, findings). */
export const REMOTE_CONTROL_TOKEN_REFUSAL =
  'Remote Control requires a full-scope login token. Long-lived tokens (from claude setup-token or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons. Run claude auth login to use Remote Control.';

const LIVE_STATES = ['starting', 'running'] as const;

// ---- tmux ---------------------------------------------------------------------------------------------------

export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one tmux command. Injected in tests; nothing else in this module spawns tmux. */
export type TmuxRunner = (args: readonly string[], input?: string) => TmuxResult;

export const realTmux: TmuxRunner = (args, input) => {
  const r = spawnSync('tmux', [...args], { encoding: 'utf8', ...(input !== undefined ? { input } : {}), timeout: 15_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
};

/** The tmux session name of a project's coordinator: jv-coord-<project> (tmux turns "." and ":" into "_"). */
export function coordinatorTmuxName(project: string): string {
  return `jv-coord-${project.replace(/[.:]/g, '_')}`;
}

/** An exact-match target for a session's active pane ("=" stops tmux from matching a name by prefix). */
export function paneTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

export function hasSession(tmux: TmuxRunner, name: string): boolean {
  return tmux(['has-session', '-t', `=${name}`]).code === 0;
}

/** The visible screen of the session's active pane, or undefined when the session is gone. */
export function capturePane(tmux: TmuxRunner, name: string): string | undefined {
  const r = tmux(['capture-pane', '-p', '-t', paneTarget(name)]);
  return r.code === 0 ? r.stdout : undefined;
}

export function panePid(tmux: TmuxRunner, name: string): number | undefined {
  const r = tmux(['display-message', '-p', '-t', paneTarget(name), '#{pane_pid}']);
  const pid = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Types one line literally, then Enter. */
export function typeLine(tmux: TmuxRunner, name: string, line: string): boolean {
  if (tmux(['send-keys', '-t', paneTarget(name), '-l', '--', line]).code !== 0) return false;
  return tmux(['send-keys', '-t', paneTarget(name), 'Enter']).code === 0;
}

/**
 * Types `prefix` literally, pastes `body` through a tmux buffer (bracketed paste, so Claude Code takes it as one
 * pasted block however long it is), then Enter.
 */
export function pasteMessage(tmux: TmuxRunner, name: string, prefix: string, body: string): boolean {
  const buffer = `jv-${process.pid}-${randomUUID().slice(0, 8)}`;
  if (prefix !== '' && tmux(['send-keys', '-t', paneTarget(name), '-l', '--', `${prefix} `]).code !== 0) return false;
  if (tmux(['load-buffer', '-b', buffer, '-'], body).code !== 0) return false;
  if (tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneTarget(name)]).code !== 0) return false;
  return tmux(['send-keys', '-t', paneTarget(name), 'Enter']).code === 0;
}

// ---- the screen ---------------------------------------------------------------------------------------------

export type ScreenState = 'ready' | 'dialog' | 'starting' | 'gone';

const DIALOG_MARKERS = [/trust this folder/i, /Bypass Permissions mode/i, /Enter to confirm/i, /Do you want to/i, /Choose the text style/i];

/** What the coordinator's screen shows: a dialog, the input prompt (ready), or not yet either. */
export function screenState(screen: string | undefined): ScreenState {
  if (screen === undefined) return 'gone';
  if (DIALOG_MARKERS.some((m) => m.test(screen))) return 'dialog';
  if (/bypass permissions on/i.test(screen) && /^\s*[❯>]/m.test(screen)) return 'ready';
  return 'starting';
}

export async function waitForScreen(
  tmux: TmuxRunner,
  name: string,
  options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ state: ScreenState; screen?: string }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? READY_TIMEOUT_MS);
  let last: { state: ScreenState; screen?: string } = { state: 'starting' };
  for (;;) {
    const screen = capturePane(tmux, name);
    last = { state: screenState(screen), ...(screen !== undefined ? { screen } : {}) };
    if (last.state === 'ready' || last.state === 'gone') return last;
    if (Date.now() >= deadline) return last;
    await sleep(500);
  }
}

// ---- registration -------------------------------------------------------------------------------------------

export interface RemoteControlInfo {
  /** Whether --remote-control was passed. */
  requested: boolean;
  /** unavailable: this login cannot use it; requested: flag passed, not confirmed on screen; seen: on screen. */
  state: 'unavailable' | 'requested' | 'seen';
  detail: string;
  /** What the owner runs inside the coordinator (or before) to turn it on. */
  ownerCommand: string;
}

export interface CoordinatorRecord {
  sessionId: string;
  projectId: string;
  projectName: string;
  tmuxSession: string;
  promptFile: string;
  startedAt: string;
  stoppedAt?: string;
  remoteControl: RemoteControlInfo;
}

export function coordinatorMetaKey(projectId: string): string {
  return `${COORDINATOR_META_PREFIX}${projectId}`;
}

export function readCoordinatorRecord(store: Store, projectId: string): CoordinatorRecord | undefined {
  const raw = store.getMeta(coordinatorMetaKey(projectId));
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as CoordinatorRecord;
    return typeof v.sessionId === 'string' && typeof v.tmuxSession === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeCoordinatorRecord(store: Store, record: CoordinatorRecord): void {
  store.setMeta(coordinatorMetaKey(record.projectId), JSON.stringify(record));
}

export interface LiveCoordinator {
  record: CoordinatorRecord;
  session: SessionRow;
}

/**
 * The project's coordinator when it is registered, its row is starting or running, and its tmux session exists;
 * else undefined (nothing to type into).
 */
export function liveCoordinator(store: Store, projectId: string, tmux: TmuxRunner = realTmux): LiveCoordinator | undefined {
  const record = readCoordinatorRecord(store, projectId);
  if (!record || record.stoppedAt) return undefined;
  const session = store.getSession(record.sessionId);
  if (!session || session.kind !== 'coordinator' || !(LIVE_STATES as readonly string[]).includes(session.state)) return undefined;
  if (!hasSession(tmux, record.tmuxSession)) return undefined;
  return { record, session };
}

/** Whether the pane's process is `jv exec --session <sessionId>` (true when /proc cannot tell). */
export function paneIsOurs(tmux: TmuxRunner, name: string, sessionId: string, readCmdline = defaultCmdline): boolean {
  const pid = panePid(tmux, name);
  if (pid === undefined) return false;
  const cmdline = readCmdline(pid);
  if (cmdline === undefined) return isAlive(pid);
  return cmdline.includes(sessionId);
}

function defaultCmdline(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return undefined;
  }
}

// ---- the prompt ---------------------------------------------------------------------------------------------

export interface PromptInput {
  project: Pick<ProjectRow, 'name' | 'path' | 'default_branch'>;
  /** The jv the coordinator runs (default: the installed shim, ~/.jv/bin/jv). */
  jv?: string;
  handoff: string;
  /** Folder of the installed skills (default ~/.jv/skills). */
  skillsDir?: string;
}

/** The coordinator skill body with its placeholders filled, then the handoff. */
export function coordinatorPromptText(input: PromptInput): string {
  const file = join(input.skillsDir ?? paths.skillsDir, COORDINATOR_SKILL, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw notFound(`no coordinator skill at ${file}; run jv update`);
  }
  const body = fillPlaceholders(splitFrontmatter(text).body.trim(), {
    project: input.project.name,
    path: input.project.path,
    default_branch: input.project.default_branch,
    jv: input.jv ?? paths.shim,
  });
  return `${body}\n\n# ${HANDOFF_PREFIX.replace(/:$/, '')}\n\n${input.handoff.trim()}\n`;
}

function writeFileAtomic(file: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

// ---- first-run dialogs ----------------------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reads a JSON object file: {} when missing; refuses (exit 2) when it is not a JSON object. */
function readJsonObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (isPlainObject(v)) return v;
  } catch {
    // fall through
  }
  throw refused(`${file} is not a JSON object; fix or move it before starting the coordinator`);
}

export interface PreacceptResult {
  claudeJson: 'set' | 'already';
  settings: 'set' | 'already';
}

/**
 * Pre-accepts what Claude Code asks on the first interactive start under `home` in `folders` (dev-madrid,
 * Claude Code 2.1.316): the folder trust dialog, the bypass-permissions warning, the onboarding. Writes only what is
 * missing and keeps every other key.
 */
export function preacceptDialogs(home: string, folders: readonly string[]): PreacceptResult {
  const claudeJsonFile = join(home, '.claude.json');
  const config = readJsonObject(claudeJsonFile);
  let changed = false;
  if (config.hasCompletedOnboarding !== true) {
    config.hasCompletedOnboarding = true;
    changed = true;
  }
  const projects = isPlainObject(config.projects) ? config.projects : {};
  for (const folder of new Set(folders)) {
    const entry = isPlainObject(projects[folder]) ? projects[folder] : {};
    if (entry.hasTrustDialogAccepted !== true) {
      projects[folder] = { ...entry, hasTrustDialogAccepted: true };
      changed = true;
    }
  }
  config.projects = projects;
  if (changed) writeFileAtomic(claudeJsonFile, `${JSON.stringify(config, null, 2)}\n`);

  const settingsFile = join(home, '.claude', 'settings.json');
  const settings = readJsonObject(settingsFile);
  let settingsChanged = false;
  if (settings.skipDangerousModePermissionPrompt !== true) {
    settings.skipDangerousModePermissionPrompt = true;
    settingsChanged = true;
    writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { claudeJson: changed ? 'set' : 'already', settings: settingsChanged ? 'set' : 'already' };
}

// ---- remote control -------------------------------------------------------------------------------------------

/** Whether this provider's login can use Remote Control, and what the owner does when it cannot. */
export function remoteControlPlan(provider: Provider): RemoteControlInfo {
  if (provider.kind === 'claude-subscription' && provider.tokenFile !== undefined) {
    return {
      requested: false,
      state: 'unavailable',
      detail:
        `${provider.name} signs in with a long-lived token (tokenFile in providers.json), and Claude Code refuses Remote ` +
        `Control for such a token: "${REMOTE_CONTROL_TOKEN_REFUSAL}" The coordinator runs without it.`,
      ownerCommand:
        `Remote Control needs ${provider.name} to run on a full claude.ai login (jv providers login ${provider.name}) ` +
        `instead of its tokenFile, which is the owner's choice (D-003, D-023); after that, jv coordinator restart, and ` +
        `type /remote-control inside the coordinator if it is not on.`,
    };
  }
  if (provider.kind !== 'claude-subscription') {
    return {
      requested: false,
      state: 'unavailable',
      detail: `${provider.name} is a ${provider.kind} provider; Remote Control needs a claude.ai subscription login.`,
      ownerCommand: 'Run the coordinator on a claude-subscription provider with a full claude.ai login.',
    };
  }
  return {
    requested: true,
    state: 'requested',
    detail: 'Started with --remote-control; the coordinator screen has not shown it yet.',
    ownerCommand: 'If it is not on, type /remote-control inside the coordinator (jv coordinator status prints the attach command).',
  };
}

// ---- start, stop, restart, status ----------------------------------------------------------------------------

export interface CoordinatorDeps {
  tmux?: TmuxRunner;
  providers?: ProvidersConfig;
  /** The jv command the tmux pane runs (default: the installed shim). */
  jvCommand?: string;
  /** The claude binary (default: found on PATH). */
  claudePath?: string;
  skillsDir?: string;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  stopWaitMs?: number;
  /** PATH and LANG for the pane (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Reads a process command line (tests). */
  readCmdline?: (pid: number) => string[] | undefined;
  /** Skip the pre-accept writes (tests that check them separately). */
  skipPreaccept?: boolean;
}

export interface CoordinatorStatus {
  project: string;
  tmuxSession: string;
  running: boolean;
  /** ready, dialog (a first-run dialog is waiting for a key), starting, gone. */
  screen: ScreenState;
  sessionId?: string;
  nativeSessionId?: string;
  sessionState?: string;
  sessionReason?: string;
  provider: string;
  model: string;
  effort: string;
  startedAt?: string;
  promptFile: string;
  attach: string;
  remoteControl?: RemoteControlInfo;
  /** A tmux session of our name that is not a jv coordinator. */
  foreign?: boolean;
}

/** Finds an executable on PATH. */
export function findOnPath(name: string, pathVar: string | undefined = process.env.PATH): string | undefined {
  const executable = (file: string): boolean => {
    try {
      accessSync(file, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(name)) return executable(name) ? name : undefined;
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function coordinatorProvider(providers: ProvidersConfig): Provider {
  const provider = findProvider(providers, COORDINATOR_PROVIDER);
  if (!provider) throw refused(`the coordinator runs on ${COORDINATOR_PROVIDER}, which ${providers.file} does not list`);
  if (!provider.enabled) throw refused(`the coordinator runs on ${COORDINATOR_PROVIDER}, which is disabled in ${providers.file}`);
  const model = provider.models.find((m) => m.id === COORDINATOR_MODEL);
  if (!model) throw refused(`the coordinator runs on ${COORDINATOR_MODEL}, which ${COORDINATOR_PROVIDER} does not list in ${providers.file}`);
  if (!model.efforts.includes(COORDINATOR_EFFORT)) {
    throw refused(`${COORDINATOR_MODEL} on ${COORDINATOR_PROVIDER} does not list effort ${COORDINATOR_EFFORT} in ${providers.file}`);
  }
  if (provider.home === undefined) throw refused(`${COORDINATOR_PROVIDER} has no home in ${providers.file}`);
  return provider;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The status of a project's coordinator. Marks a registered row lost when its tmux session is gone. */
export function coordinatorStatus(store: Store, projectName: string, deps: CoordinatorDeps = {}): CoordinatorStatus {
  const tmux = deps.tmux ?? realTmux;
  const project = store.requireProject(projectName);
  const name = coordinatorTmuxName(project.name);
  const record = readCoordinatorRecord(store, project.id);
  let session = record ? store.getSession(record.sessionId) : undefined;
  const alive = hasSession(tmux, name);
  const live = !!record && !record.stoppedAt && !!session && (LIVE_STATES as readonly string[]).includes(session.state);
  if (live && !alive) session = store.setSessionState(session!.id, 'lost', `tmux session ${name} is gone`);
  const ours = live && alive && paneIsOurs(tmux, name, session!.id, deps.readCmdline);
  const screen = alive ? screenState(capturePane(tmux, name)) : 'gone';
  let remoteControl = record?.remoteControl;
  if (ours && remoteControl?.state === 'requested' && /remote control/i.test(capturePane(tmux, name) ?? '')) {
    remoteControl = { ...remoteControl, state: 'seen', detail: 'Remote Control is shown on the coordinator screen.' };
  }
  return {
    project: project.name,
    tmuxSession: name,
    running: ours,
    screen,
    ...(session
      ? {
          sessionId: session.id,
          sessionState: session.state,
          sessionReason: session.state_reason,
          ...(session.native_session_id ? { nativeSessionId: session.native_session_id } : {}),
        }
      : {}),
    provider: session?.provider ?? COORDINATOR_PROVIDER,
    model: session?.model ?? COORDINATOR_MODEL,
    effort: session?.effort ?? COORDINATOR_EFFORT,
    ...(record ? { startedAt: record.startedAt } : {}),
    promptFile: paths.coordinatorPrompt(project.name),
    attach: `tmux attach -t '=${name}'`,
    ...(remoteControl ? { remoteControl } : {}),
    ...(alive && !ours ? { foreign: true } : {}),
  };
}

export interface StartResult extends CoordinatorStatus {
  started: boolean;
  preaccept?: PreacceptResult;
}

/** Starts the project's coordinator (a no-op when ours is already running). */
export async function startCoordinator(store: Store, projectName: string, deps: CoordinatorDeps = {}): Promise<StartResult> {
  const tmux = deps.tmux ?? realTmux;
  const env = deps.env ?? process.env;
  const project = store.requireProject(projectName);
  const name = coordinatorTmuxName(project.name);

  const before = coordinatorStatus(store, project.name, deps);
  if (before.running) return { ...before, started: false };
  if (before.foreign) {
    throw refused(`a tmux session named ${name} exists and is not this project's jv coordinator; it is left alone`);
  }

  const providers = deps.providers ?? loadProviders();
  const provider = coordinatorProvider(providers);
  const claude = deps.claudePath ?? findOnPath('claude', env.PATH);
  if (!claude) throw refused('claude is not on PATH; install Claude Code first');
  const jv = deps.jvCommand ?? paths.shim;
  if (!deps.jvCommand && findOnPath(jv) === undefined) throw refused(`jv is not installed at ${jv}; run jv bootstrap`);

  const preaccept = deps.skipPreaccept
    ? undefined
    : preacceptDialogs(provider.home!, [...new Set([project.path, realpathOr(project.path)])]);

  const handoff = redact(formatHandoff(buildHandoff(store, project.id)));
  const promptFile = paths.coordinatorPrompt(project.name);
  writeFileAtomic(
    promptFile,
    coordinatorPromptText({ project, handoff, ...(deps.skillsDir ? { skillsDir: deps.skillsDir } : {}) }),
  );

  const uuid = randomUUID();
  const session = store.createSession({
    request_id: `coordinator:${project.id}:${uuid}`,
    project_id: project.id,
    kind: 'coordinator',
    runtime: 'claude-tmux',
    provider: provider.name,
    model: COORDINATOR_MODEL,
    effort: COORDINATOR_EFFORT,
    cwd: project.path,
    native_session_id: uuid,
    state: 'starting',
    state_reason: `starting the coordinator in tmux ${name}`,
  }).row;

  const remoteControl = remoteControlPlan(provider);
  const claudeArgs = [
    ...(remoteControl.requested ? ['--remote-control', name] : []),
    '--model',
    COORDINATOR_MODEL,
    '--effort',
    COORDINATOR_EFFORT,
    '--append-system-prompt-file',
    promptFile,
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    uuid,
  ];
  const paneEnv = [
    ...(env.PATH ? ['-e', `PATH=${env.PATH}`] : []),
    ...(env.LANG ? ['-e', `LANG=${env.LANG}`] : []),
    '-e',
    `JV_HOME=${paths.home}`,
  ];
  const created = tmux([
    'new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', project.path, ...paneEnv,
    '-P', '-F', '#{pane_pid}',
    jv, 'exec', '--session', session.id, '--project', project.name, '--', claude, ...claudeArgs,
  ]);
  if (created.code !== 0) {
    store.setSessionState(session.id, 'failed', `tmux new-session failed: ${created.stderr.trim() || `exit ${created.code}`}`);
    throw refused(`could not start the coordinator in tmux ${name}: ${created.stderr.trim() || `exit ${created.code}`}`);
  }
  const pid = Number(created.stdout.trim());
  store.updateSession(session.id, {
    tmux_target: paneTarget(name),
    ...(Number.isInteger(pid) && pid > 0 ? { pid, pgid: pid } : {}),
  });
  const record: CoordinatorRecord = {
    sessionId: session.id,
    projectId: project.id,
    projectName: project.name,
    tmuxSession: name,
    promptFile,
    startedAt: new Date().toISOString(),
    remoteControl,
  };
  writeCoordinatorRecord(store, record);
  store.setSessionState(session.id, 'running', `coordinator in tmux ${name}`);

  const waited = await waitForScreen(tmux, name, {
    ...(deps.readyTimeoutMs !== undefined ? { timeoutMs: deps.readyTimeoutMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (waited.state === 'gone') {
    store.setSessionState(session.id, 'failed', `the coordinator exited at start (tmux ${name} is gone)`);
    throw refused(
      `the coordinator exited right after it started. Run it by hand to see why: ${jv} exec --session ${session.id} -- ${claude} ${claudeArgs.join(' ')}`,
    );
  }
  if (waited.state === 'ready' && remoteControl.requested && /remote control/i.test(waited.screen ?? '')) {
    writeCoordinatorRecord(store, { ...record, remoteControl: { ...remoteControl, state: 'seen', detail: 'Remote Control is shown on the coordinator screen.' } });
  }
  const status = coordinatorStatus(store, project.name, deps);
  return { ...status, started: true, ...(preaccept ? { preaccept } : {}) };
}

export interface StopResult {
  project: string;
  tmuxSession: string;
  stopped: boolean;
  /** The session did not end within the wait after /exit and was killed. */
  killed: boolean;
  sessionId?: string;
  reason: string;
}

/** Stops the project's coordinator: /exit, then kill-session after the wait (30 s). Only ours is touched. */
export async function stopCoordinator(store: Store, projectName: string, deps: CoordinatorDeps = {}): Promise<StopResult> {
  const tmux = deps.tmux ?? realTmux;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const project = store.requireProject(projectName);
  const name = coordinatorTmuxName(project.name);
  const status = coordinatorStatus(store, project.name, deps);
  const record = readCoordinatorRecord(store, project.id);
  if (!status.running) {
    if (status.foreign) throw refused(`the tmux session ${name} is not this project's jv coordinator; it is left alone`);
    if (record && !record.stoppedAt) writeCoordinatorRecord(store, { ...record, stoppedAt: new Date().toISOString() });
    return {
      project: project.name,
      tmuxSession: name,
      stopped: false,
      killed: false,
      ...(status.sessionId ? { sessionId: status.sessionId } : {}),
      reason: 'the coordinator is not running',
    };
  }
  const sessionId = status.sessionId!;
  typeLine(tmux, name, '/exit');
  const deadline = Date.now() + (deps.stopWaitMs ?? STOP_WAIT_MS);
  while (Date.now() < deadline && hasSession(tmux, name)) await sleep(500);
  let killed = false;
  if (hasSession(tmux, name) && paneIsOurs(tmux, name, sessionId, deps.readCmdline)) {
    tmux(['kill-session', '-t', `=${name}`]);
    killed = true;
  }
  const reason = killed ? 'stopped: /exit did not end it within 30 s, tmux session killed' : 'stopped with /exit';
  store.setSessionState(sessionId, 'stopped', reason);
  writeCoordinatorRecord(store, { ...record!, stoppedAt: new Date().toISOString() });
  return { project: project.name, tmuxSession: name, stopped: true, killed, sessionId, reason };
}

export interface RestartResult extends StartResult {
  stop: StopResult;
  /** Whether the handoff was typed into the new session. */
  handoffTyped: boolean;
  handoffReason?: string;
}

/** Stop, start, then the handoff typed as the first message. */
export async function restartCoordinator(store: Store, projectName: string, deps: CoordinatorDeps = {}): Promise<RestartResult> {
  const tmux = deps.tmux ?? realTmux;
  const stop = await stopCoordinator(store, projectName, deps);
  const started = await startCoordinator(store, projectName, deps);
  const project = store.requireProject(projectName);
  const handoff = redact(formatHandoff(buildHandoff(store, project.id)));
  if (started.screen !== 'ready') {
    const why =
      started.screen === 'dialog'
        ? `a dialog is waiting on the coordinator screen; answer it (${started.attach}) and paste the handoff from jv handoff --project ${project.name}`
        : `the coordinator was not ready within ${Math.round((deps.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} s; the handoff is in its prompt`;
    return { ...started, stop, handoffTyped: false, handoffReason: why };
  }
  const typed = pasteMessage(tmux, coordinatorTmuxName(project.name), HANDOFF_PREFIX, `\n\n${handoff}`);
  return { ...started, stop, handoffTyped: typed, ...(typed ? {} : { handoffReason: 'tmux refused the paste' }) };
}

/** The status as text for humans. */
export function formatStatus(s: CoordinatorStatus): string {
  const lines: string[] = [];
  if (s.running) lines.push(`Coordinator of ${s.project}: running in tmux ${s.tmuxSession} (screen: ${s.screen}).`);
  else if (s.foreign) lines.push(`Coordinator of ${s.project}: not running; a tmux session named ${s.tmuxSession} exists and is not a jv coordinator.`);
  else lines.push(`Coordinator of ${s.project}: not running.`);
  if (s.sessionId) lines.push(`Session ${s.sessionId} (${s.sessionState}: ${s.sessionReason}), Claude session ${s.nativeSessionId ?? 'unknown'}.`);
  lines.push(`Provider ${s.provider}, model ${s.model}, effort ${s.effort}.`);
  if (s.startedAt) lines.push(`Started ${s.startedAt}.`);
  lines.push(`Prompt: ${s.promptFile}`);
  if (s.running) lines.push(`Attach: ${s.attach}`);
  if (s.screen === 'dialog') lines.push('A first-run dialog is waiting for a key: attach and answer it.');
  if (s.remoteControl) {
    lines.push(`Remote Control: ${s.remoteControl.state}. ${s.remoteControl.detail}`);
    if (s.remoteControl.state !== 'seen') lines.push(`To turn it on: ${s.remoteControl.ownerCommand}`);
  }
  return lines.join('\n');
}
