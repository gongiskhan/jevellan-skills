// seed(): the part of jv bootstrap and jv update that runs after the build (bin/bootstrap.mjs imports dist/seeds.js).
//
//   1. writes $JV_HOME/providers.json from the template when it is missing, naming a tokenFile for a Claude
//      subscription whose $JV_HOME/secrets/<name>.token exists (D-003);
//   2. creates each provider home (mode 700) with its .claude/ (Claude kinds) or .codex/ (Codex) folder;
//   3. seeds homes from $JV_HOME/seeds.json (provider name -> source folder) when the target has no login yet,
//      copying only the login and onboarding files of D-002, never writing to the source, and records what it
//      copied (paths and byte sizes, never contents) in $JV_HOME/seeds-applied.json;
//   4. sets hasCompletedOnboarding in <home>/.claude.json of every Claude provider;
//   5. merges the jv Stop hook (section 6.4) into <home>/.claude/settings.json of every Claude provider, with the
//      absolute report guard path and the bootstrap's Node binary;
//   6. installs the jevellan skills and the coordinator agent into every Claude provider home (user scope of the
//      HOME the coordinator and workers run under), from $JV_HOME/skills; see installCoordinatorSkills;
//   7. links <home>/.jv to $JV_HOME in every Claude provider home, so a "~/.jv/..." path (the APM hook of a
//      project's .claude/settings.json) resolves under that HOME too (D-016);
//   8. archives a seeded .credentials.json of a Claude subscription that logs in with its tokenFile (D-003): jv
//      never uses it, and a second live copy of a refresh token can sign the original out.
//
// Everything is idempotent. Nothing is deleted: an unreadable .claude.json is moved aside, never removed. Every
// provider home is checked again (providerHomeProblem) before anything is written into it.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { refused } from './errors.js';
import { paths, providerHomeProblem } from './paths.js';
import { ARCHIVED_CREDENTIALS_DIR } from './redact.js';
import { CLAUDE_KINDS, loadProviders, type Provider } from './providers.js';

export interface SeedOptions {
  jvHome: string;
  runtimeDir: string;
  skillsDir: string;
  sourceSkillsDir: string;
  nodePath: string;
  log?: (line: string) => void;
}

export interface SeedCopy {
  from: string;
  to: string;
  bytes: number;
}

export interface SeedRecord {
  source: string;
  at: string;
  files: SeedCopy[];
  notes?: string[];
  /** Seeded files jv later moved to ~/.jv/archive/credentials (paths only). */
  archived?: Array<{ from: string; to: string; at: string; why: string }>;
}

export interface SeedSummary {
  providersJson: 'created' | 'kept' | 'invalid';
  providersError?: string;
  homes: string[];
  seeds: Record<string, { applied: boolean; reason: string; files?: SeedCopy[] }>;
  onboarding: Record<string, 'set' | 'already'>;
  hooks: Record<string, 'added' | 'updated' | 'unchanged' | 'invalid settings.json'>;
  hookCommand: string;
  skills: SkillInstallSummary;
  /** <home>/.jv of each Claude provider home: 'linked' now, 'present' already, or why it was left alone. */
  jvLinks: Record<string, string>;
  /** Login files moved to the archive in this run, by provider. */
  archivedLogins: Record<string, string>;
  /** Providers whose home failed the safety check; nothing was written for them. */
  refusedHomes: Record<string, string>;
  /** The agent files staged in $JV_HOME/agents. */
  agents: string[];
}

export const SEEDS_FILE = 'seeds.json';
export const SEEDS_APPLIED_FILE = 'seeds-applied.json';
export const REPORT_GUARD_MARK = 'report-guard.mjs';
const AGENTS_DIR = 'agents';
const SKILL_PREFIX = 'jevellan-';
/** jevellan-<name>.agent.md (the package) or jevellan-<name>.md (what APM deploys: the ".agent" infix dropped). */
const AGENT_FILE = /^(jevellan-[A-Za-z0-9._-]+?)(\.agent)?\.md$/;

// ---- small file helpers ------------------------------------------------------------------------------------

function ensureDir(dir: string, mode?: number): void {
  mkdirSync(dir, { recursive: true });
  if (mode !== undefined) chmodSync(dir, mode);
}

