// Doctor tests: every check against a temporary JV_HOME with fake provider homes, a fake exec (no claude or codex
// is ever run) and a fake fetch (no network). Every key and token here is a fake value written by the test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jv-doctor-test-')));
const home = join(root, 'jvhome');
mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
process.env.JV_HOME = home;

const D = await import('../src/doctor.js');
const { seed } = await import('../src/seeds.js');
const { RUNTIME_ROOT, paths } = await import('../src/paths.js');
type ExecResult = import('../src/doctor.js').ExecResult;
type ExecOptions = import('../src/doctor.js').ExecOptions;
type CheckResult = import('../src/doctor.js').CheckResult;

after(() => rmSync(root, { recursive: true, force: true }));

const FAKE_JEV = 'fake-jev-key-for-doctor-tests-0001';
const FAKE_TOKEN = 'fake-claude-token-for-doctor-tests-0002';
writeFileSync(join(home, 'secrets', 'jev.key'), FAKE_JEV, { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'claude-main.token'), FAKE_TOKEN, { mode: 0o600 });

const version = (JSON.parse(readFileSync(join(RUNTIME_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const pkgSkills = join(root, 'pkg', '.apm', 'skills');
mkdirSync(join(root, 'pkg', '.apm', 'agents'), { recursive: true });
writeFileSync(join(root, 'pkg', '.apm', 'agents', 'jevellan-coordinator.agent.md'), '---\nname: jevellan-coordinator\n---\n');
const routerFile = join(home, 'skills', 'jevellan-router', 'SKILL.md');
function writeSkill(name: string, body: string, v = version): void {
  mkdirSync(join(home, 'skills', name), { recursive: true });
  writeFileSync(join(home, 'skills', name, 'SKILL.md'), `---\nname: ${name}\njv-version: ${v}\n---\n\n${body}\n`);
}
writeSkill('jevellan-router', 'Body written in phase 3.');
writeSkill('jevellan-duty-plan', 'Body written in phase 4.');

await seed({
  jvHome: home,
  runtimeDir: RUNTIME_ROOT,
  skillsDir: join(home, 'skills'),
  sourceSkillsDir: pkgSkills,
  nodePath: process.execPath,
});

// A project to run the doctor in, registered in the store (the hook line checks registered projects only).
const project = join(root, 'proj');
mkdirSync(project);
execFileSync('git', ['init', '-q', '-b', 'main', project]);
{
  const { openStore } = await import('../src/store.js');
  const store = openStore();
  store.createProject({ name: 'proj', path: project, default_branch: 'main' });
  store.close();
}
// A git repository that is not a registered project (this package's own checkout, say).
const unregistered = join(root, 'elsewhere');
mkdirSync(unregistered);
execFileSync('git', ['init', '-q', '-b', 'main', unregistered]);

interface Call {
  command: string;
  args: readonly string[];
  options: ExecOptions | undefined;
}

function fakeExec(overrides: Record<string, ExecResult> = {}) {
  const calls: Call[] = [];
  const exec = async (command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args, options });
    const key = `${command} ${args[0] ?? ''}`.trim();
    if (overrides[key]) return overrides[key]!;
    if (command === 'git') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
    if (command === 'tmux') return { code: 0, stdout: 'tmux 3.4\n', stderr: '' };
    if (command === 'claude' && args[0] === '--version') return { code: 0, stdout: '2.1.316 (Claude Code)\n', stderr: '' };
    if (command === 'claude' && args[0] === '-p') {
      return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }), stderr: '' };
    }
    if (command === 'codex' && args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.153.4\n', stderr: '' };
    if (command === 'codex' && args[0] === 'login') return { code: 1, stdout: '', stderr: 'Not logged in\n' };
    return { code: null, stdout: '', stderr: '', error: 'not-found' };
  };
  return { exec, calls };
}

const jevModels = { models: [{ name: 'jev-latest', description: 'Jev', release_date: '2026-10-01' }] };
function fakeFetch(body: unknown = jevModels, status = 200) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get('authorization') });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: f, seen };
}

