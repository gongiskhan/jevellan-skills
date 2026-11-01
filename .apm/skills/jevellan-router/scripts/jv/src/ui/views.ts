// What each page of the viewer shows, built from the read-only store (section 10). Pure reads: nothing here writes,
// and nothing here reads a file other than the store (evidence images are served by evidence.ts).
//
// - A session counts as lost when its row says so, or (what markLost would decide, without writing) when it is
//   starting or running, has a pid, the process is gone and no `end` event arrived.
// - A task's current step is the running or retrying step, else the step at tasks.current_step (unless skipped),
//   else the first pending step, else the last step that was not skipped. Its model and provider are those of the
//   task's newest step session.
// - Screenshots carry a `url` only when the report path is under the task worktree's .jv-evidence/ folder and names
//   an image; evidence.ts checks the same rules again when the image is fetched.

import { isAbsolute, posix, relative } from 'node:path';
import { isRunAlive } from '../launcher.js';
import { EVIDENCE_DIR } from '../paths.js';
import { reportView, type ReportView } from '../report.js';
import type {
  DecisionRow,
  EventRow,
  LandingRow,
  MessageRow,
  ProjectRow,
  ProviderUsageRow,
  ReportRow,
  SessionRow,
  StepRow,
  TaskRow,
  TaskState,
} from '../types.js';
import type { ReadOnlyStore } from './db.js';

/** Image files the evidence route serves (lower case extensions). */
export const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'];

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_SESSION_STATES = ['starting', 'running'];

/** The order of the task groups on the first page (section 10). */
export const TASK_GROUPS: ReadonlyArray<{ state: TaskState; label: string; recentOnly?: boolean }> = [
  { state: 'waiting-owner', label: 'Waiting on the owner' },
  { state: 'running', label: 'Running' },
  { state: 'queued', label: 'Queued' },
  { state: 'landing', label: 'Landing' },
  { state: 'done', label: 'Done in the last 24 hours', recentOnly: true },
  { state: 'failed', label: 'Failed in the last 24 hours', recentOnly: true },
];

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---- sessions -------------------------------------------------------------------------------------------------

export interface SessionBrief {
  id: string;
  kind: string;
  runtime: string;
  provider: string;
  model: string;
  effort: string;
  state: string;
  stateReason: string;
  lost: boolean;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
}

export interface ScreenshotView {
  path: string;
  caption: string;
  /** The viewer URL of the image, or null when the path is not an image under .jv-evidence/. */
  url: string | null;
}

export type ReportOut = Omit<ReportView, 'screenshots'> & { screenshots: ScreenshotView[] };

export interface SessionView extends SessionBrief {
  stepId: string | null;
  taskId: string | null;
  cwd: string;
  nativeSessionId: string | null;
  tmuxTarget: string | null;
  pid: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  eventCount: number;
  report: ReportOut | null;
}

function hasEnd(db: ReadOnlyStore, sessionId: string): boolean {
  return db.get("SELECT 1 AS x FROM events WHERE session_id = ? AND kind = 'end' LIMIT 1", sessionId) !== undefined;
}

/** Lost as markLost would decide it, without writing anything. */
export function sessionLost(db: ReadOnlyStore, s: SessionRow, alive: (s: SessionRow) => boolean = isRunAlive): boolean {
  if (s.state === 'lost') return true;
  if (!LIVE_SESSION_STATES.includes(s.state) || s.pid === null) return false;
  if (alive(s)) return false;
  return !hasEnd(db, s.id);
}

export interface ViewOptions {
  /** Whether a run's process is alive (tests pass a fake). */
  alive?: (s: SessionRow) => boolean;
  now?: number;
}

function sessionBrief(db: ReadOnlyStore, s: SessionRow, opts: ViewOptions): SessionBrief {
  return {
    id: s.id,
    kind: s.kind,
    runtime: s.runtime,
    provider: s.provider,
    model: s.model,
    effort: s.effort,
    state: s.state,
    stateReason: s.state_reason,
    lost: sessionLost(db, s, opts.alive),
    startedAt: s.started_at,
    endedAt: s.ended_at,
    lastEventAt: s.last_event_at,
  };
}

