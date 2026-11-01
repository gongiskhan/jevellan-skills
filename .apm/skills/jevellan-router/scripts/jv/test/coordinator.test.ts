// jv coordinator (section 9.1, 9.5) against a fake tmux: the prompt file, the pre-accepted first-run dialogs, the
// sessions row and meta record, the tmux command (token never in argv), Remote Control by login kind, a foreign tmux
// session, stop (/exit, then kill), restart with the handoff, and lost detection. No real tmux, no model.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BYPASS_SCREEN, FakeTmux, READY_SCREEN, TRUST_SCREEN, writeCoordinatorHome } from './fixtures/coordinator-fixture.js';
import { FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-coordinator-test-');
writeCoordinatorHome(home);
process.env.JV_HOME = home;
const c = await import('../src/coordinator.js');
const { openStore } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');
const { loadProviders } = await import('../src/providers.js');
const { paths, RUNTIME_ROOT } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());

function project(name: string) {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  return store.createProject({ name, path: repo, default_branch: 'main' }).row;
}

function deps(tmux: FakeTmux, extra: Partial<Parameters<typeof c.startCoordinator>[2]> = {}) {
  return {
    tmux: tmux.run,
    jvCommand: '/opt/jv/bin/jv',
    claudePath: '/usr/bin/claude',
    sleep: async () => {},
    readyTimeoutMs: 50,
    stopWaitMs: 50,
    readCmdline: (pid: number) => tmux.cmdline(pid),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    ...extra,
  };
}

const claudeMainHome = join(home, 'homes', 'claude-main');

test('tmux names and targets', () => {
  assert.equal(c.coordinatorTmuxName('sandbox'), 'jv-coord-sandbox');
  assert.equal(c.coordinatorTmuxName('my.app'), 'jv-coord-my_app');
  assert.equal(c.paneTarget('jv-coord-sandbox'), '=jv-coord-sandbox:');
});

test('screenState reads the screens captured on dev-madrid', () => {
  assert.equal(c.screenState(READY_SCREEN), 'ready');
  assert.equal(c.screenState(TRUST_SCREEN), 'dialog');
  assert.equal(c.screenState(BYPASS_SCREEN), 'dialog');
  assert.equal(c.screenState(''), 'starting');
  assert.equal(c.screenState(undefined), 'gone');
});

test('the prompt fills every placeholder and appends the handoff', () => {
  const text = c.coordinatorPromptText({
    project: { name: 'sandbox', path: '/repos/sandbox', default_branch: 'trunk' },
    handoff: 'Tasks not done (0):\n- none',
  });
  assert.ok(!text.includes('{{'), text);
  assert.ok(!text.startsWith('---'), 'no frontmatter');
  assert.match(text, /coordinator of the project "sandbox" at \/repos\/sandbox/);
  assert.match(text, /default branch trunk/);
  assert.ok(text.includes(`${paths.shim} status --json`));
  assert.match(text, /# Handoff from your previous session\n\nTasks not done \(0\):\n- none\n$/);
});

test('preacceptDialogs writes the trust and bypass keys once and keeps every other key', () => {
  const h = join(home, 'homes', 'preaccept');
  mkdirSync(join(h, '.claude'), { recursive: true });
  writeFileSync(join(h, '.claude.json'), JSON.stringify({ userID: 'u1', numStartups: 4, projects: { '/other': { allowedTools: ['x'] } } }));
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, model: 'opus' }));
  const first = c.preacceptDialogs(h, ['/repos/a', '/real/a']);
  assert.deepEqual(first, { claudeJson: 'set', settings: 'set' });
  const config = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf8'));
  assert.equal(config.userID, 'u1');
  assert.equal(config.numStartups, 4);
  assert.equal(config.hasCompletedOnboarding, true);
  assert.deepEqual(config.projects['/other'], { allowedTools: ['x'] });
  assert.equal(config.projects['/repos/a'].hasTrustDialogAccepted, true);
  assert.equal(config.projects['/real/a'].hasTrustDialogAccepted, true);
  const settings = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.hooks, { Stop: [] });
  assert.equal(settings.model, 'opus');
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.deepEqual(c.preacceptDialogs(h, ['/repos/a', '/real/a']), { claudeJson: 'already', settings: 'already' });
  writeFileSync(join(h, '.claude.json'), 'not json');
  assert.throws(() => c.preacceptDialogs(h, ['/repos/a']), (e: unknown) => e instanceof JvError && e.exitCode === 2);
});

