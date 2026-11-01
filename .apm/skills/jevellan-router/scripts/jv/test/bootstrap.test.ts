// Bootstrap tests: bin/bootstrap.mjs and bin/jv.mjs end to end, against a copy of this package in a temporary
// folder and temporary JV_HOMEs (every child gets JV_HOME, so the real ~/.jv is never touched). Each build runs
// npm ci, tsc and npm prune for real (with npm's cache preferred), so this file takes about a minute. Set
// JV_TEST_SKIP_BOOTSTRAP=1 to skip it.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, describe, test } from 'node:test';

const { RUNTIME_ROOT } = await import('../src/paths.js');

const skip = process.env.JV_TEST_SKIP_BOOTSTRAP === '1';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jv-bootstrap-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

// The package copy: .apm/skills (the runtime inside the router skill) and .apm/agents, without build output.
const pkg = join(root, 'pkg');
const apm = join(RUNTIME_ROOT, '..', '..', '..', '..');
const skipNames = new Set(['node_modules', 'dist', 'dist-test']);
for (const part of ['skills', 'agents']) {
  cpSync(join(apm, part), join(pkg, '.apm', part), {
    recursive: true,
    filter: (src) => !relative(join(apm, part), src).split(sep).some((s) => skipNames.has(s)),
  });
}
const pkgRuntime = join(pkg, '.apm', 'skills', 'jevellan-router', 'scripts', 'jv');
const entry = join(pkgRuntime, 'bin', 'jv.mjs');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function env(jvHome: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, JV_HOME: jvHome, npm_config_prefer_offline: 'true' };
  delete e.JV_BOOTSTRAP_DELEGATED;
  return e;
}

