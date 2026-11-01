// The Codex control channel: `codex app-server` spoken over stdio JSON-RPC, ported from jevellan
// runtimes/codex/src/control.ts at 8e2788ec (CodexControl, codexUsage, probeCodex).
//
// Differences from the original, with reasons:
// - The child environment is built by the caller (doctor's probeEnvironment: HOME and CODEX_HOME of the provider
//   home), not by @jevellan/core's minimalEnvironment.
// - probeCodex reads the account with refreshToken: false. Section 11 asks for account/rateLimits/read, which is a
//   server call with the stored access token: a revoked or rotated login answers 401 there. Asking account/read to
//   refresh would rotate the refresh token on every doctor run, and jv's Codex login is a copy of the one the running
//   Jevellan uses (D-022), so jv never forces a refresh just to check.
// - Errors are classified with the same "auth" rule as Jevellan's classifyRuntimeError.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

const ReplySchema = z.object({
  id: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const AccountReplySchema = z.object({
  account: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('apiKey') }),
      z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() }),
      z.object({ type: z.literal('amazonBedrock'), usesCodexManagedCredentials: z.boolean() }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const RateWindowSchema = z.object({
  usedPercent: z.number().nonnegative(),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().max(253_402_300_799).nullable(),
});
const RateSnapshotSchema = z.object({
  limitId: z.string().nullable().optional(),
  primary: RateWindowSchema.nullable().optional(),
  secondary: RateWindowSchema.nullable().optional(),
});
const RateLimitsReplySchema = z.object({
  rateLimits: RateSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), RateSnapshotSchema).nullable().optional(),
});

export interface CodexUsage {
  observedAt: string;
  fiveHourPct?: number;
  weeklyPct?: number;
  fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
}

/** The account's five-hour and weekly windows from an account/rateLimits/read reply (window duration decides). */
export function codexUsage(raw: unknown, now: Date = new Date()): CodexUsage | undefined {
  const response = RateLimitsReplySchema.parse(raw);
  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (snapshot.limitId && snapshot.limitId !== 'codex') return undefined;
  const windows = [snapshot.primary, snapshot.secondary];
  const five = windows.find((w) => w?.windowDurationMins === 300);
  const week = windows.find((w) => w?.windowDurationMins === 10080);
  if (!five && !week) return undefined;
  // Primary can be weekly on some subscriptions. Window duration, not position, determines the quota.
  return {
    observedAt: now.toISOString(),
    ...(five ? { fiveHourPct: Math.min(100, five.usedPercent) } : {}),
    ...(five && five.resetsAt !== null ? { fiveHourResetsAt: new Date(five.resetsAt * 1000).toISOString() } : {}),
    ...(week ? { weeklyPct: Math.min(100, week.usedPercent) } : {}),
    ...(week && week.resetsAt !== null ? { weeklyResetsAt: new Date(week.resetsAt * 1000).toISOString() } : {}),
  };
}

/**
 * Jevellan's classifyRuntimeError "auth" rule, plus the phrasings Claude Code and Codex print for a refused login
 * ("Invalid token ... Please run /login", "Invalid API key", "try signing in again").
 */
export function isAuthError(message: string): boolean {
  return /401|403|authentication|unauthori[sz]ed|needs.login|token.*(?:expired|revoked)|not.logged.in|sign(?:ing)? in again|run \/login|invalid (?:api key|token|bearer)/i.test(
    message,
  );
}

export class CodexControlError extends Error {
  readonly kind: 'auth' | 'other';
  constructor(message: string, kind: 'auth' | 'other' = 'other') {
    super(message);
    this.name = 'CodexControlError';
    this.kind = kind;
  }
}

export interface CodexControlOptions {
  env: Record<string, string>;
  cwd: string;
  executable?: string;
  /** Per request, default 15 s. */
  requestTimeoutMs?: number;
}

