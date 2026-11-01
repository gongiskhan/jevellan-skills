// jv status [--project N] (section 3): the tasks and sessions that are not done, waiting-on-owner first. Lost runs
// are marked at read time (launcher.markLost); they are not advanced: jv task resume continues them.
//
// --json is what the coordinator reads: per task its id, title, kind, state, state_reason, current step (ordinal and
// duty), the latest run's model, provider, runtime and state, the last report's status and summary, and, when the
// task waits on the owner, the question and its options (a landing ask offers "Land now" and "Leave it").
// Tasks that are done are left out, and so are stopped ones: a task is stopped only when the owner discarded it, so
// it is no open work (the viewer's first page and the handoff leave it out too, D-083). Failed tasks are listed for
// 24 hours after they ended, and tasks done in the last 24 hours are listed apart as `recent` (what landed today).

import { markLost } from './launcher.js';
import { reportView } from './report.js';
import type { Store } from './store.js';
import type { SessionRow, StepRow, TaskRow, TaskState } from './types.js';

export const RECENT_MS = 24 * 60 * 60 * 1000;
const ORDER: readonly TaskState[] = ['waiting-owner', 'running', 'landing', 'queued', 'failed'];
export const LANDING_OPTIONS = [
  { label: 'Land now', description: 'jv land T --force' },
  { label: 'Leave it', description: 'jv task stop T --discard' },
];

export interface TaskStatus {
  id: string;
  project: string;
  title: string;
  kind: string;
  state: TaskState;
  state_reason: string;
  step: { ordinal: number; duty: string; state: string; of: number } | null;
  run: { id: string; model: string; provider: string; runtime: string; effort: string; state: string; lastEventAt: string | null } | null;
  lost: boolean;
  report: { session: string; status: string; summary: string } | null;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  updatedAt: string;
}

export interface SessionStatus {
  id: string;
  project: string;
  kind: string;
  task: string | null;
  step: number | null;
  runtime: string;
  provider: string;
  model: string;
  state: string;
  state_reason: string;
  lastEventAt: string | null;
  tmuxTarget: string | null;
}

export interface StatusView {
  tasks: TaskStatus[];
  sessions: SessionStatus[];
  recent: Array<{ id: string; project: string; title: string; kind: string; endedAt: string | null; landedCommit: string | null }>;
  lost: string[];
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : text;
}

function statusStep(store: Store, task: TaskRow, steps: StepRow[]): StepRow | undefined {
  const byOrdinal = task.current_step > 0 ? steps.find((s) => s.ordinal === task.current_step) : undefined;
  return byOrdinal ?? steps.find((s) => s.state !== 'done' && s.state !== 'skipped') ?? steps.at(-1);
}

export function taskStatus(store: Store, task: TaskRow, projectName: string): TaskStatus {
  const steps = store.listSteps(task.id);
  const step = statusStep(store, task, steps);
  const run = store.listSessions({ task_id: task.id, kind: 'step' }).at(-1);
  const report = store.listReports({ task_id: task.id }).at(-1);
  const view = report ? reportView(report) : undefined;
  const landing = store.listLandings({ task_id: task.id }).at(-1);
  const status: TaskStatus = {
    id: task.id,
    project: projectName,
    title: task.title,
    kind: task.kind,
    state: task.state,
    state_reason: task.state_reason,
    step: step ? { ordinal: step.ordinal, duty: step.duty, state: step.state, of: steps.length } : null,
    run: run
      ? { id: run.id, model: run.model, provider: run.provider, runtime: run.runtime, effort: run.effort, state: run.state, lastEventAt: run.last_event_at }
      : null,
    lost: run?.state === 'lost',
    report: view ? { session: view.sessionId, status: view.status, summary: cut(view.summary, 600) } : null,
    updatedAt: run?.last_event_at ?? task.ended_at ?? task.started_at ?? task.created_at,
  };
  if (task.state === 'waiting-owner') {
    if (landing?.state === 'asked') {
      status.question = `Land ${task.id}? ${landing.reason}`;
      status.options = LANDING_OPTIONS.map((o) => ({ label: o.label, description: o.description.replace(' T ', ` ${task.id} `) }));
    } else if (view && (view.status === 'needs-decision' || view.status === 'blocked') && run && view.sessionId === run.id) {
      if (view.question) status.question = view.question;
      if (view.options?.length) status.options = view.options;
    }
  }
  return status;
}

