// The models a Claude login offers, through the agent SDK's supportedModels(): ported from jevellan
// runtimes/claude/src/control.ts at 8e2788ec (listClaudeModels).
//
// An open input stream that never yields performs the SDK handshake without submitting a model turn, so the probe
// costs no usage. The child environment is the provider's (doctor's probeEnvironment: HOME, the token, the
// endpoint variables), never the whole process environment. Endpoint providers are not probed: Claude Code lists
// Anthropic's aliases there, not the endpoint's models (Jevellan returned the configured list for them too).

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ModelsSchema = z.array(
  z.object({
    value: z.string(),
    resolvedModel: z.string().optional(),
    displayName: z.string(),
    supportedEffortLevels: z.array(z.enum(EFFORTS)).optional(),
  }),
);

export interface OfferedModel {
  /** The canonical model id (resolvedModel, else value). */
  id: string;
  label: string;
  efforts: string[];
}

export interface ListClaudeModelsOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  executable?: string;
}

/** The models the login offers, deduplicated by canonical id, in the SDK's order. Throws when the probe fails. */
export async function listClaudeModels(options: ListClaudeModelsOptions): Promise<OfferedModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release: (() => void) | undefined;
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
            release = () => resolve({ done: true, value: undefined });
          }),
      };
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const runtime = query({
    prompt: input,
    options: {
      cwd: options.cwd,
      env: options.env,
      abortController: controller,
      settingSources: ['user'],
      permissionMode: 'dontAsk',
      stderr: () => {},
      ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
    },
  });
  try {
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new Error('supportedModels() did not answer in time')), { once: true }),
    );
    const models = ModelsSchema.parse(await Promise.race([runtime.supportedModels(), timedOut]));
    const out = new Map<string, OfferedModel>();
    for (const m of models) {
      const id = m.resolvedModel ?? m.value;
      if (!out.has(id)) out.set(id, { id, label: m.displayName, efforts: [...(m.supportedEffortLevels ?? [])] });
    }
    return [...out.values()];
  } finally {
    clearTimeout(timer);
    release?.();
    runtime.close();
  }
}

// ---- usage probe: ported from jevellan runtimes/claude/src/control.ts at 8e2788ec (claudeUsage, probeClaude) -------
//
// Differences from the original, with reasons:
// - The probe model is the caller's (the provider's cheapest model from providers.json), not a fixed id: model ids are
//   the providers' (section 6.6), and the runtime names no model of its own.
// - The token comes from the caller (tokenFile, or the home's own login), read at the moment of use; it travels only
//   in the Authorization header, never in a log or an error.
// - Errors are short human text (no server body, which can echo request details).

export interface ClaudeUsage {
  observedAt: string;
  fiveHourPct?: number;
  weeklyPct?: number;
  fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
}

/** The account's five-hour and seven-day windows from the anthropic-ratelimit-unified-* response headers. */
export function claudeUsage(headers: Headers, now: Date = new Date()): ClaudeUsage | undefined {
  const window = (prefix: string) => {
    const raw = headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
    const value = raw === null || !raw.trim() ? NaN : Number(raw);
    const reset = headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
    const seconds = reset === null || !reset.trim() ? NaN : Number(reset);
    return {
      pct: Number.isFinite(value) && value >= 0 ? Math.min(100, Math.round(value * 1000) / 10) : undefined,
      reset: Number.isFinite(seconds) && seconds >= 0 && seconds < 8.64e12 ? new Date(seconds * 1000).toISOString() : undefined,
    };
  };
  const five = window('5h');
  const week = window('7d');
  if (five.pct === undefined && week.pct === undefined) return undefined;
  return {
    observedAt: now.toISOString(),
    ...(five.pct === undefined ? {} : { fiveHourPct: five.pct }),
    ...(week.pct === undefined ? {} : { weeklyPct: week.pct }),
    ...(five.reset ? { fiveHourResetsAt: five.reset } : {}),
    ...(week.reset ? { weeklyResetsAt: week.reset } : {}),
  };
}

export interface ClaudeProbe {
  auth: 'ready' | 'needs-login' | 'unknown';
  usage?: ClaudeUsage;
  /** Short human text, never server output or a credential. */
  error?: string;
}

export const ANTHROPIC_API = 'https://api.anthropic.com';
/** The identity line the subscription requires of OAuth requests. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface ProbeClaudeOptions {
  /** subscription: OAuth token on api.anthropic.com; endpoint: the key on the provider's Anthropic-compatible URL. */
  kind: 'subscription' | 'endpoint';
  token: string;
  model: string;
  /** Endpoint providers: the base URL (ANTHROPIC_BASE_URL). */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One-token Messages call that proves the login and, for a subscription, reads the account's usage windows from the
 * response headers. 401/403: needs-login; 2xx or 429: ready; anything else: unknown.
 */
export async function probeClaude(options: ProbeClaudeOptions): Promise<ClaudeProbe> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const subscription = options.kind === 'subscription';
  const base = subscription ? ANTHROPIC_API : (options.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return { auth: 'unknown', error: 'the provider has no base URL' };
  try {
    const response = await fetcher(`${base}/v1/messages`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${options.token}`,
        ...(subscription ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 1,
        ...(subscription ? { system: CLAUDE_CODE_IDENTITY } : {}),
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const usage = subscription ? claudeUsage(response.headers) : undefined;
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return { auth: 'needs-login', error: 'the provider refused this credential' };
    if (response.ok || response.status === 429) return { auth: 'ready', ...(usage ? { usage } : {}) };
    return { auth: 'unknown', ...(usage ? { usage } : {}), error: `the probe returned HTTP ${response.status}` };
  } catch {
    return { auth: 'unknown', error: 'the probe could not connect' };
  }
}