export class CodexControl {
  #id = 0;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let reply: z.infer<typeof ReplySchema>;
      try {
        reply = ReplySchema.parse(JSON.parse(line));
      } catch {
        this.#fail(new CodexControlError('Codex control returned an invalid response.'));
        return;
      }
      if (reply.id === undefined) return; // a notification
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if (reply.error) {
        // The refusal's text can name URLs and server bodies; only its class leaves this module.
        const auth = isAuthError(reply.error.message);
        pending.reject(new CodexControlError(auth ? 'Codex refused this login (401).' : 'Codex control request was refused.', auth ? 'auth' : 'other'));
      } else pending.resolve(reply.result);
    });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      lines.close();
      this.#fail(new CodexControlError('Codex control process closed.'));
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      this.#fail(new CodexControlError(error.code === 'ENOENT' ? 'codex is not on PATH' : 'Codex control process failed.')),
    );
    child.stdin.on('error', () => this.#fail(new CodexControlError('Codex control channel closed.')));
  }

  #fail(error: Error): void {
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }

  static async open(options: CodexControlOptions): Promise<CodexControl> {
    const child = spawn(options.executable ?? 'codex', ['app-server'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const control = new CodexControl(child, options.requestTimeoutMs ?? 15_000);
    try {
      await control.request('initialize', { clientInfo: { name: 'jv', version: '0.1.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      return control;
    } catch (error) {
      await control.close();
      throw error;
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new CodexControlError('Codex control closed.');
    const id = ++this.#id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new CodexControlError('Codex control request timed out.'));
        }, this.requestTimeoutMs);
        this.#pending.set(id, { resolve, reject });
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** SIGTERM to the process group, SIGKILL after 2 s; resolves when the process is gone (or after the kill). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pid = this.child.pid;
    const gone = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null || pid === undefined) resolve();
      else this.child.once('exit', () => resolve());
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (pid !== undefined) process.kill(-pid, signal);
      } catch {
        // already gone
      }
    };
    kill('SIGTERM');
    const hard = setTimeout(() => kill('SIGKILL'), 2000);
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    clearTimeout(hard);
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.stdin.destroy();
    this.#fail(new CodexControlError('Codex control closed.'));
  }
}

export interface CodexProbe {
  auth: 'ready' | 'needs-login' | 'unknown';
  plan?: string;
  usage?: CodexUsage;
  /** Short human text, never server output. */
  error?: string;
}

/**
 * The login state of a Codex home: account/read (no refresh) says whether a login is stored, and
 * account/rateLimits/read proves it against the server; 401 or 403 there means the login was revoked or rotated
 * away (needs-login). An unreadable quota with a stored login is 'unknown', not a login failure.
 */
export async function probeCodex(options: CodexControlOptions): Promise<CodexProbe> {
  let control: CodexControl;
  try {
    control = await CodexControl.open(options);
  } catch (error) {
    return { auth: 'unknown', error: error instanceof CodexControlError ? error.message : 'Codex control could not start.' };
  }
  try {
    const response = AccountReplySchema.parse(await control.request('account/read', { refreshToken: false }));
    if (!response.account) return { auth: 'needs-login', error: 'no Codex login is stored in this home' };
    if (response.account.type === 'amazonBedrock') return { auth: 'unknown', error: 'this credential provider is not supported' };
    const plan = response.account.type === 'chatgpt' ? response.account.planType : 'api key';
    try {
      const usage = codexUsage(await control.request('account/rateLimits/read', {}));
      return { auth: 'ready', plan, ...(usage ? { usage } : {}) };
    } catch (error) {
      if (error instanceof CodexControlError && error.kind === 'auth') {
        return { auth: 'needs-login', plan, error: 'the server refused the stored login (revoked, expired or rotated away)' };
      }
      return { auth: 'unknown', plan, error: 'a login is stored, but the usage endpoint could not be read' };
    }
  } catch (error) {
    if (error instanceof CodexControlError && error.kind === 'auth') return { auth: 'needs-login', error: 'Codex refused this login' };
    return { auth: 'unknown', error: error instanceof CodexControlError ? error.message : 'the Codex account reply was not understood' };
  } finally {
    await control.close();
  }
}