type CodexProbe = import('../src/codex-control.js').CodexProbe;
type OfferedModel = import('../src/claude-control.js').OfferedModel;
type AuthRecord = import('../src/providers.js').ProviderAuthRecord;

const OFFERED: OfferedModel[] = ['claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-haiku-5-5'].map((id) => ({ id, label: id, efforts: ['low', 'high'] }));

function fakeCodex(result: CodexProbe = { auth: 'needs-login', error: 'no Codex login is stored in this home' }) {
  const calls: Array<{ env: Record<string, string>; cwd: string }> = [];
  return { probe: async (env: Record<string, string>, cwd: string) => (calls.push({ env, cwd }), result), calls };
}
function fakeModels(result: OfferedModel[] | Error = OFFERED) {
  const calls: Array<{ env: Record<string, string>; cwd: string }> = [];
  return {
    list: async (env: Record<string, string>, cwd: string) => {
      calls.push({ env, cwd });
      if (result instanceof Error) throw result;
      return result;
    },
    calls,
  };
}
function fakeRecorder() {
  const records = new Map<string, AuthRecord>();
  return { record: (name: string, r: AuthRecord) => void records.set(name, r), records };
}

function deps(over: Partial<import('../src/doctor.js').DoctorDeps> = {}) {
  return {
    codexProbe: fakeCodex().probe,
    claudeModels: fakeModels().list,
    recordAuth: fakeRecorder().record,
    exec: fakeExec().exec,
    fetch: fakeFetch().fetch,
    cwd: project,
    env: { PATH: '/usr/bin:/bin', USER: 'tester', LANG: 'C.UTF-8', SECRET_ELSEWHERE: 'not-for-children' },
    nodeVersion: '22.23.2',
    freeBytes: () => 400 * 1024 ** 3,
    probeTimeoutMs: 60_000,
    ...over,
  };
}

const byName = (rs: CheckResult[]) => new Map(rs.map((r) => [r.name, r]));

