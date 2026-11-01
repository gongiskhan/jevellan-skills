// jv providers check and jv providers login with fakes (fetch, supportedModels, the Codex probe and model/list, a
// fake tmux runner): the header usage probe, login states and fixes, provider_usage and provider_auth rows, model
// lists filled from what the logins offer (providers.json rewritten only on change, mode 600), local rows for
// openai-compatible providers, Jev reachability, and the login session through jv exec.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_KEY, FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-providers-check-test-');
process.env.JV_HOME = home;
const FAKE_JEV = 'fake-jev-key-abcdefghijklmnop';
const FAKE_OPENAI = 'fake-openai-key-qrstuvwxyz0123';
writeFileSync(join(home, 'secrets', 'jev.key'), `${FAKE_JEV}\n`, { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'deepseek.key'), `${FAKE_OPENAI}\n`, { mode: 0o600 });
mkdirSync(join(home, 'homes', 'codex', '.codex'), { recursive: true });
mkdirSync(join(home, 'homes', 'claude-second', '.claude'), { recursive: true });
const file = join(home, 'providers.json');
const raw = JSON.parse(readFileSync(file, 'utf8')) as { jev: Record<string, unknown>; providers: Array<Record<string, unknown>> };
raw.providers.push(
  { name: 'claude-second', kind: 'claude-subscription', home: '~/.jv/homes/claude-second', models: 'same as claude-main' },
  { name: 'codex', kind: 'codex-subscription', home: '~/.jv/homes/codex', models: [{ id: 'gpt-placeholder', label: 'GPT', efforts: ['low', 'high'] }] },
  { name: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://chat.example.test', keyFile: '~/.jv/secrets/deepseek.key', models: [{ id: 'chat', label: 'Chat', efforts: ['low'] }] },
  { name: 'off', kind: 'openai-compatible', enabled: false, baseUrl: 'https://off.example.test', models: [{ id: 'x', label: 'X', efforts: ['low'] }] },
);
writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

const P = await import('../src/commands/providers.js');
const { openStore } = await import('../src/store.js');
const { loadProviderAuthRecords, loadProviders } = await import('../src/providers.js');

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());

interface Seen {
  url: string;
  auth?: string;
  body?: Record<string, unknown>;
}

