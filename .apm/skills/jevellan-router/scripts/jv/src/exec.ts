// jv exec (internal, D-007): runs one command under a provider's minimal environment, with inherited stdio.
//
//   jv exec (--session R | --provider P) [--project N] [--cwd DIR] [--home-login] -- <command> [args...]
//
// Both --session and --provider may be given when they agree (the session row's provider is the one used).
// --home-login (Claude subscriptions only) leaves the provider's tokenFile out of the environment, so Claude Code
// signs in with the home's own .credentials.json: the coordinator on a login the owner made with jv providers login
// (Remote Control refuses a long-lived token, D-054), and that login command itself. Workers never get it (D-003).
//
// Every process jv launches in tmux (the coordinator, claude-tmux sessions, jv attach, jv providers login) goes
// through this command, so the provider's token and keys travel only through this process's child environment:
// never on a command line, in tmux history or in a log.
//
// - The environment is env.ts minimalEnvironment of the provider (of the session row with --session), plus
//   JV_SESSION=R with --session, plus JV_PROJECT when the project is known (the session's project, --project, or a
//   JV_PROJECT this process already has), plus COLORTERM when the terminal sets it (the child draws in a tmux pane).
//   Its PATH starts with the bootstrap Node's folder and $JV_HOME/bin, so `jv` runs from inside the child.
// - The working directory is --cwd, else the session's cwd, else this process's.
// - The child shares this process's terminal (stdio inherited, same process group, so terminal signals such as
//   Ctrl-C and window resizes reach it directly and are not forwarded a second time). SIGTERM, SIGHUP and SIGQUIT
//   sent to this process are forwarded to the child; this process exits with the child's exit code (128 + signal
//   number when the child was killed by a signal), 127 when the command cannot be started.

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import { minimalEnvironment } from './env.js';
import { notFound, refused } from './errors.js';
import { findProvider, loadProviders, type Provider, type ProvidersConfig } from './providers.js';
import type { Store } from './store.js';

export interface ExecSpec {
  /** The session row the command belongs to (sets JV_SESSION and, by default, the provider and cwd). */
  sessionId?: string;
  /** The provider, when there is no session row. */
  providerName?: string;
  /** The project name for JV_PROJECT (default: the session's project, else base JV_PROJECT). */
  projectName?: string;
  cwd?: string;
  /** Sign in with the home's own login instead of the tokenFile (Claude subscriptions only). */
  homeLogin?: boolean;
  /** The command and its arguments. */
  command: readonly string[];
}

export interface ExecPlan {
  file: string;
  args: string[];
  cwd: string;
  /** May hold secrets: only for the child process. */
  env: Record<string, string>;
  provider: Provider;
  sessionId?: string;
  projectName?: string;
}

export interface ExecOptions {
  providers?: ProvidersConfig;
  /** The environment the base keys come from (default process.env). */
  base?: NodeJS.ProcessEnv;
}

/** Signals sent to this process (by kill or tmux) that the child must get too. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGQUIT'];
/** Signals the terminal sends to the whole foreground process group: the child already has them. */
export const TERMINAL_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGWINCH', 'SIGTSTP'];

/** Resolves what jv exec would run: the provider, the environment, the cwd. Refuses with the reason. */
export function planExec(store: Store, spec: ExecSpec, options: ExecOptions = {}): ExecPlan {
  const [file, ...args] = spec.command;
  if (file === undefined || file === '') throw refused('jv exec needs a command after --');
  if (!spec.sessionId && !spec.providerName) throw refused('jv exec needs --session R or --provider P');
  const base = options.base ?? process.env;

  let providerName = spec.providerName;
  let projectName = spec.projectName;
  let cwd = spec.cwd === undefined ? undefined : resolve(spec.cwd);
  if (spec.sessionId) {
    const session = store.requireSession(spec.sessionId);
    if (providerName !== undefined && providerName !== session.provider) {
      throw refused(`session ${session.id} runs on provider ${session.provider}, not ${providerName}`);
    }
    providerName = session.provider;
    cwd ??= session.cwd;
    if (projectName === undefined) projectName = store.getProject(session.project_id)?.name;
  }
  if (projectName !== undefined && !store.getProjectByName(projectName)) throw notFound(`no project ${projectName}`);
  if (projectName === undefined && base.JV_PROJECT) projectName = base.JV_PROJECT;

  const providers = options.providers ?? loadProviders();
  const provider = findProvider(providers, providerName!);
  if (!provider) throw refused(`no provider ${providerName} in ${providers.file}`);
  if (spec.homeLogin && provider.kind !== 'claude-subscription') {
    throw refused(`--home-login is for Claude subscriptions; ${provider.name} is a ${provider.kind} provider`);
  }
  const env = minimalEnvironment({
    provider,
    base,
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    ...(spec.homeLogin ? { homeLogin: true } : {}),
  });
  if (projectName) env.JV_PROJECT = projectName;
  if (base.COLORTERM) env.COLORTERM = base.COLORTERM;
  return {
    file,
    args,
    cwd: cwd ?? process.cwd(),
    env,
    provider,
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    ...(projectName ? { projectName } : {}),
  };
}

function signalNumber(signal: NodeJS.Signals): number {
  return (osConstants.signals as Record<string, number>)[signal] ?? 1;
}

/**
 * Spawns the plan with inherited stdio and resolves with the exit code to use. The store must be closed by the caller
 * before (the child may run for days).
 *
 * The signal handlers are installed before the child is spawned: the child can start, print and be signalled for
 * (tmux, a test, the owner) before spawn() even returns here, and a SIGTERM in that window used to kill this process
 * with the default action and leave the child running on its own. A forwarded signal that arrives before the child
 * exists is delivered to it right after the spawn.
 */
export function runExec(plan: ExecPlan, options: { stdio?: 'inherit' | 'ignore' } = {}): Promise<number> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn> | undefined;
    const early: NodeJS.Signals[] = [];
    const forward = (sig: NodeJS.Signals): void => {
      if (!child) {
        early.push(sig);
        return;
      }
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    };
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const sig of FORWARDED_SIGNALS) {
      const h = (): void => forward(sig);
      handlers.set(sig, h);
      process.on(sig, h);
    }
    // The terminal delivers these to the child itself; this process only must not die of them.
    const ignore = (): void => {};
    for (const sig of TERMINAL_SIGNALS) process.on(sig, ignore);
    const cleanup = (): void => {
      for (const [sig, h] of handlers) process.off(sig, h);
      for (const sig of TERMINAL_SIGNALS) process.off(sig, ignore);
    };
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(code);
    };
    try {
      child = spawn(plan.file, plan.args, { cwd: plan.cwd, env: plan.env, stdio: options.stdio ?? 'inherit' });
    } catch (error) {
      process.stderr.write(`jv exec: cannot start ${plan.file}: ${error instanceof Error ? error.message : String(error)}\n`);
      settle(early.length ? 128 + signalNumber(early[0]!) : 127);
      return;
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      const why = error.code === 'ENOENT' ? 'command not found' : error.message;
      process.stderr.write(`jv exec: cannot start ${plan.file}: ${why}\n`);
      settle(127);
    });
    child.on('exit', (code, signal) => settle(code ?? (signal ? 128 + signalNumber(signal) : 1)));
    for (const sig of early.splice(0)) forward(sig);
  });
}
