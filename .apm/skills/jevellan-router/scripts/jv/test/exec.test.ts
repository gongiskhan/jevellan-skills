// jv exec (D-007): the environment it builds (provider HOME and login, JV_SESSION, JV_PROJECT, PATH with
// $JV_HOME/bin), its cwd rule, its refusals, the child's exit code, and SIGTERM forwarding. Temporary JV_HOME, made-up
// secrets, no tmux, no model.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-exec-test-');
process.env.JV_HOME = home;
const { planExec, runExec } = await import('../src/exec.js');
const { openStore } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');
const { paths } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());
const repo = join(home, 'repos', 'sandbox');
mkdirSync(repo, { recursive: true });
const project = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;
const session = store.createSession({
  request_id: 'req-exec-1',
  project_id: project.id,
  kind: 'coordinator',
  runtime: 'claude-tmux',
  provider: 'claude-main',
  model: 'model-strong',
  effort: 'high',
  cwd: repo,
}).row;

const base = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'tmux-256color', COLORTERM: 'truecolor', SECRET_OF_PARENT: 'x' };

test('--session: the provider of the row, JV_SESSION, JV_PROJECT, its cwd, PATH with $JV_HOME/bin', () => {
  const plan = planExec(store, { sessionId: session.id, command: ['claude', '--model', 'x'] }, { base });
  assert.equal(plan.file, 'claude');
  assert.deepEqual(plan.args, ['--model', 'x']);
  assert.equal(plan.cwd, repo);
  assert.equal(plan.env.HOME, join(home, 'homes', 'claude-main'));
  assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
  assert.equal(plan.env.JV_SESSION, session.id);
  assert.equal(plan.env.JV_PROJECT, 'sandbox');
  assert.equal(plan.env.JV_HOME, home);
  assert.equal(plan.env.COLORTERM, 'truecolor');
  assert.equal(plan.env.TERM, 'tmux-256color');
  assert.equal(plan.env.SECRET_OF_PARENT, undefined, 'never the whole parent environment');
  assert.ok(plan.env.PATH!.split(delimiter).includes(paths.binDir));
  assert.ok(plan.env.PATH!.split(delimiter).includes('/usr/bin'));
  // the token is in the environment only, never in the command line
  assert.ok(![plan.file, ...plan.args].some((a) => a.includes(FAKE_TOKEN)));
});

test('--provider: no JV_SESSION; --project and --cwd; JV_PROJECT kept from the caller', () => {
  const plan = planExec(store, { providerName: 'claude-main', projectName: 'sandbox', cwd: '/tmp', command: ['sh'] }, { base });
  assert.equal(plan.env.JV_SESSION, undefined);
  assert.equal(plan.env.JV_PROJECT, 'sandbox');
  assert.equal(plan.cwd, '/tmp');
  const inherited = planExec(store, { providerName: 'claude-main', command: ['sh'] }, { base: { ...base, JV_PROJECT: 'other' } });
  assert.equal(inherited.env.JV_PROJECT, 'other');
  assert.equal(inherited.cwd, process.cwd());
});

test('--session and --provider together must agree', () => {
  const plan = planExec(store, { sessionId: session.id, providerName: 'claude-main', command: ['sh'] }, { base });
  assert.equal(plan.provider.name, 'claude-main');
  assert.throws(
    () => planExec(store, { sessionId: session.id, providerName: 'glm', command: ['sh'] }, { base }),
    (e: unknown) => e instanceof JvError && e.exitCode === 2 && /not glm/.test(e.message),
  );
});

test('refusals: no command, neither flag, unknown provider, unknown session or project', () => {
  const refusedWith = (code: number) => (e: unknown) => e instanceof JvError && e.exitCode === code;
  assert.throws(() => planExec(store, { providerName: 'claude-main', command: [] }, { base }), refusedWith(2));
  assert.throws(() => planExec(store, { command: ['sh'] }, { base }), refusedWith(2));
  assert.throws(() => planExec(store, { providerName: 'nope', command: ['sh'] }, { base }), refusedWith(2));
  assert.throws(() => planExec(store, { sessionId: 'R000000', command: ['sh'] }, { base }), refusedWith(3));
  assert.throws(() => planExec(store, { providerName: 'claude-main', projectName: 'nope', command: ['sh'] }, { base }), refusedWith(3));
});

test('runExec returns the child exit code, 127 for a missing command', async () => {
  const plan = planExec(store, { providerName: 'claude-main', command: ['sh', '-c', 'exit 7'] }, { base });
  assert.equal(await runExec(plan, { stdio: 'ignore' }), 7);
  const missing = planExec(store, { providerName: 'claude-main', command: ['jv-no-such-command-here'] }, { base });
  assert.equal(await runExec(missing, { stdio: 'ignore' }), 127);
  const signalled = planExec(store, { providerName: 'claude-main', command: ['sh', '-c', 'kill -KILL $$'] }, { base });
  assert.equal(await runExec(signalled, { stdio: 'ignore' }), 128 + 9);
});

const cliUrl = new URL('../src/cli.js', import.meta.url).href;
function jvArgs(argv: string[]): string[] {
  return [
    '--disable-warning=ExperimentalWarning',
    '--input-type=module',
    '-e',
    `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(${JSON.stringify(argv)});`,
  ];
}

test('jv exec through the CLI: the child sees the environment, stdio is inherited, the exit code passes through', () => {
  const r = spawnSync(
    process.execPath,
    jvArgs(['exec', '--session', session.id, '--', 'sh', '-c', 'printf "%s|%s|%s|%s" "$HOME" "$JV_SESSION" "$JV_PROJECT" "$PWD"; exit 3']),
    { env: { ...process.env, JV_HOME: home }, encoding: 'utf8' },
  );
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, `${join(home, 'homes', 'claude-main')}|${session.id}|sandbox|${repo}`);
});

test('SIGTERM to jv exec reaches the child', async () => {
  const child = spawn(
    process.execPath,
    jvArgs(['exec', '--provider', 'claude-main', '--', 'sh', '-c', 'sleep 30 & P=$!; trap "kill $P; exit 42" TERM; echo ready; wait']),
    { env: { ...process.env, JV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child never got ready')), 15_000);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('ready')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 42);
});
