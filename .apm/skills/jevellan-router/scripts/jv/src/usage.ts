// Provider usage by week (section 6.6, `jv usage`): ISO weeks, the token sums of a provider's sessions, the `local`
// provider_usage rows of openai-compatible providers, and the weekly view of every provider's rows.
//
// - Weeks are ISO 8601 weeks in UTC ("2026-W44", Monday 00:00 to the next Monday), the form `jv usage --week` takes.
// - Local rows: openai-compatible providers have no quota windows, so their usage is the sum of their sessions'
//   tokens and costs in the week, recorded as a provider_usage row with source `local` (local_week, local_*). A
//   subscription never gets a local row: placement reads the newest row per provider, and a row without percentages
//   would hide the last probe.

import { refused } from './errors.js';
import type { Store } from './store.js';
import type { ProviderUsageRow, SessionRow } from './types.js';

const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;

/** The ISO week of a date, "YYYY-Www" (UTC). */
export function isoWeek(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Start (Monday 00:00 UTC, inclusive) and end (next Monday, exclusive) of an ISO week, as ISO strings. */
export function weekRange(week: string): { week: string; from: string; to: string } {
  const m = WEEK.exec(week);
  if (!m) throw refused(`--week needs an ISO week like ${isoWeek()} or a date like 2026-11-01, not "${week}"`);
  const year = Number(m[1]);
  const n = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = Date.UTC(year, 0, 4) - ((jan4.getUTCDay() || 7) - 1) * DAY_MS;
  const from = monday1 + (n - 1) * 7 * DAY_MS;
  if (n < 1 || n > 53 || isoWeek(new Date(from)) !== week) throw refused(`there is no ISO week ${week}`);
  return { week, from: new Date(from).toISOString(), to: new Date(from + 7 * DAY_MS).toISOString() };
}

/** A --week value: an ISO week, or a date (the week containing it); default the current week. */
export function parseWeek(value: string | undefined, now: Date = new Date()): string {
  if (value === undefined || value.trim() === '') return isoWeek(now);
  const v = value.trim();
  if (WEEK.test(v)) return weekRange(v).week;
  if (/^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return isoWeek(new Date(v));
  throw refused(`--week needs an ISO week like ${isoWeek(now)} or a date like 2026-11-01, not "${v}"`);
}

export interface TokenSums {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the sessions' costs; null when no session has one. */
  costUsd: number | null;
}

/** A session belongs to the week it started in (a row that never started: the week of its last event). */
function inWeek(s: SessionRow, range: { from: string; to: string }): boolean {
  const at = s.started_at ?? s.last_event_at ?? s.ended_at;
  return at !== null && at >= range.from && at < range.to;
}

/** The token sums of sessions started in `week`, per provider (all providers when `provider` is omitted). */
export function weekTokenSums(store: Store, week: string, provider?: string): Map<string, TokenSums> {
  const range = weekRange(week);
  const out = new Map<string, TokenSums>();
  for (const s of store.listSessions()) {
    if (provider !== undefined && s.provider !== provider) continue;
    if (!inWeek(s, range)) continue;
    const sum = out.get(s.provider) ?? { sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
    sum.sessions++;
    sum.inputTokens += s.input_tokens;
    sum.outputTokens += s.output_tokens;
    sum.cacheReadTokens += s.cache_read_tokens;
    sum.cacheWriteTokens += s.cache_write_tokens;
    if (s.cost_usd !== null) sum.costUsd = Math.round(((sum.costUsd ?? 0) + s.cost_usd) * 1e6) / 1e6;
    out.set(s.provider, sum);
  }
  return out;
}

/** Writes the `local` usage row of an openai-compatible provider for `week` (default the current week). */
export function recordLocalUsage(store: Store, provider: string, week: string = isoWeek()): ProviderUsageRow {
  const sums = weekTokenSums(store, week, provider).get(provider);
  return store.recordProviderUsage({
    provider,
    source: 'local',
    local_week: week,
    local_input_tokens: (sums?.inputTokens ?? 0) + (sums?.cacheReadTokens ?? 0) + (sums?.cacheWriteTokens ?? 0),
    local_output_tokens: sums?.outputTokens ?? 0,
    local_cost_usd: sums?.costUsd ?? null,
  });
}

export interface ProviderWeek {
  provider: string;
  /** The newest row of each source observed in the week (local: the newest row for the week). */
  probe: ProviderUsageRow | null;
  stream: ProviderUsageRow | null;
  local: ProviderUsageRow | null;
  /** Number of usage rows observed in the week. */
  rows: number;
  /** Token sums of the provider's sessions started in the week. */
  sessions: TokenSums | null;
}

export interface UsageWeek {
  week: string;
  from: string;
  to: string;
  providers: ProviderWeek[];
}

/** Every provider's usage in `week`: its rows by source, and its sessions' token sums. */
export function usageForWeek(store: Store, week: string, providerNames: readonly string[] = []): UsageWeek {
  const range = weekRange(week);
  const rows = store.listProviderUsage({ since: range.from }).filter((r) => r.observed_at < range.to || r.local_week === week);
  const sums = weekTokenSums(store, week);
  const names = [...new Set([...providerNames, ...rows.map((r) => r.provider), ...sums.keys()])];
  const newest = (list: ProviderUsageRow[]) => list.reduce<ProviderUsageRow | null>((a, r) => (!a || r.observed_at > a.observed_at ? r : a), null);
  const providers = names.map((provider): ProviderWeek => {
    const mine = rows.filter((r) => r.provider === provider);
    const inside = mine.filter((r) => r.observed_at >= range.from && r.observed_at < range.to);
    return {
      provider,
      probe: newest(inside.filter((r) => r.source === 'probe')),
      stream: newest(inside.filter((r) => r.source === 'stream')),
      local: newest(mine.filter((r) => r.source === 'local' && r.local_week === week)),
      rows: inside.length,
      sessions: sums.get(provider) ?? null,
    };
  });
  return { week, from: range.from, to: range.to, providers };
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? 'unknown' : `${v}%`;
}

/** The text of `jv usage`. */
export function formatUsageWeek(u: UsageWeek): string {
  const lines = [`Usage for ${u.week} (${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}, UTC)`];
  if (u.providers.length === 0) lines.push('  no usage recorded');
  for (const p of u.providers) {
    const window = p.probe ?? p.stream;
    const quota =
      window && (window.weekly_pct !== null || window.five_hour_pct !== null)
        ? `week ${pct(window.weekly_pct)}, five hours ${pct(window.five_hour_pct)} (${window.source} ${window.observed_at})`
        : p.local
          ? `local ${p.local.local_input_tokens ?? 0} in, ${p.local.local_output_tokens ?? 0} out${p.local.local_cost_usd !== null ? `, $${p.local.local_cost_usd}` : ''}`
          : 'no quota observation';
    const s = p.sessions;
    const tokens = s
      ? `${s.sessions} sessions, ${s.inputTokens} in, ${s.outputTokens} out, cache ${s.cacheReadTokens} read ${s.cacheWriteTokens} write${s.costUsd !== null ? `, $${s.costUsd}` : ''}`
      : 'no sessions';
    lines.push(`  ${p.provider.padEnd(16)} ${quota}; ${tokens}`);
  }
  return lines.join('\n');
}