function writeAtomic(file: string, content: string, mode = 0o600): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, missing: true };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, missing: false };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function shellWord(s: string): string {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---- providers.json ----------------------------------------------------------------------------------------

/** Writes providers.json from the template when it is missing. Returns whether it was created. */
export function writeProvidersFromTemplate(runtimeDir: string, file: string = paths.providersFile): boolean {
  if (existsSync(file)) return false;
  const template = JSON.parse(readFileSync(join(runtimeDir, 'templates', 'providers.json'), 'utf8')) as {
    providers: Array<Record<string, unknown>>;
  };
  template.providers = template.providers.map((p) => {
    if (p.kind !== 'claude-subscription' || typeof p.name !== 'string') return p;
    const tokenName = `${p.name}.token`;
    if (!existsSync(paths.secretFile(tokenName))) return p;
    // Keep the key order readable: tokenFile right after home.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      out[k] = v;
      if (k === 'home') out.tokenFile = `~/.jv/secrets/${tokenName}`;
    }
    if (!('tokenFile' in out)) out.tokenFile = `~/.jv/secrets/${tokenName}`;
    return out;
  });
  writeAtomic(file, `${JSON.stringify(template, null, 2)}\n`, 0o600);
  return true;
}

// ---- provider homes ----------------------------------------------------------------------------------------

/** Refuses (exit 2) a provider HOME jv must not write into (see paths.providerHomeProblem). */
export function assertProviderHome(home: string): void {
  const problem = providerHomeProblem(home);
  if (problem) throw refused(`refusing to write into the provider home: ${problem}`);
}

/** Creates the provider's HOME (mode 700) and its .claude/ or .codex/ config folder. */
export function ensureProviderHome(p: Provider): string | undefined {
  if (p.home === undefined) return undefined;
  assertProviderHome(p.home);
  ensureDir(p.home, 0o700);
  if (CLAUDE_KINDS.includes(p.kind)) ensureDir(join(p.home, '.claude'), 0o700);
  if (p.kind === 'codex-subscription') ensureDir(join(p.home, '.codex'), 0o700);
  return p.home;
}

/** The file whose presence means the home already has its own login. */
export function loginFile(p: Provider): string | undefined {
  if (p.home === undefined) return undefined;
  if (CLAUDE_KINDS.includes(p.kind)) return join(p.home, '.claude', '.credentials.json');
  if (p.kind === 'codex-subscription') return join(p.home, '.codex', 'auth.json');
  return undefined;
}

/** Whether the provider logs in with a token file, so a .credentials.json in its home is never used (D-003). */
export function usesTokenFile(p: Provider): boolean {
  return p.kind === 'claude-subscription' && p.tokenFile !== undefined;
}

/**
 * D-002: the only files copied from a Jevellan home, as [source name, target path]. A Claude subscription with a
 * tokenFile gets no .credentials.json: the token is its login, and a second live copy of Jevellan's refresh token
 * could be refreshed here and sign Jevellan out.
 */
export function seedFileMap(p: Provider): Array<[string, string]> {
  if (p.home === undefined) return [];
  if (CLAUDE_KINDS.includes(p.kind)) {
    return [
      ['.claude.json', join(p.home, '.claude.json')],
      ...(usesTokenFile(p) ? [] : ([['.credentials.json', join(p.home, '.claude', '.credentials.json')]] as Array<[string, string]>)),
    ];
  }
  if (p.kind === 'codex-subscription') return [['auth.json', join(p.home, '.codex', 'auth.json')]];
  return [];
}

function readSeedsApplied(file: string): Record<string, SeedRecord> {
  const r = readJsonFile(file);
  return r.ok && isPlainObject(r.value) ? (r.value as Record<string, SeedRecord>) : {};
}

/** Whether a .claude.json is the minimal one jv writes (its only key is hasCompletedOnboarding). */
export function isMinimalClaudeJson(file: string): boolean {
  const r = readJsonFile(file);
  return r.ok && isPlainObject(r.value) && Object.keys(r.value).length === 1 && r.value.hasCompletedOnboarding === true;
}

/**
 * Seeds one provider home from a source folder. Reads the source only; writes a target file only when it does not
 * exist, or, for .claude.json, when the target is the minimal file jv wrote itself (a jv call that ran before
 * seeds.json existed). A .claude.json that is not valid JSON is not copied: a minimal one is written instead.
 * applied is true only when a file was copied; a call that copied nothing leaves the home free to be seeded later.
 */
