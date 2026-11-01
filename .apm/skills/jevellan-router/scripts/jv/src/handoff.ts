// The handoff (section 9.5): what a new coordinator session needs to pick up where the last one stopped, built
// from the store plus notes.md. `jv handoff --project N` prints it; `jv coordinator start` puts it in the
// coordinator prompt and `jv coordinator restart` types it as the first message.
//
// Parts, in order:
// - tasks not done (queued, running, waiting-owner, landing): id, title, kind, current step, state and reason, the
//   latest report's summary cut to 300 characters;
// - questions waiting on the owner: waiting-owner tasks whose latest report is needs-decision (question and
//   options) or blocked (summary), and landings Jev routed to the owner (state asked: "Land now" or "Leave it");
// - tasks landed in the last 24 hours;
// - failed tasks with their reasons (those that ended in the last 7 days: older failures are history in the store,
//   not work in flight);
// - Jev refusals: pending steps whose state_reason is a Jev refusal ("Jev: ..."), so the step waits for Jev;
// - provider usage: the latest provider_usage row of every provider in providers.json (and any other provider the
//   store has rows for);
// - the full notes.md.

import { readFileSync } from 'node:fs';
import { paths } from './paths.js';
import { loadProviders } from './providers.js';
import { reportView } from './report.js';
import type { Store } from './store.js';
import type { ProjectRow, ReportRow, StepRow, TaskRow } from './types.js';

export const HANDOFF_SUMMARY_MAX = 300;
export const LANDED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const JEV_REFUSAL_PREFIX = 'Jev: ';
export const OPEN_TASK_STATES = ['queued', 'running', 'waiting-owner', 'landing'] as const;
export const LANDING_OPTIONS = [
  { label: 'Land now', description: 'jv land T --force' },
  { label: 'Leave it', description: 'jv task stop T --discard' },
] as const;

export interface HandoffStep {
  ordinal: number;
  total: number;
  duty: string;
  state: string;
  stateReason: string;
}

export interface HandoffTask {
  id: string;
  title: string;
  kind: string;
  state: string;
  stateReason: string;
  step: HandoffStep | null;
  lastReport: { sessionId: string; status: string; summary: string } | null;
}

export interface HandoffQuestion {
  taskId: string;
  title: string;
  /** decision: a needs-decision report; blocked: a blocked report; landing: Jev routed the landing to the owner. */
  kind: 'decision' | 'blocked' | 'landing';
  question: string;
  options: Array<{ label: string; description?: string }>;
  sessionId?: string;
  landingId?: string;
}

export interface HandoffLanded {
  id: string;
  title: string;
  commit: string | null;
  landedAt: string | null;
}

export interface HandoffFailed {
  id: string;
  title: string;
  reason: string;
  endedAt: string | null;
}

export interface HandoffRefusal {
  taskId: string;
  title: string;
  stepId: string;
  ordinal: number;
  duty: string;
  reason: string;
}

export interface HandoffUsage {
  provider: string;
  source: string;
  observedAt: string;
  weeklyPct: number | null;
  fiveHourPct: number | null;
  weeklyResetsAt: string | null;
  fiveHourResetsAt: string | null;
  localWeek: string | null;
  localInputTokens: number | null;
  localOutputTokens: number | null;
  localCostUsd: number | null;
}

export interface Handoff {
  project: { id: string; name: string; path: string; defaultBranch: string };
  generatedAt: string;
  open: HandoffTask[];
  questions: HandoffQuestion[];
  landed: HandoffLanded[];
  failed: HandoffFailed[];
  jevRefusals: HandoffRefusal[];
  usage: HandoffUsage[];
  /** Why provider usage could not list every provider (providers.json missing or invalid), when that happened. */
  usageNote?: string;
  notes: string;
}

export interface BuildHandoffOptions {
  now?: Date;
  /** Provider names to report usage for (default: providers.json, plus every provider the store has rows for). */
  providers?: readonly string[];
  /** notes.md (default ~/.jv/projects/<name>/notes.md). */
  notesFile?: string;
}

/** Text cut to `max` characters (code points), with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join('');
  return `${chars
    .slice(0, max - 3)
    .join('')
    .trimEnd()}...`;
}

/** The step a task is on: the running or retrying one, else the one at current_step, else the first pending, else the last. */
export function currentStepOf(task: Pick<TaskRow, 'current_step'>, steps: readonly StepRow[]): StepRow | undefined {
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  return (
    sorted.find((s) => s.state === 'running' || s.state === 'retrying') ??
    sorted.find((s) => s.ordinal === task.current_step) ??
    sorted.find((s) => s.state === 'pending') ??
    sorted.at(-1)
  );
}

