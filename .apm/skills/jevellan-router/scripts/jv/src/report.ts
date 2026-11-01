// The report contract (section 5): the JSON every worker produces exactly once per turn, its validation, and the one
// write path into the store. Ported from jevellan packages/core/src/project-schemas.ts (ThreadReportFieldsSchema) and
// the jevellan_thread_report description in packages/core/src/bridge-schemas.ts, reshaped to section 5:
//
// - Jevellan's daemon-filled fields (schema, turn, synthesized, fix) are gone: the turn is the session row (D-006) and
//   a synthesized report says so in `limitations`.
// - options carry { label, description } (Jevellan: detail); screenshots, limitations and ownerCommands are added.
//   ownerCommands keep Jevellan's OwnerCommandSchema bounds without its device and kind fields.
// - As in Jevellan, the object schema stays unrefined so the tool input schema derives from it (zod refuses
//   .omit/.extend on refined objects, and a refinement has no JSON Schema form); the needs-decision rule (a question
//   and two to four options) is checked in code by parseReport.
//
// writeReport inserts the reports row once per session row: a second call returns REPORT_ALREADY_SENT and changes
// nothing (Jevellan's REPORT_ALREADY_SENT). Every string is redacted before it is stored.

import { z } from 'zod';
import { recordEvent } from './events.js';
import { notFound } from './errors.js';
import { defaultRedactor, type Redactor } from './redact.js';
import type { Store } from './store.js';
import type { ReportRow, ReportStatus, SessionRow } from './types.js';

export const REPORT_TOOL_NAME = 'jv_report';
/** The report tool as the in-process SDK server exposes it to Claude (mcp__<server>__<tool>). */
export const REPORT_SERVER_NAME = 'jv';
export const REPORT_TOOL_QUALIFIED = `mcp__${REPORT_SERVER_NAME}__${REPORT_TOOL_NAME}`;

export const REPORT_RECORDED = 'Report recorded. End your turn.';
export const REPORT_ALREADY_SENT = 'Report already sent for this turn.';
export const NEEDS_DECISION_QUESTION = 'A needs-decision report needs a question.';
export const NEEDS_DECISION_OPTIONS = 'A needs-decision report needs two to four options.';

/** Ported from jevellan bridge-schemas.ts (jevellan_thread_report), with the jv names and fields. */
export const REPORT_TOOL_DESCRIPTION =
  "Report this turn's outcome exactly once, at the end of the turn. status is progress while you are still working, " +
  'done when the step is complete, blocked when something outside your control stops you, needs-decision when a ' +
  'choice belongs to the owner. needs-decision requires a question; options are two to four short choices. Explain ' +
  'the result for the owner, what they can see or do and how to try it. Include limitations, tests actually run and ' +
  'changed files. For visual work list screenshots saved under .jv-evidence/ in the worktree, each with a caption. ' +
  'If the owner must run something, put the exact command in ownerCommands with why. summary accepts up to 4,000 ' +
  'characters.';

export const SUMMARY_MAX = 4000;

export const ReportStatusSchema = z.enum(['progress', 'done', 'blocked', 'needs-decision']);

export const ReportOptionSchema = z.strictObject({
  label: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
});

export const TestsRunSchema = z.strictObject({
  command: z.string(),
  passed: z.boolean(),
  summary: z.string().max(600),
});

export const ScreenshotSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  caption: z.string().min(1).max(300),
});

export const OwnerCommandSchema = z.strictObject({
  command: z.string().min(1).max(4000),
  cwd: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (value) => ['worktree', 'checkout', 'home'].includes(value) || (value.startsWith('/') && !/[\0\r\n]/u.test(value)),
      'Choose worktree, checkout, home or an absolute folder.',
    ),
  why: z.string().min(1).max(300),
});

/** The fields of a report, unrefined (the tool input schema derives from it). */
export const ReportFieldsSchema = z.strictObject({
  status: ReportStatusSchema,
  summary: z.string().min(1).max(SUMMARY_MAX),
  question: z.string().max(1000).optional(),
  options: z.array(ReportOptionSchema).min(2).max(4).optional(),
  testsRun: TestsRunSchema.optional(),
  changedFiles: z.array(z.string()).max(200).default([]),
  screenshots: z.array(ScreenshotSchema).max(50).default([]),
  limitations: z.string().max(4000).optional(),
  ownerCommands: z.array(OwnerCommandSchema).max(5).optional(),
});