function sessionStatus(s: SessionRow, projectName: string, step: number | null): SessionStatus {
  return {
    id: s.id,
    project: projectName,
    kind: s.kind,
    task: s.task_id,
    step,
    runtime: s.runtime,
    provider: s.provider,
    model: s.model,
    state: s.state,
    state_reason: s.state_reason,
    lastEventAt: s.last_event_at,
    tmuxTarget: s.tmux_target,
  };
}

/** The status of every project (or one). Marks lost runs first. */
export function statusView(store: Store, options: { project?: string; now?: number; markLost?: boolean } = {}): StatusView {
  const lost = options.markLost === false ? [] : markLost(store).map((s) => s.id);
  const now = options.now ?? Date.now();
  const project = options.project ? store.requireProject(options.project) : undefined;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const tasks = store.listTasks(project ? { project_id: project.id } : {});
  const recentCut = new Date(now - RECENT_MS).toISOString();

  const listed = tasks.filter((t) => {
    if (t.state === 'done' || t.state === 'stopped') return false;
    if (t.state === 'failed') return (t.ended_at ?? t.created_at) >= recentCut;
    return true;
  });
  const statuses = listed
    .map((t) => taskStatus(store, t, names.get(t.project_id) ?? t.project_id))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.updatedAt.localeCompare(b.updatedAt));

  const openTasks = new Set(tasks.filter((t) => !['done', 'stopped'].includes(t.state)).map((t) => t.id));
  const sessions: SessionStatus[] = [];
  for (const s of store.listSessions(project ? { project_id: project.id } : {})) {
    if (['done', 'failed', 'stopped'].includes(s.state)) continue;
    if (s.kind === 'step') {
      if (!s.task_id || !openTasks.has(s.task_id)) continue;
      // A lost run that a later run of its step continued is history, not open work.
      if (s.state === 'lost' && store.listSessions({ step_id: s.step_id ?? '' }).at(-1)?.id !== s.id) continue;
    }
    const step = s.step_id ? (store.getStep(s.step_id)?.ordinal ?? null) : null;
    sessions.push(sessionStatus(s, names.get(s.project_id) ?? s.project_id, step));
  }

  const recent = tasks
    .filter((t) => t.state === 'done' && (t.ended_at ?? '') >= recentCut)
    .map((t) => ({ id: t.id, project: names.get(t.project_id) ?? t.project_id, title: t.title, kind: t.kind, endedAt: t.ended_at, landedCommit: t.landed_commit }));
  return { tasks: statuses, sessions, recent, lost };
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function formatStatus(view: StatusView, now: number = Date.now()): string {
  const lines: string[] = [];
  if (!view.tasks.length) lines.push('No open tasks.');
  let group: string | undefined;
  for (const t of view.tasks) {
    if (t.state !== group) {
      group = t.state;
      lines.push('', `${t.state}:`);
    }
    const step = t.step ? `step ${t.step.ordinal}/${t.step.of} ${t.step.duty}` : 'no step';
    const run = t.run ? `${t.run.model} ${t.run.effort} on ${t.run.provider} (${t.run.runtime}) ${t.run.state}, last event ${ago(t.run.lastEventAt, now)}` : 'no run yet';
    lines.push(`  ${t.id} [${t.project}] ${t.title} (${t.kind}) - ${step} - ${run}${t.lost ? ' - LOST: jv task resume ' + t.id : ''}`);
    lines.push(`     ${t.state_reason}`);
    if (t.question) lines.push(`     Question: ${t.question}`);
    for (const [i, o] of (t.options ?? []).entries()) lines.push(`       ${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ''}`);
  }
  const others = view.sessions.filter((s) => s.kind !== 'step');
  if (others.length) {
    lines.push('', 'Other sessions:');
    for (const s of others) lines.push(`  ${s.id} ${s.kind} [${s.project}] ${s.model} on ${s.provider} ${s.state}${s.tmuxTarget ? ` (tmux ${s.tmuxTarget})` : ''}`);
  }
  if (view.recent.length) {
    lines.push('', 'Done in the last 24 hours:');
    for (const r of view.recent) lines.push(`  ${r.id} [${r.project}] ${r.title}${r.landedCommit ? ` (landed ${r.landedCommit.slice(0, 12)})` : ''}`);
  }
  if (view.lost.length) lines.push('', `Marked lost now: ${view.lost.join(', ')}`);
  return lines.join('\n').replace(/^\n+/, '');
}
