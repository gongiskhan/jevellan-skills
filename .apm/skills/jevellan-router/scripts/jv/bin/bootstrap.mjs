#!/usr/bin/env node
// jv bootstrap and jv update (plain JS, Node built-ins only, idempotent). D-021 describes the layout.
//
// From the package (the router skill's scripts/jv folder, wherever APM or npm put it):
//   1. takes $JV_HOME/bootstrap.lock (one bootstrap at a time; a first-use call that finds another bootstrap running
//      waits for it and then uses what it installed);
//   2. fingerprints the package (runtime files, jevellan-* skills and agents, this Node binary, the bootstrap
//      format); when the fingerprint matches install.json and the build is there, nothing is rebuilt;
//   3. otherwise builds a fresh runtime in $JV_HOME/runtimes/<id>.partial (copy without node_modules, dist,
//      dist-test; npm ci, tsc -p tsconfig.json, npm prune --omit=dev, D-005) and a fresh skill set in
//      $JV_HOME/skill-sets/<id>.partial (every jevellan-* skill folder, the router without scripts/);
//   4. switches $JV_HOME/runtime and $JV_HOME/skills, which are symlinks to those folders, with an atomic rename, so
//      $JV_HOME/runtime/bin/jv.mjs and dist/ never go missing; on any failure before the switch the installed
//      runtime and skills are untouched;
//   5. keeps the current and the previous version in place (running processes import from them lazily) and moves
//      older ones to $JV_HOME/archive/ (an archived runtime loses its node_modules, which npm ci recreates);
//   6. writes the $JV_HOME/bin/jv shim (D-001, D-024), creates the folders of section 1 (the home and secrets
//      mode 700), calls seed() from the new runtime's dist/seeds.js, records install.json and prints the PATH line.
// jv update runs the same steps from the source recorded in install.json, with that source's own bootstrap.mjs
// when it differs from this one, so a fix to the bootstrap applies on the update that brings it.
// Deleted: only jv's own build output (*.partial folders a failed run left behind, node_modules of archived
// runtimes). Nothing else.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_MAJOR = 22;
const MIN_MINOR = 13;
/** Bumped when the bootstrap's own output changes, so an unchanged package still rebuilds once. */
const BOOTSTRAP_FORMAT = '2';
const RUNTIME_EXCLUDES = new Set(['node_modules', 'dist', 'dist-test']);
const SKILL_PREFIX = 'jevellan-';
const ROUTER_SKILL = 'jevellan-router';
const AGENT_FILE = /^jevellan-[A-Za-z0-9._-]+?(\.agent)?\.md$/;
const LOCK_FILE = 'bootstrap.lock';
const LOCK_POLL_MS = 200;

const here = dirname(fileURLToPath(import.meta.url));

