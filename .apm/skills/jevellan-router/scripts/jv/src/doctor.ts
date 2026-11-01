// jv doctor: the preflights of section 11. Each check gives lines of OK, WARN or FAIL with a fix; runChecks(names)
// runs a subset, so jv task create can run the Jev and provider checks it needs before creating anything.
//
// Every effect on the outside world (child processes, HTTP, the clock, the disk) goes through DoctorDeps, so tests
// run with fakes. Probe output is never shown raw: at most its first line, through the redactor. Secrets travel
// only in child environments (D-007), never in argv.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listClaudeModels, type OfferedModel } from './claude-control.js';
import { isAuthError, probeCodex, type CodexProbe } from './codex-control.js';
import type { CommandIo, ParsedArgs } from './command.js';
import { packageVersion } from './commands/version.js';
import { jevClient } from './jev/client.js';
import { JevError } from './jev/contract.js';
import { paths } from './paths.js';
import { gitTopLevel } from './project.js';
import {
  allModelIds,
  cheapestModel,
  CLAUDE_KINDS,
  keyFileStatus,
  loadProviders,
  providerEnv,
  providerSecretFile,
  recordProviderAuth,
  type Provider,
  type ProviderAuthRecord,
  type ProvidersConfig,
} from './providers.js';
import { redact } from './redact.js';
import { REPORT_GUARD_MARK } from './seeds.js';
import { openStore, SCHEMA_VERSION } from './store.js';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface ExecResult {
  /** Exit code, or null when the process did not exit normally (not found, killed, timed out). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 'not-found' when the command is not on PATH, 'timeout' when it was killed after timeoutMs. */
  error?: 'not-found' | 'timeout' | string;
}

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface DoctorDeps {
  exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
  fetch: typeof fetch;
  /** Folder whose git repository is "the current project" (default process.cwd()). */
  cwd: string;
  /** The process environment the minimal child environments are built from. */
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  /** Free bytes available to jv at a path. */
  freeBytes: (path: string) => number;
  /** Timeout of a Claude login probe (default 60 s). */
  probeTimeoutMs: number;
  /** The Codex login probe (app-server account/read and account/rateLimits/read) under a provider's environment. */
  codexProbe: (env: Record<string, string>, cwd: string) => Promise<CodexProbe>;
  /** The models a Claude login offers (the agent SDK's supportedModels()) under a provider's environment. */
  claudeModels: (env: Record<string, string>, cwd: string) => Promise<OfferedModel[]>;
  /** Stores a login probe's result for placement (meta provider_auth:<name>, D-012). */
  recordAuth: (provider: string, record: ProviderAuthRecord) => void;
}

export const MIN_NODE: readonly [number, number] = [22, 13];
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
export const APM_INSTALL_COMMAND = 'apm install gongiskhan/jevellan-skills --target claude';
const BASE_ENV_KEYS = ['PATH', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'] as const;
const SKILL_PREFIX = 'jevellan-';
const ROUTER_SKILL = 'jevellan-router';

// ---- default effects ---------------------------------------------------------------------------------------

/** How long output may still drain after the process exited, before the pipes are closed. */
export const EXEC_DRAIN_MS = 300;
/** Grace between SIGTERM and SIGKILL of a timed out process group. */
export const EXEC_KILL_GRACE_MS = 2000;

/**
 * Runs a command without a shell, stdin closed, in its own process group so a timeout kills everything it started.
 * It settles when the process exits (plus a short drain of its output), not when its pipes close: a grandchild that
 * left the group and holds stdout open can never hold jv up. On a timeout it settles after the SIGKILL grace even if
 * the process never reports its exit.
 */
export function execCommand(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise(r);
    };
    const result = (code: number | null): ExecResult => ({
      code: timedOut ? null : code,
      stdout,
      stderr,
      ...(timedOut ? { error: 'timeout' } : {}),
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        timers.push(
          setTimeout(() => {
            kill('SIGKILL');
            timers.push(setTimeout(() => done(result(null)), EXEC_DRAIN_MS));
          }, EXEC_KILL_GRACE_MS),
        );
      }, options.timeoutMs ?? 30_000),
    );
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 1_000_000) stderr += d;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      done({ code: null, stdout, stderr, error: error.code === 'ENOENT' ? 'not-found' : error.message });
    });
    // 'close' comes first when nothing else holds the pipes; otherwise 'exit' plus a short drain settles it.
    child.on('close', (code) => done(result(code)));
    child.on('exit', (code) => {
      timers.push(setTimeout(() => done(result(code)), EXEC_DRAIN_MS));
    });
  });
}

