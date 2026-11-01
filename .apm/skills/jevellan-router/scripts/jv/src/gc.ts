// jv gc (section 3): archives the worktrees of landed or discarded tasks older than project.json retentionDays
// (default 3). Owner rule: archive, never delete.
//
// For every task that is done with a landed commit, or stopped (discarded), whose end is older than the retention:
// - a clean worktree whose branch landed (the branch is contained in the default branch) is removed with
//   `git worktree remove` (never --force); its evidence (.jv-evidence/ and an untracked plan.md, which the
//   repository's info/exclude hides from git) is moved first to ~/.jv/archive/worktrees/<project>/<name>-<date>/, and
//   the task's worktree_path then names that folder, so report screenshots stay readable;
// - any other worktree (uncommitted changes, a discarded task, a branch with commits that did not land) is moved
//   whole with `git worktree move` to ~/.jv/archive/worktrees/<project>/<name>-<date>, where it stays a registered
//   worktree on its branch; worktree_path follows it.
// Branches stay. Nothing is pruned (`git worktree prune` would also forget worktrees that are not jv's). Each task is
// handled once: meta gc:<task id> records what was done.

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  findWorktree,
  isAncestor,
  isIgnored,
  listText,
  moveWorktree,
  removeWorktree,
  resolveCommit,
  uncommittedFiles,
} from './land-git.js';
import { loadProjectSettings } from './land.js';
import { paths } from './paths.js';
import { nowIso, type Store } from './store.js';
import type { ProjectRow, TaskRow } from './types.js';

export const GC_META_PREFIX = 'gc:';
/** Untracked files a removed worktree's archive keeps. */
export const EVIDENCE_ENTRIES = ['.jv-evidence', 'plan.md'] as const;
const DAY_MS = 86_400_000;

export type GcActionKind = 'removed' | 'archived' | 'skipped';

export interface GcAction {
  taskId: string;
  project: string;
  worktree: string;
  action: GcActionKind;
  reason: string;
  /** The archive folder (archived: the worktree itself; removed: its evidence), when there is one. */
  to?: string;
  /** Planned only (--dry-run). */
  dryRun?: boolean;
}

export interface GcOptions {
  /** Only this project (name or id). */
  project?: string;
  /** Report what would happen, change nothing. */
  dryRun?: boolean;
  now?: Date;
}

/** ~/.jv/archive/worktrees/<project>/ */
export function worktreeArchiveDir(project: string): string {
  return join(paths.archiveDir, 'worktrees', project);
}

/** A free archive folder for a worktree: <name>-<YYYY-MM-DD>, then -2, -3 ... */
export function archiveTarget(project: string, worktree: string, now: Date): string {
  const base = join(worktreeArchiveDir(project), `${basename(worktree)}-${now.toISOString().slice(0, 10)}`);
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) if (!existsSync(`${base}-${i}`)) return `${base}-${i}`;
}

/** Tasks gc considers: landed (done with a landed commit) or discarded (stopped), with a worktree, not handled yet. */
export function gcCandidates(store: Store, project: ProjectRow): TaskRow[] {
  return store
    .listTasks({ project_id: project.id, states: ['done', 'stopped'] })
    .filter((t) => t.worktree_path && (t.state === 'stopped' || t.landed_commit) && store.getMeta(`${GC_META_PREFIX}${t.id}`) === undefined);
}

function record(store: Store, action: GcAction): void {
  store.setMeta(`${GC_META_PREFIX}${action.taskId}`, JSON.stringify({ ...action, at: nowIso() }));
}