/** The viewer URL of a report screenshot, or null when it is not an image under the worktree's .jv-evidence/. */
export function evidenceUrl(taskId: string | null, worktree: string | null, path: string): string | null {
  if (!taskId || !worktree) return null;
  const p = path.replace(/\\/g, '/').trim();
  if (p === '' || p.includes('\0')) return null;
  let rel: string;
  if (isAbsolute(p)) {
    const r = relative(`${worktree.replace(/\/+$/, '')}/${EVIDENCE_DIR}`, p).replace(/\\/g, '/');
    if (r === '' || r.startsWith('../') || r === '..' || isAbsolute(r)) return null;
    rel = r;
  } else {
    const n = posix.normalize(p).replace(/^(\.\/)+/, '');
    if (!n.startsWith(`${EVIDENCE_DIR}/`)) return null;
    rel = n.slice(EVIDENCE_DIR.length + 1);
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const lower = rel.toLowerCase();
  if (!IMAGE_EXTENSIONS.some((e) => lower.endsWith(e))) return null;
  return `/evidence/${encodeURIComponent(taskId)}/${segments.map(encodeURIComponent).join('/')}`;
}

function reportOut(row: ReportRow, task: Pick<TaskRow, 'id' | 'worktree_path'> | undefined): ReportOut {
  const view = reportView(row);
  return {
    ...view,
    screenshots: view.screenshots.map((s) => ({
      path: s.path,
      caption: s.caption,
      url: evidenceUrl(task?.id ?? null, task?.worktree_path ?? null, s.path),
    })),
  };
}

function sessionView(db: ReadOnlyStore, s: SessionRow, task: TaskRow | undefined, opts: ViewOptions): SessionView {
  const report = db.get<ReportRow>('SELECT * FROM reports WHERE session_id = ?', s.id);
  const count = db.get<{ n: number }>('SELECT count(*) AS n FROM events WHERE session_id = ?', s.id)?.n ?? 0;
  return {
    ...sessionBrief(db, s, opts),
    stepId: s.step_id,
    taskId: s.task_id,
    cwd: s.cwd,
    nativeSessionId: s.native_session_id,
    tmuxTarget: s.tmux_target,
    pid: s.pid,
    tokens: { input: s.input_tokens, output: s.output_tokens, cacheRead: s.cache_read_tokens, cacheWrite: s.cache_write_tokens },
    costUsd: s.cost_usd,
    eventCount: Number(count),
    report: report ? reportOut(report, task) : null,
  };
}

// ---- task lines (first page, child tasks) ------------------------------------------------------------------------

export interface TaskLine {
  id: string;
  projectId: string;
  title: string;
  kind: string;
  state: string;
  stateReason: string;
  parentTaskId: string | null;
  visible: boolean;
  step: { id: string; ordinal: number; duty: string; state: string; attempts: number; of: number } | null;
  session: SessionBrief | null;
  /** The newest last_event_at of the task's sessions. */
  lastEventAt: string | null;
  lost: boolean;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** The step a task is on (see the header). */
export function currentStep(task: Pick<TaskRow, 'current_step'>, steps: readonly StepRow[]): StepRow | undefined {
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  return (
    sorted.find((s) => s.state === 'running' || s.state === 'retrying') ??
    sorted.find((s) => s.ordinal === task.current_step && s.state !== 'skipped') ??
    sorted.find((s) => s.state === 'pending') ??
    sorted.findLast((s) => s.state !== 'skipped') ??
    sorted.at(-1)
  );
}

function taskLines(db: ReadOnlyStore, tasks: readonly TaskRow[], opts: ViewOptions): TaskLine[] {
  if (!tasks.length) return [];
  const ids = tasks.map((t) => t.id);
  const steps = db.all<StepRow>(`SELECT * FROM steps WHERE task_id IN (${placeholders(ids.length)}) ORDER BY ordinal`, ...ids);
  const sessions = db.all<SessionRow>(
    `SELECT * FROM sessions WHERE task_id IN (${placeholders(ids.length)}) ORDER BY rowid`,
    ...ids,
  );
  return tasks.map((t) => {
    const own = steps.filter((s) => s.task_id === t.id);
    const step = currentStep(t, own);
    const runs = sessions.filter((s) => s.task_id === t.id);
    const stepRuns = runs.filter((s) => s.kind === 'step');
    const latest = stepRuns.at(-1);
    const lastEventAt = runs.reduce<string | null>((m, s) => (s.last_event_at && (!m || s.last_event_at > m) ? s.last_event_at : m), null);
    const brief = latest ? sessionBrief(db, latest, opts) : null;
    return {
      id: t.id,
      projectId: t.project_id,
      title: t.title,
      kind: t.kind,
      state: t.state,
      stateReason: t.state_reason,
      parentTaskId: t.parent_task_id,
      visible: t.visible === 1,
      step: step
        ? { id: step.id, ordinal: step.ordinal, duty: step.duty, state: step.state, attempts: step.attempts, of: own.length }
        : null,
      session: brief,
      lastEventAt,
      lost: brief?.lost ?? false,
      createdAt: t.created_at,
      startedAt: t.started_at,
      endedAt: t.ended_at,
    };
  });
}

// ---- first page ---------------------------------------------------------------------------------------------------

export interface OverviewProject {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  groups: Array<{ state: string; label: string; tasks: TaskLine[] }>;
  /** Tasks not shown: done, failed and stopped ones that ended more than a day ago, and stopped ones. */
  hidden: number;
}

export interface Overview {
  generatedAt: string;
  projects: OverviewProject[];
}

function activity(t: TaskLine): string {
  return t.lastEventAt ?? t.endedAt ?? t.startedAt ?? t.createdAt;
}

export function overview(db: ReadOnlyStore, opts: ViewOptions = {}): Overview {
  const now = opts.now ?? Date.now();
  const since = new Date(now - DAY_MS).toISOString();
  const projects = db.all<ProjectRow>('SELECT * FROM projects ORDER BY name');
  const out: OverviewProject[] = [];
  for (const p of projects) {
    const all = db.all<TaskRow>('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id', p.id);
    const shown = all.filter((t) => {
      const g = TASK_GROUPS.find((x) => x.state === t.state);
      if (!g) return false;
      if (!g.recentOnly) return true;
      return (t.ended_at ?? t.created_at) >= since;
    });
    const lines = taskLines(db, shown, opts);
    const groups = TASK_GROUPS.map((g) => {
      const tasks = lines.filter((l) => l.state === g.state);
      if (g.state === 'queued') tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      else tasks.sort((a, b) => activity(b).localeCompare(activity(a)));
      return { state: g.state, label: g.label, tasks };
    }).filter((g) => g.tasks.length > 0);
    out.push({ id: p.id, name: p.name, path: p.path, defaultBranch: p.default_branch, groups, hidden: all.length - shown.length });
  }
  return { generatedAt: new Date(now).toISOString(), projects: out };
}

// ---- decisions ----------------------------------------------------------------------------------------------------

export interface AnswerView {
  question: string;
  type: string;
  /** Where the answer came from: Jev, or the only option (no question asked). */
  source: 'jev' | 'only-option';
  choice?: string;
  confidence?: number;
  /** noul: the probability of true. */
  noul?: number;
  /** Every option with its probability, highest first. */
  probabilities: Array<{ option: string; p: number }>;
}

export interface DecisionView {
  id: string;
  kind: string;
  projectId: string;
  taskId: string | null;
  stepId: string | null;
  sessionId: string | null;
  createdAt: string;
  skillName: string;
  skillHash: string;
  jevModel: string;
  latencyMs: number;
  /** jev, owner (jv task override), or only-option when nothing was asked. */
  source: string;
  /** One line: what was decided. */
  summary: string;
  answers: AnswerView[];
  chosen: unknown;
  override: unknown;
  overrideMode: string | null;
  outcome: unknown;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  task?: { id: string; title: string } | null;
  step?: { id: string; ordinal: number; duty: string } | null;
}

function sortedProbabilities(p: unknown): Array<{ option: string; p: number }> {
  const o = obj(p);
  if (!o) return [];
  return Object.entries(o)
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([option, v]) => ({ option, p: v }))
    .sort((a, b) => b.p - a.p);
}

function answerViews(answersJson: string, chosen: Record<string, unknown> | undefined): AnswerView[] {
  const answers = obj(parse<unknown>(answersJson, {})) ?? {};
  const out: AnswerView[] = [];
  for (const [question, raw] of Object.entries(answers)) {
    const a = obj(raw);
    if (!a) continue;
    const type = str(a.type) ?? 'choice';
    const view: AnswerView = { question, type, source: 'jev', probabilities: sortedProbabilities(a.probabilities) };
    if (str(a.choice)) view.choice = a.choice as string;
    if (num(a.confidence) !== undefined) view.confidence = a.confidence as number;
    if (type === 'noul' && num(a.noul) !== undefined) {
      view.noul = a.noul as number;
      view.choice = (a.noul as number) >= 0.5 ? 'true' : 'false';
      view.probabilities = [
        { option: 'true', p: a.noul as number },
        { option: 'false', p: 1 - (a.noul as number) },
      ].sort((x, y) => y.p - x.p);
    }
    if (type === 'score' && num(a.score) !== undefined) view.choice = String(a.score);
    out.push(view);
  }
  // A placement records the questions it did not ask (one option) in chosen.choices.
  const choices = obj(chosen?.choices);
  if (choices) {
    for (const [question, raw] of Object.entries(choices)) {
      const c = obj(raw);
      if (!c || out.some((a) => a.question === question)) continue;
      const option = str(c.option);
      out.push({
        question,
        type: 'choice',
        source: c.source === 'jev' ? 'jev' : 'only-option',
        ...(option ? { choice: option } : {}),
        probabilities: sortedProbabilities(c.probabilities),
      });
    }
  }
  return out;
}

function decisionSummary(kind: string, chosen: Record<string, unknown> | undefined, answers: AnswerView[]): string {
  if (kind === 'placement' && chosen) {
    const name = str(chosen.label) ?? str(chosen.model) ?? '?';
    const placed = `${name} ${str(chosen.effort) ?? ''} via ${str(chosen.provider) ?? '?'} (${str(chosen.runtime) ?? '?'})`.replace(/\s+/g, ' ');
    return chosen.source === 'owner' ? `${placed}, set by the owner` : placed;
  }
  if (kind === 'workflow' && chosen) {
    const a = obj(chosen.answers);
    if (a) {
      const parts = Object.entries(a).map(([q, v]) => {
        const r = obj(v);
        const yes = r?.value === true;
        const p = num(r?.probability);
        return `${q} ${yes ? 'yes' : 'no'}${p !== undefined ? ` (${p.toFixed(2)})` : ''}`;
      });
      if (parts.length) return parts.join(', ');
    }
  }
  if (kind === 'landing') {
    const route = str(chosen?.route) ?? answers.find((a) => a.question === 'landing_route')?.choice;
    if (route) return route;
  }
  const first = answers[0];
  if (first?.choice) return `${first.question}: ${first.choice}`;
  if (chosen) {
    const keys = Object.entries(chosen)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 3)
      .map(([k, v]) => `${k} ${String(v)}`);
    if (keys.length) return keys.join(', ');
  }
  return kind;
}

