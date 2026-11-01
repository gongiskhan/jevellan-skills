// Projects: jv project add and jv project list (the command lives in src/commands/project.ts; the CLI table points
// here, so run() is re-exported lazily below).
//
// jv project add <path> [--name N] registers a git repository in the store with its default branch, writes
// ~/.jv/projects/<name>/ (project.json and landing.json from the templates, an empty notes.md, workflows/), adds the
// jv lines to the repository's shared .git/info/exclude once, and installs the jevellan skills and the coordinator
// agent into the Claude provider homes. It never edits the project's checkout. Running it again changes nothing.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CommandIo, ParsedArgs } from './command.js';
import { notFound, refused } from './errors.js';
import { paths, RUNTIME_ROOT } from './paths.js';
import { loadProviders } from './providers.js';
import { claudeHomes, installCoordinatorSkills, stagedAgentsDir, type SkillInstallSummary } from './seeds.js';
import { openStore } from './store.js';
import type { ProjectRow } from './types.js';

export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Lines jv keeps in the repository's .git/info/exclude (worktrees share it). */
export const EXCLUDE_ALWAYS = ['/.jv-evidence/', '/plan.md'] as const;
/** Added only when the repository does not ignore them already (owner rule: never tracked). */
export const EXCLUDE_IF_NOT_IGNORED = [
  { line: '.claude/', probe: '.claude/' },
  { line: 'CLAUDE.md', probe: 'CLAUDE.md' },
] as const;

