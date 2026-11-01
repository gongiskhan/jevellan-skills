// Redactor tests with made-up values in a temporary JV_HOME (no real secret is ever read here).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'jv-redact-test-'));
process.env.JV_HOME = home;
const { Redactor, redact, REDACTED, secretFilesFromProviders } = await import('../src/redact.js');

after(() => rmSync(home, { recursive: true, force: true }));

const FAKE_KEY = 'fake-key-0123456789abcdef';
const FAKE_TOKEN = 'fake-oauth-token-ZYXWVU987654';
const FAKE_ENV_VALUE = 'fake-env-value-555555';
const FAKE_OUTSIDE = 'fake-outside-secrets-424242';

mkdirSync(join(home, 'secrets'), { recursive: true });
writeFileSync(join(home, 'secrets', 'jev.key'), `${FAKE_KEY}\n`, { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'claude-main.token'), FAKE_TOKEN, { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'env.txt'), `export SOME_KEY="${FAKE_ENV_VALUE}"\nab\n`, { mode: 0o600 });
mkdirSync(join(home, 'elsewhere'));
writeFileSync(join(home, 'elsewhere', 'glm.key'), FAKE_OUTSIDE, { mode: 0o600 });
writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({
    jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-latest' },
    providers: [
      { name: 'glm', kind: 'claude-endpoint', keyFile: join(home, 'elsewhere', 'glm.key') },
      { name: 'claude-main', kind: 'claude-subscription', tokenFile: '~/.jv/secrets/claude-main.token' },
      { name: 'deepseek', kind: 'openai-compatible', keyFile: '~/.jv/secrets/missing.key' },
    ],
  }),
);

test('providers.json key and token files resolve ~/.jv onto JV_HOME', () => {
  const files = secretFilesFromProviders(join(home, 'providers.json'));
  assert.ok(files.includes(join(home, 'secrets', 'jev.key')));
  assert.ok(files.includes(join(home, 'secrets', 'claude-main.token')));
  assert.ok(files.includes(join(home, 'elsewhere', 'glm.key')));
});

test('every loaded value is masked, in text and in nested values', () => {
  const r = Redactor.load();
  const text = `key=${FAKE_KEY} token ${FAKE_TOKEN} env ${FAKE_ENV_VALUE} other ${FAKE_OUTSIDE}`;
  const masked = r.redact(text);
  for (const v of [FAKE_KEY, FAKE_TOKEN, FAKE_ENV_VALUE, FAKE_OUTSIDE]) assert.ok(!masked.includes(v));
  assert.equal(masked.split(REDACTED).length - 1, 4);
  assert.ok(r.leaks(text));
  assert.ok(!r.leaks(masked));
  const value = r.redactValue({ a: [FAKE_TOKEN], b: { c: `x ${FAKE_KEY} y` }, n: 3 });
  assert.deepEqual(value, { a: [REDACTED], b: { c: `x ${REDACTED} y` }, n: 3 });
});

test('very short values are not masked (they would mangle every text)', () => {
  assert.equal(Redactor.load().redact('ab cd ab'), 'ab cd ab');
});

test('the process redactor picks up a key file added later', () => {
  const later = 'fake-added-later-77777777';
  assert.equal(redact(`v ${later}`), `v ${later}`);
  writeFileSync(join(home, 'secrets', 'later.key'), later, { mode: 0o600 });
  assert.equal(redact(`v ${later}`), `v ${REDACTED}`);
});

test('OAuth logins in provider homes and archived login copies are masked, value by value', () => {
  // Made-up login files shaped like Codex auth.json and Claude .credentials.json.
  const codexAccess = 'fake-codex-access-token-aaaaaaaaaaaa';
  const codexRefresh = 'fake-codex-refresh-token-bbbbbbbbbbb';
  const codexId = 'fake-codex-id-token-cccccccccccccccccc';
  const claudeAccess = 'fake-claude-access-token-dddddddddddd';
  const claudeRefresh = 'fake-claude-refresh-token-eeeeeeeeeee';
  const archivedRefresh = 'fake-archived-refresh-token-ffffffffff';
  const endpointRefresh = 'fake-endpoint-home-refresh-gggggggggg';
  writeFileSync(
    join(home, 'providers.json'),
    JSON.stringify({
      jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-latest' },
      providers: [
        { name: 'codex', kind: 'codex-subscription', home: '~/.jv/homes/codex' },
        { name: 'claude-second', kind: 'claude-subscription', home: '~/.jv/homes/claude-second' },
        { name: 'glm', kind: 'claude-endpoint', keyFile: '~/.jv/secrets/glm.key' },
      ],
    }),
  );
  mkdirSync(join(home, 'homes', 'codex', '.codex'), { recursive: true });
  writeFileSync(
    join(home, 'homes', 'codex', '.codex', 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: codexId, access_token: codexAccess, refresh_token: codexRefresh, account_id: 'short' } }),
    { mode: 0o600 },
  );
  mkdirSync(join(home, 'homes', 'claude-second', '.claude'), { recursive: true });
  writeFileSync(
    join(home, 'homes', 'claude-second', '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: claudeAccess, refreshToken: claudeRefresh, scopes: ['user:inference'], subscriptionType: 'max' } }),
    { mode: 0o600 },
  );
  // A claude-endpoint without a home uses ~/.jv/homes/<name>, as parseProviders does.
  mkdirSync(join(home, 'homes', 'glm', '.claude'), { recursive: true });
  writeFileSync(join(home, 'homes', 'glm', '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: endpointRefresh } }), { mode: 0o600 });
  mkdirSync(join(home, 'archive', 'credentials'), { recursive: true });
  writeFileSync(join(home, 'archive', 'credentials', 'claude-second-x.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: archivedRefresh } }), { mode: 0o600 });

  const all = [codexAccess, codexRefresh, codexId, claudeAccess, claudeRefresh, archivedRefresh, endpointRefresh];
  const echoed = `cat auth.json: {"access_token":"${codexAccess}","refresh_token":"${codexRefresh}","id_token":"${codexId}"}\n` +
    `{"claudeAiOauth":{"accessToken":"${claudeAccess}","refreshToken":"${claudeRefresh}"}} ${archivedRefresh} ${endpointRefresh}`;
  const masked = redact(echoed);
  for (const v of all) assert.ok(!masked.includes(v), 'a login value leaked');
  assert.equal(masked.split(REDACTED).length - 1, all.length);
  // Short fields (plan names, scopes) are left alone.
  assert.equal(redact('max user:inference short'), 'max user:inference short');
});