export function seedProviderHome(p: Provider, source: string): { applied: boolean; reason: string; record?: SeedRecord } {
  if (!isAbsolute(source)) return { applied: false, reason: 'source is not an absolute path' };
  let st;
  try {
    st = statSync(source);
  } catch {
    return { applied: false, reason: 'source folder missing' };
  }
  if (!st.isDirectory()) return { applied: false, reason: 'source is not a folder' };
  const map = seedFileMap(p);
  if (map.length === 0) return { applied: false, reason: `a ${p.kind} provider has no home to seed` };
  const login = loginFile(p);
  if (login !== undefined && existsSync(login)) return { applied: false, reason: 'target home has a login already' };
  const home = resolve(p.home!);
  if (resolve(source) === home) return { applied: false, reason: 'source is the target' };

  ensureProviderHome(p);
  const files: SeedCopy[] = [];
  const notes: string[] = [];
  if (usesTokenFile(p)) notes.push('.credentials.json: not copied, the provider logs in with its tokenFile (D-003)');
  for (const [name, target] of map) {
    const from = join(source, name);
    let fromStat;
    try {
      fromStat = lstatSync(from);
    } catch {
      notes.push(`${name}: not in the source`);
      continue;
    }
    if (!fromStat.isFile()) {
      notes.push(`${name}: not a regular file in the source`);
      continue;
    }
    const replaceMinimal = name === '.claude.json' && existsSync(target) && isMinimalClaudeJson(target);
    if (existsSync(target) && !replaceMinimal) {
      notes.push(`${name}: target exists, kept`);
      continue;
    }
    if (name === '.claude.json') {
      const text = readFileSync(from, 'utf8');
      let valid = true;
      try {
        valid = isPlainObject(JSON.parse(text));
      } catch {
        valid = false;
      }
      if (!valid) {
        notes.push(`${name}: invalid json in the source, ${replaceMinimal ? 'kept the minimal one' : 'wrote a minimal one'}`);
        if (replaceMinimal) continue;
      }
      const content = valid ? text : `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`;
      if (replaceMinimal) {
        writeAtomic(target, content, 0o600);
        notes.push(`${name}: replaced the minimal one jv wrote before seeding`);
      } else {
        writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
        chmodSync(target, 0o600);
      }
      files.push({ from, to: target, bytes: Buffer.byteLength(content) });
    } else {
      copyFileSync(from, target, constants.COPYFILE_EXCL);
      chmodSync(target, 0o600);
      files.push({ from, to: target, bytes: statSync(target).size });
    }
  }
  const record: SeedRecord = { source, at: new Date().toISOString(), files, ...(notes.length ? { notes } : {}) };
  return { applied: files.length > 0, reason: files.length ? `copied ${files.length} file(s)` : 'nothing to copy', record };
}

/**
 * Moves a seeded .credentials.json out of a home that logs in with its tokenFile, into
 * $JV_HOME/archive/credentials/ (mode 700; the file keeps mode 600 and stays masked by the redactor). Only a file
 * the seed record says jv copied is moved. Returns the archive path, or undefined when there was nothing to move.
 */
export function archiveUnusedSeededLogin(p: Provider, record: SeedRecord | undefined): { from: string; to: string } | undefined {
  if (!usesTokenFile(p) || p.home === undefined || !record) return undefined;
  const file = join(p.home, '.claude', '.credentials.json');
  if (!record.files.some((f) => resolve(f.to) === resolve(file)) || !existsSync(file)) return undefined;
  const dir = join(paths.archiveDir, ARCHIVED_CREDENTIALS_DIR);
  ensureDir(paths.archiveDir);
  ensureDir(dir, 0o700);
  const to = join(dir, `${p.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.credentials.json`);
  renameSync(file, to);
  chmodSync(to, 0o600);
  return { from: file, to };
}

/**
 * Links <home>/.jv to $JV_HOME, so "~/.jv/..." resolves under a provider HOME the way it does under the owner's
 * (the APM hook in a project's .claude/settings.json is "node ~/.jv/runtime/dist/report-guard.mjs", and the
 * coordinator runs in the project checkout with HOME set to its provider home). Never replaces anything.
 */
export function ensureJvLink(home: string, jvHome: string = paths.home): string {
  const link = join(home, '.jv');
  let st;
  try {
    st = lstatSync(link);
  } catch {
    symlinkSync(jvHome, link);
    return 'linked';
  }
  if (!st.isSymbolicLink()) return `${link} exists and is not a link; left alone`;
  const target = readlinkSync(link);
  if (resolve(home, target) === resolve(jvHome)) return 'present';
  return `${link} points at ${target}, not ${jvHome}; left alone`;
}

