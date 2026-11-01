// CLI tests: argument parsing, the command table, exit codes and --version, against a temporary JV_HOME.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'jv-cli-test-'));
process.env.JV_HOME = home;
const { parseArgs, COMMANDS } = await import('../src/cli.js');
const { JvError } = await import('../src/errors.js');

after(() => rmSync(home, { recursive: true, force: true }));

const cliUrl = new URL('../src/cli.js', import.meta.url).href;

function jv(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(${JSON.stringify(argv)});`,
    ],
    { env: { ...process.env, JV_HOME: home }, encoding: 'utf8' },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('flags anywhere, values, booleans, = form and repeats', () => {
  const a = parseArgs(['task', 'create', '--project', 'sandbox', '--kind=feature', '--visible', '--title', 'T', '--json']);
  assert.equal(a.command, 'task');
  assert.deepEqual(a.positionals, ['create']);
  assert.equal(a.flags.project, 'sandbox');
  assert.equal(a.flags.kind, 'feature');
  assert.equal(a.flags.visible, true);
  assert.equal(a.json, true);
  const b = parseArgs(['land', 'T1', '--force']);
  assert.deepEqual(b.positionals, ['T1']);
  assert.equal(b.flags.force, true);
  const c = parseArgs(['exec', '--provider', 'p', '--', 'claude', '--resume', 'x']);
  assert.deepEqual(c.positionals, ['claude', '--resume', 'x']);
  const d = parseArgs(['evals', 'route', '--since', '2026-11-01', '--since', '2026-11-02']);
  assert.deepEqual(d.flags.since, ['2026-11-01', '2026-11-02']);
  assert.throws(() => parseArgs(['task', 'show', '--project']), (e: unknown) => e instanceof JvError && e.exitCode === 2);
});

test('the table has every command of section 3 and the internal ones', () => {
  for (const c of [
    'doctor', 'project', 'providers', 'status', 'task', 'land', 'report', 'tail', 'attach', 'ui', 'coordinator',
    'handoff', 'notes', 'evals', 'usage', 'gc', 'bootstrap', 'update', 'run', 'exec',
  ]) {
    assert.ok(Object.hasOwn(COMMANDS, c), c);
  }
  assert.equal(COMMANDS.doctor!.module, './doctor.js');
  assert.equal(COMMANDS.project!.module, './project.js');
});

test('a command this build does not have exits 2 with the standard message', () => {
  const r = jv('gc');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /jv gc is not available in this build/);
  const j = jv('gc', '--json');
  assert.equal(j.code, 2);
  assert.deepEqual(JSON.parse(j.stdout), { error: 'jv gc is not available in this build', exitCode: 2 });
});

test('an unknown command exits 2', () => {
  assert.equal(jv('frobnicate').code, 2);
});

test('jv --version prints the package and schema versions', () => {
  const r = jv('--version', '--json');
  assert.equal(r.code, 0, r.stderr);
  const v = JSON.parse(r.stdout) as { version: string; schemaVersion: string; storeSchemaVersion: string | null };
  assert.equal(v.version, '0.1.0');
  assert.equal(v.schemaVersion, '1');
  assert.equal(v.storeSchemaVersion, null);
  const t = jv('--version');
  assert.equal(t.code, 0);
  assert.match(t.stdout, /^jv 0\.1\.0\nstore schema 1/);
});

test('help lists the commands', () => {
  const r = jv('--help');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /jv task create/);
  assert.ok(fileURLToPath(cliUrl).endsWith(join('src', 'cli.js')));
});

test('jv --version reads the schema version of an existing store', async () => {
  const { Store } = await import('../src/store.js');
  Store.open({ file: join(home, 'store.sqlite') }).close();
  const r = jv('--version', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { storeSchemaVersion: string | null }).storeSchemaVersion, '1');
});