test('remoteControlPlan: a tokenFile login cannot use Remote Control; a full login gets the flag', () => {
  const providers = loadProviders();
  const main = providers.providers.find((p) => p.name === 'claude-main')!;
  const withToken = c.remoteControlPlan(main, { project: 'sandbox' });
  assert.equal(withToken.requested, false);
  assert.equal(withToken.state, 'unavailable');
  assert.equal(withToken.homeLogin, undefined);
  assert.ok(withToken.detail.includes(c.REMOTE_CONTROL_TOKEN_REFUSAL));
  assert.equal(withToken.ownerCommand, 'jv providers login claude-main', 'the one command the owner runs');
  assert.match(withToken.detail, /jv coordinator restart --project sandbox/);
  // The tokenFile and a login of the home's own (jv providers login): that login, with Remote Control.
  const own = c.remoteControlPlan(main, { ownLogin: true, project: 'sandbox' });
  assert.deepEqual([own.requested, own.state, own.homeLogin, own.name], [true, 'requested', true, 'jv-sandbox']);
  const { tokenFile: _t, ...full } = main;
  const withLogin = c.remoteControlPlan(full);
  assert.equal(withLogin.requested, true);
  assert.equal(withLogin.state, 'requested');
  assert.equal(withLogin.homeLogin, undefined, 'no tokenFile: nothing to leave out');
});

test('the prompt carries the project AGENTS.md, cut at 32 KiB', () => {
  const repo = join(home, 'repos', 'with-agents');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'AGENTS.md'), '# Working here\nUse pnpm, never npm.\n');
  const text = c.coordinatorPromptText({ project: { name: 'with-agents', path: repo, default_branch: 'main' }, handoff: 'none' });
  const at = text.indexOf(c.PROJECT_INSTRUCTIONS_HEADING);
  assert.ok(at > 0, 'an AGENTS.md section');
  assert.ok(text.indexOf('Use pnpm, never npm.') > at && text.indexOf('# Handoff from your previous session') > text.indexOf('Use pnpm'));
  writeFileSync(join(repo, 'AGENTS.md'), `${'x'.repeat(40 * 1024)}\nTAIL-MARK\n`);
  const cut = c.coordinatorPromptText({ project: { name: 'with-agents', path: repo, default_branch: 'main' }, handoff: 'none' });
  assert.ok(cut.includes('[AGENTS.md is longer than 32 KiB; the rest was cut. Read the file for the full text.]'));
  assert.ok(!cut.includes('TAIL-MARK'));
  // No AGENTS.md: no section.
  const none = c.coordinatorPromptText({ project: { name: 'sandbox', path: '/repos/none', default_branch: 'main' }, handoff: 'none' });
  assert.ok(!none.includes(c.PROJECT_INSTRUCTIONS_HEADING));
});

test('the coordinator skill and agent files keep identical bodies, and every --project example names the project', () => {
  const pkg = join(RUNTIME_ROOT, '..', '..', '..', '..');
  const body = (file: string) => {
    const text = readFileSync(file, 'utf8');
    return text.slice(text.indexOf('\n---\n', 4) + 5);
  };
  const skill = body(join(pkg, 'skills', 'jevellan-coordinator', 'SKILL.md'));
  assert.equal(body(join(pkg, 'agents', 'jevellan-coordinator.agent.md')), skill);
  for (const cmd of ['status --json', 'handoff', 'notes write', 'task create']) {
    const examples = skill.split('\n').filter((l) => l.startsWith(`{{jv}} ${cmd}`));
    assert.ok(examples.length > 0, cmd);
    for (const l of examples) assert.match(l, /--project \{\{project\}\}/, l);
  }
  assert.match(skill, /When the owner asks what your rules are or what you can do, answer with the jv commands you use, one line each with what it is for, then a short note on how you decide\./);
});