function latestReport(reports: readonly ReportRow[]): ReportRow | undefined {
  return reports.at(-1);
}

/** The notes of a project ('' when there are none). */
export function readNotes(projectName: string, file: string = paths.projectNotes(projectName)): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function usageProviders(store: Store, explicit: readonly string[] | undefined): { names: string[]; note?: string } {
  const names: string[] = [];
  let note: string | undefined;
  if (explicit) names.push(...explicit);
  else {
    try {
      names.push(...loadProviders().providers.map((p) => p.name));
    } catch (error) {
      note = `providers.json could not be read (${error instanceof Error ? error.message : String(error)}); usage lists the providers the store has rows for`;
    }
    for (const row of store.listProviderUsage()) if (!names.includes(row.provider)) names.push(row.provider);
  }
  return { names, ...(note ? { note } : {}) };
}

/** Builds the handoff of a project from the store and its notes. Exit 3 when the project is not registered. */
export function buildHandoff(store: Store, projectIdOrName: string, options: BuildHandoffOptions = {}): Handoff {
  const project: ProjectRow = store.requireProject(projectIdOrName);
  const now = options.now ?? new Date();
  const tasks = store.listTasks({ project_id: project.id });
  const open: HandoffTask[] = [];
  const questions: HandoffQuestion[] = [];
  const landed: HandoffLanded[] = [];
  const failed: HandoffFailed[] = [];
  const jevRefusals: HandoffRefusal[] = [];

  for (const task of tasks) {
    const steps = store.listSteps(task.id);
    const reports = store.listReports({ task_id: task.id });
    const last = latestReport(reports);

    if ((OPEN_TASK_STATES as readonly string[]).includes(task.state)) {
      const step = currentStepOf(task, steps);
      open.push({
        id: task.id,
        title: task.title,
        kind: task.kind,
        state: task.state,
        stateReason: task.state_reason,
        step: step
          ? { ordinal: step.ordinal, total: steps.length, duty: step.duty, state: step.state, stateReason: step.state_reason }
          : null,
        lastReport: last ? { sessionId: last.session_id, status: last.status, summary: cut(last.summary, HANDOFF_SUMMARY_MAX) } : null,
      });
      for (const s of steps) {
        if (s.state === 'pending' && s.state_reason.startsWith(JEV_REFUSAL_PREFIX)) {
          jevRefusals.push({ taskId: task.id, title: task.title, stepId: s.id, ordinal: s.ordinal, duty: s.duty, reason: s.state_reason });
        }
      }
    }

    if (task.state === 'waiting-owner') {
      // Only the last landing row can be an open question: an answered ask is closed by the landing that followed.
      const lastLanding = store.listLandings({ task_id: task.id }).at(-1);
      const asked = lastLanding?.state === 'asked' ? lastLanding : undefined;
      if (asked) {
        questions.push({
          taskId: task.id,
          title: task.title,
          kind: 'landing',
          question: `Land it? ${asked.reason}`.trim(),
          options: LANDING_OPTIONS.map((o) => ({ label: o.label, description: o.description.replace(' T ', ` ${task.id} `) })),
          landingId: asked.id,
        });
      } else if (last && (last.status === 'needs-decision' || last.status === 'blocked')) {
        const view = reportView(last);
        questions.push({
          taskId: task.id,
          title: task.title,
          kind: last.status === 'needs-decision' ? 'decision' : 'blocked',
          question: view.question ?? cut(view.summary, HANDOFF_SUMMARY_MAX),
          options: view.options ?? [],
          sessionId: last.session_id,
        });
      }
    }

    if (task.state === 'done' && task.landed_commit) {
      const landing = store.listLandings({ task_id: task.id, states: ['landed'] }).at(-1);
      const at = landing?.ended_at ?? task.ended_at;
      if (at && now.getTime() - Date.parse(at) <= LANDED_WINDOW_MS) {
        landed.push({ id: task.id, title: task.title, commit: task.landed_commit, landedAt: at });
      }
    }

    if (task.state === 'failed') {
      const at = task.ended_at;
      if (!at || now.getTime() - Date.parse(at) <= FAILED_WINDOW_MS) {
        failed.push({ id: task.id, title: task.title, reason: task.state_reason, endedAt: at });
      }
    }
  }

  const { names, note } = usageProviders(store, options.providers);
  const usage: HandoffUsage[] = [];
  for (const name of names) {
    const row = store.latestProviderUsage(name);
    if (!row) continue;
    usage.push({
      provider: row.provider,
      source: row.source,
      observedAt: row.observed_at,
      weeklyPct: row.weekly_pct,
      fiveHourPct: row.five_hour_pct,
      weeklyResetsAt: row.weekly_resets_at,
      fiveHourResetsAt: row.five_hour_resets_at,
      localWeek: row.local_week,
      localInputTokens: row.local_input_tokens,
      localOutputTokens: row.local_output_tokens,
      localCostUsd: row.local_cost_usd,
    });
  }

  const notesFile = options.notesFile ?? paths.projectNotes(project.name);
  return {
    project: { id: project.id, name: project.name, path: project.path, defaultBranch: project.default_branch },
    generatedAt: now.toISOString(),
    open,
    questions,
    landed,
    failed,
    jevRefusals,
    usage,
    ...(note ? { usageNote: note } : {}),
    notes: readNotes(project.name, notesFile),
  };
}

