// Every jv path, resolved from JV_HOME (default ~/.jv). Nothing else in the runtime reads the user's home for jv
// paths; code that needs a place under the home asks this module. "The user's home" is the owner's home from the user
// database (userHome), never HOME: jv commands run by the coordinator or a worker have HOME set to a provider home
// ($JV_HOME/homes/<name>), and reading HOME there made that provider home "the user's home folder" (J4).

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The owner's home folder from the user database, not from HOME (HOME is a provider home inside sessions). */
export function userHome(): string {
  try {
    const h = userInfo().homedir;
    if (h) return h;
  } catch {
    // no passwd entry
  }
  return homedir();
}

function resolveJvHome(): string {
  const fromEnv = process.env.JV_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(expandTilde(fromEnv.trim()));
  return join(userHome(), '.jv');
}

function expandTilde(p: string): string {
  if (p === '~') return userHome();
  if (p.startsWith('~/')) return join(userHome(), p.slice(2));
  return p;
}

/** The jv home folder, resolved once when this module loads. */
export const JV_HOME: string = resolveJvHome();

/** Name of the evidence folder workers write inside a worktree. */
export const EVIDENCE_DIR = '.jv-evidence';

function findRuntimeRoot(): string {
  // dist/paths.js and dist-test/src/paths.js both sit below the runtime folder; walk up to its package.json.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'bin', 'jv.mjs'))) return dir;
    dir = dirname(dir);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** The folder of the runtime this code runs from (the folder holding package.json and bin/jv.mjs). */
export const RUNTIME_ROOT: string = findRuntimeRoot();

function safeSegment(kind: string, value: string): string {
  if (value === '' || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`invalid ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
}

export const paths = {
  home: JV_HOME,
  store: join(JV_HOME, 'store.sqlite'),
  installFile: join(JV_HOME, 'install.json'),
  providersFile: join(JV_HOME, 'providers.json'),

  binDir: join(JV_HOME, 'bin'),
  shim: join(JV_HOME, 'bin', 'jv'),

  runtimeDir: join(JV_HOME, 'runtime'),
  runtimeDist: join(JV_HOME, 'runtime', 'dist'),
  reportGuard: join(JV_HOME, 'runtime', 'dist', 'report-guard.mjs'),

  skillsDir: join(JV_HOME, 'skills'),
  secretsDir: join(JV_HOME, 'secrets'),
  homesDir: join(JV_HOME, 'homes'),
  projectsDir: join(JV_HOME, 'projects'),
  worktreesDir: join(JV_HOME, 'worktrees'),
  logsDir: join(JV_HOME, 'logs'),
  archiveDir: join(JV_HOME, 'archive'),

  /** ~/.jv/skills/<name>/ */
  skillDir(name: string): string {
    return join(JV_HOME, 'skills', safeSegment('skill name', name));
  },
  /** ~/.jv/skills/<name>/SKILL.md */
  skillFile(name: string): string {
    return join(JV_HOME, 'skills', safeSegment('skill name', name), 'SKILL.md');
  },
  /** ~/.jv/homes/<provider>/ (the HOME of that provider's sessions) */
  providerHome(provider: string): string {
    return join(JV_HOME, 'homes', safeSegment('provider name', provider));
  },
  /** ~/.jv/secrets/<file> */
  secretFile(name: string): string {
    return join(JV_HOME, 'secrets', safeSegment('secret file name', name));
  },
  /** ~/.jv/logs/<session-id>.log */
  sessionLog(sessionId: string): string {
    return join(JV_HOME, 'logs', `${safeSegment('session id', sessionId)}.log`);
  },

  /** ~/.jv/projects/<project>/ */
  projectDir(project: string): string {
    return join(JV_HOME, 'projects', safeSegment('project name', project));
  },
  projectJson(project: string): string {
    return join(paths.projectDir(project), 'project.json');
  },
  projectNotes(project: string): string {
    return join(paths.projectDir(project), 'notes.md');
  },
  projectLanding(project: string): string {
    return join(paths.projectDir(project), 'landing.json');
  },
  projectRules(project: string): string {
    return join(paths.projectDir(project), 'rules.json');
  },
  projectWorkflowsDir(project: string): string {
    return join(paths.projectDir(project), 'workflows');
  },
  /** ~/.jv/projects/<project>/workflows/<kind>.json */
  projectWorkflow(project: string, kind: string): string {
    return join(paths.projectWorkflowsDir(project), `${safeSegment('workflow kind', kind)}.json`);
  },
  coordinatorPrompt(project: string): string {
    return join(paths.projectDir(project), 'coordinator-prompt.md');
  },
  /** ~/.jv/projects/<project>/tasks/<task-id>/ */
  taskDir(project: string, taskId: string): string {
    return join(paths.projectDir(project), 'tasks', safeSegment('task id', taskId));
  },
  /** ~/.jv/projects/<project>/tasks/<task-id>/task.md */
  taskFile(project: string, taskId: string): string {
    return join(paths.taskDir(project, taskId), 'task.md');
  },

  /** ~/.jv/worktrees/<project>/ */
  projectWorktreesDir(project: string): string {
    return join(JV_HOME, 'worktrees', safeSegment('project name', project));
  },
  /** ~/.jv/worktrees/<project>/<branch-slug>/ */
  worktree(project: string, branchSlug: string): string {
    return join(paths.projectWorktreesDir(project), safeSegment('branch slug', branchSlug));
  },
  /** ~/.jv/archive/<project>/ */
  projectArchiveDir(project: string): string {
    return join(JV_HOME, 'archive', safeSegment('project name', project));
  },
};

/** Folders the bootstrap creates (section 1). The home and secrets are mode 700. */
export const HOME_FOLDERS: readonly string[] = [
  paths.binDir,
  paths.runtimeDir,
  paths.skillsDir,
  paths.secretsDir,
  paths.homesDir,
  paths.projectsDir,
  paths.worktreesDir,
  paths.logsDir,
  paths.archiveDir,
];

/**
 * Resolves a path written in a config file (providers.json, project.json). "~/.jv" and anything under it map onto
 * JV_HOME, so a home moved with JV_HOME keeps working with the shipped templates; any other "~/" maps onto the user's
 * home; relative paths resolve against `base` (default JV_HOME).
 */
export function resolveConfigPath(p: string, base: string = JV_HOME): string {
  const v = p.trim();
  if (v === '~/.jv' || v === '~/.jv/') return JV_HOME;
  if (v.startsWith('~/.jv/')) return join(JV_HOME, v.slice('~/.jv/'.length));
  if (v === '~' || v.startsWith('~/')) return expandTilde(v);
  if (isAbsolute(v)) return v;
  return resolve(base, v);
}

/** Whether `child` is `parent` itself (when `orEqual`) or a path below it. Both are compared as given. */
export function isInside(child: string, parent: string, orEqual = false): boolean {
  const rel = relative(parent, child);
  if (rel === '') return orEqual;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The path with symlinks resolved as far as it exists (a missing tail is kept as written). */
export function realpathAsFarAsExists(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try {
    head = realpathSync(head);
  } catch {
    // keep it as written
  }
  return tail.length ? join(head, ...tail) : head;
}

/** The user's Jevellan folders (~/.jevellan, ~/.jevellan-hub, ...): jv never writes there. */
function jevellanFolders(): string[] {
  try {
    return readdirSync(userHome())
      .filter((n) => n.startsWith('.jevellan'))
      .map((n) => join(userHome(), n));
  } catch {
    return [];
  }
}

/**
 * Why a provider HOME is not acceptable, or undefined when it is: it must be a folder strictly inside
 * $JV_HOME/homes/, and never the user's home, nor inside a ~/.jevellan* folder (checked with symlinks resolved too),
 * because jv writes into it (.claude.json, settings.json, skills, logins).
 */
export function providerHomeProblem(home: string): string | undefined {
  const candidates = [...new Set([resolve(home), realpathAsFarAsExists(home)])];
  const homesDirs = [...new Set([paths.homesDir, realpathAsFarAsExists(paths.homesDir)])];
  for (const c of candidates) {
    if (c === resolve(userHome()) || c === realpathAsFarAsExists(userHome())) return `${home} is the user's home folder`;
    const jevellan = [...jevellanFolders(), join(userHome(), '.jevellan')].find((j) => isInside(c, j, true));
    if (jevellan) return `${home} is inside ${jevellan}, which belongs to Jevellan`;
  }
  if (!candidates.every((c) => homesDirs.some((h) => isInside(c, h)))) return `${home} is not inside ${paths.homesDir}`;
  return undefined;
}

/** Branch name of a task: jv/<slug>-<task short id>. */
export function taskBranch(slug: string, taskId: string): string {
  return `jv/${slug}-${taskShortId(taskId)}`;
}

/** The 6 characters of a task id, lower case (used in branch names). */
export function taskShortId(taskId: string): string {
  return taskId.slice(1).toLowerCase();
}

/** A branch name turned into one folder name (for ~/.jv/worktrees/<project>/<branch-slug>). */
export function branchSlug(branch: string): string {
  return branch.replace(/^jv\//, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
}

/** A title turned into a short branch slug: lower case, dashes, at most 40 characters. */
export function slugify(text: string, max = 40): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, max).replace(/-+$/g, '');
  return cut || 'task';
}