class BootstrapError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function expandTilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function resolveJvHome() {
  const v = process.env.JV_HOME;
  if (v !== undefined && v.trim() !== '') return resolve(expandTilde(v.trim()));
  return join(homedir(), '.jv');
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function writeFileAtomic(file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
  if (mode !== undefined) chmodSync(file, mode);
}

function ensureDir(dir, mode) {
  mkdirSync(dir, { recursive: true });
  if (mode !== undefined) chmodSync(dir, mode); // mkdir's mode is masked by the umask
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function nodeIsRecentEnough() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
}

function nodeBinDir() {
  return dirname(process.execPath);
}

/** npm next to this Node binary: npm-cli.js run with process.execPath, else the npm script itself. */
function npmInvocation() {
  const bin = nodeBinDir();
  const candidates = [
    join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((c) => existsSync(c));
  if (cli) return { command: process.execPath, prefix: [cli] };
  const script = join(bin, 'npm');
  if (existsSync(script)) return { command: script, prefix: [] };
  throw new BootstrapError(`no npm next to ${process.execPath}; install npm for this Node and run jv bootstrap again`);
}

function childEnv() {
  // npm's scripts and npm itself run "node" from PATH: put this Node first so they never fall back to an older one.
  const env = { ...process.env };
  env.PATH = [nodeBinDir(), env.PATH ?? ''].filter(Boolean).join(delimiter);
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  return env;
}

function run(command, args, cwd, log, label) {
  log(`${label}`);
  const r = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw new BootstrapError(`${label} could not start: ${r.error.message}`, 1);
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    throw new BootstrapError(`${label} failed (exit ${r.status ?? r.signal})\n${tail}`, 1);
  }
}

function runtimeFilter(sourceRuntime) {
  return (src) => {
    const rel = relative(sourceRuntime, src);
    if (rel === '') return true;
    const first = rel.split(sep)[0];
    return !RUNTIME_EXCLUDES.has(first);
  };
}

function skillFilter(skillDir, name) {
  return (src) => {
    const rel = relative(skillDir, src);
    if (rel === '') return true;
    const first = rel.split(sep)[0];
    if (first === 'node_modules') return false;
    if (name === ROUTER_SKILL && first === 'scripts') return false;
    return true;
  };
}

function parseOptions(argv) {
  const opts = { mode: 'bootstrap', firstUse: false, json: false, rebuild: false, source: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'bootstrap' || a === 'update') opts.mode = a;
    else if (a === '--first-use') opts.firstUse = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--rebuild') opts.rebuild = true;
    else if (a === '--source') opts.source = argv[++i];
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
  }
  return opts;
}

function validRuntime(dir) {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'bin', 'bootstrap.mjs'));
}

/** Whether dir is $JV_HOME/runtime, one of $JV_HOME/runtimes/*, or an archived runtime of this home. */
function isInstalledRuntime(dir, jvHome) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  for (const root of [join(jvHome, 'runtimes'), join(jvHome, 'archive')]) {
    let r;
    try {
      r = realpathSync(root);
    } catch {
      continue;
    }
    const rel = relative(r, real);
    if (rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep)) return true;
  }
  return samePath(dir, join(jvHome, 'runtime'));
}

/**
 * The jv home a runtime folder is installed in ($JV_HOME/runtimes/<id>, or $JV_HOME/runtime itself), or undefined
 * when the folder is a package. Lets a shim of one home bootstrap another (JV_HOME set by the caller, D-024).
 */
function homeOfInstalledRuntime(dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return undefined;
  }
  const parent = dirname(real);
  if (parent.split(sep).pop() === 'runtimes' && existsSync(join(dirname(parent), 'install.json'))) return dirname(parent);
  return undefined;
}

function resolveSource(opts, jvHome, log) {
  const selfRuntime = resolve(here, '..');
  const installed = readJson(join(jvHome, 'install.json'));
  const selfHome = isInstalledRuntime(selfRuntime, jvHome) ? jvHome : homeOfInstalledRuntime(selfRuntime);
  let source;
  let why;
  if (opts.source) {
    source = resolve(expandTilde(opts.source));
    why = 'given with --source';
  } else if (opts.mode === 'update' && installed?.source) {
    source = installed.source;
    why = 'recorded in install.json';
  } else if (selfHome === undefined) {
    source = selfRuntime;
    why = 'the package this bootstrap runs from';
  } else if (installed?.source) {
    source = installed.source;
    why = 'recorded in install.json';
  } else if (readJson(join(selfHome, 'install.json'))?.source) {
    source = readJson(join(selfHome, 'install.json')).source;
    why = `recorded in ${join(selfHome, 'install.json')}`;
  } else {
    throw new BootstrapError(
      `cannot tell where the package is: ${join(jvHome, 'install.json')} has no source. ` +
        'Run jv bootstrap from the installed package (the jevellan-router skill folder).',
    );
  }
  if (!validRuntime(source)) {
    throw new BootstrapError(`${source} (${why}) is not a jv runtime folder; reinstall the package and run jv bootstrap`);
  }
  if (isInstalledRuntime(source, jvHome) || homeOfInstalledRuntime(source) !== undefined) {
    throw new BootstrapError(`the source ${source} is an installed runtime itself; run jv bootstrap from the package`);
  }
  const skills = resolve(source, '..', '..', '..');
  if (!existsSync(join(skills, ROUTER_SKILL, 'SKILL.md'))) {
    throw new BootstrapError(`${skills} has no ${ROUTER_SKILL}/SKILL.md; the runtime is not inside the package skills`);
  }
  log(`source: ${source} (${why})`);
  return { runtime: realpathSync(source), skills: realpathSync(skills) };
}