function git(cwd: string, args: string[], config: string[] = []): string | undefined {
  try {
    return execFileSync('git', [...config.flatMap((c) => ['-c', c]), '-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    return undefined;
  }
}

function gitOk(cwd: string, args: string[], config: string[] = []): boolean {
  return git(cwd, args, config) !== undefined;
}

/** The top folder of the git work tree containing `dir`, or undefined. */
export function gitTopLevel(dir: string): string | undefined {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top ? realpathSync(top) : undefined;
}

/**
 * The repository's default branch: origin's HEAD when the remote has one, else a local main or master, else the
 * branch checked out now, else init.defaultBranch, else main.
 */
export function defaultBranch(repo: string): string {
  const remote = git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (remote) return remote.replace(/^[^/]+\//, '');
  for (const b of ['main', 'master']) if (gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  const current = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (current) return current;
  return git(repo, ['config', '--get', 'init.defaultBranch']) || 'main';
}

/** The repository's shared exclude file (via --git-common-dir, so linked worktrees resolve to the same file). */
export function excludeFile(repo: string): string {
  const common = git(repo, ['rev-parse', '--git-common-dir']);
  if (!common) throw refused(`${repo} is not a git repository`);
  return join(resolve(repo, common), 'info', 'exclude');
}

/** Appends the jv lines to .git/info/exclude when missing. Returns the lines added. */
export function ensureGitExclude(repo: string): { file: string; added: string[] } {
  const file = excludeFile(repo);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const has = (line: string) => lines.has(line) || lines.has(line.replace(/^\//, ''));
  const added: string[] = [];
  for (const line of EXCLUDE_ALWAYS) if (!has(line)) added.push(line);
  for (const { line, probe } of EXCLUDE_IF_NOT_IGNORED) {
    if (has(line)) continue;
    // Only the repository's own rules count: workers run git with HOME set to a provider home, where the owner's
    // global excludes file does not apply, so a rule that lives only there would not keep .claude/ untracked.
    if (gitOk(repo, ['check-ignore', '-q', probe], ['core.excludesFile=/dev/null'])) continue;
    added.push(line);
  }
  if (added.length) {
    mkdirSync(dirname(file), { recursive: true });
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${sep}# jv (jevellan-skills)\n${added.join('\n')}\n`);
  }
  return { file, added };
}

/** The project's commands guessed from package.json: test and dev scripts with the lockfile's package manager. */
export function detectCommands(repo: string): { testCommand: string | null; devCommand: string | null } {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts?: unknown };
    if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts as Record<string, unknown>;
  } catch {
    return { testCommand: null, devCommand: null };
  }
  const pm = existsSync(join(repo, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(repo, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(repo, 'bun.lockb')) || existsSync(join(repo, 'bun.lock'))
        ? 'bun'
        : 'npm';
  const script = (n: string) => typeof scripts[n] === 'string' && (scripts[n] as string).trim() !== '';
  // npm init writes a test script that only fails; it is not a test command.
  const placeholder = typeof scripts.test === 'string' && /no test specified/.test(scripts.test);
  const testCommand = script('test') && !placeholder ? `${pm} test` : null;
  const devCommand = script('dev') ? `${pm} run dev` : script('start') ? `${pm} start` : null;
  return { testCommand, devCommand };
}

function readTemplate(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RUNTIME_ROOT, 'templates', name), 'utf8')) as Record<string, unknown>;
}

function writeIfMissing(file: string, content: string): 'created' | 'kept' {
  if (existsSync(file)) return 'kept';
  writeFileSync(file, content, { flag: 'wx' });
  return 'created';
}

export interface AddProjectResult {
  project: ProjectRow;
  created: boolean;
  /** Set when the project was registered with another default branch, which this call replaced. */
  branchChangedFrom?: string;
  folder: string;
  files: Record<'project.json' | 'landing.json' | 'notes.md' | 'workflows/', 'created' | 'kept'>;
  exclude: { file: string; added: string[] };
  skills: SkillInstallSummary | { skipped: string };
}

/** The skill installation of jv project add: user scope of every Claude provider home. */
export function installProjectSkills(): SkillInstallSummary | { skipped: string } {
  let homes: string[];
  try {
    homes = claudeHomes(loadProviders().providers);
  } catch (error) {
    return { skipped: error instanceof Error ? error.message : String(error) };
  }
  return installCoordinatorSkills({ skillsDir: paths.skillsDir, agentsDir: stagedAgentsDir(), homes });
}

export function addProject(path: string, options: { name?: string } = {}): AddProjectResult {
  const abs = resolve(path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw notFound(`no folder ${abs}`);
  }
  if (!st.isDirectory()) throw refused(`${abs} is not a folder`);
  const top = gitTopLevel(abs);
  if (!top) throw refused(`${abs} is not inside a git repository`);
  if (realpathSync(abs) !== top) throw refused(`${abs} is inside the repository ${top}; register ${top} instead`);
  const name = options.name ?? basename(top);
  if (!PROJECT_NAME.test(name)) {
    throw refused(`project name "${name}" may use letters, digits, dot, dash and underscore only; pass --name`);
  }
  const branch = defaultBranch(top);

  const store = openStore();
  let created: { row: ProjectRow; created: boolean; branchChangedFrom?: string };
  try {
    created = store.createProject({ name, path: top, default_branch: branch });
  } finally {
    store.close();
  }

  const folder = paths.projectDir(name);
  mkdirSync(folder, { recursive: true });
  const projectJson = { ...readTemplate('project.json'), ...detectCommands(top) };
  const files: AddProjectResult['files'] = {
    'project.json': writeIfMissing(paths.projectJson(name), `${JSON.stringify(projectJson, null, 2)}\n`),
    'landing.json': writeIfMissing(paths.projectLanding(name), `${JSON.stringify(readTemplate('landing.json'), null, 2)}\n`),
    'notes.md': writeIfMissing(paths.projectNotes(name), ''),
    'workflows/': existsSync(paths.projectWorkflowsDir(name)) ? 'kept' : 'created',
  };
  mkdirSync(paths.projectWorkflowsDir(name), { recursive: true });

  const exclude = ensureGitExclude(top);
  const skills = installProjectSkills();
  return {
    project: created.row,
    created: created.created,
    ...(created.branchChangedFrom !== undefined ? { branchChangedFrom: created.branchChangedFrom } : {}),
    folder,
    files,
    exclude,
    skills,
  };
}

export function listProjectRows(): ProjectRow[] {
  const store = openStore();
  try {
    return store.listProjects();
  } finally {
    store.close();
  }
}

/** The CLI entry (the table maps `project` to this file). */
export async function run(args: ParsedArgs, io: CommandIo): Promise<number | void> {
  const mod = await import('./commands/project.js');
  return mod.run(args, io);
}