function pct(v: number | null): string {
  return v === null ? 'unknown' : `${Math.round(v * 10) / 10}%`;
}

/** The handoff as text: what `jv handoff` prints and what the next coordinator session reads. */
export function formatHandoff(h: Handoff): string {
  const out: string[] = [];
  out.push(`Handoff for the project "${h.project.name}" (${h.project.path}, default branch ${h.project.defaultBranch}), ${h.generatedAt}.`);

  out.push('', `Tasks not done (${h.open.length}):`);
  if (h.open.length === 0) out.push('- none');
  for (const t of h.open) {
    const step = t.step ? `step ${t.step.ordinal} of ${t.step.total} ${t.step.duty} (${t.step.state})` : 'no step';
    out.push(`- ${t.id} "${t.title}" (${t.kind}): ${t.state}, ${step}. ${t.stateReason}`.trimEnd());
    if (t.lastReport) out.push(`  Last report (${t.lastReport.status}, jv report ${t.lastReport.sessionId}): ${t.lastReport.summary.replace(/\s*\n\s*/g, ' ')}`);
  }

  out.push('', `Questions waiting on the owner (${h.questions.length}):`);
  if (h.questions.length === 0) out.push('- none');
  h.questions.forEach((q, i) => {
    out.push(`${i + 1}. ${q.taskId} "${q.title}" (${q.kind}): ${q.question.replace(/\s*\n\s*/g, ' ')}`);
    for (const o of q.options) out.push(`   - ${o.label}${o.description ? `: ${o.description}` : ''}`);
  });

  out.push('', `Landed in the last 24 hours (${h.landed.length}):`);
  if (h.landed.length === 0) out.push('- none');
  for (const l of h.landed) out.push(`- ${l.id} "${l.title}"${l.commit ? ` at ${l.commit.slice(0, 12)}` : ''}${l.landedAt ? `, ${l.landedAt}` : ''}`);

  out.push('', `Failed tasks (${h.failed.length}):`);
  if (h.failed.length === 0) out.push('- none');
  for (const f of h.failed) out.push(`- ${f.id} "${f.title}": ${f.reason}`);

  out.push('', `Jev refusals (${h.jevRefusals.length}):`);
  if (h.jevRefusals.length === 0) out.push('- none');
  for (const r of h.jevRefusals) out.push(`- ${r.taskId} "${r.title}" step ${r.ordinal} ${r.duty} waits: ${r.reason}`);

  out.push('', 'Provider usage (latest observation):');
  if (h.usage.length === 0) out.push('- no observations yet');
  for (const u of h.usage) {
    const local =
      u.localWeek !== null
        ? `, week ${u.localWeek}: ${u.localInputTokens ?? 0} in, ${u.localOutputTokens ?? 0} out${u.localCostUsd !== null ? `, $${u.localCostUsd.toFixed(2)}` : ''}`
        : '';
    out.push(`- ${u.provider}: week ${pct(u.weeklyPct)}, five hours ${pct(u.fiveHourPct)} (${u.source}, ${u.observedAt})${local}`);
  }
  if (h.usageNote) out.push(`  (${h.usageNote})`);

  out.push('', 'Notes (notes.md):');
  out.push(h.notes.trim() === '' ? 'No notes yet.' : h.notes.trimEnd());
  return out.join('\n');
}