function freeBytesAt(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const st = statfsSync(p);
  return Number(st.bavail) * Number(st.bsize);
}

export function defaultDeps(): DoctorDeps {
  return {
    exec: execCommand,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    env: process.env,
    nodeVersion: process.versions.node,
    freeBytes: freeBytesAt,
    probeTimeoutMs: 60_000,
    codexProbe: (env, cwd) => probeCodex({ env, cwd }),
    claudeModels: (env, cwd) => listClaudeModels({ env, cwd }),
    recordAuth: (provider, record) => {
      const store = openStore();
      try {
        recordProviderAuth(store, provider, record);
      } finally {
        store.close();
      }
    },
  };
}

// ---- helpers -----------------------------------------------------------------------------------------------

function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  const masked = redact(line);
  return masked.length > max ? `${masked.slice(0, max - 3)}...` : masked;
}

function ok(name: string, detail: string): CheckResult {
  return { name, status: 'OK', detail };
}
function warn(name: string, detail: string, fix?: string): CheckResult {
  return { name, status: 'WARN', detail, ...(fix ? { fix } : {}) };
}
function fail(name: string, detail: string, fix?: string): CheckResult {
  return { name, status: 'FAIL', detail, ...(fix ? { fix } : {}) };
}

function sha256(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/** The child environment of a provider probe: the base variables, the provider's HOME and login, and jv's flags. */
export function probeEnvironment(p: Provider, base: NodeJS.ProcessEnv): { env: Record<string, string>; missing?: string } {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k]!;
  const provider = providerEnv(p);
  Object.assign(env, provider.env);
  if (CLAUDE_KINDS.includes(p.kind)) {
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  }
  return { env, ...(provider.missing ? { missing: provider.missing } : {}) };
}

/** Frontmatter value of a SKILL.md (simple `key: value` lines between the first two --- lines). */
export function frontmatterValue(text: string, key: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv && kv[1] === key) return kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/**
 * The model ids that have a line in the router policy's "## model descriptions" section ("<model id>: <text>"),
 * or undefined when the policy has no such section.
 */
export function policyModelDescriptions(body: string): Map<string, string> | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+model descriptions\s*$/i.test(l));
  if (start < 0) return undefined;
  const out = new Map<string, string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line)) break;
    // The id ends at the first colon followed by a space, so ids with a colon (qwen3:8b) still parse.
    const m = /^(\S+?):\s+(\S.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

function stopHookRegistered(settingsFile: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { hooks?: { Stop?: unknown } };
    const stop = settings.hooks?.Stop;
    if (!Array.isArray(stop)) return false;
    return stop.some(
      (g) =>
        g &&
        typeof g === 'object' &&
        Array.isArray((g as { hooks?: unknown }).hooks) &&
        (g as { hooks: unknown[] }).hooks.some(
          (h) => !!h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string' && (h as { command: string }).command.includes(REPORT_GUARD_MARK),
        ),
    );
  } catch {
    return false;
  }
}

function jvSkillNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(SKILL_PREFIX) && existsSync(join(dir, n, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

// ---- the checks --------------------------------------------------------------------------------------------

interface Ctx {
  deps: DoctorDeps;
  providers(): ProvidersConfig | { error: string };
  /** Whether a result is asked for (a check skips expensive work, a probe, for results nobody asked for). */
  wants(resultName: string): boolean;
}

type Check = (ctx: Ctx) => Promise<CheckResult[]>;

function providersOrFail(ctx: Ctx, name: string): ProvidersConfig | CheckResult {
  const c = ctx.providers();
  return 'error' in c ? fail(name, `providers.json: ${c.error}`, 'fix providers.json, or run jv update to write it from the template') : c;
}

async function tool(ctx: Ctx, name: string, command: string, args: string[], missing: CheckStatus, fix: string): Promise<CheckResult[]> {
  const r = await ctx.deps.exec(command, args, { timeoutMs: 15_000 });
  if (r.error === 'not-found') return [{ name, status: missing, detail: `${command} is not on PATH`, fix }];
  if (r.code !== 0) return [{ name, status: missing, detail: `${command} ${args.join(' ')} failed: ${firstLine(r.stderr || r.stdout) || `exit ${r.code ?? r.error}`}`, fix }];
  return [ok(name, firstLine(r.stdout || r.stderr))];
}

const checkNode: Check = async (ctx) => {
  const [major = 0, minor = 0] = ctx.deps.nodeVersion.split('.').map(Number);
  const good = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return [
    good
      ? ok('node', `Node ${ctx.deps.nodeVersion}`)
      : fail('node', `Node ${ctx.deps.nodeVersion} is older than ${MIN_NODE.join('.')} (node:sqlite)`, 'install Node 22.13 or later and run jv bootstrap with it'),
  ];
};

const checkGit: Check = (ctx) => tool(ctx, 'git', 'git', ['--version'], 'FAIL', 'install git');
const checkTmux: Check = (ctx) => tool(ctx, 'tmux', 'tmux', ['-V'], 'FAIL', 'install tmux (sudo apt install tmux)');
const checkClaude: Check = (ctx) =>
  tool(ctx, 'claude', 'claude', ['--version'], 'FAIL', 'install Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
const checkCodex: Check = (ctx) => tool(ctx, 'codex', 'codex', ['--version'], 'WARN', 'install Codex: npm install -g @openai/codex');

const checkProviders: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'providers');
  if ('status' in c) return [c];
  const on = c.providers.filter((p) => p.enabled).length;
  return [ok('providers', `${c.providers.length} providers (${on} enabled) in ${c.file}`)];
};

const checkKeys: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'keys');
  if ('status' in c) return [c];
  return c.providers.map((p): CheckResult => {
    const name = `key:${p.name}`;
    const file = providerSecretFile(p);
    if (file === undefined) {
      return ok(name, p.kind === 'openai-compatible' ? 'no key needed' : 'no key file; the home holds its own login');
    }
    const st = keyFileStatus(file);
    const write = `write the key to ${file} and run chmod 600 ${file}`;
    switch (st.state) {
      case 'ok':
        return ok(name, `key file present, mode 600 (${file})`);
      case 'missing':
        return warn(name, `key file missing (${file})`, write);
      case 'empty':
        return warn(name, `key file empty (${file})`, write);
      case 'mode':
        return fail(name, `key file ${file} has mode ${st.mode}, not 600`, `chmod 600 ${file}`);
      default:
        return fail(name, `${file} is not a regular file`, write);
    }
  });
};

/** A login check's line and the login state it establishes (recorded for placement; undefined: nothing probed). */
type Probed = { result: CheckResult; auth?: ProviderAuthRecord['auth'] };