/** A decision row for display (no state_json: it is the input Jev saw, large, and not part of any page). */
export function decisionView(d: DecisionRow): DecisionView {
  const chosenValue = parse<unknown>(d.chosen_json, null);
  const chosen = obj(chosenValue);
  const answers = answerViews(d.answers_json, chosen);
  const usage = obj(parse<unknown>(d.usage_json, {})) ?? {};
  let source = str(chosen?.source) ?? (d.jev_model === 'none' ? 'owner' : 'jev');
  if (source === 'jev' && answers.length > 0 && answers.every((a) => a.source === 'only-option')) source = 'only-option';
  return {
    id: d.id,
    kind: d.kind,
    projectId: d.project_id,
    taskId: d.task_id,
    stepId: d.step_id,
    sessionId: d.session_id,
    createdAt: d.created_at,
    skillName: d.skill_name,
    skillHash: d.skill_hash,
    jevModel: d.jev_model,
    latencyMs: d.latency_ms,
    source,
    summary: decisionSummary(d.kind, chosen, answers),
    answers,
    chosen: chosenValue,
    override: parse<unknown>(d.override_json, null),
    overrideMode: d.override_mode,
    outcome: parse<unknown>(d.outcome_json, null),
    usage: {
      inputTokens: num(usage.input_tokens) ?? 0,
      outputTokens: num(usage.output_tokens) ?? 0,
      calls: Array.isArray(usage.calls) ? usage.calls.length : 0,
    },
  };
}

