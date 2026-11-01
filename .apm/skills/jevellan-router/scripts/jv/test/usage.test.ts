// ISO weeks, token sums per provider and week, local usage rows, the weekly view and `jv usage`.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-usage-test-');
process.env.JV_HOME = home;
const usage = await import('../src/usage.js');
const { openStore } = await import('../src/store.js');
const { main } = await import('../src/cli.js');

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);

test('ISO weeks: year boundaries, ranges, --week values', () => {
  assert.equal(usage.isoWeek(new Date('2026-11-01T12:00:00Z')), '2026-W44');
  assert.equal(usage.isoWeek(new Date('2026-11-02T00:00:00Z')), '2026-W45');
  assert.equal(usage.isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  assert.equal(usage.isoWeek(new Date('2024-12-30T00:00:00Z')), '2025-W01');
  assert.deepEqual(usage.weekRange('2026-W44'), { week: '2026-W44', from: '2026-10-26T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' });
  assert.equal(usage.parseWeek('2026-11-01'), '2026-W44');
  assert.equal(usage.parseWeek(undefined, new Date('2026-11-04T00:00:00Z')), '2026-W45');
  assert.throws(() => usage.parseWeek('last week'), /ISO week/);
  assert.throws(() => usage.weekRange('2025-W53'), /no ISO week/);
});

function run(provider: string, tokens: { i: number; o: number; r?: number; c?: number }) {
  const s = store.createSession({
    project_id: seeded.projectId,
    request_id: `req-usage-${Math.random()}`,
    kind: 'step',
    runtime: 'llm',
    provider,
    model: 'm',
    effort: 'low',
    cwd: seeded.repo,
  }).row;
  store.setSessionState(s.id, 'running', 'test');
  store.addSessionUsage(s.id, { input_tokens: tokens.i, output_tokens: tokens.o, cache_read_tokens: tokens.r ?? 0, ...(tokens.c !== undefined ? { cost_usd: tokens.c } : {}) });
  return s;
}

test('token sums per provider and the local row of a week', () => {
  run('deepseek', { i: 100, o: 10, r: 50, c: 0.01 });
  run('deepseek', { i: 200, o: 20, c: 0.02 });
  run('claude-main', { i: 5, o: 5 });
  const week = usage.isoWeek();
  const sums = usage.weekTokenSums(store, week);
  assert.deepEqual(sums.get('deepseek'), { sessions: 2, inputTokens: 300, outputTokens: 30, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 0.03 });
  const row = usage.recordLocalUsage(store, 'deepseek', week);
  assert.equal(row.source, 'local');
  assert.equal(row.local_week, week);
  assert.equal(row.local_input_tokens, 350);
  assert.equal(row.local_output_tokens, 30);
  assert.equal(row.local_cost_usd, 0.03);
  assert.equal(usage.weekTokenSums(store, '2020-W01').size, 0);
});

test('the weekly view keeps the newest probe, stream and local rows per provider', async () => {
  const now = new Date();
  store.recordProviderUsage({ provider: 'claude-main', source: 'probe', observed_at: new Date(now.getTime() - 60_000).toISOString(), weekly_pct: 40, five_hour_pct: 10 });
  store.recordProviderUsage({ provider: 'claude-main', source: 'probe', observed_at: now.toISOString(), weekly_pct: 48, five_hour_pct: 12 });
  store.recordProviderUsage({ provider: 'claude-main', source: 'stream', weekly_pct: 49 });
  const u = usage.usageForWeek(store, usage.isoWeek(), ['claude-main', 'codex']);
  const main1 = u.providers.find((p) => p.provider === 'claude-main')!;
  assert.equal(main1.probe!.weekly_pct, 48);
  assert.equal(main1.stream!.weekly_pct, 49);
  assert.equal(main1.rows, 3);
  assert.equal(main1.sessions!.sessions, 1);
  const codex = u.providers.find((p) => p.provider === 'codex')!;
  assert.equal(codex.probe, null);
  assert.equal(u.providers.find((p) => p.provider === 'deepseek')!.local!.local_input_tokens, 350);
  const text = usage.formatUsageWeek(u);
  assert.match(text, /claude-main\s+week 48%, five hours 12%/);
  assert.match(text, /codex\s+no quota observation; no sessions/);

  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await main(['usage', '--week', usage.isoWeek(), '--json']), 0);
  } finally {
    process.stdout.write = write;
  }
  const parsed = JSON.parse(out) as { week: string; providers: Array<{ provider: string }> };
  assert.equal(parsed.week, usage.isoWeek());
  assert.ok(parsed.providers.some((p) => p.provider === 'glm'));
});