async function claudeLogin(ctx: Ctx, p: Provider): Promise<Probed> {
  const name = `login:${p.name}`;
  const home = p.home!;
  const login = `jv providers login ${p.name}`;
  if (!existsSync(join(home, '.claude'))) return { result: fail(name, `provider home ${home} is not set up`, 'run jv update'), auth: 'unknown' };
  const { env, missing } = probeEnvironment(p, ctx.deps.env);
  if (missing) {
    return { result: warn(name, `key file missing (${missing}); login not probed`, `write the key to ${missing} (mode 600)`), auth: 'needs-login' };
  }
  if (p.kind === 'claude-subscription' && p.tokenFile === undefined && !existsSync(join(home, '.claude', '.credentials.json'))) {
    return { result: warn(name, `needs login: no token file and no login in ${home}`, login), auth: 'needs-login' };
  }
  const model = cheapestModel(p).id;
  const r = await ctx.deps.exec(
    'claude',
    ['-p', 'Reply with the single word OK.', '--max-turns', '1', '--model', model, '--output-format', 'json'],
    { env, cwd: home, timeoutMs: ctx.deps.probeTimeoutMs },
  );
  if (r.error === 'not-found') return { result: fail(name, 'claude is not on PATH; login not probed', 'install Claude Code'), auth: 'unknown' };
  if (r.error === 'timeout') {
    const secs = Math.round(ctx.deps.probeTimeoutMs / 1000);
    return { result: fail(name, `the one-turn probe on ${model} did not answer within ${secs} s`, login), auth: 'unknown' };
  }
  let parsed: { is_error?: unknown; result?: unknown; subtype?: unknown } | undefined;
  try {
    const lastJson = r.stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).at(-1) ?? r.stdout;
    parsed = JSON.parse(lastJson) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (r.code === 0 && parsed && parsed.is_error !== true) {
    return { result: ok(name, `logged in: a one-turn probe on ${model} answered`), auth: 'ready' };
  }
  const text = typeof parsed?.result === 'string' ? parsed.result : '';
  const why = firstLine(text || r.stderr || r.stdout) || `exit ${r.code}`;
  const auth = isAuthError(`${text}\n${r.stderr}\n${r.stdout}`) ? 'needs-login' : 'unknown';
  return { result: fail(name, `the one-turn probe on ${model} failed: ${why}`, login), auth };
}

async function codexLogin(ctx: Ctx, p: Provider): Promise<Probed> {
  const name = `login:${p.name}`;
  const home = p.home!;
  const loginCommand = `jv providers login ${p.name}`;
  if (!existsSync(join(home, '.codex'))) return { result: fail(name, `provider home ${home} is not set up`, 'run jv update'), auth: 'unknown' };
  const { env } = probeEnvironment(p, ctx.deps.env);
  const r = await ctx.deps.codexProbe(env, home);
  if (r.error === 'codex is not on PATH') {
    return { result: warn(name, 'codex is not on PATH; login not checked', 'install Codex: npm install -g @openai/codex'), auth: 'unknown' };
  }
  const usage = r.usage
    ? [r.usage.weeklyPct !== undefined ? `week ${r.usage.weeklyPct}%` : '', r.usage.fiveHourPct !== undefined ? `five hours ${r.usage.fiveHourPct}%` : '']
        .filter(Boolean)
        .join(', ')
    : '';
  if (r.auth === 'ready') {
    return { result: ok(name, `ready: ChatGPT ${r.plan ?? 'login'} answered account/rateLimits/read${usage ? ` (${usage})` : ''}`), auth: 'ready' };
  }
  if (r.auth === 'needs-login') return { result: warn(name, `needs login: ${r.error ?? 'no login'}`, loginCommand), auth: 'needs-login' };
  return { result: warn(name, `login state unknown: ${r.error ?? 'the probe did not complete'}`, `run jv doctor again; if it persists, ${loginCommand}`), auth: 'unknown' };
}

const checkLogins: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'logins');
  if ('status' in c) return [c];
  const probes = c.providers.map(async (p): Promise<CheckResult | undefined> => {
    if (p.kind === 'openai-compatible' || !ctx.wants(`login:${p.name}`)) return undefined;
    if (!p.enabled) return ok(`login:${p.name}`, 'disabled in providers.json; not probed');
    const probed = p.kind === 'codex-subscription' ? await codexLogin(ctx, p) : await claudeLogin(ctx, p);
    if (probed.auth !== undefined) {
      try {
        ctx.deps.recordAuth(p.name, { auth: probed.auth, observedAt: new Date().toISOString(), detail: probed.result.detail.slice(0, 300) });
      } catch (error) {
        return warn(probed.result.name, `${probed.result.detail} (not recorded in the store: ${firstLine(error instanceof Error ? error.message : String(error))})`, probed.result.fix);
      }
    }
    return probed.result;
  });
  return (await Promise.all(probes)).filter((r): r is CheckResult => r !== undefined);
};