test('start: row, meta, prompt, pre-accepted dialogs and the tmux command; a second start is a no-op', async () => {
  const p = project('sandbox');
  const tmux = new FakeTmux();
  const r = await c.startCoordinator(store, 'sandbox', deps(tmux));
  assert.equal(r.started, true);
  assert.equal(r.running, true);
  assert.equal(r.screen, 'ready');
  assert.equal(r.tmuxSession, 'jv-coord-sandbox');

  const session = store.getSession(r.sessionId!)!;
  assert.equal(session.kind, 'coordinator');
  assert.equal(session.runtime, 'claude-tmux');
  assert.equal(session.provider, 'claude-main');
  assert.equal(session.model, 'claude-opus-5-5');
  assert.equal(session.effort, 'high');
  assert.equal(session.cwd, p.path);
  assert.equal(session.state, 'running');
  assert.equal(session.tmux_target, '=jv-coord-sandbox:');
  assert.match(session.native_session_id!, /^[0-9a-f-]{36}$/);
  assert.equal(session.pid, tmux.sessions.get('jv-coord-sandbox')!.pid);

  const record = c.readCoordinatorRecord(store, p.id)!;
  assert.equal(record.sessionId, session.id);
  assert.equal(record.tmuxSession, 'jv-coord-sandbox');
  assert.equal(record.remoteControl.state, 'unavailable');

  const fake = tmux.sessions.get('jv-coord-sandbox')!;
  assert.equal(fake.cwd, p.path);
  assert.ok(fake.env.includes('PATH=/usr/local/bin:/usr/bin:/bin'));
  assert.deepEqual(fake.command.slice(0, 7), ['/opt/jv/bin/jv', 'exec', '--session', session.id, '--project', 'sandbox', '--']);
  const claudeArgs = fake.command.slice(7);
  assert.equal(claudeArgs[0], '/usr/bin/claude');
  assert.ok(!claudeArgs.includes('--remote-control'), 'no --remote-control for a tokenFile login');
  assert.ok(!fake.command.includes('--home-login'), 'the token login: no --home-login');
  assert.deepEqual(claudeArgs.slice(-2), ['--setting-sources', 'user'], "no CLAUDE.md or rules of the checkout's ancestor folders");
  const flag = (f: string) => claudeArgs[claudeArgs.indexOf(f) + 1];
  assert.equal(flag('--model'), 'claude-opus-5-5');
  assert.equal(flag('--effort'), 'high');
  assert.equal(flag('--permission-mode'), 'bypassPermissions');
  assert.equal(flag('--session-id'), session.native_session_id);
  assert.equal(flag('--append-system-prompt-file'), paths.coordinatorPrompt('sandbox'));
  for (const call of tmux.calls) assert.ok(!call.join(' ').includes(FAKE_TOKEN), 'the token never reaches tmux');

  const prompt = readFileSync(paths.coordinatorPrompt('sandbox'), 'utf8');
  assert.match(prompt, /coordinator of the project "sandbox"/);
  assert.match(prompt, /# Handoff from your previous session/);
  assert.ok(!prompt.includes('{{'));

  const config = JSON.parse(readFileSync(join(claudeMainHome, '.claude.json'), 'utf8'));
  assert.equal(config.projects[p.path].hasTrustDialogAccepted, true);
  const settings = JSON.parse(readFileSync(join(claudeMainHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.skipDangerousModePermissionPrompt, true);

  const again = await c.startCoordinator(store, 'sandbox', deps(tmux));
  assert.equal(again.started, false);
  assert.equal(again.sessionId, session.id);
  assert.equal(tmux.history.length, 1);

  const stopped = await c.stopCoordinator(store, 'sandbox', deps(tmux));
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.killed, false);
  assert.deepEqual(fake.submitted, ['/exit']);
  assert.equal(store.getSession(session.id)!.state, 'stopped');
  assert.ok(c.readCoordinatorRecord(store, p.id)!.stoppedAt);
  assert.equal(c.liveCoordinator(store, p.id, tmux.run), undefined);
  const twice = await c.stopCoordinator(store, 'sandbox', deps(tmux));
  assert.equal(twice.stopped, false);
});

test('a full login gets --remote-control jv-<project>', async () => {
  project('rc');
  const tmux = new FakeTmux();
  const providers = loadProviders();
  providers.providers = providers.providers.map((p) => {
    if (p.name !== 'claude-main') return p;
    const { tokenFile: _t, ...rest } = p;
    return rest;
  });
  const r = await c.startCoordinator(store, 'rc', deps(tmux, { providers }));
  const args = tmux.sessions.get('jv-coord-rc')!.command;
  assert.equal(args[args.indexOf('--remote-control') + 1], 'jv-rc');
  assert.ok(!args.includes('--home-login'));
  assert.equal(r.remoteControl!.state, 'requested');
  await c.stopCoordinator(store, 'rc', deps(tmux));
});

test('a tokenFile plus a login jv did not seed: the coordinator runs on that login with Remote Control', async () => {
  const credentials = join(claudeMainHome, '.claude', '.credentials.json');
  mkdirSync(join(claudeMainHome, '.claude'), { recursive: true });
  const login = JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access-for-coordinator-test-0001' } });
  writeFileSync(credentials, login, { mode: 0o600 });
  try {
    // A copy the seed made (and never archived) is not a login of the home's own: the token, no Remote Control.
    project('seededlogin');
    const seededTmux = new FakeTmux();
    const seededLogin = { 'claude-main': { source: '/elsewhere', at: '2026-11-01T00:00:00.000Z', files: [{ from: '/elsewhere/.credentials.json', to: credentials, bytes: Buffer.byteLength(login) }] } };
    const seeded = await c.startCoordinator(store, 'seededlogin', deps(seededTmux, { seedsApplied: seededLogin }));
    assert.equal(seeded.remoteControl!.state, 'unavailable');
    assert.ok(!seededTmux.sessions.get('jv-coord-seededlogin')!.command.includes('--home-login'));
    await c.stopCoordinator(store, 'seededlogin', deps(seededTmux));

    // The owner's own login (nothing seeded there, or the seeded copy archived since): --home-login and the flag.
    project('ownlogin');
    const tmux = new FakeTmux();
    const archived = { 'claude-main': { ...seededLogin['claude-main'], archived: [{ from: credentials, to: '/archive/x', at: '2026-11-01T00:00:01.000Z', why: 'test' }] } };
    for (const [i, seedsApplied] of [{}, archived].entries()) {
      const r = await c.startCoordinator(store, 'ownlogin', deps(tmux, { seedsApplied }));
      const command = tmux.sessions.get('jv-coord-ownlogin')!.command;
      const dashes = command.indexOf('--');
      assert.deepEqual(command.slice(0, dashes + 1), ['/opt/jv/bin/jv', 'exec', '--session', r.sessionId!, '--project', 'ownlogin', '--home-login', '--'], `case ${i}`);
      assert.equal(command[command.indexOf('--remote-control') + 1], 'jv-ownlogin');
      assert.deepEqual([r.remoteControl!.requested, r.remoteControl!.homeLogin, r.remoteControl!.state], [true, true, 'requested']);
      for (const call of tmux.calls) assert.ok(!call.join(' ').includes(FAKE_TOKEN));
      await c.stopCoordinator(store, 'ownlogin', deps(tmux));
    }
  } finally {
    rmSync(credentials, { force: true });
  }
});

test('status: a token coordinator prints the one login command; after that login, the restart', async () => {
  project('rcstatus');
  const tmux = new FakeTmux();
  await c.startCoordinator(store, 'rcstatus', deps(tmux, { seedsApplied: {} }));
  const text = c.formatStatus(c.coordinatorStatus(store, 'rcstatus', deps(tmux, { seedsApplied: {} })));
  assert.match(text, /^Remote Control: unavailable\./m);
  assert.match(text, /^To turn it on: jv providers login claude-main$/m);
  const credentials = join(claudeMainHome, '.claude', '.credentials.json');
  writeFileSync(credentials, '{}', { mode: 0o600 });
  try {
    const after = c.coordinatorStatus(store, 'rcstatus', deps(tmux, { seedsApplied: {} }));
    assert.equal(after.remoteControl!.ownerCommand, 'jv coordinator restart --project rcstatus');
    assert.match(after.remoteControl!.detail, /now has a login of its own/);
  } finally {
    rmSync(credentials, { force: true });
  }
  await c.stopCoordinator(store, 'rcstatus', deps(tmux));
});

test('a foreign tmux session of our name is refused and left alone', async () => {
  project('foreign');
  const tmux = new FakeTmux();
  tmux.addForeign('jv-coord-foreign');
  await assert.rejects(
    c.startCoordinator(store, 'foreign', deps(tmux)),
    (e: unknown) => e instanceof JvError && e.exitCode === 2 && /not this project's jv coordinator/.test(e.message),
  );
  const status = c.coordinatorStatus(store, 'foreign', deps(tmux));
  assert.equal(status.running, false);
  assert.equal(status.foreign, true);
  await assert.rejects(c.stopCoordinator(store, 'foreign', deps(tmux)), (e: unknown) => e instanceof JvError && e.exitCode === 2);
  assert.ok(tmux.sessions.has('jv-coord-foreign'));
  assert.ok(!tmux.calls.some((a) => a[0] === 'kill-session' || (a[0] === 'send-keys' && a.includes('/exit'))));
});

test('stop kills the session when /exit does not end it within the wait', async () => {
  project('stubborn');
  const tmux = new FakeTmux();
  tmux.exitOnSlashExit = false;
  await c.startCoordinator(store, 'stubborn', deps(tmux));
  const r = await c.stopCoordinator(store, 'stubborn', deps(tmux));
  assert.equal(r.killed, true);
  assert.ok(!tmux.sessions.has('jv-coord-stubborn'));
  assert.match(store.getSession(r.sessionId!)!.state_reason, /killed/);
});

test('a dialog on screen is reported; a coordinator that exits at once fails its row', async () => {
  project('dialog');
  const tmux = new FakeTmux();
  tmux.startScreen = TRUST_SCREEN;
  const r = await c.startCoordinator(store, 'dialog', deps(tmux));
  assert.equal(r.screen, 'dialog');
  assert.match(c.formatStatus(r), /dialog is waiting/);
  await c.stopCoordinator(store, 'dialog', deps(tmux));

  project('dies');
  const dying = new FakeTmux();
  dying.dieOnStart = true;
  await assert.rejects(c.startCoordinator(store, 'dies', deps(dying)), (e: unknown) => e instanceof JvError && /exited right after/.test(e.message));
  const row = store.listSessions({ kind: 'coordinator' }).find((s) => s.cwd.endsWith(join('repos', 'dies')))!;
  assert.equal(row.state, 'failed');
});

test('status marks a coordinator whose tmux session vanished as lost; start then starts a new one', async () => {
  const p = project('vanish');
  const tmux = new FakeTmux();
  const first = await c.startCoordinator(store, 'vanish', deps(tmux));
  tmux.sessions.delete('jv-coord-vanish');
  const status = c.coordinatorStatus(store, 'vanish', deps(tmux));
  assert.equal(status.running, false);
  assert.equal(store.getSession(first.sessionId!)!.state, 'lost');
  const second = await c.startCoordinator(store, 'vanish', deps(tmux));
  assert.equal(second.started, true);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(c.liveCoordinator(store, p.id, tmux.run)!.session.id, second.sessionId);
  await c.stopCoordinator(store, 'vanish', deps(tmux));
});

test('restart: stop, start, then the handoff pasted as the first message', async () => {
  const p = project('restart');
  mkdirSync(paths.projectDir('restart'), { recursive: true });
  writeFileSync(paths.projectNotes('restart'), 'Owner: ask before touching billing.\n');
  const tmux = new FakeTmux();
  const first = await c.startCoordinator(store, 'restart', deps(tmux));
  const r = await c.restartCoordinator(store, 'restart', deps(tmux));
  assert.equal(r.stop.stopped, true);
  assert.equal(r.handoffTyped, true);
  assert.notEqual(r.sessionId, first.sessionId);
  const fresh = tmux.sessions.get('jv-coord-restart')!;
  assert.equal(fresh.submitted.length, 1);
  const message = fresh.submitted[0]!;
  assert.ok(message.startsWith(`${c.HANDOFF_PREFIX} `), message.slice(0, 80));
  assert.match(message, /Handoff for the project "restart"/);
  assert.match(message, /ask before touching billing/);
  assert.ok(tmux.calls.some((a) => a[0] === 'load-buffer') && tmux.calls.some((a) => a[0] === 'paste-buffer' && a.includes('-p')));
  assert.equal(c.liveCoordinator(store, p.id, tmux.run)!.session.id, r.sessionId);
  await c.stopCoordinator(store, 'restart', deps(tmux));
});

test('start refuses when claude-main does not list the coordinator model', async () => {
  project('nomodel');
  const tmux = new FakeTmux();
  const providers = loadProviders();
  providers.providers = providers.providers.map((p) => (p.name === 'claude-main' ? { ...p, models: p.models.filter((m) => m.id !== 'claude-opus-5-5') } : p));
  await assert.rejects(
    c.startCoordinator(store, 'nomodel', deps(tmux, { providers })),
    (e: unknown) => e instanceof JvError && e.exitCode === 2 && /claude-opus-5-5/.test(e.message),
  );
  assert.equal(tmux.history.length, 0);
});
