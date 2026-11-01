// Project tests: jv project add and list against temporary git repositories and a temporary JV_HOME.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jv-project-test-')));
const home = join(root, 'jvhome');
process.env.JV_HOME = home;

const Proj = await import('../src/project.js');
const { run } = await import('../src/commands/project.js');
const { paths, RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
const { writeProvidersFromTemplate } = await import('../src/seeds.js');

after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'jv test',
  GIT_AUTHOR_EMAIL: 'jv-test@example.invalid',
  GIT_COMMITTER_NAME: 'jv test',
  GIT_COMMITTER_EMAIL: 'jv-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

function makeRepo(name: string, files: Record<string, string>, branch = 'trunk'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function captureIo(json: boolean) {
  const out: { data?: unknown; text?: string } = {};
  return {
    out,
    io: {
      json,
      result(data: unknown, text: string | (() => string)) {
        out.data = data;
        out.text = typeof text === 'function' ? text() : text;
      },
      info() {},
      warn() {},
      write() {},
    },
  };
}

function args(...positionals: string[]) {
  return { command: 'project', positionals, flags: {}, json: true, raw: [] };
}

const isCode = (code: number) => (e: unknown) => e instanceof JvError && e.exitCode === code;

// Skills and the staged agent, as the bootstrap leaves them, plus providers.json from the template.
mkdirSync(join(home, 'skills', 'jevellan-workflow-feature'), { recursive: true });
writeFileSync(join(home, 'skills', 'jevellan-workflow-feature', 'SKILL.md'), '---\nname: jevellan-workflow-feature\n---\nBody.\n');
mkdirSync(join(home, 'agents'), { recursive: true });
writeFileSync(join(home, 'agents', 'jevellan-coordinator.agent.md'), '---\nname: jevellan-coordinator\n---\n');
mkdirSync(join(home, 'secrets'), { recursive: true });
writeProvidersFromTemplate(RUNTIME_ROOT);

const repo = makeRepo('sandbox-app', {
  'package.json': JSON.stringify({ scripts: { test: 'node --test', dev: 'vite' } }),
  '.gitignore': '.claude/\nnode_modules/\n',
});

describe('jv project add', () => {
  test('registers the repository and writes the project folder', async () => {
    const { io, out } = captureIo(true);
    assert.equal(await run(args('add', repo), io), 0);
    const r = out.data as import('../src/project.js').AddProjectResult;
    assert.equal(r.created, true);
    assert.equal(r.project.name, 'sandbox-app');
    assert.equal(r.project.path, repo);
    assert.equal(r.project.default_branch, 'trunk');
    assert.match(r.project.id, /^P[0-9A-Z]{6}$/);
    const pj = JSON.parse(readFileSync(paths.projectJson('sandbox-app'), 'utf8'));
    assert.deepEqual(pj, {
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      automationDir: 'automations/',
      commitPlan: false,
      pushAfterLanding: false,
      retentionDays: 3,
      guidance: '',
      mcpServers: [],
    });
    assert.deepEqual(JSON.parse(readFileSync(paths.projectLanding('sandbox-app'), 'utf8')), { riskyPaths: [], checks: [] });
    assert.equal(readFileSync(paths.projectNotes('sandbox-app'), 'utf8'), '');
    assert.ok(existsSync(paths.projectWorkflowsDir('sandbox-app')));
    assert.deepEqual(Object.values(r.files), ['created', 'created', 'created', 'created']);
  });

  test('adds the jv lines to .git/info/exclude, skipping what is already ignored', () => {
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    const lines = exclude.split('\n');
    for (const l of ['/.jv-evidence/', '/plan.md', 'CLAUDE.md']) assert.ok(lines.includes(l), l);
    assert.ok(!lines.includes('.claude/'));
    // The repository's checkout is untouched.
    assert.equal(git(repo, 'status', '--porcelain'), '');
    git(repo, 'check-ignore', '-q', '.jv-evidence/shot.png');
    git(repo, 'check-ignore', '-q', 'plan.md');
  });

  test('installs the skills and the agent into the Claude provider homes', () => {
    for (const name of ['claude-main', 'claude-second', 'glm']) {
      const h = paths.providerHome(name);
      assert.ok(existsSync(join(h, '.claude', 'skills', 'jevellan-workflow-feature', 'SKILL.md')), name);
      assert.ok(existsSync(join(h, '.claude', 'agents', 'jevellan-coordinator.md')), name);
    }
    assert.ok(!existsSync(join(paths.providerHome('codex'), '.claude')));
  });

  test('is idempotent', async () => {
    const excludeBefore = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    writeFileSync(paths.projectJson('sandbox-app'), '{"testCommand":"npm run test:all"}\n');
    const { io, out } = captureIo(true);
    await run(args('add', repo), io);
    const r = out.data as import('../src/project.js').AddProjectResult;
    assert.equal(r.created, false);
    assert.deepEqual(Object.values(r.files), ['kept', 'kept', 'kept', 'kept']);
    assert.deepEqual(r.exclude.added, []);
    assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), excludeBefore);
    assert.equal(readFileSync(paths.projectJson('sandbox-app'), 'utf8'), '{"testCommand":"npm run test:all"}\n');
    assert.ok('homes' in r.skills && r.skills.homes.every((h) => h.written === 0));
  });

  test('the same name with another path is a conflict (exit 4)', () => {
    const other = makeRepo('other', { 'a.txt': 'a' });
    assert.throws(() => Proj.addProject(other, { name: 'sandbox-app' }), isCode(4));
    const r = Proj.addProject(other, { name: 'second-app' });
    assert.equal(r.project.default_branch, 'trunk');
    const pj = JSON.parse(readFileSync(paths.projectJson('second-app'), 'utf8'));
    assert.equal(pj.testCommand, null);
    assert.equal(pj.devCommand, null);
    // Not ignored there: .claude/ is added too.
    assert.ok(readFileSync(join(other, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.claude/'));
  });

  test('the same repository under a second name is a conflict (exit 4) naming the first project', () => {
    assert.throws(
      () => Proj.addProject(repo, { name: 'sandbox-again' }),
      (e) => isCode(4)(e) && (e as Error).message.includes('sandbox-app'),
    );
    assert.ok(!existsSync(paths.projectDir('sandbox-again')));
  });

  test('a renamed default branch is updated on the next add, with a reason', async () => {
    const r1 = makeRepo('renames', { 'a.txt': 'a' }, 'trunk');
    assert.equal(Proj.addProject(r1).project.default_branch, 'trunk');
    git(r1, 'branch', '-m', 'trunk', 'main');
    const { io, out } = captureIo(false);
    await run(args('add', r1), io);
    const r = out.data as import('../src/project.js').AddProjectResult;
    assert.equal(r.project.default_branch, 'main');
    assert.equal(r.branchChangedFrom, 'trunk');
    assert.match(out.text!, /updated from trunk/);
    assert.equal(Proj.listProjectRows().filter((p) => p.name === 'renames').length, 1);
  });

  test('an ignore rule that lives only in the owner\'s global excludes file does not count', () => {
    const globalIgnore = join(root, 'global-ignore');
    writeFileSync(globalIgnore, '.claude/\nCLAUDE.md\n');
    const globalConfig = join(root, 'global-gitconfig');
    writeFileSync(globalConfig, `[core]\n\texcludesFile = ${globalIgnore}\n`);
    const r2 = makeRepo('global-only', { 'a.txt': 'a' });
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      // The owner's git sees .claude/ as ignored, but a worker (HOME = provider home) would not.
      execFileSync('git', ['-C', r2, 'check-ignore', '-q', '.claude/'], { env: process.env });
      const { added } = Proj.ensureGitExclude(r2);
      assert.ok(added.includes('.claude/'));
      assert.ok(added.includes('CLAUDE.md'));
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });

  test('refuses a missing folder (3), a folder outside git or inside a repository (2), a bad name (2)', () => {
    assert.throws(() => Proj.addProject(join(root, 'nope')), isCode(3));
    const plain = join(root, 'plain');
    mkdirSync(plain);
    assert.throws(() => Proj.addProject(plain), isCode(2));
    mkdirSync(join(repo, 'src'), { recursive: true });
    assert.throws(() => Proj.addProject(join(repo, 'src')), (e) => isCode(2)(e) && (e as Error).message.includes(repo));
    assert.throws(() => Proj.addProject(repo, { name: 'bad name' }), isCode(2));
  });

  test('the default branch follows origin HEAD in a clone', () => {
    const clone = join(root, 'clone');
    git(root, 'clone', '-q', repo, clone);
    git(clone, 'checkout', '-q', '-b', 'feature-x');
    assert.equal(Proj.defaultBranch(clone), 'trunk');
    const unborn = join(root, 'unborn');
    mkdirSync(unborn);
    git(unborn, 'init', '-q', '-b', 'develop');
    assert.equal(Proj.defaultBranch(unborn), 'develop');
  });

  test('a linked worktree shares the main exclude file', () => {
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'jv/x-abc123', wt);
    assert.equal(Proj.excludeFile(wt), join(repo, '.git', 'info', 'exclude'));
    git(wt, 'check-ignore', '-q', 'plan.md');
  });

  test('test command detection skips npm\'s placeholder and follows the lockfile', () => {
    const d = join(root, 'detect');
    mkdirSync(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', start: 'node .' } }));
    assert.deepEqual(Proj.detectCommands(d), { testCommand: null, devCommand: 'npm start' });
    writeFileSync(join(d, 'pnpm-lock.yaml'), '');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', dev: 'vite' } }));
    assert.deepEqual(Proj.detectCommands(d), { testCommand: 'pnpm test', devCommand: 'pnpm run dev' });
  });
});

describe('jv project list', () => {
  test('lists the registered projects', async () => {
    const { io, out } = captureIo(true);
    await run(args('list'), io);
    const rows = out.data as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name), ['renames', 'sandbox-app', 'second-app']);
    const text = captureIo(false);
    await run(args('list'), text.io);
    assert.match(text.out.text!, /sandbox-app {2}P[0-9A-Z]{6} {2}trunk {2}/);
  });

  test('an unknown subcommand is refused', async () => {
    const { io } = captureIo(true);
    await assert.rejects(run(args('remove'), io), isCode(2));
  });
});