const checkModels: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'models');
  if ('status' in c) return [c];
  const probes = c.providers.map(async (p): Promise<CheckResult | undefined> => {
    const name = `models:${p.name}`;
    if (!CLAUDE_KINDS.includes(p.kind) || !ctx.wants(name)) return undefined;
    if (!p.enabled) return ok(name, 'disabled in providers.json; not probed');
    if (p.kind === 'claude-endpoint') return ok(name, `the endpoint serves its configured models (${p.models.map((m) => m.id).join(', ')}); not probed`);
    const { env, missing } = probeEnvironment(p, ctx.deps.env);
    if (missing) return warn(name, `key file missing (${missing}); supportedModels not probed`, `write the key to ${missing} (mode 600)`);
    let offered: OfferedModel[];
    try {
      offered = await ctx.deps.claudeModels(env, p.home!);
    } catch (error) {
      return fail(name, `the supportedModels probe could not run: ${firstLine(error instanceof Error ? error.message : String(error))}`, `jv providers login ${p.name}`);
    }
    const ids = new Set(offered.map((m) => m.id));
    const absent = p.models.filter((m) => !ids.has(m.id)).map((m) => m.id);
    if (absent.length) {
      return warn(
        name,
        `not offered to this login: ${absent.join(', ')} (offered: ${[...ids].join(', ') || 'none'})`,
        `change the model ids of ${p.name} in ${c.file} to offered ones`,
      );
    }
    return ok(name, `all ${p.models.length} models in providers.json are offered (${offered.length} offered)`);
  });
  return (await Promise.all(probes)).filter((r): r is CheckResult => r !== undefined);
};

const checkJev: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'jev');
  if ('status' in c) return [c];
  const file = c.jev.keyFile;
  const st = keyFileStatus(file);
  const write = `write the Jev key to ${file} and run chmod 600 ${file}`;
  if (st.state === 'missing' || st.state === 'empty') return [fail('jev', 'no key configured', write)];
  if (st.state !== 'ok') return [fail('jev', `the Jev key file ${file} has mode ${st.mode ?? '?'}, not 600`, `chmod 600 ${file}`)];
  try {
    const models = await jevClient(c.jev, { fetch: ctx.deps.fetch }).models();
    const names = models.models.map((m) => m.name);
    if (!names.includes(c.jev.model)) {
      return [
        fail('jev', `reachable, but the configured model ${c.jev.model} is not listed (listed: ${names.join(', ') || 'none'})`, `set jev.model in ${c.file} to a listed model`),
      ];
    }
    return [ok('jev', `reachable, model ${c.jev.model} listed (${names.length} models)`)];
  } catch (error) {
    const message = error instanceof JevError ? error.message : error instanceof Error ? firstLine(error.message) : String(error);
    const fix = error instanceof JevError && (error.kind === 'auth' || error.kind === 'no-key') ? write : 'check the network and run jv doctor again';
    return [fail('jev', `GET /v1/models: ${message}`, fix)];
  }
};

const checkStore: Check = async () => {
  try {
    const store = openStore();
    try {
      const v = store.schemaVersion();
      return [
        v === SCHEMA_VERSION
          ? ok('store', `schema ${v} at ${store.file}`)
          : fail('store', `schema ${v} at ${store.file}, this runtime needs ${SCHEMA_VERSION}`, 'run jv update'),
      ];
    } finally {
      store.close();
    }
  } catch (error) {
    return [fail('store', `cannot open ${paths.store}: ${firstLine(error instanceof Error ? error.message : String(error))}`, 'run jv update')];
  }
};

const checkDisk: Check = async (ctx) => {
  try {
    const free = ctx.deps.freeBytes(paths.home);
    const gb = (free / 1024 ** 3).toFixed(1);
    return [
      free >= MIN_FREE_BYTES
        ? ok('disk', `${gb} GB free for ${paths.home}`)
        : fail('disk', `only ${gb} GB free for ${paths.home}; jv needs 5 GB for worktrees and logs`, 'free disk space, or run jv gc'),
    ];
  } catch (error) {
    return [warn('disk', `free space unknown: ${firstLine(error instanceof Error ? error.message : String(error))}`)];
  }
};