async function handle(store: Store, project: ProjectRow, task: TaskRow, now: Date, dryRun: boolean): Promise<GcAction> {
  const worktree = task.worktree_path!;
  const base = { taskId: task.id, project: project.name, worktree, ...(dryRun ? { dryRun: true } : {}) };
  const skip = (reason: string): GcAction => ({ ...base, action: 'skipped', reason });
  const entry = await findWorktree(project.path, worktree);
  if (!existsSync(worktree)) {
    return skip(entry ? 'the folder is gone but git still lists the worktree (jv never prunes)' : 'no worktree at this path');
  }
  if (!entry) return skip(`not a registered worktree of ${project.path}`);
  if (entry.locked) return skip('the worktree is locked');

  const dirty = await uncommittedFiles(worktree);
  let landed = false;
  // A child task landed into its parent's branch (land.ts), which reaches the default branch only later.
  const parent = task.parent_task_id ? store.getTask(task.parent_task_id) : undefined;
  const into = parent?.branch ?? project.default_branch;
  if (task.landed_commit && task.branch && dirty.length === 0) {
    const head = await resolveCommit(project.path, `refs/heads/${task.branch}`);
    const def = await resolveCommit(project.path, `refs/heads/${into}`);
    landed = !!head && !!def && (await isAncestor(project.path, head, def));
  }
  const to = archiveTarget(project.name, worktree, now);

  if (landed) {
    const keep: string[] = [];
    for (const name of EVIDENCE_ENTRIES) {
      if (existsSync(join(worktree, name)) && (await isIgnored(worktree, name))) keep.push(name);
    }
    const action: GcAction = {
      ...base,
      action: 'removed',
      reason: `clean, and ${task.branch} landed; the branch stays${keep.length ? `; ${keep.join(' and ')} archived` : ''}`,
      ...(keep.length ? { to } : {}),
    };
    if (dryRun) return action;
    if (keep.length) {
      mkdirSync(to, { recursive: true });
      for (const name of keep) renameSync(join(worktree, name), join(to, name));
    }
    await removeWorktree(project.path, worktree);
    store.updateTask(task.id, { worktree_path: keep.length ? to : null });
    record(store, action);
    return action;
  }

  const why = dirty.length
    ? `uncommitted changes (${listText(dirty, 5)})`
    : task.state === 'stopped'
      ? 'the task was discarded'
      : `${task.branch ?? 'the branch'} has commits that are not on ${into}`;
  const action: GcAction = { ...base, action: 'archived', reason: `${why}; moved, never deleted; the branch stays`, to };
  if (dryRun) return action;
  mkdirSync(worktreeArchiveDir(project.name), { recursive: true });
  await moveWorktree(project.path, worktree, to);
  store.updateTask(task.id, { worktree_path: to });
  record(store, action);
  return action;
}

/** Runs gc over every project (or one). A failure on one worktree is reported as skipped and gc goes on. */
export async function gc(store: Store, options: GcOptions = {}): Promise<GcAction[]> {
  const now = options.now ?? new Date();
  const projects = options.project ? [store.requireProject(options.project)] : store.listProjects();
  const actions: GcAction[] = [];
  for (const project of projects) {
    const { retentionDays } = loadProjectSettings(project.name);
    const cutoff = now.getTime() - retentionDays * DAY_MS;
    for (const task of gcCandidates(store, project)) {
      const ended = Date.parse(task.ended_at ?? task.created_at);
      if (!(ended <= cutoff)) continue;
      try {
        actions.push(await handle(store, project, task, now, options.dryRun === true));
      } catch (error) {
        actions.push({
          taskId: task.id,
          project: project.name,
          worktree: task.worktree_path!,
          action: 'skipped',
          reason: `failed: ${error instanceof Error ? error.message : String(error)}`,
          ...(options.dryRun ? { dryRun: true } : {}),
        });
      }
    }
  }
  return actions;
}

export function formatGc(actions: readonly GcAction[]): string {
  if (actions.length === 0) return 'Nothing to archive.';
  return actions
    .map((a) => `${a.dryRun ? '(dry run) ' : ''}${a.taskId} ${a.project}: ${a.action} ${a.worktree}${a.to ? ` -> ${a.to}` : ''} (${a.reason})`)
    .join('\n');
}