function node(jvHome: string, args: string[]): Run {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], {
    env: env(jvHome),
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function shim(shimHome: string, jvHome: string, args: string[]): Run {
  const r = spawnSync(join(shimHome, 'bin', 'jv'), args, { env: env(jvHome), encoding: 'utf8', timeout: 300_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const json = (r: Run) => JSON.parse(r.stdout) as Record<string, unknown>;
const link = (home: string, name: string) => readlinkSync(join(home, name));
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

const home = join(root, 'home');

describe('jv bootstrap', { skip }, () => {
  test('a first bootstrap builds a versioned runtime and skill set behind links', () => {
    const r = node(home, ['bootstrap', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = json(r);
    assert.equal(out.built, true);
    assert.ok(lstatSync(join(home, 'runtime')).isSymbolicLink());
    assert.ok(lstatSync(join(home, 'skills')).isSymbolicLink());
    assert.match(link(home, 'runtime'), /^runtimes\/0\.1\.0-[0-9a-f]{8}-\d{8}T\d{6}Z$/);
    assert.ok(existsSync(join(home, 'runtime', 'dist', 'cli.js')));
    assert.ok(!existsSync(join(home, 'runtime', 'node_modules', 'typescript')), 'dev dependencies are pruned');
    assert.ok(existsSync(join(home, 'skills', 'jevellan-router', 'SKILL.md')));
    assert.ok(!existsSync(join(home, 'skills', 'jevellan-router', 'scripts')));
    assert.ok(!existsSync(join(home, 'bootstrap.lock')));
    const v = shim(home, home, ['--version', '--json']);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(json(v).version, '0.1.0');
  });

  test('a rerun with an unchanged package rebuilds nothing and changes nothing', () => {
    const cli = join(home, 'runtime', 'dist', 'cli.js');
    const before = { link: link(home, 'runtime'), skills: link(home, 'skills'), mtime: statSync(cli).mtimeMs, install: readFileSync(join(home, 'install.json'), 'utf8') };
    const r = node(home, ['bootstrap', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(json(r).built, false);
    assert.match(r.stderr, /unchanged/);
    assert.ok(!/npm ci/.test(r.stderr));
    assert.equal(link(home, 'runtime'), before.link);
    assert.equal(link(home, 'skills'), before.skills);
    assert.equal(statSync(cli).mtimeMs, before.mtime);
    assert.equal(readFileSync(join(home, 'install.json'), 'utf8'), before.install);
    assert.deepEqual(listing(join(home, 'runtimes')), [before.link.split('/')[1]]);
    assert.deepEqual(listing(join(home, 'archive', 'runtimes')), []);
  });

  test('files deleted from the package are gone after jv update; current and previous versions stay, older ones are archived', () => {
    const ids = join(pkgRuntime, 'src', 'ids.ts');
    const idsOriginal = readFileSync(ids, 'utf8');
    const legacy = join(pkgRuntime, 'src', 'legacy.ts');
    // Version N: a module that imports an export that version N+1 removes.
    writeFileSync(ids, `${idsOriginal}\nexport const legacyThing = 1;\n`);
    writeFileSync(legacy, "import { legacyThing } from './ids.js';\nexport const legacy = legacyThing + 1;\n");
    const n = shim(home, home, ['update', '--json']);
    assert.equal(n.status, 0, n.stderr);
    assert.ok(existsSync(join(home, 'runtime', 'src', 'legacy.ts')));
    const versionN = link(home, 'runtime');
    // Version N+1 drops both.
    writeFileSync(ids, idsOriginal);
    rmSync(legacy);
    const n1 = shim(home, home, ['update', '--json']);
    assert.equal(n1.status, 0, n1.stderr);
    assert.ok(!existsSync(join(home, 'runtime', 'src', 'legacy.ts')));
    assert.ok(!existsSync(join(home, 'runtime', 'dist', 'legacy.js')));
    assert.equal(shim(home, home, ['--version']).status, 0);
    // The first build is archived without node_modules; N stays as the previous version.
    const runtimes = listing(join(home, 'runtimes'));
    assert.equal(runtimes.length, 2);
    assert.ok(runtimes.includes(versionN.split('/')[1]!));
    const archived = listing(join(home, 'archive', 'runtimes'));
    assert.equal(archived.length, 1);
    assert.ok(existsSync(join(home, 'archive', 'runtimes', archived[0]!, 'package.json')));
    assert.ok(!existsSync(join(home, 'archive', 'runtimes', archived[0]!, 'node_modules')));
    assert.equal(listing(join(home, 'archive', 'skill-sets')).length, 1);
  });

  test('a failed update leaves the installed runtime working and untouched', () => {
    const lock = join(pkgRuntime, 'package-lock.json');
    const original = readFileSync(lock, 'utf8');
    const before = link(home, 'runtime');
    writeFileSync(lock, original.replace(/"version": "0\.1\.0"/, '"version": "0.1.0",\n  "broken": ').slice(0, 400));
    // Change something so the fingerprint differs and a build is attempted.
    try {
      const r = shim(home, home, ['update', '--json']);
      assert.notEqual(r.status, 0);
      assert.equal(json(r).ok, false);
      assert.equal(link(home, 'runtime'), before);
      const v = shim(home, home, ['--version', '--json']);
      assert.equal(v.status, 0, v.stderr);
      assert.equal(json(v).version, '0.1.0');
      assert.ok(!existsSync(join(home, 'bootstrap.lock')));
    } finally {
      writeFileSync(lock, original);
    }
  });

  test('jv update runs the package\'s own bootstrap when it differs from the installed one', () => {
    const file = join(pkgRuntime, 'bin', 'bootstrap.mjs');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// a later bootstrap\n`);
    const before = link(home, 'runtime');
    const r = shim(home, home, ['update', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /the package's bootstrap differs from the installed one; running /);
    assert.equal(json(r).built, true);
    assert.notEqual(link(home, 'runtime'), before);
    assert.match(readFileSync(join(home, 'runtime', 'bin', 'bootstrap.mjs'), 'utf8'), /a later bootstrap/);
    // Now they match: the next update runs the installed one and rebuilds nothing.
    const again = shim(home, home, ['update', '--json']);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!/differs from the installed one/.test(again.stderr));
    assert.equal(json(again).built, false);
  });

  test('a shim pointed at a JV_HOME with no runtime installs one there from its own home\'s package', () => {
    const other = join(root, 'brand-new');
    const v = shim(home, other, ['--version', '--json']);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(json(v).store, join(other, 'store.sqlite'));
    assert.ok(existsSync(join(other, 'runtime', 'dist', 'cli.js')));
    const install = JSON.parse(readFileSync(join(other, 'install.json'), 'utf8')) as { source: string };
    assert.equal(install.source, realpathSync(pkgRuntime));
  });

  test('a jv call during another bootstrap waits for its lock and builds nothing itself', async () => {
    const fresh = join(root, 'fresh');
    const first = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, 'bootstrap'], { env: env(fresh), stdio: ['ignore', 'ignore', 'pipe'] });
    let firstErr = '';
    first.stderr.setEncoding('utf8').on('data', (d: string) => (firstErr += d));
    const firstDone = new Promise<number | null>((r) => first.on('exit', (code) => r(code)));
    for (let i = 0; i < 200 && !existsSync(join(fresh, 'bootstrap.lock')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(join(fresh, 'bootstrap.lock')), 'the first bootstrap took the lock');
    const second = await new Promise<Run>((resolve) => {
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, '--version', '--json'], { env: env(fresh) });
      let stdout = '';
      let stderr = '';
      c.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      c.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      c.on('exit', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(await firstDone, 0, firstErr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /waiting for jv bootstrap \(pid \d+\)/);
    assert.match(second.stderr, /another jv bootstrap installed the runtime meanwhile/);
    assert.ok(!/npm ci/.test(second.stderr), 'the second call ran no build of its own');
    assert.equal(json(second).version, '0.1.0');
    assert.equal(listing(join(fresh, 'runtimes')).length, 1);
  });

  test('a JV_HOME set by the caller wins over the shim\'s own home', () => {
    const other = join(root, 'fresh');
    const v = shim(home, other, ['--version', '--json']);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(json(v).store, join(other, 'store.sqlite'));
    const text = readFileSync(join(home, 'bin', 'jv'), 'utf8');
    assert.match(text, /JV_HOME="\$\{JV_HOME:-\}"/);
  });

  test('a stale lock (its pid is gone) is taken over', () => {
    writeFileSync(join(home, 'bootstrap.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: '2026-01-01T00:00:00.000Z' }));
    const r = node(home, ['bootstrap', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(home, 'bootstrap.lock')));
  });
});

// No build: help and a bad argument answer before the lock, so these run even with JV_TEST_SKIP_BOOTSTRAP.
describe('jv bootstrap and jv update arguments', () => {
  const blank = join(root, 'blank');

  test('jv update --help prints the usage, exits 0 and installs nothing', () => {
    for (const args of [['update', '--help'], ['update', '-h'], ['bootstrap', '--help']]) {
      const r = node(blank, args);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `jv ${args[0]} [--rebuild] [--source DIR] [--json]\n`);
      assert.equal(r.stderr, '');
    }
    assert.deepEqual(listing(blank), []);
  });

  test('an unknown argument or a --source without a folder exits 2 and installs nothing', () => {
    const r = node(blank, ['update', '--forse']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^jv update: unknown argument "--forse"\. Usage: jv update \[--rebuild\]/);
    const s = node(blank, ['bootstrap', '--source']);
    assert.equal(s.status, 2);
    assert.match(s.stderr, /--source needs a folder/);
    const j = node(blank, ['update', 'now', '--json']);
    assert.equal(j.status, 2);
    assert.equal(json(j).exitCode, 2);
    assert.deepEqual(listing(blank), []);
  });
});