const checkHook: Check = async (ctx) => {
  const top = gitTopLevel(ctx.deps.cwd);
  if (!top) return [ok('hook', `${ctx.deps.cwd} is not inside a git repository; run jv doctor in a project to check its hook`)];
  const file = join(top, '.claude', 'settings.json');
  return [
    stopHookRegistered(file)
      ? ok('hook', `the jv Stop hook is registered in ${file}`)
      : warn('hook', `the jv Stop hook is not registered in ${file}`, `in ${top}: ${APM_INSTALL_COMMAND}`),
  ];
};

const checkSkills: Check = async () => {
  const names = jvSkillNames(paths.skillsDir);
  if (names.length === 0) return [fail('skills', `no jevellan skills in ${paths.skillsDir}`, 'run jv update')];
  const version = packageVersion();
  const off = names
    .map((n) => {
      const v = frontmatterValue(readFileSync(join(paths.skillsDir, n, 'SKILL.md'), 'utf8'), 'jv-version');
      return v === version ? undefined : `${n} ${v ?? 'no jv-version'}`;
    })
    .filter((x): x is string => x !== undefined);
  return [
    off.length === 0
      ? ok('skills', `${names.length} skills in ${paths.skillsDir} at version ${version}`)
      : warn('skills', `runtime ${version}, skills differ: ${off.join(', ')}`, 'run jv update'),
  ];
};

function compareCopies(label: string, dir: string, reference: string[], expectInstalled: boolean, fix: string): CheckResult {
  const name = `skill-copies:${label}`;
  const installed = jvSkillNames(dir);
  if (installed.length === 0) {
    return expectInstalled ? warn(name, `no jevellan skills in ${dir}`, fix) : ok(name, `no jevellan skills installed in ${dir}`);
  }
  const differ = installed.filter((n) => sha256(join(dir, n, 'SKILL.md')) !== sha256(join(paths.skillsDir, n, 'SKILL.md')));
  const missing = expectInstalled ? reference.filter((n) => !installed.includes(n)) : [];
  if (differ.length === 0 && missing.length === 0) return ok(name, `${installed.length} skills in ${dir} match ${paths.skillsDir}`);
  const parts = [];
  if (differ.length) parts.push(`differ from ${paths.skillsDir}: ${differ.join(', ')}`);
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  return warn(name, `skills in ${dir} ${parts.join('; ')}`, fix);
}

const checkSkillCopies: Check = async (ctx) => {
  const reference = jvSkillNames(paths.skillsDir);
  const out: CheckResult[] = [];
  const top = gitTopLevel(ctx.deps.cwd);
  if (top) {
    out.push(compareCopies('project', join(top, '.claude', 'skills'), reference, false, `in ${top}: ${APM_INSTALL_COMMAND}`));
  }
  const c = ctx.providers();
  if (!('error' in c)) {
    for (const p of c.providers) {
      if (!CLAUDE_KINDS.includes(p.kind) || p.home === undefined || !p.enabled) continue;
      out.push(compareCopies(p.name, join(p.home, '.claude', 'skills'), reference, true, 'run jv update'));
    }
  }
  return out;
};

