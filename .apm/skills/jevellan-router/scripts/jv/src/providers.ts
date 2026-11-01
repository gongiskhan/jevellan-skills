// Providers: ~/.jv/providers.json (section 6.6), key files, the environment that carries a provider's login, and
// eligibility (ceiling and ranking), ported from jevellan packages/accounts/src/eligibility.ts.
//
// providers.json holds no secret. A provider's key lives in the file its keyFile (or, for a Claude subscription,
// tokenFile, D-003) names, mode 600; the file is read at the moment of use and its content only ever travels in a
// child process environment. "~/.jv/..." paths map onto JV_HOME (paths.resolveConfigPath).

import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { refused } from './errors.js';
import { paths, providerHomeProblem, resolveConfigPath } from './paths.js';
import type { ProviderUsageRow } from './types.js';

export const PROVIDER_KINDS = ['claude-subscription', 'claude-endpoint', 'codex-subscription', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Kinds that run Claude Code (claude-sdk, claude-tmux) under the provider's HOME. */
export const CLAUDE_KINDS: readonly ProviderKind[] = ['claude-subscription', 'claude-endpoint'];

/** Kinds billed per token: ranked after subscriptions (Jevellan's "metered" accounts). */
const METERED_BY_DEFAULT: readonly ProviderKind[] = ['claude-endpoint', 'openai-compatible'];

// ---- schema ------------------------------------------------------------------------------------------------

const text = z.string().trim().min(1);
const providerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, dot, dash or underscore');
const configPath = text;
const url = z.url({ protocol: /^https?$/ });

export const ModelSchema = z.strictObject({
  id: text,
  label: text,
  efforts: z.array(text).min(1),
  /** max_tokens of a chat/completions call (openai-compatible providers). */
  maxTokens: z.number().int().positive().optional(),
});
export type ProviderModel = z.infer<typeof ModelSchema>;

const SAME_AS = /^same as (\S+)$/;
const ModelsSchema = z.union([
  z.array(ModelSchema).min(1),
  z.string().regex(SAME_AS, 'a model list, or "same as <provider name>"'),
]);

const common = {
  name: providerName,
  enabled: z.boolean().default(true),
  ceilingPct: z.number().min(1).max(100).default(90),
  /** Metered providers only: 'never' keeps them out of the menu; 'when-subscriptions-run-out' only when no subscription is eligible. */
  paidUse: z.enum(['always', 'never', 'when-subscriptions-run-out']).default('always'),
  models: ModelsSchema,
};

const ClaudeSubscriptionSchema = z.strictObject({
  ...common,
  kind: z.literal('claude-subscription'),
  home: configPath,
  tokenFile: configPath.optional(),
});
const ClaudeEndpointSchema = z.strictObject({
  ...common,
  kind: z.literal('claude-endpoint'),
  /** Default ~/.jv/homes/<name> (section 6.6 shows endpoint entries without a home). */
  home: configPath.optional(),
  baseUrl: url,
  keyFile: configPath,
  metered: z.boolean().optional(),
});
const CodexSubscriptionSchema = z.strictObject({
  ...common,
  kind: z.literal('codex-subscription'),
  home: configPath,
});
const OpenAiCompatibleSchema = z.strictObject({
  ...common,
  kind: z.literal('openai-compatible'),
  baseUrl: url,
  keyFile: configPath.optional(),
  metered: z.boolean().optional(),
});

const ProviderSchema = z.discriminatedUnion('kind', [
  ClaudeSubscriptionSchema,
  ClaudeEndpointSchema,
  CodexSubscriptionSchema,
  OpenAiCompatibleSchema,
]);

const JevSchema = z.strictObject({
  keyFile: configPath,
  model: text,
  timeoutMs: z.number().int().positive().default(4000),
});

export const ProvidersFileSchema = z.strictObject({
  jev: JevSchema,
  providers: z.array(ProviderSchema).min(1),
});

// ---- resolved config ---------------------------------------------------------------------------------------

export interface JevConfig {
  /** Absolute path of the Jev key file. */
  keyFile: string;
  model: string;
  timeoutMs: number;
}

export interface Provider {
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  ceilingPct: number;
  paidUse: 'always' | 'never' | 'when-subscriptions-run-out';
  /** Billed per token (ranked after subscriptions). */
  metered: boolean;
  /** Absolute HOME of the provider's sessions (every kind but openai-compatible). */
  home?: string;
  baseUrl?: string;
  /** Absolute path of the key file (claude-endpoint, openai-compatible). */
  keyFile?: string;
  /** Absolute path of the OAuth token file (claude-subscription, D-003). */
  tokenFile?: string;
  models: ProviderModel[];
  /** Set when the models came from "same as <name>". */
  modelsFrom?: string;
}

export interface ProvidersConfig {
  file: string;
  jev: JevConfig;
  providers: Provider[];
}

function issueText(error: z.ZodError, raw: unknown): string {
  return error.issues
    .slice(0, 5)
    .map((i) => {
      const at = i.path.map((p) => {
        // Name the provider instead of its index when it has one.
        if (typeof p === 'number' && i.path[0] === 'providers') {
          const entry = (raw as { providers?: Array<{ name?: unknown }> }).providers?.[p];
          if (entry && typeof entry.name === 'string') return entry.name;
        }
        return String(p);
      });
      return `${at.join('.') || '(top)'}: ${i.message}`;
    })
    .join('; ');
}

/** Validates the parsed content of providers.json and resolves paths and "same as" model lists. */
export function parseProviders(raw: unknown, file: string = paths.providersFile): ProvidersConfig {
  const result = ProvidersFileSchema.safeParse(raw);
  if (!result.success) throw refused(`${file} is not valid: ${issueText(result.error, raw)}`);
  const data = result.data;

  const seen = new Set<string>();
  for (const p of data.providers) {
    if (seen.has(p.name)) throw refused(`${file} is not valid: provider name ${p.name} is used twice`);
    seen.add(p.name);
  }
  const byName = new Map(data.providers.map((p) => [p.name, p]));
  const resolveModels = (name: string, chain: string[]): ProviderModel[] => {
    const p = byName.get(name);
    if (!p) throw refused(`${file} is not valid: ${chain.at(-1)} has models "same as ${name}", and there is no provider ${name}`);
    if (Array.isArray(p.models)) return p.models;
    const target = SAME_AS.exec(p.models)![1]!;
    if (chain.includes(target)) throw refused(`${file} is not valid: "same as" loops through ${[...chain, target].join(' -> ')}`);
    return resolveModels(target, [...chain, target]);
  };

  const providers: Provider[] = data.providers.map((p) => {
    const models = resolveModels(p.name, [p.name]);
    const out: Provider = {
      name: p.name,
      kind: p.kind,
      enabled: p.enabled,
      ceilingPct: p.ceilingPct,
      paidUse: p.paidUse,
      metered: 'metered' in p && p.metered !== undefined ? p.metered : METERED_BY_DEFAULT.includes(p.kind),
      models: models.map((m) => ({ ...m, efforts: [...m.efforts] })),
    };
    if (typeof p.models === 'string') out.modelsFrom = SAME_AS.exec(p.models)![1]!;
    if ('home' in p && p.home !== undefined) out.home = resolveConfigPath(p.home);
    else if (p.kind === 'claude-endpoint') out.home = paths.providerHome(p.name);
    if (out.home !== undefined) {
      const problem = providerHomeProblem(out.home);
      if (problem) throw refused(`${file} is not valid: providers.${p.name}.home: ${problem}`);
    }
    if ('baseUrl' in p) out.baseUrl = p.baseUrl.replace(/\/+$/, '');
    if ('keyFile' in p && p.keyFile !== undefined) out.keyFile = resolveConfigPath(p.keyFile);
    if ('tokenFile' in p && p.tokenFile !== undefined) out.tokenFile = resolveConfigPath(p.tokenFile);
    return out;
  });

  return {
    file,
    jev: { keyFile: resolveConfigPath(data.jev.keyFile), model: data.jev.model, timeoutMs: data.jev.timeoutMs },
    providers,
  };
}

/** Loads ~/.jv/providers.json (or `file`). Exit 2 when it is missing or invalid. */
export function loadProviders(file: string = paths.providersFile): ProvidersConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw refused(`no providers file at ${file}; run jv update to write it from the template`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseProviders(raw, file);
}

export function findProvider(config: ProvidersConfig, name: string): Provider | undefined {
  return config.providers.find((p) => p.name === name);
}

/** Every model id the providers offer, in order, without repeats. */
export function allModelIds(config: ProvidersConfig): string[] {
  return [...new Set(config.providers.flatMap((p) => p.models.map((m) => m.id)))];
}

/**
 * The provider's cheapest model, for login probes: a Haiku model when the list has one, else the last model of the
 * list (templates list models strongest first).
 */
export function cheapestModel(p: Provider): ProviderModel {
  return p.models.find((m) => /haiku/i.test(m.id)) ?? p.models[p.models.length - 1]!;
}

// ---- key files ---------------------------------------------------------------------------------------------

export type KeyFileState = 'ok' | 'missing' | 'empty' | 'not-a-file' | 'mode';

export interface KeyFileStatus {
  file: string;
  state: KeyFileState;
  /** Octal permission bits, e.g. "600", when the file exists. */
  mode?: string;
}

/** Checks a key file without reading it: present, a regular file, not empty, mode 600. */
export function keyFileStatus(file: string): KeyFileStatus {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { file, state: 'missing' };
  }
  const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
  if (!st.isFile()) return { file, state: 'not-a-file', mode };
  if (st.size === 0) return { file, state: 'empty', mode };
  if ((st.mode & 0o077) !== 0) return { file, state: 'mode', mode };
  return { file, state: 'ok', mode };
}

