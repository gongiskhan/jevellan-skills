// Codex control tests: the app-server JSON-RPC client and probeCodex against a fake `codex app-server` written by
// the test (a small Node script), so no real Codex runs and no login is read. Every token here is made up.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const C = await import('../src/codex-control.js');

const root = mkdtempSync(join(tmpdir(), 'jv-codex-control-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A fake app-server: answers initialize, account/read and account/rateLimits/read as `mode` says. */
function fakeCodex(mode: 'ready' | 'revoked' | 'no-account' | 'garbage' | 'silent'): string {
  const file = join(root, `codex-${mode}`);
  writeFileSync(
    file,
    `#!${process.execPath}
const mode = ${JSON.stringify(mode)};
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (mode === 'silent' && m.method !== 'initialize') return;
  if (m.method === 'initialize') { send({ method: 'remoteControl/status/changed', params: {} }); return send({ id: m.id, result: {} }); }
  if (mode === 'garbage') return process.stdout.write('not json\\n');
  if (m.method === 'account/read') {
    if (m.params.refreshToken !== false) return send({ id: m.id, error: { code: -1, message: 'refresh was requested' } });
    if (mode === 'no-account') return send({ id: m.id, result: { account: null, requiresOpenaiAuth: true } });
    return send({ id: m.id, result: { account: { type: 'chatgpt', email: 'someone@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true } });
  }
  if (m.method === 'account/rateLimits/read') {
    if (mode === 'revoked') return send({ id: m.id, error: { code: -32603, message: 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized' } });
    return send({ id: m.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1893456000 }, secondary: { usedPercent: 31, windowDurationMins: 300, resetsAt: null } } } });
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root };

describe('probeCodex', () => {
  test('ready: the plan and both windows, by window duration', async () => {
    const r = await C.probeCodex({ env, cwd: root, executable: fakeCodex('ready') });
    assert.equal(r.auth, 'ready');
    assert.equal(r.plan, 'pro');
    assert.equal(r.usage!.weeklyPct, 7);
    assert.equal(r.usage!.fiveHourPct, 31);
    assert.equal(r.usage!.weeklyResetsAt, new Date(1893456000 * 1000).toISOString());
    assert.equal(r.usage!.fiveHourResetsAt, undefined);
    assert.ok(!JSON.stringify(r).includes('someone@example.invalid'));
  });

  test('a stored login the server refuses is needs-login; the server text never leaves the module', async () => {
    const r = await C.probeCodex({ env, cwd: root, executable: fakeCodex('revoked') });
    assert.equal(r.auth, 'needs-login');
    assert.match(r.error!, /refused the stored login/);
    assert.ok(!r.error!.includes('chatgpt.com'));
  });

  test('no stored login is needs-login; an unreadable reply or a silent server is unknown', async () => {
    assert.equal((await C.probeCodex({ env, cwd: root, executable: fakeCodex('no-account') })).auth, 'needs-login');
    assert.equal((await C.probeCodex({ env, cwd: root, executable: fakeCodex('garbage') })).auth, 'unknown');
    const t0 = Date.now();
    const silent = await C.probeCodex({ env, cwd: root, executable: fakeCodex('silent'), requestTimeoutMs: 300 });
    assert.equal(silent.auth, 'unknown');
    assert.match(silent.error!, /timed out/);
    assert.ok(Date.now() - t0 < 5000);
  });

  test('a missing executable is reported as such', async () => {
    const r = await C.probeCodex({ env, cwd: root, executable: join(root, 'no-such-codex') });
    assert.equal(r.auth, 'unknown');
    assert.equal(r.error, 'codex is not on PATH');
  });
});

describe('codexUsage and isAuthError', () => {
  test('a snapshot for another limit, or without known windows, gives no usage', () => {
    assert.equal(C.codexUsage({ rateLimits: { limitId: 'other', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } } }), undefined);
    assert.equal(C.codexUsage({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: null } } }), undefined);
    assert.equal(C.codexUsage({ rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } } })!.fiveHourPct, 100);
  });

  test('the auth rule', () => {
    for (const m of ['401 Unauthorized', 'Please try signing in again.', 'token has expired', 'Not logged in', 'Invalid token · Please run /login', 'Invalid API key']) assert.ok(C.isAuthError(m), m);
    for (const m of ['429 Too Many Requests', 'connection reset']) assert.ok(!C.isAuthError(m), m);
  });
});