function homeFolders(jvHome) {
  return {
    700: [jvHome, join(jvHome, 'secrets')],
    default: [
      join(jvHome, 'bin'),
      join(jvHome, 'runtimes'),
      join(jvHome, 'skill-sets'),
      join(jvHome, 'homes'),
      join(jvHome, 'projects'),
      join(jvHome, 'worktrees'),
      join(jvHome, 'logs'),
      join(jvHome, 'archive'),
    ],
  };
}

function writeShim(jvHome) {
  const shim = join(jvHome, 'bin', 'jv');
  const entry = join(jvHome, 'runtime', 'bin', 'jv.mjs');
  // ${JV_HOME:-default} keeps a JV_HOME the caller set (section 1); the default is quoted outside the expansion.
  const content = [
    '#!/bin/sh',
    '# Written by jv bootstrap: runs the jv runtime with the Node binary it was installed with (D-001). A JV_HOME',
    '# set by the caller wins over the home this shim was installed in (D-024).',
    `JV_HOME="\${JV_HOME:-}"`,
    `[ -n "$JV_HOME" ] || JV_HOME=${shQuote(jvHome)}`,
    'export JV_HOME',
    `exec ${shQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shQuote(entry)} "$@"`,
    '',
  ].join('\n');
  writeFileAtomic(shim, content, 0o755);
  return shim;
}

// ---- the lock ----------------------------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v.pid === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

function tryCreateLock(file) {
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Takes $JV_HOME/bootstrap.lock (O_EXCL, holding {pid, at}). A lock whose pid is gone is stale and removed (after
 * reading it again, so a fresh lock is never removed). Waits up to waitMs for a live holder; returns a release
 * function, also run on process exit.
 */
async function acquireLock(jvHome, waitMs, log) {
  const file = join(jvHome, LOCK_FILE);
  const started = Date.now();
  let announced = false;
  for (;;) {
    if (tryCreateLock(file)) break;
    const holder = readLock(file);
    if (holder === undefined) {
      // Being written right now, or garbage: garbage older than a few seconds is stale.
      let age = 0;
      try {
        age = Date.now() - statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age > 5000) {
        try {
          unlinkSync(file);
        } catch {
          // someone else removed it
        }
        continue;
      }
    } else if (holder.pid === process.pid) {
      break; // re-entrant (a delegated bootstrap in the same process)
    } else if (!pidAlive(holder.pid)) {
      const again = readLock(file);
      if (again && again.pid === holder.pid) {
        try {
          unlinkSync(file);
        } catch {
          // someone else removed it
        }
      }
      continue;
    } else if (!announced) {
      log(`waiting for jv bootstrap (pid ${holder.pid}) to finish`);
      announced = true;
    }
    if (Date.now() - started > waitMs) {
      throw new BootstrapError(
        `another jv bootstrap (pid ${holder?.pid ?? '?'}) still holds ${file} after ${Math.round(waitMs / 1000)} s; try again when it is done`,
        2,
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const holder = readLock(file);
    if (holder && holder.pid === process.pid) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
  };
  process.once('exit', release);
  return release;
}

// ---- fingerprint, versions and the switch -----------------------------------------------------------------

function hashTree(hash, root, filter, label) {
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (!filter(p)) continue;
      const st = lstatSync(p);
      const rel = relative(root, p).split(sep).join('/');
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        hash.update(`${label}:${rel}\0${st.mode & 0o111 ? 'x' : '-'}\0`);
        hash.update(readFileSync(p));
        hash.update('\0');
      } else if (st.isSymbolicLink()) hash.update(`${label}:${rel}\0link\0${readlinkSync(p)}\0`);
    }
  };
  walk(root);
}

