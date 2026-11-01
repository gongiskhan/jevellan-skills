// jv usage [--week W]: provider usage by week (provider_usage rows by source, and the token sums of the sessions
// started in the week). W is an ISO week (2026-W44) or a date in it; default the current week.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { loadProviders } from '../providers.js';
import { openStore } from '../store.js';
import { formatUsageWeek, parseWeek, usageForWeek } from '../usage.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const week = parseWeek(flagString(args, 'week') ?? args.positionals[0]);
  let names: string[] = [];
  try {
    names = loadProviders().providers.map((p) => p.name);
  } catch {
    // no providers.json: show what the store has
  }
  const store = openStore();
  try {
    const u = usageForWeek(store, week, names);
    io.result(u, () => formatUsageWeek(u));
    return 0;
  } finally {
    store.close();
  }
}
