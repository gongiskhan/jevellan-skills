// The worker environment (minimalEnvironment, D-004): only the listed variables, the provider's HOME and login, never
// the whole process environment.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_KEY, FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-env-test-');
process.env.JV_HOME = home;
const { minimalEnvironment, bootstrapNode } = await import('../src/env.js');
const { loadProviders, findProvider } = await import('../src/providers.js');
const { JvError } = await import('../src/errors.js');

after(() => rmSync(home, { recursive: true, force: true }));

const config = loadProviders();
const base: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/owner',
  USER: 'owner',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  SHELL: '/bin/zsh',
  TMPDIR: '/tmp',
  AWS_SECRET_ACCESS_KEY: 'must-not-pass',
  ANTHROPIC_API_KEY: 'must-not-pass-either',
  CLAUDE_CONFIG_DIR: '/somewhere',
  JV_SESSION: 'RCOORD1',
};
const node = '/opt/node22/bin/node';
const ownerHome = join(home, 'owner');
mkdirSync(join(ownerHome, '.cache', 'ms-playwright'), { recursive: true });

test('a Claude subscription: base keys, provider HOME, token from tokenFile, jv additions, nothing else', () => {
  const env = minimalEnvironment({
    provider: findProvider(config, 'claude-main')!,
    sessionId: 'R1A2B3C',
    base,
    nodeBinary: node,
    gitIdentity: { name: 'Owner Name', email: 'owner@example.test' },
    ownerHome,
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ENABLE_CLAUDEAI_MCP_SERVERS',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_NAME',
    'HOME',
    'JV_HOME',
    'JV_SESSION',
    'LANG',
    'PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
  ]);
  assert.equal(env.HOME, join(home, 'homes', 'claude-main'));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
  assert.equal(env.PATH, `/opt/node22/bin:${join(home, 'bin')}:/usr/local/bin:/usr/bin`);
  assert.equal(env.JV_SESSION, 'R1A2B3C');
  assert.equal(env.JV_HOME, home);
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(env.GIT_COMMITTER_NAME, 'Owner Name');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(ownerHome, '.cache', 'ms-playwright'));
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test('a Claude endpoint: base URL, auth token from keyFile and the default model ids', () => {
  const env = minimalEnvironment({ provider: findProvider(config, 'glm')!, sessionId: 'R2', base, nodeBinary: node, gitIdentity: {}, ownerHome: '/nowhere' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://endpoint.example.test/api/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, FAKE_KEY);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-big');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-mid');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-tiny');
  assert.equal(env.HOME, join(home, 'homes', 'glm'));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.GIT_AUTHOR_NAME, undefined);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, undefined);
});

test('a missing key file refuses with the file name and no content', () => {
  writeFileSync(join(home, 'secrets', 'glm.key'), '');
  try {
    assert.throws(
      () => minimalEnvironment({ provider: findProvider(config, 'glm')!, base, nodeBinary: node, gitIdentity: {} }),
      (e: unknown) => e instanceof JvError && e.exitCode === 2 && /glm\.key/.test(e.message),
    );
  } finally {
    writeFileSync(join(home, 'secrets', 'glm.key'), `${FAKE_KEY}\n`, { mode: 0o600 });
  }
});

test('PATH keeps no duplicates and JV_SESSION is only the given one', () => {
  const env = minimalEnvironment({
    provider: findProvider(config, 'claude-main')!,
    base: { PATH: `/opt/node22/bin:/usr/bin:${join(home, 'bin')}`, JV_SESSION: 'RCOORD1' },
    nodeBinary: node,
    gitIdentity: {},
  });
  assert.equal(env.PATH, `/opt/node22/bin:${join(home, 'bin')}:/usr/bin`);
  assert.equal(env.JV_SESSION, undefined);
});

test('the bootstrap node is the one install.json records, else this process', () => {
  assert.equal(bootstrapNode(join(home, 'no-install.json')), process.execPath);
  writeFileSync(join(home, 'install.json'), JSON.stringify({ nodePath: process.execPath }));
  assert.equal(bootstrapNode(join(home, 'install.json')), process.execPath);
  writeFileSync(join(home, 'install.json'), JSON.stringify({ nodePath: '/does/not/exist/node' }));
  assert.equal(bootstrapNode(join(home, 'install.json')), process.execPath);
  rmSync(join(home, 'install.json'));
});