function fakeFetch(seen: Seen[]) {
  return (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, ...(headers.authorization ?? headers.Authorization ? { auth: headers.authorization ?? headers.Authorization } : {}), ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
    if (url === 'https://api.anthropic.com/v1/messages') {
      return new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-7d-utilization': '0.48',
          'anthropic-ratelimit-unified-7d-reset': '1793000000',
          'anthropic-ratelimit-unified-5h-utilization': '0.12',
          'anthropic-ratelimit-unified-5h-reset': '1792000000',
        },
      });
    }
    if (url === 'https://endpoint.example.test/api/anthropic/v1/messages') return new Response('{}', { status: 401 });
    if (url === 'https://chat.example.test/models') return new Response('{"data":[]}', { status: 200 });
    if (url === 'https://api.typesafe.ai/v1/models') {
      return new Response(JSON.stringify({ models: [{ name: 'jev-test', description: 'Jev', release_date: '2026-10-01' }] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

test('fillModels: by id, else by family; keeps labels and efforts; drops what is not offered; lists the rest', () => {
  const f = P.fillModels(
    [
      { id: 'claude-opus-x', label: 'Opus', efforts: ['high', 'max'] },
      { id: 'model-small', label: 'Small', efforts: ['low'] },
      { id: 'gone-model', label: 'Gone', efforts: ['low'] },
    ],
    [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'model-small', label: 'Small' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    ],
  );
  assert.deepEqual(f.models, [
    { id: 'claude-opus-5-5', label: 'Opus', efforts: ['high', 'max'] },
    { id: 'model-small', label: 'Small', efforts: ['low'] },
  ]);
  assert.deepEqual(f.renamed, [{ from: 'claude-opus-x', to: 'claude-opus-5-5' }]);
  assert.deepEqual(f.removed, ['gone-model']);
  assert.deepEqual(f.alsoOffered, ['claude-opus-4-6']);
  assert.equal(f.changed, true);
  const none = P.fillModels([{ id: 'a', label: 'A', efforts: ['low'] }], [{ id: 'zzz', label: 'Zed' }]);
  assert.equal(none.changed, false);
  assert.deepEqual(none.models, [{ id: 'a', label: 'A', efforts: ['low'] }]);
});

test('check: probes, usage and auth rows, model lists, local rows, Jev; secrets only in headers', async () => {
  const seen: Seen[] = [];
  const envs: Array<Record<string, string>> = [];
  const result = await P.checkProviders(store, {
    fetch: fakeFetch(seen),
    env: { PATH: '/usr/bin' },
    providersFile: file,
    claudeModels: async (env) => {
      envs.push(env);
      return [
        { id: 'model-strong-2', label: 'Strong 2', efforts: ['low', 'high'] },
        { id: 'model-small', label: 'Small', efforts: ['low'] },
      ];
    },
    codexProbe: async () => ({ auth: 'ready', plan: 'pro', usage: { observedAt: new Date().toISOString(), weeklyPct: 31 } }),
    codexModels: async () => [{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high'] }],
  });
  const by = new Map(result.providers.map((p) => [p.name, p]));

  const main = by.get('claude-main')!;
  assert.equal(main.auth, 'ready');
  assert.deepEqual(main.usage, { weeklyPct: 48, fiveHourPct: 12, weeklyResetsAt: new Date(1793000000 * 1000).toISOString(), fiveHourResetsAt: new Date(1792000000 * 1000).toISOString() });
  assert.deepEqual(main.models!.ids, ['model-strong-2', 'model-small']);
  const probe = seen.find((s) => s.url === 'https://api.anthropic.com/v1/messages')!;
  assert.equal(probe.auth, `Bearer ${FAKE_TOKEN}`);
  assert.equal(probe.body!.model, 'model-small');
  assert.equal(probe.body!.max_tokens, 1);
  assert.equal(envs[0]!.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
  const usageRow = store.latestProviderUsage('claude-main', 'probe')!;
  assert.equal(usageRow.weekly_pct, 48);
  assert.equal(usageRow.five_hour_pct, 12);

  const second = by.get('claude-second')!;
  assert.equal(second.auth, 'needs-login');
  assert.equal(second.fix, 'jv providers login claude-second');

  const glm = by.get('glm')!;
  assert.equal(glm.auth, 'needs-login');
  assert.match(glm.fix ?? '', /write the key to .*glm\.key/);
  assert.equal(seen.find((s) => s.url.startsWith('https://endpoint.example.test'))!.auth, `Bearer ${FAKE_KEY}`);

  const codex = by.get('codex')!;
  assert.equal(codex.auth, 'ready');
  assert.equal(codex.usage!.weeklyPct, 31);
  assert.deepEqual(codex.models!.renamed, [{ from: 'gpt-placeholder', to: 'gpt-6.1-sol' }]);

  const ds = by.get('deepseek')!;
  assert.equal(ds.auth, 'ready');
  assert.equal(ds.local!.inputTokens, 0);
  assert.ok(store.latestProviderUsage('deepseek', 'local'));
  assert.equal(seen.find((s) => s.url === 'https://chat.example.test/models')!.auth, `Bearer ${FAKE_OPENAI}`);

  assert.equal(by.get('off')!.auth, 'disabled');
  assert.ok(!seen.some((s) => s.url.includes('off.example.test')));

  assert.deepEqual(result.jev, { reachable: true, model: 'jev-test', listed: true, detail: 'reachable, model jev-test listed' });

  const auth = loadProviderAuthRecords(store);
  assert.equal(auth['claude-main']!.auth, 'ready');
  assert.equal(auth['claude-second']!.auth, 'needs-login');
  assert.equal(auth.codex!.auth, 'ready');
  assert.equal(auth.off, undefined);

  // providers.json: model lists rewritten (claude-main, codex), "same as" kept, mode 600, other keys kept.
  assert.equal(result.providersFile.changed, true);
  const written = JSON.parse(readFileSync(file, 'utf8')) as { providers: Array<{ name: string; models: unknown; tokenFile?: string }> };
  const w = new Map(written.providers.map((p) => [p.name, p]));
  assert.deepEqual(w.get('claude-main')!.models, [
    { id: 'model-strong-2', label: 'Strong', efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'model-small', label: 'Small', efforts: ['low'] },
  ]);
  assert.equal(w.get('claude-main')!.tokenFile, '~/.jv/secrets/claude-main.token');
  assert.equal(w.get('claude-second')!.models, 'same as claude-main');
  assert.deepEqual(w.get('codex')!.models, [{ id: 'gpt-6.1-sol', label: 'GPT', efforts: ['low', 'high'] }]);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // No secret in the store or in the text output.
  const text = P.formatCheckResult(result);
  assert.match(text, /claude-main\s+ready\s+the probe answered; week 48%/);
  assert.match(text, /claude-second\s+needs login .*fix: jv providers login claude-second/);
  for (const secret of [FAKE_TOKEN, FAKE_KEY, FAKE_OPENAI, FAKE_JEV]) {
    assert.ok(!text.includes(secret));
    assert.ok(!JSON.stringify(store.listMeta('provider_auth:')).includes(secret));
  }

  // A second check with nothing new leaves the file alone.
  const before = statSync(file).mtimeMs;
  const again = await P.checkProviders(store, {
    fetch: fakeFetch([]),
    env: { PATH: '/usr/bin' },
    providersFile: file,
    claudeModels: async () => [
      { id: 'model-strong-2', label: 'Strong 2', efforts: ['low'] },
      { id: 'model-small', label: 'Small', efforts: ['low'] },
    ],
    codexProbe: async () => ({ auth: 'needs-login', error: 'the server refused the stored login' }),
    codexModels: async () => [],
  });
  assert.equal(again.providersFile.changed, false);
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(again.providers.find((p) => p.name === 'codex')!.fix, 'jv providers login codex');
});

test('a Claude home with its own login is probed with that token; no Jev key is "no key configured"', async () => {
  const h = join(home, 'homes', 'claude-second', '.claude', '.credentials.json');
  writeFileSync(h, JSON.stringify({ claudeAiOauth: { accessToken: 'home-access-token-0123456789', expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  rmSync(join(home, 'secrets', 'jev.key'));
  const seen: Seen[] = [];
  const r = await P.checkProviders(store, {
    fetch: fakeFetch(seen),
    env: { PATH: '/usr/bin' },
    providersFile: file,
    claudeModels: async () => [],
    codexProbe: async () => ({ auth: 'unknown' }),
    codexModels: async () => [],
  });
  assert.equal(r.providers.find((p) => p.name === 'claude-second')!.auth, 'ready');
  assert.ok(seen.some((s) => s.auth === 'Bearer home-access-token-0123456789'));
  assert.equal(r.jev.reachable, false);
  assert.equal(r.jev.detail, 'no key configured');
});

test('an unreachable endpoint that needs no key is told to start it or disable it, not to write a key', async () => {
  const f = join(home, 'providers-ollama.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { jev: Record<string, unknown>; providers: Array<Record<string, unknown>> };
  cfg.providers = [
    ...cfg.providers.filter((p) => p.kind === 'claude-subscription' && p.name === 'claude-main'),
    { name: 'ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'llama', label: 'Llama', efforts: ['low'] }] },
    { name: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://chat.example.test', keyFile: '~/.jv/secrets/missing.key', models: [{ id: 'chat', label: 'Chat', efforts: ['low'] }] },
  ];
  writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  const down = (async (u: string | URL | Request, init?: RequestInit) => {
    if (String(u).startsWith('http://127.0.0.1:9/')) throw new TypeError('fetch failed');
    return fakeFetch([])(u, init);
  }) as typeof fetch;
  const r = await P.checkProviders(store, { fetch: down, env: { PATH: '/usr/bin' }, providersFile: f, claudeModels: async () => [], codexProbe: async () => ({ auth: 'unknown' }), codexModels: async () => [] });
  const ollama = r.providers.find((p) => p.name === 'ollama')!;
  assert.equal(ollama.auth, 'unknown');
  assert.doesNotMatch(ollama.fix ?? '', /write the key/);
  assert.match(ollama.fix ?? '', /http:\/\/127\.0\.0\.1:9\/v1 is reachable .*"enabled": false for ollama/);
  const ds = r.providers.find((p) => p.name === 'deepseek')!;
  assert.equal(ds.auth, 'needs-login');
  assert.match(ds.fix ?? '', /write the key to .*secrets\/missing\.key/);
});

test('login: a tmux session jv-login-<name> through jv exec --provider; token and key providers refused', () => {
  const calls: string[][] = [];
  const live = new Set<string>();
  const tmux = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'has-session') return { status: live.has(String(args[2]).replace(/^=/, '')) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'new-session') live.add(args[3]!);
    return { status: 0, stdout: '', stderr: '' };
  };
  const providers = () => loadProviders(file);
  const r = P.loginProvider('codex', { tmux, providers, tty: false, insideTmux: false, codex: '/opt/codex' });
  assert.equal(r.tmuxTarget, 'jv-login-codex');
  assert.equal(r.created, true);
  assert.deepEqual(r.command, ['tmux', 'attach', '-t', '=jv-login-codex']);
  const created = calls.find((c) => c[0] === 'new-session')!;
  assert.deepEqual(created.slice(0, 6), ['new-session', '-d', '-s', 'jv-login-codex', '-c', join(home, 'homes', 'codex')]);
  const exec = created.indexOf('exec');
  assert.deepEqual(created.slice(exec), ['exec', '--provider', 'codex', '--', '/opt/codex', 'login']);
  const again = P.loginProvider('codex', { tmux, providers, tty: false });
  assert.equal(again.created, false);
  const second = P.loginProvider('claude-second', { tmux, providers, tty: false, insideTmux: false, claude: '/opt/claude' });
  assert.deepEqual(calls.filter((c) => c[0] === 'new-session').at(-1)!.slice(-5), ['exec', '--provider', 'claude-second', '--', '/opt/claude']);
  assert.equal(second.tmuxTarget, 'jv-login-claude-second');
  assert.throws(() => P.loginProvider('claude-main', { tmux, providers, tty: false }), /token file/);
  assert.throws(() => P.loginProvider('deepseek', { tmux, providers, tty: false }), /key file/);
  assert.throws(() => P.loginProvider('nobody', { tmux, providers, tty: false }), /no provider nobody/);
});

test('listCodexModels reads every page of model/list from codex app-server, default first, hidden left out', async () => {
  const { listCodexModels } = await import('../src/codex-control.js');
  const fake = join(home, 'fake-codex');
  writeFileSync(
    fake,
    `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
const pages = {
  '': { data: [
    { id: 'a', model: 'gpt-mini', displayName: 'GPT mini', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'h', model: 'gpt-hidden', displayName: 'Hidden', hidden: true, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ], nextCursor: 'p2' },
  p2: { data: [
    { id: 'b', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'weird' }] },
    { id: 'c', model: 'no-efforts', displayName: 'None', hidden: false, isDefault: false, supportedReasoningEfforts: [] },
  ], nextCursor: null },
};
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize' ? {} : m.method === 'model/list' ? pages[m.params.cursor || ''] : null;
  process.stdout.write(JSON.stringify(result === null ? { id: m.id, error: { code: -32601, message: 'no' } } : { id: m.id, result }) + '\\n');
});
`,
    { mode: 0o755 },
  );
  const models = await listCodexModels({ env: { PATH: process.env.PATH ?? '' }, cwd: home, executable: fake });
  assert.deepEqual(models, [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['high', 'xhigh'] },
    { id: 'gpt-mini', label: 'GPT mini', efforts: ['low'] },
  ]);
});

test('claudeUsage reads the unified five-hour and seven-day headers; nothing when they are absent', async () => {
  const { claudeUsage } = await import('../src/claude-control.js');
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal(claudeUsage(new Headers(), now), undefined);
  assert.deepEqual(claudeUsage(new Headers({ 'anthropic-ratelimit-unified-7d-utilization': '1.7' }), now), { observedAt: now.toISOString(), weeklyPct: 100 });
  assert.deepEqual(claudeUsage(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.0333', 'anthropic-ratelimit-unified-5h-reset': 'x' }), now), {
    observedAt: now.toISOString(),
    fiveHourPct: 3.3,
  });
});