/** Sets hasCompletedOnboarding in <home>/.claude.json, keeping every other key. */
export function ensureOnboarding(home: string): 'set' | 'already' {
  const file = join(home, '.claude.json');
  const r = readJsonFile(file);
  let config: Record<string, unknown> = {};
  if (r.ok && isPlainObject(r.value)) config = r.value;
  else if (!r.ok && !r.missing) {
    // Unreadable: archive it next to itself, never delete.
    renameSync(file, `${file}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
  if (config.hasCompletedOnboarding === true) return 'already';
  config.hasCompletedOnboarding = true;
  writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  return 'set';
}

// ---- the Stop hook -----------------------------------------------------------------------------------------

/** The hook command: the bootstrap's Node binary running the installed report guard by absolute path. */
export function reportGuardCommand(nodePath: string, jvHome: string): string {
  const guard = join(jvHome, 'runtime', 'dist', 'report-guard.mjs');
  return `${shellWord(nodePath)} --disable-warning=ExperimentalWarning ${shellWord(guard)}`;
}

function isOurHook(h: unknown): boolean {
  return isPlainObject(h) && typeof h.command === 'string' && h.command.includes(REPORT_GUARD_MARK);
}

/**
 * Returns the hooks.Stop array with exactly one report guard entry, `command`. Every other entry whose command
 * contains report-guard.mjs (an older jv path, an APM copy with "node ~/.jv/...") is folded into it; every other
 * hook and key is kept as it is.
 */
export function mergeStopHooks(stop: unknown, command: string): unknown[] {
  const ours = { type: 'command', command };
  const groups = Array.isArray(stop) ? stop : [];
  const out: unknown[] = [];
  let placed = false;
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurHook(h));
    if (kept.length === group.hooks.length) {
      out.push(group);
      continue;
    }
    if (!placed && kept.length === 0) {
      out.push({ ...group, hooks: [ours] });
      placed = true;
    } else if (kept.length > 0) {
      out.push({ ...group, hooks: kept });
    }
  }
  if (!placed) out.push({ hooks: [ours] });
  return out;
}

/** Merges the jv Stop hook into a Claude settings.json; writes only when something changed. */
export function installStopHook(settingsFile: string, command: string): 'added' | 'updated' | 'unchanged' | 'invalid settings.json' {
  const r = readJsonFile(settingsFile);
  if (!r.ok && !r.missing) return 'invalid settings.json';
  if (r.ok && !isPlainObject(r.value)) return 'invalid settings.json';
  const settings: Record<string, unknown> = r.ok ? (r.value as Record<string, unknown>) : {};
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) return 'invalid settings.json';
  const hooks: Record<string, unknown> = isPlainObject(settings.hooks) ? settings.hooks : {};
  const before = JSON.stringify(hooks.Stop ?? null);
  const hadOurs = Array.isArray(hooks.Stop) && hooks.Stop.some((g) => isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurHook));
  const merged = mergeStopHooks(hooks.Stop, command);
  if (JSON.stringify(merged) === before) return 'unchanged';
  settings.hooks = { ...hooks, Stop: merged };
  ensureDir(join(settingsFile, '..'));
  writeAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  return hadOurs ? 'updated' : 'added';
}

// ---- skills in provider homes ------------------------------------------------------------------------------

export interface SkillInstallSummary {
  homes: Array<{ home: string; skills: number; agents: number; written: number; unchanged: number; archived: string[] }>;
}

function copyTreeIfChanged(src: string, dst: string, counts: { written: number; unchanged: number }): void {
  for (const name of readdirSync(src)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-test') continue;
    const from = join(src, name);
    const to = join(dst, name);
    const st = lstatSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      copyTreeIfChanged(from, to, counts);
    } else if (st.isFile()) {
      if (existsSync(to) && fileHash(to) === fileHash(from)) {
        counts.unchanged++;
        continue;
      }
      ensureDir(dst);
      copyFileSync(from, to);
      counts.written++;
    }
  }
}

/**
 * Installs the jevellan skills and the coordinator agent at user scope of each given HOME:
 * <home>/.claude/skills/<name>/ from `skillsDir` ($JV_HOME/skills, the copy the runtime reads, so the installed
 * copies match it by hash) and <home>/.claude/agents/<name>.md from `agentsDir` (the ".agent" infix dropped, as APM
 * does). The coordinator runs with HOME set to its provider home, so this is the user scope it loads. Files are
 * written only when their content differs. A jevellan-* skill folder in a home that `skillsDir` no longer has (a
 * skill removed from the package) is moved to $JV_HOME/archive/skills/, never deleted. D-015 says why this is a
 * plain copy and not an APM install.
 */
export function installCoordinatorSkills(opts: {
  skillsDir: string;
  agentsDir: string;
  homes: readonly string[];
  archiveDir?: string;
}): SkillInstallSummary {
  const skills = existsSync(opts.skillsDir)
    ? readdirSync(opts.skillsDir).filter(
        (n) => n.startsWith(SKILL_PREFIX) && statSync(join(opts.skillsDir, n)).isDirectory() && existsSync(join(opts.skillsDir, n, 'SKILL.md')),
      )
    : [];
  const agents = existsSync(opts.agentsDir) ? readdirSync(opts.agentsDir).filter((n) => AGENT_FILE.test(n)).sort() : [];
  const archiveRoot = join(opts.archiveDir ?? paths.archiveDir, 'skills');
  const summary: SkillInstallSummary = { homes: [] };
  for (const home of opts.homes) {
    assertProviderHome(home);
    const counts = { written: 0, unchanged: 0 };
    const archived: string[] = [];
    const skillsTarget = join(home, '.claude', 'skills');
    if (existsSync(skillsTarget)) {
      for (const name of readdirSync(skillsTarget)) {
        if (!name.startsWith(SKILL_PREFIX) || skills.includes(name)) continue;
        const dest = join(archiveRoot, `${basename(home)}-${new Date().toISOString().replace(/[:.]/g, '-')}`, name);
        ensureDir(join(dest, '..'));
        renameSync(join(skillsTarget, name), dest);
        archived.push(name);
      }
    }
    for (const name of skills) {
      ensureDir(join(skillsTarget, name));
      copyTreeIfChanged(join(opts.skillsDir, name), join(skillsTarget, name), counts);
    }
    const agentsTarget = join(home, '.claude', 'agents');
    for (const file of agents) {
      ensureDir(agentsTarget);
      const from = join(opts.agentsDir, file);
      const to = join(agentsTarget, `${AGENT_FILE.exec(file)![1]}.md`);
      if (existsSync(to) && fileHash(to) === fileHash(from)) counts.unchanged++;
      else {
        copyFileSync(from, to);
        counts.written++;
      }
    }
    summary.homes.push({ home, skills: skills.length, agents: agents.length, ...counts, archived });
  }
  return summary;
}

/** The Claude provider homes (the homes that get the hook and the skills). */
export function claudeHomes(providers: readonly Provider[]): string[] {
  return providers.filter((p) => CLAUDE_KINDS.includes(p.kind) && p.home !== undefined).map((p) => p.home!);
}

/**
 * Copies the jevellan agents of a package into `staged` as <name>.agent.md. The source is the package's
 * .apm/agents (jevellan-coordinator.agent.md) or, for a package APM installed, the project's .claude/agents, where
 * APM wrote jevellan-coordinator.md; only jevellan-* files are taken, so the owner's own agents are never copied.
 * When both forms exist, the .agent.md file wins. Writes only when the content differs. Returns the staged names.
 */
export function stageAgents(source: string, staged: string): string[] {
  if (!existsSync(source)) return [];
  const picked = new Map<string, string>();
  for (const f of readdirSync(source).sort()) {
    const m = AGENT_FILE.exec(f);
    if (!m || !lstatSync(join(source, f)).isFile()) continue;
    if (!picked.has(m[1]!) || m[2] !== undefined) picked.set(m[1]!, f);
  }
  if (picked.size) ensureDir(staged);
  const out: string[] = [];
  for (const [name, f] of [...picked].sort()) {
    const to = join(staged, `${name}.agent.md`);
    const from = join(source, f);
    if (!existsSync(to) || fileHash(to) !== fileHash(from)) copyFileSync(from, to);
    out.push(`${name}.agent.md`);
  }
  return out;
}

/** $JV_HOME/agents: the agent files staged by the bootstrap for installCoordinatorSkills. */
export function stagedAgentsDir(jvHome: string = paths.home): string {
  return join(jvHome, AGENTS_DIR);
}

// ---- seed ----------------------------------------------------------------------------------------------------

export async function seed(opts: SeedOptions): Promise<SeedSummary> {
  const log = opts.log ?? (() => {});
  if (resolve(opts.jvHome) !== paths.home) {
    throw refused(`seed() was called for ${opts.jvHome} but JV_HOME resolves to ${paths.home}`);
  }
  const hookCommand = reportGuardCommand(opts.nodePath, paths.home);
  const summary: SeedSummary = {
    providersJson: 'kept',
    homes: [],
    seeds: {},
    onboarding: {},
    hooks: {},
    hookCommand,
    skills: { homes: [] },
    jvLinks: {},
    archivedLogins: {},
    refusedHomes: {},
    agents: [],
  };

  if (writeProvidersFromTemplate(opts.runtimeDir)) {
    summary.providersJson = 'created';
    log(`wrote ${paths.providersFile} from the template`);
  }

  // Stage the agent files next to the skills, so jv project add can install them without the package.
  const agentsDir = stagedAgentsDir();
  summary.agents = stageAgents(resolve(opts.sourceSkillsDir, '..', AGENTS_DIR), agentsDir);

  let providers: Provider[];
  try {
    providers = loadProviders().providers;
  } catch (error) {
    summary.providersJson = 'invalid';
    summary.providersError = error instanceof Error ? error.message : String(error);
    log(`providers.json: ${summary.providersError}; provider homes, hooks and skills were not set up`);
    return summary;
  }

  // A home that fails the safety check gets nothing written (parseProviders refuses it already; this is the
  // second check right before writing).
  const safe = providers.filter((p) => {
    if (p.home === undefined) return true;
    const problem = providerHomeProblem(p.home);
    if (problem) {
      summary.refusedHomes[p.name] = problem;
      log(`provider ${p.name}: ${problem}; nothing written`);
    }
    return !problem;
  });
  providers = safe;

  for (const p of providers) {
    const home = ensureProviderHome(p);
    if (home !== undefined) summary.homes.push(home);
  }

  const seedsFile = join(paths.home, SEEDS_FILE);
  const appliedFile = join(paths.home, SEEDS_APPLIED_FILE);
  const seedsJson = readJsonFile(seedsFile);
  if (seedsJson.ok && isPlainObject(seedsJson.value)) {
    const applied = readSeedsApplied(appliedFile);
    let changed = false;
    for (const [name, source] of Object.entries(seedsJson.value)) {
      const p = providers.find((x) => x.name === name);
      if (!p) summary.seeds[name] = { applied: false, reason: 'no such provider in providers.json' };
      else if (typeof source !== 'string') summary.seeds[name] = { applied: false, reason: 'source is not a path' };
      else if (applied[name]) summary.seeds[name] = { applied: false, reason: `already seeded at ${applied[name]!.at}` };
      else {
        const r = seedProviderHome(p, source);
        summary.seeds[name] = { applied: r.applied, reason: r.reason, ...(r.record ? { files: r.record.files } : {}) };
        // Recorded only when a file was copied, so a home that got nothing can still be seeded later.
        if (r.applied && r.record) {
          applied[name] = r.record;
          changed = true;
        }
      }
      log(`seed ${name}: ${summary.seeds[name]!.reason}`);
    }
    if (changed) writeAtomic(appliedFile, `${JSON.stringify(applied, null, 2)}\n`, 0o600);
  } else if (!seedsJson.ok && !seedsJson.missing) {
    log(`${seedsFile} is not valid JSON; no homes were seeded`);
  }

  // A seeded .credentials.json in a home that logs in with its tokenFile is never used: archive it (D-003).
  {
    const applied = readSeedsApplied(appliedFile);
    let changed = false;
    for (const p of providers) {
      const moved = archiveUnusedSeededLogin(p, applied[p.name]);
      if (!moved) continue;
      const record = applied[p.name]!;
      record.archived = [
        ...(record.archived ?? []),
        { from: moved.from, to: moved.to, at: new Date().toISOString(), why: 'the provider logs in with its tokenFile (D-003)' },
      ];
      changed = true;
      summary.archivedLogins[p.name] = moved.to;
      log(`archived the unused ${moved.from} to ${moved.to}`);
    }
    if (changed) writeAtomic(appliedFile, `${JSON.stringify(applied, null, 2)}\n`, 0o600);
  }

  for (const p of providers) {
    if (!CLAUDE_KINDS.includes(p.kind) || p.home === undefined) continue;
    summary.onboarding[p.name] = ensureOnboarding(p.home);
    summary.hooks[p.name] = installStopHook(join(p.home, '.claude', 'settings.json'), hookCommand);
    summary.jvLinks[p.name] = ensureJvLink(p.home, paths.home);
    log(`hook ${p.name}: ${summary.hooks[p.name]}; ~/.jv link: ${summary.jvLinks[p.name]}`);
  }

  summary.skills = installCoordinatorSkills({ skillsDir: opts.skillsDir, agentsDir, homes: claudeHomes(providers) });
  return summary;
}