const checkModelDescriptions: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'model-descriptions');
  if ('status' in c) return [c];
  const file = paths.skillFile(ROUTER_SKILL);
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return [fail('model-descriptions', `no router policy at ${file}`, 'run jv update')];
  }
  const described = policyModelDescriptions(body);
  if (!described) {
    return [warn('model-descriptions', `the router policy (${file}) has no "## model descriptions" section yet`, 'run jv update with a package whose router policy is written')];
  }
  const ids = allModelIds(c);
  const missing = ids.filter((id) => !described.has(id));
  // A line whose id no provider serves is stale (a renamed model): Jev never sees it, and it hides the rename.
  const stale = [...described.keys()].filter((id) => !ids.includes(id));
  if (missing.length === 0 && stale.length === 0) return [ok('model-descriptions', `every model in providers.json has a description line in ${file}`)];
  const details: string[] = [];
  const fixes: string[] = [];
  if (missing.length) {
    details.push(`no description line in the router policy for: ${missing.join(', ')}`);
    fixes.push(`add "<model id>: <text>" lines to "## model descriptions" in the router policy, or remove the models from ${c.file}`);
  }
  if (stale.length) {
    details.push(`description lines for models no provider in providers.json has: ${stale.join(', ')}`);
    fixes.push(`remove those lines from "## model descriptions" in ${file}, or add the models to ${c.file}`);
  }
  return [warn('model-descriptions', details.join('; '), fixes.join('; '))];
};

/** Every check group, in the order jv doctor prints them. */
export const CHECKS: ReadonlyArray<readonly [string, Check]> = [
  ['node', checkNode],
  ['git', checkGit],
  ['tmux', checkTmux],
  ['claude', checkClaude],
  ['models', checkModels],
  ['codex', checkCodex],
  ['providers', checkProviders],
  ['keys', checkKeys],
  ['logins', checkLogins],
  ['jev', checkJev],
  ['store', checkStore],
  ['disk', checkDisk],
  ['hook', checkHook],
  ['skills', checkSkills],
  ['skill-copies', checkSkillCopies],
  ['model-descriptions', checkModelDescriptions],
];

export const CHECK_NAMES: readonly string[] = CHECKS.map(([n]) => n);

/** Group of a result-level name: key:<p> -> keys, login:<p> -> logins, skill-copies:<x> -> skill-copies. */
function groupOf(name: string): string {
  const prefix = name.split(':')[0]!;
  if (prefix === 'key') return 'keys';
  if (prefix === 'login') return 'logins';
  return prefix;  // models:<p> -> models
}

/**
 * Runs the named checks (all when `names` is empty or omitted). A name is a group ("jev", "logins", "keys") or one
 * result ("login:claude-main", "key:glm"). Results come back in the order of CHECKS.
 */
export async function runChecks(names: readonly string[] = [], overrides: Partial<DoctorDeps> = {}): Promise<CheckResult[]> {
  const deps: DoctorDeps = { ...defaultDeps(), ...overrides };
  const unknown = names.filter((n) => !CHECK_NAMES.includes(groupOf(n)));
  if (unknown.length) throw new Error(`unknown doctor check: ${unknown.join(', ')} (known: ${CHECK_NAMES.join(', ')})`);
  const groups = new Set(names.map(groupOf));
  const exact = new Set(names.filter((n) => n.includes(':')));
  const wholeGroups = new Set(names.filter((n) => !n.includes(':')));

  let cached: ProvidersConfig | { error: string } | undefined;
  const wants = (r: string) => names.length === 0 || wholeGroups.has(groupOf(r)) || exact.has(r) || !r.includes(':');
  const ctx: Ctx = {
    deps,
    wants,
    providers() {
      if (!cached) {
        try {
          cached = loadProviders();
        } catch (error) {
          cached = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      return cached;
    },
  };
  const selected = CHECKS.filter(([n]) => names.length === 0 || groups.has(n));
  const results = await Promise.all(
    selected.map(async ([group, check]) => {
      try {
        return await check(ctx);
      } catch (error) {
        return [fail(group, `the check failed: ${firstLine(error instanceof Error ? error.message : String(error))}`)];
      }
    }),
  );
  return results.flat().filter((r) => wants(r.name));
}

/** One line per check: STATUS name: detail - fix: ... */
export function formatCheck(r: CheckResult): string {
  return `${r.status.padEnd(4)} ${r.name}: ${r.detail}${r.fix && r.status !== 'OK' ? ` - fix: ${r.fix}` : ''}`;
}

/** The CLI entry (the table maps `doctor` to this file). */
export async function run(args: ParsedArgs, io: CommandIo): Promise<number | void> {
  const mod = await import('./commands/doctor.js');
  return mod.run(args, io);
}