describe('jv doctor', () => {
  test('the full run: every check, in order, with the expected status', async () => {
    const fx = fakeExec();
    const ff = fakeFetch();
    const rec = fakeRecorder();
    const results = await D.runChecks([], deps({ exec: fx.exec, fetch: ff.fetch, recordAuth: rec.record }));
    const m = byName(results);
    const status = (n: string) => m.get(n)?.status;
    assert.equal(status('node'), 'OK');
    assert.equal(status('git'), 'OK');
    assert.equal(status('tmux'), 'OK');
    assert.equal(m.get('claude')!.detail, '2.1.316 (Claude Code)');
    assert.equal(status('codex'), 'OK');
    assert.equal(status('providers'), 'OK');
    assert.equal(status('key:claude-main'), 'OK');
    assert.equal(status('key:claude-second'), 'OK');
    assert.equal(m.get('key:glm')!.status, 'WARN');
    assert.match(m.get('key:glm')!.detail, /^key file missing/);
    assert.match(m.get('key:deepseek')!.detail, /^key file missing/);
    assert.equal(m.get('key:ollama')!.detail, 'no key needed');
    assert.equal(status('login:claude-main'), 'OK');
    assert.equal(m.get('login:claude-second')!.status, 'WARN');
    assert.match(m.get('login:claude-second')!.detail, /needs login/);
    assert.equal(m.get('login:claude-second')!.fix, 'jv providers login claude-second');
    assert.equal(m.get('login:codex')!.status, 'WARN');
    assert.equal(m.get('login:codex')!.detail, 'needs login: no Codex login is stored in this home');
    assert.equal(m.get('login:codex')!.fix, 'jv providers login codex');
    assert.equal(status('models:claude-main'), 'OK');
    assert.match(m.get('models:claude-main')!.detail, /all 4 models in providers.json are offered/);
    assert.match(m.get('models:glm')!.detail, /endpoint serves its configured models/);
    assert.equal(m.get('models:codex'), undefined);
    // Every probed login state is recorded for placement; providers that were not probed get no record.
    assert.deepEqual(Object.fromEntries([...rec.records].map(([k, v]) => [k, v.auth])), {
      'claude-main': 'ready',
      'claude-second': 'needs-login',
      codex: 'needs-login',
      glm: 'needs-login',
    });
    assert.equal(m.get('login:glm')!.status, 'WARN');
    assert.match(m.get('login:glm')!.detail, /key file missing/);
    assert.equal(m.get('login:deepseek'), undefined);
    assert.equal(status('jev'), 'OK');
    assert.match(m.get('jev')!.detail, /jev-latest listed/);
    assert.equal(status('store'), 'OK');
    assert.equal(status('disk'), 'OK');
    assert.equal(m.get('hook')!.status, 'WARN');
    assert.match(m.get('hook')!.fix!, /apm install gongiskhan\/jevellan-skills --target claude/);
    assert.equal(status('skills'), 'OK');
    assert.equal(status('skill-copies:project'), 'OK');
    assert.equal(status('skill-copies:claude-main'), 'OK');
    assert.equal(m.get('model-descriptions')!.status, 'WARN');
    assert.match(m.get('model-descriptions')!.detail, /no "## model descriptions" section yet/);
    // Order follows CHECKS.
    const groups = results.map((r) => r.name.split(':')[0]);
    assert.deepEqual([...new Set(groups)].slice(0, 7), ['node', 'git', 'tmux', 'claude', 'models', 'codex', 'providers']);
    assert.ok(!results.some((r) => r.status === 'FAIL'), JSON.stringify(results.filter((r) => r.status === 'FAIL')));
    // Jev got the key in the header, from the file.
    assert.deepEqual(ff.seen, [{ url: 'https://api.typesafe.ai/v1/models', auth: `Bearer ${FAKE_JEV}` }]);
  });

  test('the Claude probe: cheapest model, provider HOME, token only in the environment', async () => {
    const fx = fakeExec();
    await D.runChecks(['login:claude-main'], deps({ exec: fx.exec }));
    assert.equal(fx.calls.length, 1);
    const call = fx.calls[0]!;
    assert.equal(call.command, 'claude');
    assert.deepEqual(call.args, ['-p', 'Reply with the single word OK.', '--max-turns', '1', '--model', 'claude-haiku-5-5', '--output-format', 'json']);
    assert.ok(!call.args.join(' ').includes(FAKE_TOKEN));
    const env = call.options!.env!;
    assert.equal(env.HOME, paths.providerHome('claude-main'));
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(env.SECRET_ELSEWHERE, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(call.options!.timeoutMs, 60_000);
  });

  test('a failing probe is FAIL, with its output redacted', async () => {
    const fx = fakeExec({
      'claude -p': { code: 1, stdout: JSON.stringify({ is_error: true, result: `Invalid token ${FAKE_TOKEN} · Please run /login` }), stderr: '' },
    });
    const rec = fakeRecorder();
    const [r] = await D.runChecks(['login:claude-main'], deps({ exec: fx.exec, recordAuth: rec.record }));
    assert.equal(r!.status, 'FAIL');
    assert.equal(rec.records.get('claude-main')!.auth, 'needs-login');
    assert.ok(!r!.detail.includes(FAKE_TOKEN));
    assert.match(r!.detail, /\[redacted\]/);
    assert.equal(r!.fix, 'jv providers login claude-main');
    const timeout = fakeExec({ 'claude -p': { code: null, stdout: '', stderr: '', error: 'timeout' } });
    const [t] = await D.runChecks(['login:claude-main'], deps({ exec: timeout.exec, recordAuth: rec.record }));
    assert.equal(t!.status, 'FAIL');
    assert.equal(rec.records.get('claude-main')!.auth, 'unknown');
    assert.match(t!.detail, /within 60 s/);
  });

  test('the Codex probe: provider HOME and CODEX_HOME, ready with usage, revoked, unknown; tmux missing', async () => {
    const ready = fakeCodex({ auth: 'ready', plan: 'pro', usage: { observedAt: '2026-11-01T10:00:00.000Z', weeklyPct: 12 } });
    const fx = fakeExec({ 'tmux -V': { code: null, stdout: '', stderr: '', error: 'not-found' } });
    const rec = fakeRecorder();
    const m = byName(await D.runChecks(['login:codex', 'tmux'], deps({ exec: fx.exec, codexProbe: ready.probe, recordAuth: rec.record })));
    assert.equal(m.get('login:codex')!.status, 'OK');
    assert.equal(m.get('login:codex')!.detail, 'ready: ChatGPT pro answered account/rateLimits/read (week 12%)');
    assert.equal(ready.calls[0]!.env.HOME, paths.providerHome('codex'));
    assert.equal(ready.calls[0]!.env.CODEX_HOME, join(paths.providerHome('codex'), '.codex'));
    assert.equal(ready.calls[0]!.env.SECRET_ELSEWHERE, undefined);
    assert.equal(rec.records.get('codex')!.auth, 'ready');
    assert.equal(m.get('tmux')!.status, 'FAIL');
    // A stored login the server refuses (revoked, or rotated away by another holder) needs a login.
    const revoked = fakeCodex({ auth: 'needs-login', plan: 'pro', error: 'the server refused the stored login (revoked, expired or rotated away)' });
    const [r] = await D.runChecks(['login:codex'], deps({ codexProbe: revoked.probe, recordAuth: rec.record }));
    assert.equal(r!.status, 'WARN');
    assert.match(r!.detail, /^needs login: the server refused/);
    assert.equal(r!.fix, 'jv providers login codex');
    assert.equal(rec.records.get('codex')!.auth, 'needs-login');
    const unknown = fakeCodex({ auth: 'unknown', error: 'Codex control request timed out.' });
    const [u] = await D.runChecks(['login:codex'], deps({ codexProbe: unknown.probe, recordAuth: rec.record }));
    assert.match(u!.detail, /^login state unknown/);
    assert.equal(rec.records.get('codex')!.auth, 'unknown');
    const none = fakeExec({ 'codex --version': { code: null, stdout: '', stderr: '', error: 'not-found' } });
    assert.equal((await D.runChecks(['codex'], deps({ exec: none.exec })))[0]!.status, 'WARN');
  });

  test('the supportedModels probe: provider env, a model not offered is WARN, a probe that cannot run is FAIL', async () => {
    const fm = fakeModels(OFFERED.filter((x) => x.id !== 'claude-fable-5-1'));
    const [w] = await D.runChecks(['models:claude-main'], deps({ claudeModels: fm.list }));
    assert.equal(w!.status, 'WARN');
    assert.match(w!.detail, /not offered to this login: claude-fable-5-1/);
    assert.equal(fm.calls.length, 1);
    assert.equal(fm.calls[0]!.env.HOME, paths.providerHome('claude-main'));
    assert.equal(fm.calls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
    assert.equal(fm.calls[0]!.env.SECRET_ELSEWHERE, undefined);
    const broken = fakeModels(new Error(`spawn failed with ${FAKE_TOKEN}`));
    const [f] = await D.runChecks(['models:claude-main'], deps({ claudeModels: broken.list }));
    assert.equal(f!.status, 'FAIL');
    assert.match(f!.detail, /could not run/);
    assert.ok(!f!.detail.includes(FAKE_TOKEN));
    // claude-second has no token file in this home and no login: still probed, the SDK reports what it can.
    const all = byName(await D.runChecks(['models'], deps()));
    assert.deepEqual([...all.keys()], ['models:claude-main', 'models:claude-second', 'models:glm']);
  });

  test('a login state that cannot be recorded is still shown, as WARN', async () => {
    const [r] = await D.runChecks(['login:claude-main'], deps({ recordAuth: () => { throw new Error('the store is busy'); } }));
    assert.equal(r!.status, 'WARN');
    assert.match(r!.detail, /not recorded in the store: the store is busy/);
  });

  test('the default recorder writes provider_auth:<name> into the store meta', async () => {
    const rec = D.defaultDeps().recordAuth;
    rec('claude-main', { auth: 'ready', observedAt: '2026-11-01T10:00:00.000Z' });
    const { openStore } = await import('../src/store.js');
    const { loadProviderAuth } = await import('../src/providers.js');
    const store = openStore();
    try {
      assert.equal(loadProviderAuth(store)['claude-main'], 'ready');
    } finally {
      store.close();
    }
  });

  test('execCommand settles on exit even when a grandchild that left the group keeps the pipes open', async () => {
    const t0 = Date.now();
    const r = await D.execCommand('sh', ['-c', 'setsid sleep 20 & echo started'], { timeoutMs: 2000 });
    const took = Date.now() - t0;
    assert.equal(r.code, 0);
    assert.match(r.stdout, /started/);
    assert.ok(took < 2000, `took ${took} ms`);
    // A command that ignores SIGTERM and outlives its timeout settles after the SIGKILL grace.
    const t1 = Date.now();
    const slow = await D.execCommand('sh', ['-c', 'trap "" TERM; setsid sleep 20 & sleep 30'], { timeoutMs: 500 });
    const tookSlow = Date.now() - t1;
    assert.equal(slow.error, 'timeout');
    assert.equal(slow.code, null);
    assert.ok(tookSlow < 500 + D.EXEC_KILL_GRACE_MS + D.EXEC_DRAIN_MS + 1500, `took ${tookSlow} ms`);
  });

  test('Jev: no key, auth failure, model not listed', async () => {
    const keyFile = join(home, 'secrets', 'jev.key');
    const [authFail] = await D.runChecks(['jev'], deps({ fetch: fakeFetch({}, 401).fetch }));
    assert.equal(authFail!.status, 'FAIL');
    assert.equal(authFail!.detail, 'GET /v1/models: authentication failed');
    const other = { models: [{ name: 'jev-2', description: '', release_date: '2026-10-01' }] };
    const [notListed] = await D.runChecks(['jev'], deps({ fetch: fakeFetch(other).fetch }));
    assert.equal(notListed!.status, 'FAIL');
    assert.match(notListed!.detail, /jev-latest is not listed \(listed: jev-2\)/);
    chmodSync(keyFile, 0o644);
    assert.equal((await D.runChecks(['jev'], deps()))[0]!.status, 'FAIL');
    chmodSync(keyFile, 0o600);
    unlinkSync(keyFile);
    try {
      const [noKey] = await D.runChecks(['jev'], deps());
      assert.equal(noKey!.status, 'FAIL');
      assert.equal(noKey!.detail, 'no key configured');
    } finally {
      writeFileSync(keyFile, FAKE_JEV, { mode: 0o600 });
    }
  });

  test('the router policy model descriptions', async () => {
    const original = readFileSync(routerFile, 'utf8');
    try {
      writeSkill(
        'jevellan-router',
        '## model\nAsk.\n\n## model descriptions\nclaude-opus-5-5: Strong default.\ngpt-6-astra: Long runs.\n\n## effort\nx\n',
      );
      const [w] = await D.runChecks(['model-descriptions'], deps());
      assert.equal(w!.status, 'WARN');
      assert.match(w!.detail, /for: claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5, glm-5.3/);
      assert.ok(!w!.detail.includes('claude-opus-5-5,'));
      const all = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6-astra', 'glm-5.3', 'deepseek-chat', 'kimi-k2-turbo-preview', 'qwen3:8b'];
      writeSkill('jevellan-router', `## model descriptions\n${all.map((id) => `${id}: text`).join('\n')}\n`);
      const [o] = await D.runChecks(['model-descriptions'], deps());
      assert.equal(o!.status, 'OK');
      writeSkill('jevellan-router', `## model descriptions\n${[...all, 'gpt-old-1'].map((id) => `${id}: text`).join('\n')}\n`);
      const [stale] = await D.runChecks(['model-descriptions'], deps());
      assert.equal(stale!.status, 'WARN');
      assert.equal(stale!.detail, 'description lines for models no provider in providers.json has: gpt-old-1');
      assert.deepEqual([...D.policyModelDescriptions('## model descriptions\na: x\nb : y\n## next\nc: z')!.keys()], ['a']);
    } finally {
      writeFileSync(routerFile, original);
    }
  });

  test('skill versions and copies', async () => {
    writeSkill('jevellan-duty-plan', 'Body written in phase 4.', '0.0.9');
    try {
      const m = byName(await D.runChecks(['skills', 'skill-copies'], deps()));
      assert.equal(m.get('skills')!.status, 'WARN');
      assert.match(m.get('skills')!.detail, /jevellan-duty-plan 0\.0\.9/);
      assert.equal(m.get('skill-copies:claude-main')!.status, 'WARN');
      assert.match(m.get('skill-copies:claude-main')!.detail, /differ from .*: jevellan-duty-plan/);
    } finally {
      writeSkill('jevellan-duty-plan', 'Body written in phase 4.');
    }
    // A project install that differs.
    mkdirSync(join(project, '.claude', 'skills', 'jevellan-router'), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', 'jevellan-router', 'SKILL.md'), 'old copy\n');
    const [copy] = await D.runChecks(['skill-copies:project'], deps());
    assert.equal(copy!.status, 'WARN');
    assert.match(copy!.detail, /jevellan-router/);
  });

  test('the Stop hook in the project settings, APM form or absolute', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/.jv/runtime/dist/report-guard.mjs' }] }] } }),
    );
    assert.equal((await D.runChecks(['hook'], deps()))[0]!.status, 'OK');
    // A folder inside the registered project is checked against the project's settings too.
    mkdirSync(join(project, 'src'), { recursive: true });
    const nested = (await D.runChecks(['hook'], deps({ cwd: join(project, 'src') })))[0]!;
    assert.equal(nested.status, 'OK');
    assert.match(nested.detail, /is registered in/);
  });

  test('the hook line outside a registered project is OK and skipped, never "run apm install there"', async () => {
    for (const cwd of [unregistered, root, join(root, 'jvhome')]) {
      const [line] = await D.runChecks(['hook'], deps({ cwd }));
      assert.equal(line!.status, 'OK', cwd);
      assert.equal(line!.detail, 'not inside a registered project; skipped');
      assert.equal(line!.fix, undefined);
    }
    // A sibling folder whose name starts with the project's is not inside it.
    const sibling = `${project}-other`;
    mkdirSync(sibling, { recursive: true });
    assert.equal((await D.runChecks(['hook'], deps({ cwd: sibling })))[0]!.detail, 'not inside a registered project; skipped');
    assert.equal(D.registeredProjectAt(join(project, 'src'), [{ name: 'proj', path: project }])?.name, 'proj');
    assert.equal(D.registeredProjectAt(sibling, [{ name: 'proj', path: project }]), undefined);
  });

  test('disk, node and an invalid providers.json', async () => {
    assert.equal((await D.runChecks(['disk'], deps({ freeBytes: () => 2 * 1024 ** 3 })))[0]!.status, 'FAIL');
    assert.equal((await D.runChecks(['node'], deps({ nodeVersion: '20.19.4' })))[0]!.status, 'FAIL');
    const file = join(home, 'providers.json');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, '{"jev": {}}');
    try {
      const m = byName(await D.runChecks(['providers', 'keys', 'logins', 'jev'], deps()));
      for (const n of ['providers', 'keys', 'logins', 'jev']) assert.equal(m.get(n)!.status, 'FAIL', n);
    } finally {
      writeFileSync(file, original);
    }
  });

  test('runChecks selects groups and single results; unknown names throw', async () => {
    const rs = await D.runChecks(['jev', 'key:glm'], deps());
    assert.deepEqual(rs.map((r) => r.name), ['key:glm', 'jev']);
    await assert.rejects(D.runChecks(['nope'], deps()), /unknown doctor check: nope/);
    assert.equal(D.formatCheck({ name: 'key:glm', status: 'WARN', detail: 'key file missing (/x)', fix: 'write it' }), 'WARN key:glm: key file missing (/x) - fix: write it');
    assert.equal(D.formatCheck({ name: 'node', status: 'OK', detail: 'Node 22' }), 'OK   node: Node 22');
  });
});