/**
 * The trimmed content of a secret file, or undefined when it is missing, unreadable or empty. Callers pass the value
 * straight into a child environment or an HTTP header; it is never logged or returned to a user.
 */
export function readSecretFile(file: string): string | undefined {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** The key or token file a provider needs, if any (the file that makes it usable). */
export function providerSecretFile(p: Provider): string | undefined {
  return p.kind === 'claude-subscription' ? p.tokenFile : p.keyFile;
}

/** Whether the provider can authenticate as far as files go: its key/token file is fine, or it needs none. */
export function providerKeyReady(p: Provider): boolean {
  const file = providerSecretFile(p);
  return file === undefined || keyFileStatus(file).state === 'ok';
}

// ---- environment -------------------------------------------------------------------------------------------

export interface ProviderEnv {
  /** Variables that carry the provider's home and login. Values may be secrets: only for a child environment. */
  env: Record<string, string>;
  /** The key file that is missing or unreadable, when the login could not be built. */
  missing?: string;
}

/**
 * The provider's part of a child environment (D-003, D-004): HOME (and CODEX_HOME), plus
 * CLAUDE_CODE_OAUTH_TOKEN from tokenFile for a Claude subscription, or ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and
 * the ANTHROPIC_DEFAULT_*_MODEL ids for a Claude endpoint. CLAUDE_CONFIG_DIR is never set.
 */
export function providerEnv(p: Provider): ProviderEnv {
  const env: Record<string, string> = {};
  if (p.home !== undefined) env.HOME = p.home;
  if (p.kind === 'codex-subscription' && p.home !== undefined) env.CODEX_HOME = `${p.home}/.codex`;
  if (p.kind === 'claude-subscription' && p.tokenFile !== undefined) {
    const token = readSecretFile(p.tokenFile);
    if (token === undefined) return { env, missing: p.tokenFile };
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  if (p.kind === 'claude-endpoint') {
    const key = p.keyFile === undefined ? undefined : readSecretFile(p.keyFile);
    if (key === undefined) return { env, ...(p.keyFile ? { missing: p.keyFile } : {}) };
    env.ANTHROPIC_BASE_URL = p.baseUrl!;
    env.ANTHROPIC_AUTH_TOKEN = key;
    const ids = p.models.map((m) => m.id);
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = ids[0]!;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = ids[1] ?? ids[0]!;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ids[ids.length - 1]!;
  }
  return { env };
}

// ---- login state of the last probe (meta provider_auth:<name>) -------------------------------------------

export type ProviderAuthState = 'ready' | 'needs-login' | 'unknown';

export interface ProviderAuthRecord {
  auth: ProviderAuthState;
  observedAt: string;
  /** Short human reason (never a secret, never raw probe output). */
  detail?: string;
}

export const PROVIDER_AUTH_META_PREFIX = 'provider_auth:';

/** The meta key of a provider's last login probe. */
export function providerAuthKey(name: string): string {
  return `${PROVIDER_AUTH_META_PREFIX}${name}`;
}

interface MetaReader {
  listMeta(prefix?: string): Array<{ key: string; value: string }>;
}
interface MetaWriter {
  setMeta(key: string, value: string): void;
}

/** Records a login probe's result in meta (D-012). */
export function recordProviderAuth(store: MetaWriter, name: string, record: ProviderAuthRecord): void {
  store.setMeta(providerAuthKey(name), JSON.stringify(record));
}

/** Every recorded login probe, by provider name. Unreadable records are left out (the provider counts as unprobed). */
export function loadProviderAuthRecords(store: MetaReader): Record<string, ProviderAuthRecord> {
  const out: Record<string, ProviderAuthRecord> = {};
  for (const { key, value } of store.listMeta(PROVIDER_AUTH_META_PREFIX)) {
    try {
      const r = JSON.parse(value) as Partial<ProviderAuthRecord>;
      if ((r.auth === 'ready' || r.auth === 'needs-login' || r.auth === 'unknown') && typeof r.observedAt === 'string') {
        out[key.slice(PROVIDER_AUTH_META_PREFIX.length)] = {
          auth: r.auth,
          observedAt: r.observedAt,
          ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
        };
      }
    } catch {
      // not a record jv wrote
    }
  }
  return out;
}

/** The auth map rankProviders takes, from the recorded probes. */
export function loadProviderAuth(store: MetaReader): Record<string, ProviderAuthState> {
  return Object.fromEntries(Object.entries(loadProviderAuthRecords(store)).map(([k, v]) => [k, v.auth]));
}

// ---- eligibility (ported from jevellan packages/accounts/src/eligibility.ts rankAccounts) ------------------

export type ExclusionReason =
  | 'unsupported'
  | 'model-not-served'
  | 'disabled'
  | 'no-key'
  | 'needs-login'
  | 'usage-ceiling'
  | 'paid-not-allowed';

export interface RankedProvider {
  provider: Provider;
  usage?: ProviderUsageRow;
  eligible: boolean;
  reason: ExclusionReason | 'eligible';
  /** A current usage percentage is known (subscriptions only). */
  knownUsage: boolean;
  /** The higher of the current five-hour and weekly percentages (0 when unknown). */
  effectivePct: number;
  weeklyPct: number;
}

/**
 * The usage percentages that still apply: a percentage counts only until its window resets, so a row observed before
 * a reset says nothing about the window after it.
 */
export function currentUsage(
  row: ProviderUsageRow | undefined,
  now: number = Date.now(),
): { fiveHourPct?: number; weeklyPct?: number } {
  const current = (pct: number | null | undefined, reset: string | null | undefined) =>
    pct !== null && pct !== undefined && (!reset || Date.parse(reset) > now) ? pct : undefined;
  const fiveHourPct = current(row?.five_hour_pct, row?.five_hour_resets_at);
  const weeklyPct = current(row?.weekly_pct, row?.weekly_resets_at);
  return { ...(fiveHourPct === undefined ? {} : { fiveHourPct }), ...(weeklyPct === undefined ? {} : { weeklyPct }) };
}

/** The newest usage row per provider. */
export function latestUsageByProvider(rows: readonly ProviderUsageRow[]): Map<string, ProviderUsageRow> {
  const out = new Map<string, ProviderUsageRow>();
  for (const row of rows) {
    const prev = out.get(row.provider);
    if (!prev || row.observed_at > prev.observed_at) out.set(row.provider, row);
  }
  return out;
}

export interface RankInput {
  providers: readonly Provider[];
  /** provider_usage rows; the newest row per provider is used. */
  usage: readonly ProviderUsageRow[];
  /** Only providers serving this model id are eligible. */
  model?: string;
  /** Only these kinds are eligible (the runtime's kinds). */
  kinds?: readonly ProviderKind[];
  /**
   * Login state per provider name from the last probe (loadProviderAuth). Only 'ready' is eligible: a provider with
   * no recorded probe, or whose probe said needs-login or unknown, is excluded with 'needs-login' (section 7.2).
   */
  auth: Readonly<Record<string, ProviderAuthState>>;
  /** Whether a provider's key file is usable; default: the file on disk (providerKeyReady). */
  keyReady?: (p: Provider) => boolean;
  now?: number;
}

/**
 * Ranks providers for a placement. Excluded providers stay in the list with their reason, so the decision row can
 * say why a provider was not in the menu. A subscription at or over its ceilingPct in either current window is
 * excluded ('usage-ceiling'); endpoint and openai-compatible providers have no windows. Order: eligible first, then
 * subscriptions before metered providers, then known usage before unknown, then lower effective usage, then lower
 * weekly usage, then name.
 */
export function rankProviders(input: RankInput): RankedProvider[] {
  const now = input.now ?? Date.now();
  const keyReady = input.keyReady ?? providerKeyReady;
  const latest = latestUsageByProvider(input.usage);
  const base = input.providers.map((provider): RankedProvider => {
    const row = latest.get(provider.name);
    const usage = currentUsage(row, now);
    const hasWindows = provider.kind === 'claude-subscription' || provider.kind === 'codex-subscription';
    const windows = hasWindows
      ? [usage.fiveHourPct, usage.weeklyPct].filter((value): value is number => value !== undefined)
      : [];
    let reason: RankedProvider['reason'] = 'eligible';
    if (input.kinds && !input.kinds.includes(provider.kind)) reason = 'unsupported';
    else if (input.model && !provider.models.some((m) => m.id === input.model)) reason = 'model-not-served';
    else if (!provider.enabled) reason = 'disabled';
    else if (!keyReady(provider)) reason = 'no-key';
    else if (input.auth[provider.name] !== 'ready') reason = 'needs-login';
    else if (windows.some((value) => value >= provider.ceilingPct)) reason = 'usage-ceiling';
    return {
      provider,
      ...(row ? { usage: row } : {}),
      eligible: reason === 'eligible',
      reason,
      knownUsage: windows.length > 0,
      effectivePct: windows.length ? Math.max(...windows) : 0,
      weeklyPct: hasWindows ? (usage.weeklyPct ?? 0) : 0,
    };
  });
  // Paid use follows the provider's paidUse: never, or only when no subscription is eligible.
  const subscriptionReady = base.some((entry) => entry.eligible && !entry.provider.metered);
  for (const entry of base) {
    if (!entry.eligible || !entry.provider.metered) continue;
    const paidUse = entry.provider.paidUse;
    if (paidUse === 'never' || (paidUse === 'when-subscriptions-run-out' && subscriptionReady)) {
      entry.eligible = false;
      entry.reason = 'paid-not-allowed';
    }
  }
  return base.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      Number(a.provider.metered) - Number(b.provider.metered) ||
      Number(b.knownUsage) - Number(a.knownUsage) ||
      a.effectivePct - b.effectivePct ||
      a.weeklyPct - b.weeklyPct ||
      a.provider.name.localeCompare(b.provider.name),
  );
}
