// The worker environment: minimalEnvironment, ported from jevellan packages/core/src/environment.ts with the jv
// additions of D-004. A worker never gets the whole process environment; it gets:
//
// - PATH, USER, LANG, TERM, SHELL, TMPDIR from the process (Jevellan's BASE list), with PATH prefixed by the
//   bootstrap Node's bin folder and $JV_HOME/bin, so `node` is Node 22 (node:sqlite) for the report MCP server and the
//   Stop hook, and `jv` is on PATH;
// - HOME = the provider's home (Codex: also CODEX_HOME=<home>/.codex, D-002); CLAUDE_CONFIG_DIR is never set;
// - the provider's login (providers.providerEnv): CLAUDE_CODE_OAUTH_TOKEN from tokenFile (D-003) for a Claude
//   subscription, or ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN (keyFile) and ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL
//   (the provider's model ids) for a Claude endpoint;
// - CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, and ENABLE_CLAUDEAI_MCP_SERVERS=false for Claude kinds (D-004);
// - GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL from the machine's git config (D-004);
// - PLAYWRIGHT_BROWSERS_PATH when the machine has ~/.cache/ms-playwright (D-004);
// - JV_SESSION=<session id>, and JV_HOME, so the report MCP server and the Stop hook find this store even when
//   JV_HOME is not ~/.jv (D-024) or the provider home has no .jv link (Codex homes, D-016).
//
// Values may be secrets: the result only ever goes into a child process environment.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { refused } from './errors.js';
import { paths } from './paths.js';
import { CLAUDE_KINDS, providerEnv, type Provider } from './providers.js';

/** Jevellan's BASE list, without HOME (always the provider's). */
export const BASE_KEYS = ['PATH', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'] as const;
export const GIT_IDENTITY_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;

export interface GitIdentity {
  name?: string;
  email?: string;
}

/** The Node binary jv was bootstrapped with (install.json nodePath), else this process's. */
export function bootstrapNode(installFile: string = paths.installFile): string {
  try {
    const install = JSON.parse(readFileSync(installFile, 'utf8')) as { nodePath?: unknown };
    if (typeof install.nodePath === 'string' && install.nodePath !== '' && existsSync(install.nodePath)) return install.nodePath;
  } catch {
    // no install.json (a test home, or a run from the source folder)
  }
  return process.execPath;
}

/**
 * The owner's own home folder from the user database, not from HOME: jv commands run by the coordinator (or any
 * session) have HOME set to a provider home, where there is no .gitconfig and no browser cache.
 */
export function ownerHome(): string {
  try {
    const h = userInfo().homedir;
    if (h) return h;
  } catch {
    // no passwd entry
  }
  return homedir();
}

let cachedIdentity: GitIdentity | undefined;

/** The machine's git identity (user.name, user.email), read with the owner's home, once per process. */
export function machineGitIdentity(base: NodeJS.ProcessEnv = process.env): GitIdentity {
  if (cachedIdentity) return cachedIdentity;
  const read = (key: string): string | undefined => {
    try {
      const v = execFileSync('git', ['config', '--get', key], {
        cwd: '/',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: base.PATH ?? '/usr/bin:/bin', HOME: ownerHome() },
      }).trim();
      return v === '' ? undefined : v;
    } catch {
      return undefined;
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  cachedIdentity = { ...(name ? { name } : {}), ...(email ? { email } : {}) };
  return cachedIdentity;
}

export interface MinimalEnvironmentOptions {
  provider: Provider;
  /** JV_SESSION of the worker. */
  sessionId?: string;
  /** The process environment the base keys come from (default process.env). */
  base?: NodeJS.ProcessEnv;
  /** Default: machineGitIdentity(base). */
  gitIdentity?: GitIdentity;
  /** Default: bootstrapNode(). */
  nodeBinary?: string;
  /** The owner's own home, where ~/.cache/ms-playwright lives (default: ownerHome()). */
  ownerHome?: string;
  /** Sign in with the home's own .credentials.json, not the tokenFile (providers.providerEnv). */
  homeLogin?: boolean;
}

function joinPath(first: readonly string[], rest: string | undefined): string {
  const out: string[] = [];
  for (const p of [...first, ...(rest ?? '').split(delimiter)]) if (p !== '' && !out.includes(p)) out.push(p);
  return out.join(delimiter);
}

/**
 * The worker's environment. Refuses (exit 2) when the provider's key or token file is missing or empty; the error
 * names the file, never its content.
 */
export function minimalEnvironment(options: MinimalEnvironmentOptions): Record<string, string> {
  const base = options.base ?? process.env;
  const p = options.provider;
  const env: Record<string, string> = {};
  for (const key of BASE_KEYS) if (base[key] !== undefined && base[key] !== '') env[key] = base[key]!;
  const node = options.nodeBinary ?? bootstrapNode();
  env.PATH = joinPath([dirname(node), paths.binDir], base.PATH);

  const login = providerEnv(p, { homeLogin: options.homeLogin === true });
  if (login.missing) throw refused(`provider ${p.name}: key file ${login.missing} is missing or empty`);
  if (login.env.HOME === undefined) throw refused(`provider ${p.name} (${p.kind}) has no home; it cannot run a worker session`);
  Object.assign(env, login.env);

  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (CLAUDE_KINDS.includes(p.kind)) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';

  const identity = options.gitIdentity ?? machineGitIdentity(base);
  if (identity.name) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_COMMITTER_NAME = identity.name;
  }
  if (identity.email) {
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }

  const browsers = join(options.ownerHome ?? ownerHome(), '.cache', 'ms-playwright');
  if (existsSync(browsers)) env.PLAYWRIGHT_BROWSERS_PATH = browsers;

  env.JV_HOME = paths.home;
  if (options.sessionId) env.JV_SESSION = options.sessionId;
  return env;
}