function skillNames(skillsRoot) {
  return readdirSync(skillsRoot)
    .filter((n) => n.startsWith(SKILL_PREFIX) && statSync(join(skillsRoot, n)).isDirectory())
    .sort();
}

/** sha256 of everything the bootstrap installs from the package, plus the Node binary and the bootstrap format. */
function fingerprint(source) {
  const hash = createHash('sha256');
  hash.update(`format ${BOOTSTRAP_FORMAT}\0node ${process.execPath}\0`);
  hashTree(hash, source.runtime, runtimeFilter(source.runtime), 'runtime');
  for (const name of skillNames(source.skills)) {
    const dir = join(source.skills, name);
    hashTree(hash, dir, skillFilter(dir, name), `skill/${name}`);
  }
  const agents = resolve(source.skills, '..', 'agents');
  if (existsSync(agents)) {
    for (const f of readdirSync(agents).sort()) {
      if (AGENT_FILE.test(f) && lstatSync(join(agents, f)).isFile()) {
        hash.update(`agent:${f}\0`);
        hash.update(readFileSync(join(agents, f)));
      }
    }
  }
  return hash.digest('hex');
}

/** The folder a $JV_HOME link points at, or undefined when it is not a link. */
function linkTarget(link) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    return resolve(dirname(link), readlinkSync(link));
  } catch {
    return undefined;
  }
}

/**
 * Points `link` at `target` with one rename(2), so readers see the old folder or the new one, never nothing. A real
 * folder at `link` (an install from before D-021) is moved into `versionsDir` as legacy-<time> first.
 */
function switchLink(link, target, versionsDir, log) {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st && !st.isSymbolicLink()) {
    if (st.isDirectory() && readdirSync(link).length === 0) rmdirSync(link);
    else {
      const legacy = join(versionsDir, `legacy-${stamp()}`);
      log(`moving the folder ${link} (installed before versioned folders) to ${legacy}`);
      renameSync(link, legacy);
    }
  }
  const tmp = `${link}.link-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // none left over
  }
  symlinkSync(relative(dirname(link), target), tmp);
  renameSync(tmp, link);
}

/** Keeps the current and the previous version folder; moves older ones to archive/<kind>/. */
function archiveOldVersions(versionsDir, current, previous, archiveKind, jvHome, log) {
  const keep = new Set([current, previous].filter(Boolean).map((p) => resolve(p)));
  const archived = [];
  for (const name of readdirSync(versionsDir)) {
    const dir = join(versionsDir, name);
    if (keep.has(resolve(dir))) continue;
    if (name.endsWith('.partial')) {
      // A build that failed part way: jv's own output, never used.
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (!lstatSync(dir).isDirectory()) continue;
    const free = join(jvHome, 'archive', archiveKind, name);
    const dest = existsSync(free) ? `${free}-${stamp()}` : free;
    ensureDir(dirname(dest));
    renameSync(dir, dest);
    // node_modules is reinstalled by npm ci from the archived package-lock.json; the rest is kept.
    rmSync(join(dest, 'node_modules'), { recursive: true, force: true });
    archived.push(name);
  }
  if (archived.length) log(`archived ${archiveKind}: ${archived.join(', ')}`);
  return archived;
}

function removePartials(versionsDir) {
  for (const name of readdirSync(versionsDir)) {
    if (name.endsWith('.partial')) rmSync(join(versionsDir, name), { recursive: true, force: true });
  }
}

function buildRuntime(source, dir, log) {
  log(`building the runtime in ${dir}`);
  cpSync(source.runtime, dir, { recursive: true, force: true, filter: runtimeFilter(source.runtime) });
  const npm = npmInvocation();
  const hasLock = existsSync(join(dir, 'package-lock.json'));
  run(
    npm.command,
    [...npm.prefix, hasLock ? 'ci' : 'install', '--no-audit', '--no-fund', '--loglevel=error'],
    dir,
    log,
    hasLock ? 'npm ci' : 'npm install (no package-lock.json in the package)',
  );
  const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new BootstrapError(`TypeScript is missing after npm ci (${tsc})`, 1);
  run(process.execPath, [tsc, '-p', 'tsconfig.json'], dir, log, 'tsc -p tsconfig.json');
  run(npm.command, [...npm.prefix, 'prune', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], dir, log, 'npm prune --omit=dev');
  if (!existsSync(join(dir, 'dist', 'cli.js'))) throw new BootstrapError(`the build did not produce ${join(dir, 'dist', 'cli.js')}`, 1);
}

function buildSkills(source, dir) {
  ensureDir(dir);
  const copied = [];
  for (const name of skillNames(source.skills)) {
    const from = join(source.skills, name);
    cpSync(from, join(dir, name), { recursive: true, force: true, filter: skillFilter(from, name) });
    copied.push(name);
  }
  return copied;
}

/** When `jv update` runs from an installed runtime whose bootstrap differs from the source's, run the source's. */
async function delegateToSource(opts, argv, jvHome, log) {
  if (process.env.JV_BOOTSTRAP_DELEGATED === '1' || opts.source || opts.mode !== 'update') return undefined;
  const installed = readJson(join(jvHome, 'install.json'));
  const theirs = installed?.source ? join(installed.source, 'bin', 'bootstrap.mjs') : undefined;
  const mine = fileURLToPath(import.meta.url);
  if (!theirs || !existsSync(theirs) || samePath(theirs, mine)) return undefined;
  const hashOf = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  if (hashOf(theirs) === hashOf(mine)) return undefined;
  process.env.JV_BOOTSTRAP_DELEGATED = '1';
  log(`the package's bootstrap differs from the installed one; running ${theirs}`);
  const mod = await import(`${pathToFileURL(theirs).href}?at=${Date.now()}`);
  return mod.bootstrap(argv);
}