export interface DecisionFilterInput {
  kind?: string;
  /** created_at on or after this day (YYYY-MM-DD) or time. */
  from?: string;
  /** created_at on or before this day (YYYY-MM-DD, the whole day) or time. */
  to?: string;
  project?: string;
  task?: string;
  limit?: number;
}

export interface DecisionsPage {
  filter: { kind: string | null; from: string | null; to: string | null; project: string | null; task: string | null };
  kinds: string[];
  total: number;
  shown: number;
  decisions: DecisionView[];
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayBound(value: string | undefined, end: boolean): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (DAY_PATTERN.test(v)) return end ? `${v}T23:59:59.999Z` : `${v}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(v)) ? undefined : new Date(v).toISOString();
}

export function decisions(db: ReadOnlyStore, input: DecisionFilterInput = {}): DecisionsPage {
  const clauses: string[] = [];
  const params: string[] = [];
  const kind = input.kind && ['placement', 'landing', 'workflow'].includes(input.kind) ? input.kind : undefined;
  const from = dayBound(input.from, false);
  const to = dayBound(input.to, true);
  let projectId: string | undefined;
  if (input.project) {
    projectId = db.get<ProjectRow>('SELECT * FROM projects WHERE name = ? OR id = ?', input.project, input.project)?.id ?? '-';
  }
  if (kind) (clauses.push('d.kind = ?'), params.push(kind));
  if (from) (clauses.push('d.created_at >= ?'), params.push(from));
  if (to) (clauses.push('d.created_at <= ?'), params.push(to));
  if (projectId) (clauses.push('d.project_id = ?'), params.push(projectId));
  if (input.task) (clauses.push('d.task_id = ?'), params.push(input.task));
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(1000, input.limit ?? 300));
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM decisions d${where}`, ...params)?.n ?? 0;
  const rows = db.all<DecisionRow & { task_title: string | null; step_ordinal: number | null; step_duty: string | null }>(
    `SELECT d.*, t.title AS task_title, s.ordinal AS step_ordinal, s.duty AS step_duty
       FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id LEFT JOIN steps s ON s.id = d.step_id${where}
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    ...params,
    limit,
  );
  const views = rows.map((r) => ({
    ...decisionView(r),
    task: r.task_id && r.task_title !== null ? { id: r.task_id, title: r.task_title } : null,
    step: r.step_id && r.step_duty !== null ? { id: r.step_id, ordinal: r.step_ordinal ?? 0, duty: r.step_duty } : null,
  }));
  return {
    filter: { kind: kind ?? null, from: input.from ?? null, to: input.to ?? null, project: input.project ?? null, task: input.task ?? null },
    kinds: ['placement', 'landing', 'workflow'],
    total: Number(total),
    shown: views.length,
    decisions: views,
  };
}

// ---- task page ------------------------------------------------------------------------------------------------------

export interface TaskRef {
  id: string;
  title: string;
  state: string;
  branch: string | null;
}

export interface StepView {
  id: string;
  ordinal: number;
  duty: string;
  instructions: string;
  whenRule: string;
  onFail: unknown;
  state: string;
  stateReason: string;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
  current: boolean;
  sessions: SessionView[];
  placements: DecisionView[];
}

export interface LandingView {
  id: string;
  route: string;
  state: string;
  reason: string;
  commitSha: string | null;
  createdAt: string;
  endedAt: string | null;
  checks: unknown[];
  decision: DecisionView | null;
}

export interface TaskDetail {
  task: {
    id: string;
    title: string;
    kind: string;
    state: string;
    stateReason: string;
    text: string;
    workflow: string | null;
    branch: string | null;
    worktreePath: string | null;
    baseCommit: string | null;
    landedCommit: string | null;
    visible: boolean;
    currentStep: number;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
    lastEventAt: string | null;
    lost: boolean;
  };
  project: { id: string; name: string; path: string; defaultBranch: string } | null;
  parent: TaskRef | null;
  after: TaskRef | null;
  steps: StepView[];
  /** Sessions of the task that belong to no step. */
  otherSessions: SessionView[];
  workflowDecisions: DecisionView[];
  landings: LandingView[];
  /** Landing decisions no landing row points at. */
  landingDecisions: DecisionView[];
  children: TaskLine[];
  messages: Array<{ id: string; direction: string; text: string; createdAt: string; deliveredAt: string | null; sessionId: string | null }>;
}

function taskRef(db: ReadOnlyStore, id: string | null): TaskRef | null {
  if (!id) return null;
  const t = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  return t ? { id: t.id, title: t.title, state: t.state, branch: t.branch } : { id, title: '', state: 'unknown', branch: null };
}

export function taskDetail(db: ReadOnlyStore, id: string, opts: ViewOptions = {}): TaskDetail | undefined {
  const task = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return undefined;
  const project = db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', task.project_id);
  const steps = db.all<StepRow>('SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal', task.id);
  const sessions = db.all<SessionRow>('SELECT * FROM sessions WHERE task_id = ? ORDER BY rowid', task.id);
  const decisionRows = db.all<DecisionRow>('SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at, rowid', task.id);
  const landingRows = db.all<LandingRow>('SELECT * FROM landings WHERE task_id = ? ORDER BY created_at, rowid', task.id);
  const messages = db.all<MessageRow>('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid', task.id);
  const children = db.all<TaskRow>('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at, id', task.id);
  const current = currentStep(task, steps);
  const sessionViews = sessions.map((s) => sessionView(db, s, task, opts));
  const decisionViews = decisionRows.map(decisionView);
  const linked = new Set(landingRows.map((l) => l.decision_id).filter((x): x is string => !!x));
  const workflow = obj(parse<unknown>(task.workflow_json, null));
  const latest = sessionViews.filter((s) => s.kind === 'step').at(-1);
  return {
    task: {
      id: task.id,
      title: task.title,
      kind: task.kind,
      state: task.state,
      stateReason: task.state_reason,
      text: task.task_text,
      workflow: str(workflow?.name) ?? null,
      branch: task.branch,
      worktreePath: task.worktree_path,
      baseCommit: task.base_commit,
      landedCommit: task.landed_commit,
      visible: task.visible === 1,
      currentStep: task.current_step,
      createdAt: task.created_at,
      startedAt: task.started_at,
      endedAt: task.ended_at,
      lastEventAt: sessions.reduce<string | null>((m, s) => (s.last_event_at && (!m || s.last_event_at > m) ? s.last_event_at : m), null),
      lost: latest?.lost ?? false,
    },
    project: project ? { id: project.id, name: project.name, path: project.path, defaultBranch: project.default_branch } : null,
    parent: taskRef(db, task.parent_task_id),
    after: taskRef(db, task.after_task_id),
    steps: steps.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      duty: s.duty,
      instructions: s.instructions,
      whenRule: s.when_rule,
      onFail: parse<unknown>(s.on_fail_json, null),
      state: s.state,
      stateReason: s.state_reason,
      attempts: s.attempts,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      current: current?.id === s.id && ['running', 'retrying', 'pending'].includes(s.state) && !['done', 'failed', 'stopped'].includes(task.state),
      sessions: sessionViews.filter((v) => v.stepId === s.id),
      placements: decisionViews.filter((d) => d.kind === 'placement' && d.stepId === s.id),
    })),
    otherSessions: sessionViews.filter((v) => !v.stepId || !steps.some((s) => s.id === v.stepId)),
    workflowDecisions: decisionViews.filter((d) => d.kind === 'workflow'),
    landings: landingRows.map((l) => {
      const d = l.decision_id ? decisionRows.find((x) => x.id === l.decision_id) : undefined;
      return {
        id: l.id,
        route: l.route,
        state: l.state,
        reason: l.reason,
        commitSha: l.commit_sha,
        createdAt: l.created_at,
        endedAt: l.ended_at,
        checks: parse<unknown[]>(l.checks_json, []),
        decision: d ? decisionView(d) : null,
      };
    }),
    landingDecisions: decisionViews.filter((d) => d.kind === 'landing' && !linked.has(d.id)),
    children: taskLines(db, children, opts),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      createdAt: m.created_at,
      deliveredAt: m.delivered_at,
      sessionId: m.session_id,
    })),
  };
}

// ---- session page ---------------------------------------------------------------------------------------------------

export interface EventView {
  seq: number;
  at: string;
  kind: string;
  payload: unknown;
}

export interface SessionPage {
  session: SessionView;
  task: TaskRef | null;
  step: { id: string; ordinal: number; duty: string; state: string; of: number } | null;
  project: { id: string; name: string } | null;
  events: EventView[];
  /** The seq of the last event returned (0 when none). */
  lastSeq: number;
  /** More events follow after lastSeq (fetch again with after=lastSeq). */
  more: boolean;
}

export const EVENTS_PAGE = 1000;

/** An event's payload, parsed; a report event's screenshots get their viewer URL as on the task page. */
function eventPayload(e: EventRow, task: TaskRow | undefined): unknown {
  const payload = parse<unknown>(e.payload, e.payload);
  const p = obj(payload);
  if (e.kind !== 'report' || !p || !Array.isArray(p.screenshots)) return payload;
  return {
    ...p,
    screenshots: p.screenshots.map((raw) => {
      const s = obj(raw) ?? {};
      const path = str(s.path) ?? '';
      return { path, caption: str(s.caption) ?? '', url: evidenceUrl(task?.id ?? null, task?.worktree_path ?? null, path) };
    }),
  };
}

export function sessionPage(db: ReadOnlyStore, id: string, after = 0, opts: ViewOptions = {}): SessionPage | undefined {
  const s = db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) return undefined;
  const task = s.task_id ? db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', s.task_id) : undefined;
  const step = s.step_id ? db.get<StepRow>('SELECT * FROM steps WHERE id = ?', s.step_id) : undefined;
  const stepCount = step ? (db.get<{ n: number }>('SELECT count(*) AS n FROM steps WHERE task_id = ?', step.task_id)?.n ?? 0) : 0;
  const project = db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', s.project_id);
  const rows = db.all<EventRow>(
    'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    s.id,
    Math.max(0, Math.floor(after)),
    EVENTS_PAGE + 1,
  );
  const more = rows.length > EVENTS_PAGE;
  const page = more ? rows.slice(0, EVENTS_PAGE) : rows;
  return {
    session: sessionView(db, s, task, opts),
    task: task ? { id: task.id, title: task.title, state: task.state, branch: task.branch } : null,
    step: step ? { id: step.id, ordinal: step.ordinal, duty: step.duty, state: step.state, of: Number(stepCount) } : null,
    project: project ? { id: project.id, name: project.name } : null,
    events: page.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, payload: eventPayload(e, task) })),
    lastSeq: page.at(-1)?.seq ?? Math.max(0, Math.floor(after)),
    more,
  };
}

// ---- usage ----------------------------------------------------------------------------------------------------------

/** The ISO 8601 week of a time, "2026-W44". */
export function isoWeek(at: string | number | Date): string {
  const d = new Date(at);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface UsageRowView {
  provider: string;
  observedAt: string;
  source: string;
  fiveHourPct: number | null;
  weeklyPct: number | null;
  fiveHourResetsAt: string | null;
  weeklyResetsAt: string | null;
  localInputTokens: number | null;
  localOutputTokens: number | null;
  localCostUsd: number | null;
}

export interface UsageProviderWeek {
  provider: string;
  /** The newest observation of the week with a weekly percentage. */
  weeklyPct: number | null;
  fiveHourPct: number | null;
  observedAt: string | null;
  weeklyResetsAt: string | null;
  sources: Record<string, number>;
  localInputTokens: number;
  localOutputTokens: number;
  localCostUsd: number;
  /** Token totals of the provider's sessions that started this week. */
  sessions: { count: number; inputTokens: number; outputTokens: number; costUsd: number };
}

export interface UsageWeek {
  week: string;
  providers: UsageProviderWeek[];
  rows: UsageRowView[];
}

export interface UsagePage {
  generatedAt: string;
  weeks: UsageWeek[];
}

export function usage(db: ReadOnlyStore, opts: { weeks?: number; now?: number } = {}): UsagePage {
  const now = opts.now ?? Date.now();
  const weeks = Math.max(1, Math.min(52, opts.weeks ?? 8));
  const since = new Date(now - weeks * 7 * DAY_MS).toISOString();
  const rows = db.all<ProviderUsageRow>(
    'SELECT * FROM provider_usage WHERE observed_at >= ? ORDER BY observed_at DESC, provider',
    since,
  );
  const sessions = db.all<{ provider: string; created: string | null; input_tokens: number; output_tokens: number; cost_usd: number | null }>(
    `SELECT provider, coalesce(started_at, last_event_at) AS created, input_tokens, output_tokens, cost_usd
       FROM sessions WHERE coalesce(started_at, last_event_at) >= ?`,
    since,
  );
  const byWeek = new Map<string, UsageWeek>();
  const weekOf = (w: string): UsageWeek => {
    let entry = byWeek.get(w);
    if (!entry) {
      entry = { week: w, providers: [], rows: [] };
      byWeek.set(w, entry);
    }
    return entry;
  };
  const providerOf = (w: UsageWeek, name: string): UsageProviderWeek => {
    let p = w.providers.find((x) => x.provider === name);
    if (!p) {
      p = {
        provider: name,
        weeklyPct: null,
        fiveHourPct: null,
        observedAt: null,
        weeklyResetsAt: null,
        sources: {},
        localInputTokens: 0,
        localOutputTokens: 0,
        localCostUsd: 0,
        sessions: { count: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
      w.providers.push(p);
    }
    return p;
  };
  for (const r of rows) {
    const w = weekOf(r.source === 'local' && r.local_week ? r.local_week : isoWeek(r.observed_at));
    w.rows.push({
      provider: r.provider,
      observedAt: r.observed_at,
      source: r.source,
      fiveHourPct: r.five_hour_pct,
      weeklyPct: r.weekly_pct,
      fiveHourResetsAt: r.five_hour_resets_at,
      weeklyResetsAt: r.weekly_resets_at,
      localInputTokens: r.local_input_tokens,
      localOutputTokens: r.local_output_tokens,
      localCostUsd: r.local_cost_usd,
    });
    const p = providerOf(w, r.provider);
    p.sources[r.source] = (p.sources[r.source] ?? 0) + 1;
    // Rows are newest first: the first percentage seen is the newest.
    if (p.weeklyPct === null && r.weekly_pct !== null) {
      p.weeklyPct = r.weekly_pct;
      p.observedAt = r.observed_at;
      p.weeklyResetsAt = r.weekly_resets_at;
    }
    if (p.fiveHourPct === null && r.five_hour_pct !== null) p.fiveHourPct = r.five_hour_pct;
    if (r.source === 'local') {
      p.localInputTokens = Math.max(p.localInputTokens, r.local_input_tokens ?? 0);
      p.localOutputTokens = Math.max(p.localOutputTokens, r.local_output_tokens ?? 0);
      p.localCostUsd = Math.max(p.localCostUsd, r.local_cost_usd ?? 0);
    }
  }
  for (const s of sessions) {
    if (!s.created) continue;
    const p = providerOf(weekOf(isoWeek(s.created)), s.provider);
    p.sessions.count++;
    p.sessions.inputTokens += s.input_tokens;
    p.sessions.outputTokens += s.output_tokens;
    p.sessions.costUsd += s.cost_usd ?? 0;
  }
  const list = [...byWeek.values()].sort((a, b) => b.week.localeCompare(a.week));
  for (const w of list) w.providers.sort((a, b) => a.provider.localeCompare(b.provider));
  return { generatedAt: new Date(now).toISOString(), weeks: list };
}

// ---- live stream ---------------------------------------------------------------------------------------------------

/**
 * The ids of starting or running sessions whose process is gone and that have no `end` event: the lost dots change
 * without any write to the store, so the live stream watches these too.
 */
export function lostCandidates(db: ReadOnlyStore, alive: (s: SessionRow) => boolean = isRunAlive): string[] {
  const live = db.all<SessionRow>("SELECT * FROM sessions WHERE state IN ('starting', 'running') AND pid IS NOT NULL ORDER BY rowid");
  return live.filter((s) => !alive(s) && !hasEnd(db, s.id)).map((s) => s.id);
}
