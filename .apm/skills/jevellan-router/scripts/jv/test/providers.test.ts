// Providers tests: the template, validation, "same as" models, paths under JV_HOME, key files, the provider
// environment and the ported eligibility (ceiling and ranking). Runs against a temporary JV_HOME.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-providers-test-'));
process.env.JV_HOME = home;

const P = await import('../src/providers.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
type ProviderUsageRow = import('../src/types.js').ProviderUsageRow;

after(() => rmSync(home, { recursive: true, force: true }));

const templateFile = join(RUNTIME_ROOT, 'templates', 'providers.json');
const template = () => JSON.parse(readFileSync(templateFile, 'utf8')) as { jev: unknown; providers: Array<Record<string, unknown>> };

function isRefused(e: unknown, includes?: string): boolean {
  return e instanceof JvError && e.exitCode === 2 && (includes === undefined || e.message.includes(includes));
}

describe('providers.json', () => {
  test('the template validates and resolves', () => {
    const c = P.loadProviders(templateFile);
    assert.deepEqual(
      c.providers.map((p) => p.name),
      ['claude-main', 'claude-second', 'codex', 'glm', 'deepseek', 'kimi', 'ollama'],
    );
    const main = P.findProvider(c, 'claude-main')!;
    const second = P.findProvider(c, 'claude-second')!;
    assert.equal(second.modelsFrom, 'claude-main');
    assert.deepEqual(second.models, main.models);
    assert.equal(main.home, join(home, 'homes', 'claude-main'));
    assert.equal(c.jev.keyFile, join(home, 'secrets', 'jev.key'));
    assert.equal(c.jev.model, 'jev-latest');
    assert.equal(c.jev.timeoutMs, 4000);
    assert.equal(main.enabled, true);
    const glm = P.findProvider(c, 'glm')!;
    assert.equal(glm.kind, 'claude-endpoint');
    assert.equal(glm.baseUrl, 'https://api.z.ai/api/anthropic');
    assert.equal(glm.ceilingPct, 90);
    assert.equal(glm.metered, true);
    assert.equal(P.findProvider(c, 'ollama')!.metered, false);
    assert.equal(P.findProvider(c, 'ollama')!.keyFile, undefined);
    assert.equal(P.findProvider(c, 'kimi')!.baseUrl, 'https://api.moonshot.ai/v1');
    for (const name of ['deepseek', 'kimi', 'ollama']) {
      assert.ok(P.findProvider(c, name)!.models.every((m) => typeof m.maxTokens === 'number'), name);
    }
    assert.ok(P.allModelIds(c).includes('gpt-6-astra'));
    assert.equal(new Set(P.allModelIds(c)).size, P.allModelIds(c).length);
  });

  test('a claude-endpoint entry without a home gets ~/.jv/homes/<name> (the shape of section 6.6)', () => {
    const t = template();
    const glm = t.providers.find((p) => p.name === 'glm')!;
    delete glm.home;
    const c = P.parseProviders(t);
    assert.equal(P.findProvider(c, 'glm')!.home, join(home, 'homes', 'glm'));
  });

  test('a provider home must be inside $JV_HOME/homes, never the user home or a Jevellan folder', () => {
    const { homedir } = os;
    for (const bad of ['~', '~/.jevellan-hub/homes/claude/acc_X', '~/.jevellan', '/etc', '~/.jv', '~/.jv/homes', '~/.jv/secrets/x', '~/.jv/homes/../x']) {
      const t = template();
      t.providers[0]!.home = bad;
      assert.throws(() => P.parseProviders(t), (e) => isRefused(e, 'providers.claude-main.home'), bad);
    }
    const t = template();
    t.providers[0]!.home = join(home, 'homes', 'elsewhere-but-inside');
    assert.equal(P.parseProviders(t).providers[0]!.home, join(home, 'homes', 'elsewhere-but-inside'));
    // A symlink inside homes/ that points outside is refused too.
    mkdirSync(join(home, 'homes'), { recursive: true });
    symlinkSync(homedir(), join(home, 'homes', 'link-to-user-home'));
    const s = template();
    s.providers[0]!.home = join(home, 'homes', 'link-to-user-home');
    assert.throws(() => P.parseProviders(s), (e) => isRefused(e, 'home folder'));
  });

  test('"same as" must name a provider and must not loop', () => {
    const t = template();
    t.providers[1]!.models = 'same as nobody';
    assert.throws(() => P.parseProviders(t), (e) => isRefused(e, 'there is no provider nobody'));
    const loop = template();
    loop.providers[0]!.models = 'same as claude-second';
    assert.throws(() => P.parseProviders(loop), (e) => isRefused(e, 'loops'));
  });

  test('invalid entries are refused with the provider named', () => {
    const dup = template();
    dup.providers.push({ ...dup.providers[2]! });
    assert.throws(() => P.parseProviders(dup), (e) => isRefused(e, 'codex is used twice'));
    const extra = template();
    extra.providers[2]!.tokenFile = '~/.jv/secrets/codex.token';
    assert.throws(() => P.parseProviders(extra), (e) => isRefused(e, 'providers.codex'));
    const kind = template();
    kind.providers[0]!.kind = 'mystery';
    assert.throws(() => P.parseProviders(kind), (e) => isRefused(e));
    const noKey = template();
    delete noKey.providers[3]!.keyFile;
    assert.throws(() => P.parseProviders(noKey), (e) => isRefused(e, 'glm'));
    assert.throws(() => P.loadProviders(join(home, 'nope.json')), (e) => isRefused(e, 'jv update'));
  });

  test('tokenFile and enabled', () => {
    const t = template();
    t.providers[0]!.tokenFile = '~/.jv/secrets/claude-main.token';
    t.providers[1]!.enabled = false;
    const c = P.parseProviders(t);
    assert.equal(P.findProvider(c, 'claude-main')!.tokenFile, join(home, 'secrets', 'claude-main.token'));
    assert.equal(P.findProvider(c, 'claude-second')!.enabled, false);
  });

  test('cheapest model: Haiku when listed, else the last model', () => {
    const c = P.loadProviders(templateFile);
    assert.equal(P.cheapestModel(P.findProvider(c, 'claude-main')!).id, 'claude-haiku-5-5');
    assert.equal(P.cheapestModel(P.findProvider(c, 'claude-second')!).id, 'claude-haiku-5-5');
    assert.equal(P.cheapestModel(P.findProvider(c, 'codex')!).id, 'gpt-6-astra');
  });
});

describe('key files and the provider environment', () => {
  const secrets = join(home, 'secrets');
  mkdirSync(secrets, { recursive: true });
  const fake = 'fake-token-value-for-tests-0001';

  test('keyFileStatus checks presence, size and mode without reading', () => {
    const f = join(secrets, 'k1');
    assert.equal(P.keyFileStatus(f).state, 'missing');
    writeFileSync(f, '');
    chmodSync(f, 0o600);
    assert.equal(P.keyFileStatus(f).state, 'empty');
    writeFileSync(f, fake);
    chmodSync(f, 0o644);
    assert.deepEqual(P.keyFileStatus(f), { file: f, state: 'mode', mode: '644' });
    chmodSync(f, 0o600);
    assert.deepEqual(P.keyFileStatus(f), { file: f, state: 'ok', mode: '600' });
    assert.equal(P.keyFileStatus(secrets).state, 'not-a-file');
    assert.equal(P.readSecretFile(f), fake);
    assert.equal(P.readSecretFile(join(secrets, 'none')), undefined);
  });

  test('Claude subscription: token in the environment only', () => {
    const t = template();
    t.providers[0]!.tokenFile = '~/.jv/secrets/claude-main.token';
    const c = P.parseProviders(t);
    const main = P.findProvider(c, 'claude-main')!;
    assert.deepEqual(P.providerEnv(main), { env: { HOME: main.home }, missing: main.tokenFile });
    writeFileSync(main.tokenFile!, `${fake}\n`, { mode: 0o600 });
    assert.deepEqual(P.providerEnv(main).env, { HOME: main.home, CLAUDE_CODE_OAUTH_TOKEN: fake });
    assert.equal(P.providerEnv(P.findProvider(c, 'claude-second')!).env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    const codex = P.findProvider(c, 'codex')!;
    assert.deepEqual(P.providerEnv(codex).env, { HOME: codex.home, CODEX_HOME: `${codex.home}/.codex` });
  });

  test('Claude endpoint: base URL, auth token and default models', () => {
    const c = P.loadProviders(templateFile);
    const glm = P.findProvider(c, 'glm')!;
    assert.equal(P.providerEnv(glm).missing, glm.keyFile);
    writeFileSync(glm.keyFile!, fake, { mode: 0o600 });
    assert.deepEqual(P.providerEnv(glm).env, {
      HOME: glm.home,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: fake,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3',
    });
    assert.equal(P.providerKeyReady(glm), true);
    assert.equal(P.providerKeyReady(P.findProvider(c, 'deepseek')!), false);
    assert.equal(P.providerKeyReady(P.findProvider(c, 'ollama')!), true);
  });
});

describe('eligibility (ported rankAccounts)', () => {
  const c = P.loadProviders(templateFile);
  const now = Date.parse('2026-11-01T12:00:00Z');
  const future = '2026-11-05T00:00:00.000Z';
  const past = '2026-11-01T00:00:00.000Z';
  const row = (provider: string, weekly: number | null, five: number | null, extra: Partial<ProviderUsageRow> = {}): ProviderUsageRow => ({
    provider,
    observed_at: '2026-11-01T11:00:00.000Z',
    source: 'probe',
    five_hour_pct: five,
    weekly_pct: weekly,
    five_hour_resets_at: future,
    weekly_resets_at: future,
    local_week: null,
    local_input_tokens: null,
    local_output_tokens: null,
    local_cost_usd: null,
    ...extra,
  });
  const allKeys = () => true;
  const allReady = Object.fromEntries(c.providers.map((p) => [p.name, 'ready' as const]));

  test('a provider at or over its ceiling is excluded; the lower usage ranks first', () => {
    const ranked = P.rankProviders({
      providers: c.providers,
      usage: [row('claude-main', 90, 10), row('claude-second', 40, 5), row('codex', 20, 60)],
      keyReady: allKeys, auth: allReady,
      now,
    });
    const by = new Map(ranked.map((r) => [r.provider.name, r]));
    assert.equal(by.get('claude-main')!.reason, 'usage-ceiling');
    assert.equal(by.get('claude-main')!.eligible, false);
    assert.equal(ranked[0]!.provider.name, 'claude-second');
    assert.equal(ranked[1]!.provider.name, 'codex');
    assert.equal(by.get('codex')!.effectivePct, 60);
    // Metered providers come after the subscriptions, unknown usage after known.
    const order = ranked.filter((r) => r.eligible).map((r) => r.provider.name);
    assert.deepEqual(order.slice(0, 2), ['claude-second', 'codex']);
    assert.ok(order.indexOf('glm') > order.indexOf('codex'));
    assert.ok(ranked.at(-1)!.provider.name === 'claude-main');
  });

  test('a percentage counts only until its window resets', () => {
    const ranked = P.rankProviders({
      providers: c.providers,
      usage: [row('claude-main', 99, 99, { weekly_resets_at: past, five_hour_resets_at: past })],
      keyReady: allKeys, auth: allReady,
      now,
    });
    const main = ranked.find((r) => r.provider.name === 'claude-main')!;
    assert.equal(main.eligible, true);
    assert.equal(main.knownUsage, false);
    assert.deepEqual(P.currentUsage(row('x', 30, 50, { five_hour_resets_at: past }), now), { weeklyPct: 30 });
  });

  test('the newest row per provider is used', () => {
    const older = row('claude-main', 95, 0, { observed_at: '2026-11-01T09:00:00.000Z' });
    const newer = row('claude-main', 10, 0, { observed_at: '2026-11-01T11:30:00.000Z' });
    const r = P.rankProviders({ providers: c.providers, usage: [newer, older], keyReady: allKeys, auth: allReady, now });
    assert.equal(r.find((x) => x.provider.name === 'claude-main')!.reason, 'eligible');
  });

  test('model, kind, disabled, key, login and paid use exclusions', () => {
    const t = template();
    t.providers[1]!.enabled = false;
    t.providers[4]!.paidUse = 'never';
    t.providers[5]!.paidUse = 'when-subscriptions-run-out';
    const cfg = P.parseProviders(t);
    const r = P.rankProviders({
      providers: cfg.providers,
      usage: [],
      model: 'claude-opus-5-5',
      keyReady: allKeys, auth: allReady,
      now,
    });
    const reason = (n: string) => r.find((x) => x.provider.name === n)!.reason;
    assert.equal(reason('claude-main'), 'eligible');
    assert.equal(reason('claude-second'), 'disabled');
    assert.equal(reason('codex'), 'model-not-served');
    const all = P.rankProviders({ providers: cfg.providers, usage: [], keyReady: (p) => p.name !== 'glm', auth: { ...allReady, codex: 'needs-login' }, now });
    const why = (n: string) => all.find((x) => x.provider.name === n)!.reason;
    assert.equal(why('glm'), 'no-key');
    assert.equal(why('codex'), 'needs-login');
    assert.equal(why('deepseek'), 'paid-not-allowed');
    assert.equal(why('kimi'), 'paid-not-allowed');
    assert.equal(why('ollama'), 'eligible');
    const onlyCodex = P.rankProviders({ providers: cfg.providers, usage: [], kinds: ['codex-subscription'], keyReady: allKeys, auth: allReady, now });
    assert.deepEqual(onlyCodex.filter((x) => x.eligible).map((x) => x.provider.name), ['codex']);
    assert.equal(onlyCodex.find((x) => x.provider.name === 'claude-main')!.reason, 'unsupported');
    // A provider with no recorded probe, or whose probe could not tell, is not logged in (section 7.2).
    const unprobed = P.rankProviders({ providers: cfg.providers, usage: [], keyReady: allKeys, auth: { 'claude-main': 'ready', codex: 'unknown' }, now });
    const state = (n: string) => unprobed.find((x) => x.provider.name === n)!.reason;
    assert.equal(state('claude-main'), 'eligible');
    assert.equal(state('codex'), 'needs-login');
    assert.equal(state('glm'), 'needs-login');
    assert.equal(state('ollama'), 'needs-login');
  });

  test('login probes are recorded in meta and read back as the auth map', async () => {
    const { openStore } = await import('../src/store.js');
    const store = openStore({ file: join(home, 'auth-test.sqlite') });
    try {
      assert.deepEqual(P.loadProviderAuth(store), {});
      P.recordProviderAuth(store, 'claude-main', { auth: 'ready', observedAt: '2026-11-01T10:00:00.000Z', detail: 'probe answered' });
      P.recordProviderAuth(store, 'codex', { auth: 'needs-login', observedAt: '2026-11-01T10:00:01.000Z' });
      store.setMeta('provider_auth:broken', 'not json');
      assert.deepEqual(P.loadProviderAuth(store), { 'claude-main': 'ready', codex: 'needs-login' });
      assert.equal(P.loadProviderAuthRecords(store)['claude-main']!.detail, 'probe answered');
      P.recordProviderAuth(store, 'codex', { auth: 'ready', observedAt: '2026-11-01T11:00:00.000Z' });
      assert.equal(P.loadProviderAuth(store).codex, 'ready');
    } finally {
      store.close();
    }
  });

  test('when no subscription is eligible, "when-subscriptions-run-out" providers are allowed', () => {
    const t = template();
    t.providers[5]!.paidUse = 'when-subscriptions-run-out';
    // ollama is local and not metered: it counts as a free option, like a subscription.
    t.providers[6]!.enabled = false;
    const cfg = P.parseProviders(t);
    const r = P.rankProviders({
      providers: cfg.providers,
      usage: [row('claude-main', 95, 0), row('claude-second', 95, 0), row('codex', 100, 0)],
      keyReady: allKeys, auth: allReady,
      now,
    });
    assert.equal(r.find((x) => x.provider.name === 'kimi')!.eligible, true);
  });
});