/** Runs the bootstrap; returns the exit code. */
export async function bootstrap(argv = []) {
  const opts = parseOptions(argv);
  const out = opts.firstUse || opts.json ? process.stderr : process.stdout;
  const log = (line) => process.stderr.write(`[jv ${opts.mode}] ${line}\n`);
  let release = () => {};
  try {
    if (!nodeIsRecentEnough()) {
      throw new BootstrapError(`Node ${process.versions.node} is too old; jv needs Node 22.13 or later (node:sqlite)`);
    }
    const jvHome = resolveJvHome();
    const delegated = await delegateToSource(opts, argv, jvHome, log);
    if (delegated !== undefined) return delegated;

    const folders = homeFolders(jvHome);
    for (const d of folders[700]) ensureDir(d, 0o700);
    for (const d of folders.default) ensureDir(d);

    const waitMs = Number(process.env.JV_BOOTSTRAP_LOCK_WAIT_MS) || (opts.firstUse ? 120_000 : 300_000);
    release = await acquireLock(jvHome, waitMs, log);
    const runtimeLink = join(jvHome, 'runtime');
    const skillsLink = join(jvHome, 'skills');
    if (opts.firstUse && existsSync(join(runtimeLink, 'dist', 'cli.js'))) {
      log('another jv bootstrap installed the runtime meanwhile');
      return 0;
    }

    const source = resolveSource(opts, jvHome, log);
    const pkg = readJson(join(source.runtime, 'package.json')) ?? {};
    const version = String(pkg.version ?? '0.0.0');
    const installed = readJson(join(jvHome, 'install.json'));
    const fp = fingerprint(source);
    const runtimesDir = join(jvHome, 'runtimes');
    const skillSetsDir = join(jvHome, 'skill-sets');
    const upToDate =
      !opts.rebuild &&
      installed?.fingerprint === fp &&
      existsSync(join(runtimeLink, 'dist', 'cli.js')) &&
      existsSync(join(skillsLink, ROUTER_SKILL, 'SKILL.md')) &&
      linkTarget(runtimeLink) !== undefined &&
      linkTarget(skillsLink) !== undefined;

    let skills;
    let built = false;
    if (upToDate) {
      log(`the package is unchanged (fingerprint ${fp.slice(0, 12)}); nothing rebuilt`);
      skills = readdirSync(skillsLink).filter((n) => n.startsWith(SKILL_PREFIX)).sort();
    } else {
      removePartials(runtimesDir);
      removePartials(skillSetsDir);
      const id = `${version}-${fp.slice(0, 8)}-${stamp()}`;
      const runtimePartial = join(runtimesDir, `${id}.partial`);
      const skillsPartial = join(skillSetsDir, `${id}.partial`);
      buildRuntime(source, runtimePartial, log);
      skills = buildSkills(source, skillsPartial);
      log(`staged ${skills.length} skills`);
      const runtimeDir = join(runtimesDir, id);
      const skillsDir = join(skillSetsDir, id);
      renameSync(runtimePartial, runtimeDir);
      renameSync(skillsPartial, skillsDir);
      const previousRuntime = linkTarget(runtimeLink);
      const previousSkills = linkTarget(skillsLink);
      switchLink(runtimeLink, runtimeDir, runtimesDir, log);
      switchLink(skillsLink, skillsDir, skillSetsDir, log);
      log(`switched ${runtimeLink} -> ${relative(jvHome, runtimeDir)} and ${skillsLink} -> ${relative(jvHome, skillsDir)}`);
      // A legacy folder moved aside by switchLink is the previous version.
      const legacy = (dir) =>
        readdirSync(dir)
          .filter((n) => n.startsWith('legacy-'))
          .sort()
          .map((n) => join(dir, n))
          .at(-1);
      archiveOldVersions(runtimesDir, runtimeDir, previousRuntime ?? legacy(runtimesDir), 'runtimes', jvHome, log);
      archiveOldVersions(skillSetsDir, skillsDir, previousSkills ?? legacy(skillSetsDir), 'skill-sets', jvHome, log);
      built = true;
    }

    const shim = writeShim(jvHome);
    log(`wrote ${shim}`);

    let seed = null;
    const seeds = join(runtimeLink, 'dist', 'seeds.js');
    if (existsSync(seeds)) {
      process.env.JV_HOME = jvHome;
      const mod = await import(`${pathToFileURL(realpathSync(seeds)).href}?at=${Date.now()}`);
      if (typeof mod.seed === 'function') {
        log('seeding provider homes, providers.json and hooks');
        seed =
          (await mod.seed({
            jvHome,
            runtimeDir: realpathSync(runtimeLink),
            skillsDir: skillsLink,
            sourceSkillsDir: source.skills,
            nodePath: process.execPath,
            log,
          })) ?? null;
      }
    } else {
      log('no seeds module in this build; provider homes and providers.json are not seeded');
    }

    const install = {
      source: source.runtime,
      version,
      fingerprint: fp,
      runtime: relative(jvHome, realpathSync(runtimeLink)),
      skills: relative(jvHome, realpathSync(skillsLink)),
      nodePath: process.execPath,
      at: built || !installed?.at ? new Date().toISOString() : installed.at,
    };
    if (JSON.stringify(installed) !== JSON.stringify(install)) {
      writeFileAtomic(join(jvHome, 'install.json'), `${JSON.stringify(install, null, 2)}\n`);
    }

    const binDir = join(jvHome, 'bin');
    const onPath = (process.env.PATH ?? '').split(delimiter).some((p) => p !== '' && samePath(p, binDir));
    const pathLine = `export PATH="${binDir}:$PATH"`;
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, jvHome, ...install, built, skillNames: skills, shim, seed, pathLine, onPath }, null, 2)}\n`,
      );
    } else {
      out.write(`jv ${version} ${built ? 'installed' : 'is up to date'} in ${jvHome} from ${source.runtime}\n`);
      out.write(onPath ? `${binDir} is on PATH already.\n` : `Add jv to PATH (for example in ~/.profile):\n${pathLine}\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof BootstrapError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, exitCode: code }, null, 2)}\n`);
    else process.stderr.write(`jv ${opts.mode}: ${message}\n`);
    return code;
  } finally {
    release();
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name !== 'ExperimentalWarning') process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
  bootstrap(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

