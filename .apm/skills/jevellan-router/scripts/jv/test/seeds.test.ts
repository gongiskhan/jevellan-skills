// Seeds tests: providers.json from the template, provider homes, seeding from Jevellan-style homes (D-002), the
// onboarding flag, the Stop hook merge and the skill installation, all in a temporary JV_HOME with fake homes.
// Every "secret" here is a fake value written by the test.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'jv-seeds-test-'));
const home = join(root, 'jvhome');
mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
process.env.JV_HOME = home;

const S = await import('../src/seeds.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { loadProviders } = await import('../src/providers.js');

after(() => rmSync(root, { recursive: true, force: true }));

const FAKE_TOKEN = 'fake-oauth-token-for-seed-tests-000111';
const FAKE_CREDS = '{"claudeAiOauth":{"accessToken":"fake-credential-for-tests-222333"}}';
const FAKE_AUTH = '{"tokens":{"access_token":"fake-codex-auth-for-tests-444555"}}';

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[relative(dir, p)] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else out[relative(dir, p)] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.mtimeMs}:${st.mode}`;
    }
  };
  walk(dir);
  return out;
}

function mode(p: string): string {
  return (statSync(p).mode & 0o777).toString(8);
}

// Jevellan-style flat homes.
const src = join(root, 'jevellan-homes');
const srcMain = join(src, 'main');
const srcSecond = join(src, 'second');
const srcCodex = join(src, 'codex');
for (const d of [srcMain, srcSecond, srcCodex]) mkdirSync(join(d, 'projects', 'p1'), { recursive: true });
writeFileSync(join(srcMain, '.claude.json'), '{"numStartups":3,"projects":{}}\n', { mode: 0o600 });
writeFileSync(join(srcMain, 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"jevellan-hook"}]}]}}');
writeFileSync(join(srcMain, 'projects', 'p1', 'x.jsonl'), '{}\n');
writeFileSync(join(srcSecond, '.claude.json'), 'not json at all', { mode: 0o600 });
writeFileSync(join(srcSecond, '.credentials.json'), FAKE_CREDS, { mode: 0o600 });
writeFileSync(join(srcSecond, 'settings.json'), '{}');
writeFileSync(join(srcCodex, 'auth.json'), FAKE_AUTH, { mode: 0o600 });
writeFileSync(join(srcCodex, 'hooks.json'), '{}');
const before = tree(src);

// The package: two skills and the agent.
const pkgSkills = join(root, 'pkg', '.apm', 'skills');
const pkgAgents = join(root, 'pkg', '.apm', 'agents');
mkdirSync(pkgAgents, { recursive: true });
writeFileSync(join(pkgAgents, 'jevellan-coordinator.agent.md'), '---\nname: jevellan-coordinator\n---\nAgent body.\n');
const skillsDir = join(home, 'skills');
for (const n of ['jevellan-router', 'jevellan-workflow-bug']) {
  mkdirSync(join(skillsDir, n), { recursive: true });
  writeFileSync(join(skillsDir, n, 'SKILL.md'), `---\nname: ${n}\njv-version: 0.1.0\n---\nBody of ${n}.\n`);
}
mkdirSync(join(skillsDir, 'jevellan-router', 'evals'), { recursive: true });
writeFileSync(join(skillsDir, 'jevellan-router', 'evals', 'cases.json'), '[]\n');

writeFileSync(join(home, 'secrets', 'claude-main.token'), FAKE_TOKEN, { mode: 0o600 });
writeFileSync(
  join(home, 'seeds.json'),
  JSON.stringify({ 'claude-main': srcMain, 'claude-second': srcSecond, codex: srcCodex, nobody: srcMain }),
);

const homes = {
  main: join(home, 'homes', 'claude-main'),
  second: join(home, 'homes', 'claude-second'),
  codex: join(home, 'homes', 'codex'),
  glm: join(home, 'homes', 'glm'),
};

// The owner (or APM) already wrote settings in claude-second's home: two copies of a "~" report guard hook and one
// hook of their own.
mkdirSync(join(homes.second, '.claude'), { recursive: true });
const ownerSettings = {
  permissions: { allow: ['Bash(ls:*)'] },
  env: { FOO: 'bar' },
  hooks: {
    PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
    Stop: [
      { hooks: [{ type: 'command', command: 'node ~/.jv/runtime/dist/report-guard.mjs' }] },
      { hooks: [{ type: 'command', command: 'echo owner' }] },
      { hooks: [{ type: 'command', command: 'node ~/.jv/runtime/dist/report-guard.mjs' }, { type: 'command', command: 'echo kept' }] },
    ],
  },
};
writeFileSync(join(homes.second, '.claude', 'settings.json'), JSON.stringify(ownerSettings));

const logs: string[] = [];
const opts = {
  jvHome: home,
  runtimeDir: RUNTIME_ROOT,
  skillsDir,
  sourceSkillsDir: pkgSkills,
  nodePath: '/opt/node 22/bin/node',
  log: (l: string) => logs.push(l),
};

const first = await S.seed(opts);

describe('seed', () => {
  test('writes providers.json from the template, with tokenFile where a token exists', () => {
    assert.equal(first.providersJson, 'created');
    const raw = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')) as { providers: Array<Record<string, unknown>> };
    const main = raw.providers.find((p) => p.name === 'claude-main')!;
    assert.equal(main.tokenFile, '~/.jv/secrets/claude-main.token');
    assert.deepEqual(Object.keys(main).slice(0, 4), ['name', 'kind', 'home', 'tokenFile']);
    assert.equal(raw.providers.find((p) => p.name === 'claude-second')!.tokenFile, undefined);
    assert.ok(!readFileSync(join(home, 'providers.json'), 'utf8').includes(FAKE_TOKEN));
    loadProviders();
  });

  test('creates every provider home with mode 700 and its config folder', () => {
    for (const h of [homes.main, homes.second, homes.codex, homes.glm]) assert.equal(mode(h), '700', h);
    assert.ok(existsSync(join(homes.main, '.claude')));
    assert.ok(existsSync(join(homes.glm, '.claude')));
    assert.ok(existsSync(join(homes.codex, '.codex')));
    assert.ok(!existsSync(join(home, 'homes', 'deepseek')));
  });

  test('copies only the D-002 files and never writes to the source', () => {
    assert.deepEqual(tree(src), before);
    assert.equal(first.seeds['claude-main']!.applied, true);
    assert.deepEqual(first.seeds['claude-main']!.files!.map((f) => relative(homes.main, f.to)), ['.claude.json']);
    assert.deepEqual(
      first.seeds['claude-second']!.files!.map((f) => relative(homes.second, f.to)),
      ['.claude.json', '.claude/.credentials.json'],
    );
    assert.deepEqual(first.seeds.codex!.files!.map((f) => relative(homes.codex, f.to)), ['.codex/auth.json']);
    assert.equal(first.seeds.nobody!.applied, false);
    assert.equal(readFileSync(join(homes.second, '.claude', '.credentials.json'), 'utf8'), FAKE_CREDS);
    assert.equal(mode(join(homes.second, '.claude', '.credentials.json')), '600');
    assert.equal(readFileSync(join(homes.codex, '.codex', 'auth.json'), 'utf8'), FAKE_AUTH);
    assert.ok(!existsSync(join(homes.main, 'projects')));
    assert.ok(!existsSync(join(homes.codex, '.codex', 'hooks.json')));
    // Jevellan's settings.json is never copied: the only Stop hook is jv's.
    const settings = JSON.parse(readFileSync(join(homes.main, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings), ['hooks']);
    assert.ok(!JSON.stringify(settings).includes('jevellan-hook'));
  });

  test('records paths and sizes in seeds-applied.json, never contents', () => {
    const text = readFileSync(join(home, 'seeds-applied.json'), 'utf8');
    for (const secret of [FAKE_CREDS, 'fake-credential-for-tests-222333', 'fake-codex-auth-for-tests-444555', FAKE_TOKEN]) {
      assert.ok(!text.includes(secret));
    }
    const applied = JSON.parse(text) as Record<string, { source: string; files: Array<{ from: string; to: string; bytes: number }> }>;
    assert.equal(applied.codex!.source, srcCodex);
    assert.equal(applied.codex!.files[0]!.bytes, Buffer.byteLength(FAKE_AUTH));
    assert.equal(applied['claude-second']!.files[1]!.from, join(srcSecond, '.credentials.json'));
    assert.equal(mode(join(home, 'seeds-applied.json')), '600');
    assert.ok(!JSON.stringify(first).includes('fake-credential-for-tests'));
  });

  test('an invalid .claude.json is not copied; onboarding is set and other keys kept', () => {
    const main = JSON.parse(readFileSync(join(homes.main, '.claude.json'), 'utf8'));
    assert.equal(main.hasCompletedOnboarding, true);
    assert.equal(main.numStartups, 3);
    const second = JSON.parse(readFileSync(join(homes.second, '.claude.json'), 'utf8'));
    assert.deepEqual(second, { hasCompletedOnboarding: true });
    assert.ok(JSON.stringify(applied()).includes('invalid json'));
    assert.equal(first.onboarding.glm, 'set');
    assert.equal(first.onboarding.codex, undefined);
    assert.equal(mode(join(homes.glm, '.claude.json')), '600');
  });

  test('merges exactly one absolute report guard hook and keeps everything else', () => {
    const cmd = `'/opt/node 22/bin/node' --disable-warning=ExperimentalWarning ${join(home, 'runtime', 'dist', 'report-guard.mjs')}`;
    assert.equal(first.hookCommand, cmd);
    const s = JSON.parse(readFileSync(join(homes.second, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.permissions, ownerSettings.permissions);
    assert.deepEqual(s.env, ownerSettings.env);
    assert.deepEqual(s.hooks.PreCompact, ownerSettings.hooks.PreCompact);
    assert.deepEqual(s.hooks.Stop, [
      { hooks: [{ type: 'command', command: cmd }] },
      { hooks: [{ type: 'command', command: 'echo owner' }] },
      { hooks: [{ type: 'command', command: 'echo kept' }] },
    ]);
    assert.equal(first.hooks['claude-second'], 'updated');
    assert.equal(first.hooks['claude-main'], 'added');
    assert.equal(first.hooks.glm, 'added');
    assert.equal(first.hooks.codex, undefined);
    const main = JSON.parse(readFileSync(join(homes.main, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(main.hooks.Stop, [{ hooks: [{ type: 'command', command: cmd }] }]);
  });

  test('installs the skills and the agent in every Claude home', () => {
    for (const h of [homes.main, homes.second, homes.glm]) {
      assert.equal(
        readFileSync(join(h, '.claude', 'skills', 'jevellan-router', 'SKILL.md'), 'utf8'),
        readFileSync(join(skillsDir, 'jevellan-router', 'SKILL.md'), 'utf8'),
      );
      assert.ok(existsSync(join(h, '.claude', 'skills', 'jevellan-router', 'evals', 'cases.json')));
      assert.ok(existsSync(join(h, '.claude', 'agents', 'jevellan-coordinator.md')));
    }
    assert.ok(!existsSync(join(homes.codex, '.claude')));
    assert.ok(existsSync(join(home, 'agents', 'jevellan-coordinator.agent.md')));
    assert.deepEqual(first.agents, ['jevellan-coordinator.agent.md']);
    assert.equal(first.skills.homes.length, 3);
    assert.equal(first.skills.homes[0]!.written, 4);
  });

  test('links <home>/.jv to JV_HOME in every Claude home, so "~/.jv/..." resolves under that HOME', () => {
    for (const [name, h] of [['claude-main', homes.main], ['claude-second', homes.second], ['glm', homes.glm]] as const) {
      assert.equal(first.jvLinks[name], 'linked');
      assert.equal(readlinkSync(join(h, '.jv')), home);
      assert.ok(existsSync(join(h, '.jv', 'providers.json')));
    }
    assert.ok(!existsSync(join(homes.codex, '.jv')));
    // Anything already at <home>/.jv is left alone.
    const other = join(root, 'other-home', 'homes', 'x');
    mkdirSync(join(other, '.jv'), { recursive: true });
    assert.match(S.ensureJvLink(other, home), /not a link; left alone/);
  });

  test('a second run changes nothing', async () => {
    const settingsBefore = readFileSync(join(homes.second, '.claude', 'settings.json'), 'utf8');
    const homeTree = tree(join(home, 'homes'));
    const again = await S.seed(opts);
    assert.equal(again.providersJson, 'kept');
    assert.match(again.seeds['claude-main']!.reason, /already seeded/);
    assert.deepEqual(Object.values(again.hooks), ['unchanged', 'unchanged', 'unchanged']);
    assert.deepEqual(Object.values(again.onboarding), ['already', 'already', 'already']);
    assert.deepEqual(Object.values(again.jvLinks), ['present', 'present', 'present']);
    assert.deepEqual(again.archivedLogins, {});
    assert.ok(again.skills.homes.every((h) => h.written === 0));
    assert.equal(readFileSync(join(homes.second, '.claude', 'settings.json'), 'utf8'), settingsBefore);
    assert.deepEqual(tree(join(home, 'homes')), homeTree);
    assert.deepEqual(tree(src), before);
  });
});

function applied(): unknown {
  return JSON.parse(readFileSync(join(home, 'seeds-applied.json'), 'utf8'));
}

describe('seedProviderHome', () => {
  test('skips a target that has a login, and never overwrites a file', () => {
    const p = loadProviders().providers.find((x) => x.name === 'claude-second')!;
    const r = S.seedProviderHome(p, srcSecond);
    assert.equal(r.applied, false);
    assert.match(r.reason, /login/);
    const main = loadProviders().providers.find((x) => x.name === 'claude-main')!;
    const again = S.seedProviderHome(main, srcMain);
    assert.equal(again.applied, false);
    assert.equal(again.reason, 'nothing to copy');
    assert.deepEqual(again.record!.files, []);
    assert.deepEqual(again.record!.notes, [
      '.credentials.json: not copied, the provider logs in with its tokenFile (D-003)',
      '.claude.json: target exists, kept',
    ]);
    assert.equal(S.seedProviderHome(main, 'relative/path').applied, false);
    assert.equal(S.seedProviderHome(main, join(root, 'missing')).applied, false);
  });

  test('mergeStopHooks on an empty or odd value', () => {
    assert.deepEqual(S.mergeStopHooks(undefined, 'c'), [{ hooks: [{ type: 'command', command: 'c' }] }]);
    assert.deepEqual(S.mergeStopHooks([{ matcher: '', hooks: [{ type: 'command', command: 'x report-guard.mjs' }] }], 'c'), [
      { matcher: '', hooks: [{ type: 'command', command: 'c' }] },
    ]);
    const f = join(root, 'bad-settings.json');
    writeFileSync(f, '{ nope');
    assert.equal(S.installStopHook(f, 'c'), 'invalid settings.json');
    assert.equal(readFileSync(f, 'utf8'), '{ nope');
  });
});

describe('seed edge cases', () => {
  // Each case gets its own JV_HOME-shaped tree inside the test JV_HOME is not possible (paths are resolved once per
  // process), so these cases drive the exported pieces directly against folders under the test home.

  test('agents are staged from an APM-installed layout (.claude/agents/jevellan-*.md), never other agents', () => {
    const project = join(root, 'apm-project', '.claude');
    mkdirSync(join(project, 'skills', 'jevellan-router'), { recursive: true });
    mkdirSync(join(project, 'agents'), { recursive: true });
    writeFileSync(join(project, 'agents', 'jevellan-coordinator.md'), '---\nname: jevellan-coordinator\n---\nAPM copy.\n');
    writeFileSync(join(project, 'agents', 'owner-agent.md'), '---\nname: owner-agent\n---\nThe owner\'s own agent.\n');
    const staged = join(root, 'staged-agents');
    assert.deepEqual(S.stageAgents(join(project, 'agents'), staged), ['jevellan-coordinator.agent.md']);
    assert.deepEqual(readdirSync(staged), ['jevellan-coordinator.agent.md']);
    assert.match(readFileSync(join(staged, 'jevellan-coordinator.agent.md'), 'utf8'), /APM copy/);
    // When both forms are present, the package's .agent.md wins.
    writeFileSync(join(project, 'agents', 'jevellan-coordinator.agent.md'), '---\nname: jevellan-coordinator\n---\nPackage copy.\n');
    S.stageAgents(join(project, 'agents'), staged);
    assert.match(readFileSync(join(staged, 'jevellan-coordinator.agent.md'), 'utf8'), /Package copy/);
    // installCoordinatorSkills maps the staged file to <name>.md in the home.
    const h = join(home, 'homes', 'claude-main');
    const r = S.installCoordinatorSkills({ skillsDir, agentsDir: staged, homes: [h] });
    assert.equal(r.homes[0]!.agents, 1);
    assert.match(readFileSync(join(h, '.claude', 'agents', 'jevellan-coordinator.md'), 'utf8'), /Package copy/);
  });

  test('a jevellan skill removed from the package is archived out of the provider homes, other skills are kept', () => {
    const h = join(home, 'homes', 'claude-main');
    mkdirSync(join(h, '.claude', 'skills', 'jevellan-removed-skill'), { recursive: true });
    writeFileSync(join(h, '.claude', 'skills', 'jevellan-removed-skill', 'SKILL.md'), 'old\n');
    mkdirSync(join(h, '.claude', 'skills', 'owner-skill'), { recursive: true });
    const r = S.installCoordinatorSkills({ skillsDir, agentsDir: join(home, 'agents'), homes: [h] });
    assert.deepEqual(r.homes[0]!.archived, ['jevellan-removed-skill']);
    assert.ok(!existsSync(join(h, '.claude', 'skills', 'jevellan-removed-skill')));
    assert.ok(existsSync(join(h, '.claude', 'skills', 'owner-skill')));
    const archived = readdirSync(join(home, 'archive', 'skills'));
    assert.equal(archived.length, 1);
    assert.ok(existsSync(join(home, 'archive', 'skills', archived[0]!, 'jevellan-removed-skill', 'SKILL.md')));
  });

  test('a tokenFile subscription gets no .credentials.json, and a seeded one is archived, never deleted', () => {
    const main = loadProviders().providers.find((x) => x.name === 'claude-main')!;
    assert.ok(S.usesTokenFile(main));
    assert.deepEqual(S.seedFileMap(main).map(([n]) => n), ['.claude.json']);
    // Simulate an earlier bootstrap that copied a login into the token home.
    const file = join(main.home!, '.claude', '.credentials.json');
    writeFileSync(file, FAKE_CREDS, { mode: 0o600 });
    const record = { source: srcSecond, at: '2026-11-01T00:00:00.000Z', files: [{ from: join(srcSecond, '.credentials.json'), to: file, bytes: 1 }] };
    const notRecorded = S.archiveUnusedSeededLogin(main, { ...record, files: [] });
    assert.equal(notRecorded, undefined);
    assert.ok(existsSync(file));
    const moved = S.archiveUnusedSeededLogin(main, record)!;
    assert.ok(!existsSync(file));
    assert.equal(readFileSync(moved.to, 'utf8'), FAKE_CREDS);
    assert.equal(mode(moved.to), '600');
    assert.equal(mode(join(home, 'archive', 'credentials')), '700');
    assert.ok(moved.to.startsWith(join(home, 'archive', 'credentials', 'claude-main-')));
    // A subscription without a tokenFile keeps its login.
    const second = loadProviders().providers.find((x) => x.name === 'claude-second')!;
    assert.equal(S.archiveUnusedSeededLogin(second, record), undefined);
  });

  test('the minimal .claude.json jv wrote before seeds.json existed is replaced by the seed', () => {
    const glm = loadProviders().providers.find((x) => x.name === 'glm')!;
    // glm's home holds only jv's onboarding file; a source with a real .claude.json seeds it.
    assert.ok(S.isMinimalClaudeJson(join(glm.home!, '.claude.json')));
    const source = join(root, 'late-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, '.claude.json'), '{"numStartups":7,"hasCompletedOnboarding":true}\n');
    const r = S.seedProviderHome(glm, source);
    assert.equal(r.applied, true);
    assert.equal(JSON.parse(readFileSync(join(glm.home!, '.claude.json'), 'utf8')).numStartups, 7);
    assert.ok(r.record!.notes!.some((n) => n.includes('replaced the minimal one')));
    // Now it is a real file: a second seed keeps it.
    const again = S.seedProviderHome(glm, source);
    assert.equal(again.applied, false);
  });

  test('a home outside $JV_HOME/homes is refused before anything is written', () => {
    assert.throws(() => S.assertProviderHome(join(root, 'not-under-homes')), /not inside/);
    assert.throws(() => S.installCoordinatorSkills({ skillsDir, agentsDir: join(home, 'agents'), homes: [root] }), /not inside/);
    assert.ok(!existsSync(join(root, '.claude')));
  });
});