export type Report = z.output<typeof ReportFieldsSchema>;
export type ReportInput = z.input<typeof ReportFieldsSchema>;

/** The JSON Schema of the tool input (MCP tools/list), from zod's toJSONSchema. */
export function reportInputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReportFieldsSchema, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.length ? i.path.join('.') : '(report)'}: ${i.message}`)
    .join('; ');
}

export type ParsedReport = { ok: true; report: Report } | { ok: false; error: string };

/** Validates a report as the worker sent it: the schema, then the needs-decision rule. */
export function parseReport(input: unknown): ParsedReport {
  const parsed = ReportFieldsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `The report is not valid: ${issuesText(parsed.error)}` };
  const report = parsed.data;
  if (report.status === 'needs-decision') {
    if (!report.question || report.question.trim() === '') return { ok: false, error: `The report is not valid: question: ${NEEDS_DECISION_QUESTION}` };
    if (!report.options || report.options.length < 2) return { ok: false, error: `The report is not valid: options: ${NEEDS_DECISION_OPTIONS}` };
  }
  return { ok: true, report };
}

// ---- which row a report belongs to ----------------------------------------------------------------------------

/**
 * The session row a report from `sessionId`'s conversation belongs to. A claude-tmux or Codex conversation keeps one
 * MCP process (and one JV_SESSION) across turns while every turn is its own row (D-006), so the target is the newest
 * row that shares the given row's native_session_id and has no report yet; the given row itself when it has no native
 * id; when every row already has its report, the newest row (a write there answers REPORT_ALREADY_SENT).
 */
export function resolveReportSession(store: Store, sessionId: string): SessionRow {
  const session = store.getSession(sessionId);
  if (!session) throw notFound(`no session ${sessionId}`);
  if (!session.native_session_id) return session;
  const rows = store.listSessions({ native_session_id: session.native_session_id });
  if (!rows.some((r) => r.id === session.id)) rows.push(session);
  for (let i = rows.length - 1; i >= 0; i--) if (!store.getReportBySession(rows[i]!.id)) return rows[i]!;
  return rows[rows.length - 1]!;
}

// ---- writing ----------------------------------------------------------------------------------------------------

export interface WriteReportOptions {
  redactor?: Redactor;
  /** Set for a report the adapter made up (no report from the worker): `limitations` says so. */
  synthesized?: string;
}

export type WriteReportResult =
  | { outcome: 'recorded'; text: typeof REPORT_RECORDED; row: ReportRow; sessionId: string }
  | { outcome: 'already-sent'; text: typeof REPORT_ALREADY_SENT; row: ReportRow; sessionId: string }
  | { outcome: 'invalid'; text: string; sessionId: string };

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * Validates and records the report of session row `sessionId` (resolve the row first with resolveReportSession when
 * the caller is a long-lived MCP process). Once per row: a second call returns REPORT_ALREADY_SENT and changes
 * nothing. An invalid report changes nothing and returns the reason for the worker to fix. On success the row is
 * inserted and a `report` event is appended in the same transaction.
 */
export function writeReport(store: Store, sessionId: string, input: unknown, options: WriteReportOptions = {}): WriteReportResult {
  const parsed = parseReport(input);
  const existingFirst = store.getReportBySession(sessionId);
  if (existingFirst) return { outcome: 'already-sent', text: REPORT_ALREADY_SENT, row: existingFirst, sessionId };
  if (!parsed.ok) return { outcome: 'invalid', text: parsed.error, sessionId };
  const redactor = options.redactor ?? defaultRedactor();
  const r = redactor.redactValue(parsed.report);
  let limitations = r.limitations ?? null;
  if (options.synthesized) limitations = limitations ? `${options.synthesized} ${limitations}` : options.synthesized;
  return store.tx(() => {
    const existing = store.getReportBySession(sessionId);
    if (existing) return { outcome: 'already-sent' as const, text: REPORT_ALREADY_SENT, row: existing, sessionId };
    const session = store.requireSession(sessionId);
    const created = store.createReport({
      session_id: sessionId,
      step_id: session.step_id,
      task_id: session.task_id,
      status: r.status,
      summary: cut(r.summary, SUMMARY_MAX),
      question: r.question ?? null,
      options_json: r.options ? JSON.stringify(r.options) : null,
      tests_json: r.testsRun ? JSON.stringify(r.testsRun) : null,
      changed_files_json: JSON.stringify(r.changedFiles),
      screenshots_json: JSON.stringify(r.screenshots),
      limitations: limitations === null ? null : cut(limitations, 4000),
      owner_commands_json: r.ownerCommands ? JSON.stringify(r.ownerCommands) : null,
    });
    recordEvent(store, sessionId, 'report', { reportId: created.row.id, ...reportView(created.row) }, { redactor });
    return { outcome: 'recorded' as const, text: REPORT_RECORDED, row: created.row, sessionId };
  });
}

/** Records the adapter's own report for a turn that ended without one (section 5 backstop). */
export function synthesizeReport(
  store: Store,
  sessionId: string,
  report: { status: ReportStatus; summary: string; limitations: string },
  options: { redactor?: Redactor } = {},
): WriteReportResult {
  return writeReport(
    store,
    sessionId,
    { status: report.status, summary: cut(report.summary.trim() || 'No report.', SUMMARY_MAX) },
    { ...options, synthesized: report.limitations },
  );
}

// ---- reading ----------------------------------------------------------------------------------------------------

/** A stored report in the shape of section 5 (JSON columns parsed), plus its ids. */
export interface ReportView {
  id: string;
  sessionId: string;
  taskId: string | null;
  stepId: string | null;
  status: ReportStatus;
  summary: string;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  testsRun?: { command: string; passed: boolean; summary: string };
  changedFiles: string[];
  screenshots: Array<{ path: string; caption: string }>;
  limitations?: string;
  ownerCommands?: Array<{ command: string; cwd: string; why: string }>;
  createdAt: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function reportView(row: ReportRow): ReportView {
  const options = parseJson<ReportView['options'] | undefined>(row.options_json, undefined);
  const testsRun = parseJson<ReportView['testsRun'] | undefined>(row.tests_json, undefined);
  const ownerCommands = parseJson<ReportView['ownerCommands'] | undefined>(row.owner_commands_json, undefined);
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    stepId: row.step_id,
    status: row.status,
    summary: row.summary,
    ...(row.question !== null ? { question: row.question } : {}),
    ...(options ? { options } : {}),
    ...(testsRun ? { testsRun } : {}),
    changedFiles: parseJson<string[]>(row.changed_files_json, []),
    screenshots: parseJson<ReportView['screenshots']>(row.screenshots_json, []),
    ...(row.limitations !== null ? { limitations: row.limitations } : {}),
    ...(ownerCommands ? { ownerCommands } : {}),
    createdAt: row.created_at,
  };
}

/** The report as text for humans (jv report S). */
export function formatReport(view: ReportView): string {
  const lines = [`Report ${view.id} of session ${view.sessionId}: ${view.status}`, '', view.summary];
  if (view.question) lines.push('', `Question: ${view.question}`);
  if (view.options?.length) {
    for (const [i, o] of view.options.entries()) lines.push(`  ${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ''}`);
  }
  if (view.testsRun) {
    lines.push('', `Tests: ${view.testsRun.command} (${view.testsRun.passed ? 'passed' : 'failed'})`);
    if (view.testsRun.summary) lines.push(`  ${view.testsRun.summary}`);
  }
  if (view.changedFiles.length) lines.push('', 'Changed files:', ...view.changedFiles.map((f) => `  ${f}`));
  if (view.screenshots.length) lines.push('', 'Screenshots:', ...view.screenshots.map((s) => `  ${s.path} - ${s.caption}`));
  if (view.limitations) lines.push('', `Limitations: ${view.limitations}`);
  if (view.ownerCommands?.length) {
    lines.push('', 'For the owner to run:');
    for (const c of view.ownerCommands) lines.push(`  ${c.command}  (in ${c.cwd}: ${c.why})`);
  }
  return lines.join('\n');
}
