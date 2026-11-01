// jv attach S (sections 6.1 to 6.3): the owner takes a session over in tmux.
//
// - claude-tmux: `tmux attach -t jv-<R>`, the live window of the conversation (any of its rows' tmux targets).
// - claude-sdk: `tmux new-session -A -s jv-<R> -c <cwd> <jv exec --session R> -- claude --resume <native id>` with the
//   session's model and effort, after the provider home's first-run answers (prepareClaudeInteractiveHome); the newest
//   run of the conversation is marked `waiting` with reason "attached by owner", and `jv task resume` imports what
//   the owner did in the transcript as events of that run (takeover.ts), then continues it with a new turn.
// - codex: the same with `codex resume <thread id>` (the SDK's Codex binary, codexExecutable).
// - llm: refused; a plain answer has no interactive form.
//
// jv exec builds the provider's environment and reads its key files itself (D-007), so nothing secret is on the
// command line. A turn that is still running (claude-sdk, codex) is refused: two writers on one conversation would
// interleave. When stdin or stdout is not a terminal (the coordinator, a script), the window is created detached and
// the command to attach is printed instead; inside tmux, attaching is `tmux switch-client`.

import { spawnSync } from 'node:child_process';
import { refused } from './errors.js';
import { findProvider, loadProviders, type ProvidersConfig } from './providers.js';
import { EFFORT_LEVELS } from './runtimes/claude-sdk.js';
import {
  CLAUDE_SETTING_SOURCES,
  CLAUDE_TMUX_SETTINGS,
  executableOnPath,
  hasSession,
  jvExecArgv,
  prepareClaudeInteractiveHome,
  runTmux,
  sessionName,
  tmuxEnvArgs,
  type TmuxRunner,
} from './runtimes/claude-tmux.js';
import { codexExecutable, PROJECT_DOC_MAX_BYTES } from './runtimes/codex.js';
import type { Store } from './store.js';
import { ATTACHED_REASON, recordTakeoverStart } from './takeover.js';
import type { SessionRow } from './types.js';

export { ATTACHED_REASON } from './takeover.js';

export interface AttachDeps {
  tmux?: TmuxRunner;
  providers?: () => ProvidersConfig;
  /** Whether stdin and stdout are a terminal (default: both isTTY). */
  tty?: boolean;
  /** Whether this process runs inside tmux (default: $TMUX set). */
  insideTmux?: boolean;
  /** Runs the interactive tmux client with inherited stdio (default spawnSync). Returns its exit code. */
  interactive?: (args: string[]) => number;
  claude?: string;
  codex?: string;
}

export interface AttachResult {
  session: string;
  runtime: SessionRow['runtime'];
  tmuxTarget: string;
  /** The command that attaches (printed when not in a terminal). */
  command: string[];
  /** Whether jv created the tmux session now. */
  created: boolean;
  attached: boolean;
  /** The run marked waiting (claude-sdk, codex). */
  waiting?: string;
}

/** The rows of a session's conversation, oldest first. */
function conversation(store: Store, session: SessionRow): SessionRow[] {
  return session.native_session_id ? store.listSessions({ native_session_id: session.native_session_id }) : [session];
}

function interactiveDefault(args: string[]): number {
  const r = spawnSync('tmux', args, { stdio: 'inherit' });
  return r.status ?? 1;
}

/** Prepares (and, in a terminal, opens) the owner's tmux view of a session. */
export function attachSession(store: Store, sessionId: string, deps: AttachDeps = {}): AttachResult {
  const tmux = deps.tmux ?? runTmux;
  const session = store.requireSession(sessionId);
  const rows = conversation(store, session);
  const newest = rows[rows.length - 1] ?? session;
  let target: string;
  let created = false;
  let waiting: string | undefined;

  if (session.runtime === 'llm') throw refused(`session ${session.id} runs on llm: a plain answer has no interactive session to attach to`);
  if (session.runtime === 'claude-tmux') {
    const live = [...rows].reverse().find((r) => r.tmux_target && hasSession(tmux, r.tmux_target));
    if (!live?.tmux_target) {
      throw refused(`the tmux window of ${session.id} is gone${session.task_id ? `; jv task resume ${session.task_id} starts it again` : ''}`);
    }
    target = live.tmux_target;
  } else {
    if (!session.native_session_id) throw refused(`session ${session.id} has no native session yet (state ${session.state}); nothing to attach to`);
    const busy = rows.find((r) => r.state === 'starting' || r.state === 'running');
    if (busy) throw refused(`run ${busy.id} of this conversation is still ${busy.state}; wait for its report, or jv task stop ${busy.task_id ?? busy.id} first`);
    const config = (deps.providers ?? (() => loadProviders()))();
    const provider = findProvider(config, session.provider);
    if (!provider?.home) throw refused(`no provider ${session.provider} with a home in ${config.file}`);
    target = sessionName(newest.id);
    if (!hasSession(tmux, target)) {
      let command: string[];
      if (session.runtime === 'claude-sdk') {
        prepareClaudeInteractiveHome(provider.home, session.cwd);
        const effort = (EFFORT_LEVELS as readonly string[]).includes(session.effort) ? ['--effort', session.effort] : [];
        command = [
          deps.claude ?? executableOnPath('claude'),
          '--resume',
          session.native_session_id,
          '--model',
          session.model,
          ...effort,
          '--settings',
          JSON.stringify(CLAUDE_TMUX_SETTINGS),
          ...CLAUDE_SETTING_SOURCES,
        ];
      } else {
        command = [
          deps.codex ?? codexExecutable(),
          'resume',
          session.native_session_id,
          '-m',
          session.model,
          '-c',
          `model_reasoning_effort="${session.effort}"`,
          '-c',
          `project_doc_max_bytes=${PROJECT_DOC_MAX_BYTES}`,
        ];
      }
      const r = tmux(['new-session', '-d', '-s', target, '-c', session.cwd, ...tmuxEnvArgs(), ...jvExecArgv({ session: newest.id }, command)]);
      if (r.status !== 0) throw refused(`tmux could not start ${target}: ${r.stderr.trim().split('\n')[0] ?? ''}`);
      created = true;
    }
    // Where the transcript ends now: jv task resume imports what the owner adds after it (takeover.ts).
    if (session.runtime === 'claude-sdk') recordTakeoverStart(store, newest, provider.home);
    store.setSessionState(newest.id, 'waiting', ATTACHED_REASON, { tmux_target: target });
    waiting = newest.id;
  }

  const tty = deps.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const inside = deps.insideTmux ?? (process.env.TMUX !== undefined && process.env.TMUX !== '');
  const command = inside ? ['tmux', 'switch-client', '-t', `=${target}`] : ['tmux', 'attach', '-t', `=${target}`];
  let attached = false;
  if (tty) {
    const code = (deps.interactive ?? interactiveDefault)(command.slice(1));
    attached = code === 0;
  }
  return {
    session: session.id,
    runtime: session.runtime,
    tmuxTarget: target,
    command,
    created,
    attached,
    ...(waiting ? { waiting } : {}),
  };
}
