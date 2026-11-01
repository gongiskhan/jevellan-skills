// Landing (section 8): `jv land T`, automatic after a task's last step or run by the coordinator.
//
// 1. Refuse (exit 2) unless every step is done or skipped, and when the worktree has uncommitted changes (the reason
//    names the files; .jv-evidence/ and plan.md are in the repository's info/exclude, so they never count).
// 2. Build the landing state (ported LandingRouteStateSchema of jevellan packages/core/src/project-landing-schemas.ts):
//    title, task kind and text, the final summaries, riskyAreas from landing.json, the changed files with additions
//    and deletions (git diff --numstat <base>...<branch>), the checks already run (the reports' testsRun), the
//    corrections (retries and their reasons), and the policy's "## rules".
// 3. Ask Jev with the landing policy (~/.jv/skills/jevellan-landing/SKILL.md): question landing_route, choice, the
//    criteria from the policy's "## routes" (ported decideLandingRoute of packages/decisions/src/landing-route.ts:
//    highest probability, ties to Jev's choice, the reason is the chosen route's criterion). The decision row has kind
//    landing. The project's rules.json landing route override applies after Jev (route.applyRouteRules). With force:
//    no Jev call, route land, reason "forced by the owner".
// 4. Routes:
//    - land: merge the default branch into the task branch in the worktree (a conflict is aborted and routed to
//      ask-owner with reason "merge conflict"), run landing.json checks (default: project.json testCommand) in the
//      worktree with a timeout each, keeping the output tail, then fast-forward the checkout's default branch
//      (land-git.fastForwardDefault). Push only when project.json pushAfterLanding is true. Task done, landed_commit
//      set, landings row landed, the coordinator told.
//      A child task (created with --parent, its worktree branched from the parent's branch) lands into the parent's
//      branch instead (J14): the parent's branch is merged into the child branch, the checks run, and the parent's
//      branch is fast-forwarded in the parent's worktree (merge --ff-only after the touched files are found clean
//      there, else refused). The default branch is never moved and nothing is pushed for a child; the parent lands
//      into the default branch later through its own landing. A parent that is gone, discarded, already landed or
//      without a registered worktree refuses the child's landing.
//    - verify-then-land: one extra verify step is appended (placement by Jev through advance.startStep) with the
//      instructions of VERIFY_BEFORE_LANDING; when it ends, advance calls landTask again, which lands without asking
//      Jev again when it passed and puts the task in waiting-owner with the failure otherwise.
//    - a merge conflict on a landing the owner forced ("Land now" after an ask-owner, typically a merge conflict
//      itself): instead of asking the same question again, one implement step is appended (placement by Jev) with
//      the instructions of resolveConflictInstructions: merge the branch it lands into, resolve the conflicts keeping
//      both sides' intent, run the tests of the conflicted files, commit. The landing row waits in checking for it,
//      exactly like the verify step of verify-then-land, and landing continues (merge, checks, fast-forward) when it
//      ends; a second conflict on the same landing row asks the owner. Without this "Land now" could never land a
//      task that conflicts (J4: three parallel tasks that each add a CHANGELOG line).
//    - ask-owner: task waiting-owner, landings row asked, the coordinator asks "Land now" or "Leave it". An asked row
//      is closed (state failed, the reason says how) when the owner answers: "Land now" (any new landing of the task
//      closes it, reason "answered: Land now" when forced) or "Leave it" (tasks.stopTask --discard). The closed row
//      keeps why it was asked after the answer ("<answer>; asked: <reason>", D-082), so the viewer and jv evals
//      landing still see it. Only the task's last landing row can be an open question (askedLanding).
// 5. Failed checks on land: landings row failed, task waiting-owner, the coordinator woken with the output tail.
//
// `auto` (the launcher's call after the last step): nobody reads an exit code, so a refusal puts the task in
// waiting-owner with the reason and wakes the coordinator, and landTask returns state "refused" instead of throwing.
// Without `auto` a refusal throws exit 2 and changes nothing (the caller reads it).
//
// Landings of one project run one at a time (meta landing_lock:<project id>, a lock whose holder pid is gone is taken
// over); the fast-forward retries the merge and the checks when the default branch moved in between (at most three
// rounds), so two tasks finishing together both land.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BASE_KEYS, machineGitIdentity, ownerHome } from './env.js';
import { JvError, notFound, refused } from './errors.js';
import { isAlive } from './launcher.js';
import {
  changedFiles,
  currentBranch,
  fastForwardDefault,
  findWorktree,
  hasOrigin,
  listText,
  mergeInto,
  pushDefault,
  resolveCommit,
  uncommittedFiles,
  type ChangedFile,
} from './land-git.js';
import { paths } from './paths.js';
import { LANDING_POLICY, loadPolicy, parseRoutes, requireSection, type Policy } from './policy.js';
import { ensureGitExclude } from './project.js';
import type { ProvidersConfig } from './providers.js';
import { redact } from './redact.js';
import {
  applyRouteRules,
  askJev,
  loadOwnerRules,
  loadProjectGuidance,
  recordDecision,
  resolveChoice,
  STATE_LIMIT,
  TASK_SHORTENED,
  type JevDecider,
} from './route.js';
import { nowIso, type Store } from './store.js';
import {
  LANDING_ROUTES,
  type DecisionRow,
  type LandingRoute,
  type LandingRow,
  type ProjectRow,
  type StepRow,
  type TaskRow,
} from './types.js';
import { notifyCoordinator } from './wake.js';

// ---- constants -------------------------------------------------------------------------------------------------

export const LANDING_QUESTION = 'landing_route';
export const VERIFY_BEFORE_LANDING =
  "Full verification before landing: run the project's whole test command and every browser journey the change could affect.";
export const FORCED_REASON = 'forced by the owner';
/** Default timeout of one landing check (Jevellan's TEST_TIMEOUT_MS). */
export const CHECK_TIMEOUT_MS = 30 * 60_000;
/** Characters of a check's output kept in checks_json. */
export const TAIL_CHARS = 4000;
/** Characters of the output tail in a wake line. */
export const WAKE_TAIL_CHARS = 240;
/** Rounds of merge, checks and fast-forward when the default branch keeps moving. */
export const MAX_ROUNDS = 3;
/** How long a landing waits for another landing of the same project. */
export const LOCK_WAIT_MS = 60 * 60_000;
export const LOCK_META_PREFIX = 'landing_lock:';
/** meta landing_step:<landing id> = the id of the step a landing appended (verify-then-land's verify, or the conflict resolution). */
export const LANDING_STEP_META_PREFIX = 'landing_step:';
/** meta landing_forced:<landing id> = "1" for a landing the owner forced (jv land --force, "Land now"). */
export const LANDING_FORCED_META_PREFIX = 'landing_forced:';

/** The instructions of the implement step a forced landing appends when merging `into` conflicts. */
export function resolveConflictInstructions(into: string, branch: string, files: readonly string[]): string {
  return (
    `Landing this task on ${into} needs a merge first: merging ${into} into ${branch} conflicts in ${files.join(', ')}. ` +
    `The owner said "Land now". Run git merge ${into} in this worktree and resolve every conflict keeping what both sides meant ` +
    `(for a changelog or another list, keep both entries); change nothing else. Run the tests that cover the conflicted files, ` +
    `then commit the merge on ${branch}. Never touch ${into} itself: landing moves it after you report done.`
  );
}
export const OPTIONS_TEXT = 'Land now (jv land {T} --force) or Leave it (jv task stop {T} --discard)';
/** The reason an asked landing row closes with when the owner lands the task anyway. */
export const ANSWERED_LAND_NOW = 'answered: Land now (jv land --force)';
/** The reason an asked landing row closes with when a new landing decision replaces it. */
export const REPLACED_ASK = 'replaced by a new landing of the task';
/** The reason an asked landing row closes with when the owner leaves the task (jv task stop --discard). */
export const ANSWERED_LEAVE_IT = 'discarded by the owner (Leave it)';
/** The reasons of an asked row the owner's answer closed: it ended without an outcome that judges the route. */
export const CLOSED_ASK_REASONS: readonly string[] = [ANSWERED_LAND_NOW, REPLACED_ASK, ANSWERED_LEAVE_IT];
/** Between the answer that closed an asked row and the reason the row was asked. */
export const ASKED_BECAUSE = '; asked: ';

/** The reason an asked row closes with: the answer (one of CLOSED_ASK_REASONS), then why the row was asked. */
export function closedAskReason(answer: string, asked: string): string {
  return asked ? cut(`${answer}${ASKED_BECAUSE}${asked}`, 2000) : answer;
}

/** Whether a failed landing row is an asked one the owner's answer (or a new landing) closed. */
export function isClosedAsk(reason: string): boolean {
  return CLOSED_ASK_REASONS.some((r) => reason === r || reason.startsWith(`${r}${ASKED_BECAUSE}`));
}

// ---- project settings ------------------------------------------------------------------------------------------

export interface ProjectSettings {
  testCommand: string | null;
  pushAfterLanding: boolean;
  retentionDays: number;
}

/** The project.json fields landing and gc read. A missing file is the defaults; invalid JSON or types exit 2. */
export function loadProjectSettings(project: string, file: string = paths.projectJson(project)): ProjectSettings {
  let raw: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
      else throw new Error('not an object');
    } catch (error) {
      throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const testCommand = raw.testCommand;
  if (testCommand !== undefined && testCommand !== null && typeof testCommand !== 'string') throw refused(`${file}: testCommand must be a string or null`);
  const push = raw.pushAfterLanding;
  if (push !== undefined && typeof push !== 'boolean') throw refused(`${file}: pushAfterLanding must be true or false`);
  const days = raw.retentionDays;
  if (days !== undefined && (typeof days !== 'number' || !Number.isFinite(days) || days < 0)) {
    throw refused(`${file}: retentionDays must be a number of days, 0 or more`);
  }
  return {
    testCommand: typeof testCommand === 'string' && testCommand.trim() !== '' ? testCommand : null,
    pushAfterLanding: push === true,
    retentionDays: typeof days === 'number' ? days : 3,
  };
}

const LandingCheckSchema = z.strictObject({
  name: z.string().min(1).max(80),
  command: z.string().min(1).max(2000),
  timeoutMs: z.number().int().positive().max(24 * 3_600_000).optional(),
});
const LandingFileSchema = z.strictObject({
  riskyPaths: z.array(z.string().min(1).max(4096)).max(200).default([]),
  checks: z.array(LandingCheckSchema).max(30).default([]),
});
export type LandingCheck = z.infer<typeof LandingCheckSchema>;
export type LandingConfig = z.infer<typeof LandingFileSchema>;

/** ~/.jv/projects/<name>/landing.json; missing is empty. Exit 2 naming the problem when it is not valid. */
export function loadLandingConfig(project: string, file: string = paths.projectLanding(project)): LandingConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { riskyPaths: [], checks: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = LandingFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw refused(`${file} is not valid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/** The checks a land runs: landing.json checks, else the project's testCommand, else none. */
export function landingChecks(config: LandingConfig, settings: ProjectSettings): Array<Required<LandingCheck>> {
  const checks = config.checks.length
    ? config.checks
    : settings.testCommand
      ? [{ name: 'test', command: settings.testCommand }]
      : [];
  return checks.map((c) => ({ name: c.name, command: c.command, timeoutMs: c.timeoutMs ?? CHECK_TIMEOUT_MS }));
}

// ---- the landing state (ported LandingRouteStateSchema) --------------------------------------------------------

const LandingStateCheckSchema = z.strictObject({
  duty: z.string().max(40),
  command: z.string().max(2000),
  passed: z.boolean(),
  summary: z.string().max(600),
  at: z.string(),
});

export const LandingRouteStateSchema = z.strictObject({
  schema: z.literal('landing-route-state-v1'),
  project: z.strictObject({ name: z.string(), guidance: z.string() }),
  title: z.string().max(120),
  task: z.strictObject({ id: z.string(), kind: z.string(), text: z.string() }),
  summaries: z.array(z.strictObject({ duty: z.string().max(40), summary: z.string().max(4000) })).max(40),
  riskyAreas: z.array(z.string().max(4096)).max(200),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        bytes: z.number().int().nonnegative(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        risky: z.boolean(),
      }),
    )
    .max(3000),
  totals: z.strictObject({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    filesOmitted: z.number().int().nonnegative(),
  }),
  checks: z.array(LandingStateCheckSchema).max(31),
  corrections: z.array(z.string().max(500)).max(8),
  rules: z.string(),
});
export type LandingRouteState = z.infer<typeof LandingRouteStateSchema>;

/** Ported pathMatches: a file is under a risky path when it is that path or below it. */
export function pathMatches(file: string, path: string): boolean {
  const p = path.replace(/^\.\//, '').replace(/\/+$/u, '');
  return p !== '' && (file === p || file.startsWith(`${p}/`));
}

interface ReportJson {
  testsRun?: { command: string; passed: boolean; summary: string };
}

function testsOf(tests: string | null): ReportJson['testsRun'] | undefined {
  if (!tests) return undefined;
  try {
    const t = JSON.parse(tests) as ReportJson['testsRun'];
    return t && typeof t.passed === 'boolean' ? t : undefined;
  } catch {
    return undefined;
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function oneLine(text: string, max: number): string {
  return cut(text.replace(/\s+/g, ' ').trim(), max);
}

/** The reports of a step, oldest first. */
function stepReports(store: Store, step: StepRow) {
  return store.listReports({ step_id: step.id });
}

/** Retries and their reasons: every report of a step before its last one that was not a pass, and failed runs. */
export function corrections(store: Store, steps: readonly StepRow[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    const reports = stepReports(store, step);
    for (const r of reports.slice(0, -1)) {
      const tests = testsOf(r.tests_json);
      if (r.status === 'done' && tests?.passed === false) out.push(`${step.duty} failed: ${tests.summary || r.summary}`);
      else if (r.status === 'blocked') out.push(`${step.duty} blocked: ${r.summary}`);
    }
    for (const s of store.listSessions({ step_id: step.id, states: ['failed', 'lost'] })) {
      out.push(`${step.duty} run ${s.id} ${s.state}: ${s.state_reason}`);
    }
    if (step.attempts > 1 && !out.some((c) => c.startsWith(`${step.duty} `))) out.push(`${step.duty} needed ${step.attempts} attempts`);
  }
  return out.slice(-8).map((c) => oneLine(c, 500));
}

export interface LandingStateInput {
  task: TaskRow;
  project: ProjectRow;
  steps: readonly StepRow[];
  files: readonly ChangedFile[];
  riskyPaths: readonly string[];
  rules: string;
  guidance: string;
}

/** The landing state, as an object that fits the schema, and as JSON within the state cap. */
export function buildLandingState(store: Store, input: LandingStateInput): { state: LandingRouteState; json: string } {
  const { task, project, steps } = input;
  const summaries: LandingRouteState['summaries'] = [];
  const checks: LandingRouteState['checks'] = [];
  for (const step of steps) {
    if (step.state !== 'done') continue;
    const reports = stepReports(store, step);
    const last = reports[reports.length - 1];
    if (last) summaries.push({ duty: step.duty, summary: cut(last.summary, 4000) });
    const tested = [...reports].reverse().find((r) => testsOf(r.tests_json));
    const t = tested ? testsOf(tested.tests_json) : undefined;
    if (tested && t) checks.push({ duty: step.duty, command: cut(t.command, 2000), passed: t.passed, summary: cut(t.summary, 600), at: tested.created_at });
  }
  const sorted = [...input.files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path));
  const totals = {
    files: input.files.length,
    additions: input.files.reduce((n, f) => n + f.additions, 0),
    deletions: input.files.reduce((n, f) => n + f.deletions, 0),
    filesOmitted: 0,
  };
  const fileRows = (n: number) =>
    sorted.slice(0, n).map((f) => ({ ...f, risky: input.riskyPaths.some((p) => pathMatches(f.path, p)) }));
  // Risky files are never the ones left out.
  const risky = sorted.filter((f) => input.riskyPaths.some((p) => pathMatches(f.path, p)));
  let state: LandingRouteState = {
    schema: 'landing-route-state-v1',
    project: { name: project.name, guidance: input.guidance },
    title: task.title,
    task: { id: task.id, kind: task.kind, text: task.task_text },
    summaries,
    riskyAreas: [...input.riskyPaths],
    files: fileRows(3000),
    totals: { ...totals, filesOmitted: Math.max(0, sorted.length - 3000) },
    checks: checks.slice(-31),
    corrections: corrections(store, steps),
    rules: input.rules,
  };
  const size = () => JSON.stringify(state).length;
  for (const n of [500, 100, 20] as const) {
    if (size() <= STATE_LIMIT) break;
    const kept = fileRows(n);
    const extra = risky.filter((f) => !kept.some((k) => k.path === f.path)).slice(0, 200).map((f) => ({ ...f, risky: true }));
    const files = [...kept, ...extra];
    state = { ...state, files, totals: { ...totals, filesOmitted: sorted.length - files.length } };
  }
  if (size() > STATE_LIMIT) state = { ...state, summaries: state.summaries.map((s) => ({ ...s, summary: cut(s.summary, 1000) })) };
  if (size() > STATE_LIMIT) {
    const over = size() - STATE_LIMIT;
    const keep = Math.max(0, task.task_text.length - over - TASK_SHORTENED.length - 2);
    state = { ...state, task: { ...state.task, text: `${task.task_text.slice(0, keep)}\n${TASK_SHORTENED}` } };
  }
  const parsed = LandingRouteStateSchema.parse(state);
  return { state: parsed, json: JSON.stringify(parsed) };
}

// ---- checks ----------------------------------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The last TAIL_CHARS characters of stdout and stderr, redacted. */
  tail: string;
  at: string;
  round: number;
}

/**
 * The environment of a landing check: the base keys of the process, the owner's own HOME (the project's tools keep
 * their caches there), the machine's git identity and Playwright's browsers. No provider login, no Jev key.
 */
export function checkEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_KEYS) if (base[key] !== undefined && base[key] !== '') env[key] = base[key]!;
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  const home = ownerHome();
  env.HOME = home;
  const id = machineGitIdentity(base);
  if (id.name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = id.name;
  if (id.email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = id.email;
  const browsers = join(home, '.cache', 'ms-playwright');
  if (existsSync(browsers)) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Runs one check with `sh -c` in its own process group; the group is killed on timeout. */
export function runCheck(cwd: string, check: Required<LandingCheck>, round: number, env: Record<string, string> = checkEnvironment()): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let out = '';
    let timedOut = false;
    let settled = false;
    const keep = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > TAIL_CHARS * 4) out = out.slice(-TAIL_CHARS * 2);
    };
    const finish = (exitCode: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const text = (out + extra).slice(-TAIL_CHARS * 2);
      resolvePromise({
        name: check.name,
        command: check.command,
        passed: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        tail: redact(text).slice(-TAIL_CHARS),
        at: nowIso(),
        round,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('sh', ['-c', check.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, `could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
    }, check.timeoutMs);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (error) => finish(null, `\n${error.message}`));
    child.on('close', (code) => finish(code, timedOut ? `\n[timed out after ${check.timeoutMs} ms]` : ''));
  });
}

// ---- options and results ---------------------------------------------------------------------------------------

export interface LandOptions {
  /** The owner's "Land now": no Jev call, route land. */
  force?: boolean;
  /** Called by the launcher after the last step: refusals become waiting-owner and a wake line, not exit 2. */
  auto?: boolean;
  /** Test seams and pass-throughs to askJev. */
  providers?: ProvidersConfig;
  client?: JevDecider;
  fetch?: typeof fetch;
  policyFile?: string;
  /** advance.startStep (default: imported from ./advance.js at the time it is needed). */
  startStep?: StartStep;
  /** wake.notifyCoordinator. */
  notify?: typeof notifyCoordinator;
  /** How long to wait for another landing of the project (default LOCK_WAIT_MS). */
  lockWaitMs?: number;
  /** Check runner (tests). */
  runCheck?: typeof runCheck;
  /** advance.releaseDependents, for a landing outside the auto path (default: imported when needed). */
  releaseDependents?: (store: Store, taskId: string) => Promise<unknown>;
}

export type StartStep = (store: Store, taskId: string, options: { reason: string; stepId?: string }) => Promise<unknown>;

export interface LandResult {
  route: string;
  state: string;
  reason: string;
  taskId: string;
  landingId?: string;
  decisionId?: string;
  commit?: string;
  checks?: CheckResult[];
  /** The verify step a verify-then-land appended. */
  stepId?: string;
}

interface Ctx {
  store: Store;
  task: TaskRow;
  project: ProjectRow;
  options: LandOptions;
}

// ---- wake lines ------------------------------------------------------------------------------------------------

function wakePrefix(task: TaskRow): string {
  return `[jv] ${task.id} (${oneLine(task.title, 80)}) landing`;
}

async function wake(ctx: Ctx, event: string, run = `jv task show ${ctx.task.id}`): Promise<void> {
  const notify = ctx.options.notify ?? notifyCoordinator;
  const line = `${wakePrefix(ctx.task)}: ${oneLine(redact(event), 600)}. Run: ${run}`;
  try {
    await notify(ctx.store, { projectId: ctx.project.id, taskId: ctx.task.id, line });
  } catch {
    // A wake line that cannot be typed waits for jv status; landing itself is recorded in the store.
  }
}

function optionsText(taskId: string): string {
  return OPTIONS_TEXT.replaceAll('{T}', taskId);
}

// ---- locks -----------------------------------------------------------------------------------------------------

interface LockHolder {
  pid: number;
  taskId: string;
  token: string;
  at: string;
}

function tryLock(store: Store, projectId: string, holder: LockHolder): LockHolder | undefined {
  return store.tx(() => {
    const key = `${LOCK_META_PREFIX}${projectId}`;
    const raw = store.getMeta(key);
    if (raw) {
      try {
        const current = JSON.parse(raw) as LockHolder;
        if (current.token && isAlive(current.pid)) return current;
      } catch {
        // an unreadable lock is taken over
      }
    }
    store.setMeta(key, JSON.stringify(holder));
    return undefined;
  });
}

function unlock(store: Store, projectId: string, token: string): void {
  store.tx(() => {
    const key = `${LOCK_META_PREFIX}${projectId}`;
    const raw = store.getMeta(key);
    try {
      if (raw && (JSON.parse(raw) as LockHolder).token === token) store.setMeta(key, JSON.stringify({ released: nowIso() }));
    } catch {
      // nothing to release
    }
  });
}

async function withProjectLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const holder: LockHolder = { pid: process.pid, taskId: ctx.task.id, token, at: nowIso() };
  const deadline = Date.now() + (ctx.options.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    const other = tryLock(ctx.store, ctx.project.id, holder);
    if (!other) break;
    if (other.taskId === ctx.task.id) throw refused(`task ${ctx.task.id} is being landed already (process ${other.pid})`);
    if (Date.now() >= deadline) {
      throw refused(`another landing of ${ctx.project.name} (task ${other.taskId}, process ${other.pid}) is still running; try again later`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    unlock(ctx.store, ctx.project.id, token);
  }
}

// ---- helpers ---------------------------------------------------------------------------------------------------

/** The verify step a verify-then-land landing appended, if any. */
export function landingStepId(store: Store, landingId: string): string | undefined {
  return store.getMeta(`${LANDING_STEP_META_PREFIX}${landingId}`);
}

/** Whether a step is the extra verify step of a verify-then-land landing (advance calls landTask when it ends). */
export function isLandingVerifyStep(store: Store, stepId: string): boolean {
  return store.listMeta(LANDING_STEP_META_PREFIX).some((m) => m.value === stepId);
}

/**
 * The newest landing of the task that is still waiting for the step it appended: the verify step of
 * verify-then-land, or the conflict resolution of a forced landing.
 */
export function openVerifyLanding(store: Store, taskId: string): LandingRow | undefined {
  const rows = store.listLandings({ task_id: taskId });
  const last = rows[rows.length - 1];
  if (!last || !['pending', 'checking'].includes(last.state)) return undefined;
  return landingStepId(store, last.id) ? last : undefined;
}

/** What the step a landing appended does, for the texts: by its duty. */
function landingStepWhat(duty: string | undefined): string {
  return duty === 'verify' ? 'the verification before landing' : 'the merge conflict resolution before landing';
}

/** The landing question the owner has not answered: the task's last landing row when it is asked, else none. */
export function askedLanding(store: Store, taskId: string): LandingRow | undefined {
  const last = store.listLandings({ task_id: taskId }).at(-1);
  return last?.state === 'asked' ? last : undefined;
}

/** Closes every asked landing row of the task (state failed, the answer then the asked reason): the owner answered, or a new landing replaced it. */
export function closeAskedLandings(store: Store, taskId: string, answer: string): LandingRow[] {
  return store
    .listLandings({ task_id: taskId, states: ['asked'] })
    .map((l) => store.setLandingState(l.id, 'failed', closedAskReason(answer, l.reason)));
}

/** Where a task lands (see the header): the branch to merge and fast-forward, and the checkout it is moved in. */
export interface LandingTarget {
  branch: string;
  /** The project checkout (default branch), or the parent's worktree (child task). */
  checkout: string;
  /** Set for a child task. */
  parent?: TaskRow;
}

/** The landing target of a task, or the reason it has none (a child whose parent cannot take it). */
export async function landingTarget(store: Store, task: TaskRow, project: ProjectRow): Promise<LandingTarget | string> {
  if (!task.parent_task_id) return { branch: project.default_branch, checkout: project.path };
  const parent = store.getTask(task.parent_task_id);
  const of = `task ${task.id} lands into its parent's branch`;
  if (!parent) return `${of}, but the parent ${task.parent_task_id} is gone`;
  if (parent.landed_commit) {
    return `${of}, but the parent ${parent.id} already landed at ${parent.landed_commit.slice(0, 12)}; its branch takes no more work`;
  }
  if (parent.state === 'stopped') return `${of}, but the parent ${parent.id} was discarded (${parent.state_reason})`;
  if (!parent.branch || !parent.worktree_path) return `${of}, but the parent ${parent.id} has no branch and worktree`;
  if (!(await resolveCommit(project.path, `refs/heads/${parent.branch}`))) return `${of}, but the parent's branch ${parent.branch} does not exist`;
  const entry = await findWorktree(project.path, parent.worktree_path).catch(() => undefined);
  if (!entry || entry.prunable) return `${of}, but the parent's worktree ${parent.worktree_path} is not a registered worktree of ${project.path}`;
  return { branch: parent.branch, checkout: parent.worktree_path, parent };
}

function landingStepIds(store: Store, taskId: string): Set<string> {
  const ids = new Set<string>();
  for (const l of store.listLandings({ task_id: taskId })) {
    const id = landingStepId(store, l.id);
    if (id) ids.add(id);
  }
  return ids;
}

/** A refusal: exit 2 for a person at the terminal; waiting-owner and a wake line when the launcher landed it. */
async function refuse(ctx: Ctx, reason: string): Promise<LandResult> {
  if (!ctx.options.auto) throw refused(reason);
  const text = redact(reason);
  ctx.store.setTaskState(ctx.task.id, 'waiting-owner', `landing refused: ${cut(text, 1000)}`);
  await wake(ctx, `refused, ${text}`);
  return { route: 'none', state: 'refused', reason: text, taskId: ctx.task.id };
}

/**
 * With force, the extra verify step of an earlier verify-then-land does not hold the landing back: one that has not
 * started is skipped ("forced by the owner"); a running one must be stopped first. `apply` false only checks.
 */
function forceLandingSteps(ctx: Ctx, apply: boolean): string | undefined {
  const { store, task } = ctx;
  const extra = landingStepIds(store, task.id);
  for (const s of store.listSteps(task.id)) {
    if (!extra.has(s.id) || s.state === 'done' || s.state === 'skipped') continue;
    if (s.state === 'running' || s.state === 'retrying') {
      return `step ${s.ordinal} (${s.duty}, ${s.id}), ${landingStepWhat(s.duty)}, is ${s.state}; stop it first with jv task stop ${task.id}`;
    }
    if (apply) store.setStepState(s.id, 'skipped', FORCED_REASON);
  }
  return undefined;
}

async function preconditions(ctx: Ctx, applyForce = false): Promise<string | undefined> {
  const { store, task } = ctx;
  const forced = ctx.options.force ? landingStepIds(store, task.id) : new Set<string>();
  if (ctx.options.force) {
    const problem = forceLandingSteps(ctx, applyForce);
    if (problem) return problem;
  }
  const open = store
    .listSteps(task.id)
    .filter((s) => s.state !== 'done' && s.state !== 'skipped' && !forced.has(s.id))
    .map((s) => `${s.ordinal} ${s.duty} (${s.state})`);
  if (open.length) return `task ${task.id} has steps that are not done or skipped: ${open.join(', ')}`;
  if (!task.branch || !task.worktree_path || !task.base_commit) return `task ${task.id} has no branch and worktree to land`;
  const entry = await findWorktree(ctx.project.path, task.worktree_path).catch(() => undefined);
  if (!entry || entry.prunable) return `the worktree ${task.worktree_path} of task ${task.id} is not a registered worktree of ${ctx.project.path}`;
  const branch = await currentBranch(task.worktree_path);
  if (branch !== task.branch) return `the worktree ${task.worktree_path} has ${branch ?? 'a detached HEAD'} checked out, not ${task.branch}`;
  try {
    ensureGitExclude(ctx.project.path);
  } catch {
    // the check below still runs; a missing exclude makes evidence files count, which refuses (safe)
  }
  const dirty = await uncommittedFiles(task.worktree_path);
  if (dirty.length) return `the worktree ${task.worktree_path} has uncommitted changes: ${listText(dirty)}. Commit or discard them first`;
  const target = await landingTarget(store, task, ctx.project);
  if (typeof target === 'string') return target;
  return undefined;
}

function landingReasonOf(route: LandingRoute, criteria: Map<string, string>): string {
  return criteria.get(route) ?? route;
}

// ---- the decision ----------------------------------------------------------------------------------------------

interface RouteDecision {
  route: LandingRoute;
  reason: string;
  decision?: DecisionRow;
}

async function decideRoute(ctx: Ctx, policy: Policy, stateJson: string): Promise<RouteDecision> {
  const instructions = requireSection(policy, LANDING_QUESTION);
  const criteria = parseRoutes(policy);
  const names = [...criteria.keys()];
  const unknown = names.filter((n) => !(LANDING_ROUTES as readonly string[]).includes(n));
  const missing = LANDING_ROUTES.filter((r) => !criteria.has(r));
  if (unknown.length || missing.length) {
    throw refused(
      `the policy ${policy.name} (${policy.file}), "## routes" must have exactly the lines ${LANDING_ROUTES.join(', ')}` +
        `${missing.length ? `; missing ${missing.join(', ')}` : ''}${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`,
    );
  }
  const questions = { [LANDING_QUESTION]: { type: 'choice' as const, instructions, criteria: Object.fromEntries(criteria) } };
  const ex = await askJev(LANDING_POLICY, stateJson, questions, {
    policy,
    ...(ctx.options.providers ? { providers: ctx.options.providers } : {}),
    ...(ctx.options.client ? { client: ctx.options.client } : {}),
    ...(ctx.options.fetch ? { fetch: ctx.options.fetch } : {}),
  });
  const { option, probabilities } = resolveChoice(ex.questions, ex.response, LANDING_QUESTION);
  if (!(LANDING_ROUTES as readonly string[]).includes(option)) throw refused(`Jev: invalid response (route ${option})`);
  const jevRoute = option as LandingRoute;
  const ruled = applyRouteRules(jevRoute, loadOwnerRules(ctx.project.name), {
    kind: ctx.task.kind,
    text: `${ctx.task.title}\n${ctx.task.task_text}`,
  });
  // A rule that changed the route says so; the overridden route's criterion would claim what Jev did not judge.
  const reason = ruled.reason ? `Jev chose ${jevRoute} (${landingReasonOf(jevRoute, criteria)}). ${ruled.reason}` : landingReasonOf(ruled.route, criteria);
  const decision = recordDecision(ctx.store, ex, {
    kind: 'landing',
    projectId: ctx.project.id,
    taskId: ctx.task.id,
    chosen: {
      route: ruled.route,
      jevRoute,
      probabilities,
      rulesApplied: ruled.rulesApplied,
      ...(ruled.reason ? { ruleReason: ruled.reason } : {}),
      source: 'jev',
    },
  });
  return { route: ruled.route, reason, decision };
}

// ---- routes ----------------------------------------------------------------------------------------------------

async function askOwner(ctx: Ctx, landing: LandingRow, reason: string, patch?: { route: LandingRoute }): Promise<LandResult> {
  const text = redact(reason);
  const row = ctx.store.setLandingState(landing.id, 'asked', cut(text, 2000), patch);
  ctx.store.setTaskState(ctx.task.id, 'waiting-owner', `landing: ask the owner: ${cut(text, 1000)}`);
  await wake(ctx, `ask-owner, ${text}. Options: ${optionsText(ctx.task.id)}`);
  return { route: row.route, state: 'asked', reason: text, taskId: ctx.task.id, landingId: row.id, ...(row.decision_id ? { decisionId: row.decision_id } : {}) };
}

async function failLanding(ctx: Ctx, landing: LandingRow, reason: string, event: string, checks?: CheckResult[]): Promise<LandResult> {
  const text = redact(reason);
  const row = ctx.store.setLandingState(landing.id, 'failed', cut(text, 2000), checks ? { checks_json: JSON.stringify(checks) } : undefined);
  ctx.store.setTaskState(ctx.task.id, 'waiting-owner', `landing failed: ${cut(text, 1000)}`);
  await wake(ctx, event);
  return {
    route: row.route,
    state: 'failed',
    reason: text,
    taskId: ctx.task.id,
    landingId: row.id,
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(checks ? { checks } : {}),
  };
}

function checkTail(c: CheckResult): string {
  const lines = c.tail.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return oneLine(lines.slice(-6).join(' | '), WAKE_TAIL_CHARS);
}

/** The land route on an existing landings row: merge, checks, fast-forward, push when configured. */
async function land(ctx: Ctx, landing: LandingRow): Promise<LandResult> {
  const { store, project } = ctx;
  const task = store.requireTask(ctx.task.id);
  const worktree = task.worktree_path!;
  const branch = task.branch!;
  const target = await landingTarget(store, task, project);
  if (typeof target === 'string') return failLanding(ctx, landing, target, `refused, ${target}`);
  // `into` is the branch the task lands into: the default branch, or the parent's branch for a child task.
  const into = target.branch;
  const onto = target.parent ? `${into} (the branch of the parent ${target.parent.id})` : into;
  const settings = loadProjectSettings(project.name);
  const checks = landingChecks(loadLandingConfig(project.name), settings);
  const run = ctx.options.runCheck ?? runCheck;
  const results: CheckResult[] = [];
  let row = landing;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    row = store.setLandingState(row.id, 'checking', `merging ${into} into ${branch}`);
    const merged = await mergeInto(worktree, `refs/heads/${into}`, `Merge ${into} into ${branch}`);
    if (merged.kind === 'conflict') {
      // The owner already said "Land now": a step resolves the conflict (once per landing row) instead of the same question again.
      const forced = ctx.options.force === true || store.getMeta(`${LANDING_FORCED_META_PREFIX}${row.id}`) === '1';
      if (forced && !landingStepId(store, row.id)) return resolveThenLand(ctx, row, into, branch, merged.files);
      return askOwner(ctx, row, `merge conflict: merging ${into} into ${branch} conflicts in ${listText(merged.files)}`, { route: 'ask-owner' });
    }
    const head = merged.head;
    for (const check of checks) {
      row = store.setLandingState(row.id, 'checking', `running check ${check.name}`, { checks_json: JSON.stringify(results) });
      const result = await run(worktree, check, round);
      const now = await resolveCommit(worktree, 'HEAD');
      if (result.passed && now !== head) {
        result.passed = false;
        result.tail = `${result.tail}\n[the check changed the worktree's HEAD from ${head.slice(0, 12)} to ${now?.slice(0, 12) ?? 'nothing'}]`.slice(-TAIL_CHARS);
      }
      results.push(result);
      if (!result.passed) {
        const why = result.timedOut ? `timed out after ${check.timeoutMs} ms` : `exit ${result.exitCode ?? 'none'}`;
        return failLanding(ctx, row, `check ${check.name} failed (${why})`, `check ${check.name} failed (${why}): ${checkTail(result)}`, results);
      }
    }
    row = store.setLandingState(row.id, 'landing', `fast-forwarding ${into} to ${branch}`, { checks_json: JSON.stringify(results) });
    const ff = await fastForwardDefault(target.checkout, branch, into);
    if (ff.kind === 'moved') continue;
    if (ff.kind === 'refused') return failLanding(ctx, row, ff.reason, `could not update ${into}: ${ff.reason}`, results);
    let reason = `landed ${ff.commit.slice(0, 12)} on ${onto} (${ff.method})${checks.length ? `; checks passed: ${checks.map((c) => c.name).join(', ')}` : '; no checks configured'}`;
    // A child's landing moves only its parent's branch; pushAfterLanding is about the default branch.
    if (settings.pushAfterLanding && !target.parent) {
      if (await hasOrigin(project.path)) {
        const pushed = await pushDefault(project.path, into);
        reason += pushed.ok ? `; ${pushed.detail}` : `; push to origin failed: ${redact(pushed.detail)}`;
      } else reason += '; pushAfterLanding is set but the repository has no origin';
    }
    row = store.setLandingState(row.id, 'landed', cut(reason, 2000), { commit_sha: ff.commit, checks_json: JSON.stringify(results) });
    store.setTaskState(task.id, 'done', `landed ${ff.commit.slice(0, 12)} on ${onto}`, { landed_commit: ff.commit });
    await wake(ctx, `landed ${ff.commit.slice(0, 12)} on ${onto}`);
    // The auto path (advance.finishSteps) releases the tasks waiting --after this one; jv land and "Land now" do here.
    if (!ctx.options.auto) await releaseAfterLanding(ctx);
    return {
      route: row.route,
      state: 'landed',
      reason,
      taskId: task.id,
      landingId: row.id,
      commit: ff.commit,
      checks: results,
      ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    };
  }
  return failLanding(ctx, row, `${into} kept moving during ${MAX_ROUNDS} landing attempts`, `${into} kept moving during ${MAX_ROUNDS} attempts`, results);
}

/**
 * An unexpected error during the land route (a git failure, an invalid landing.json) must not leave the task in
 * `landing`: the landing fails, the task waits on the owner, the coordinator is told, and the error is passed on
 * (auto: returned as the failed landing).
 */
async function guarded(ctx: Ctx, row: LandingRow, fn: () => Promise<LandResult>): Promise<LandResult> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = ctx.store.getLanding(row.id) ?? row;
    const result = await failLanding(ctx, current, message, `failed: ${message}`);
    if (ctx.options.auto) return result;
    throw error instanceof JvError ? error : refused(redact(message));
  }
}

async function releaseAfterLanding(ctx: Ctx): Promise<void> {
  try {
    const release =
      ctx.options.releaseDependents ??
      ((await import('./advance.js')) as unknown as { releaseDependents: (store: Store, taskId: string) => Promise<unknown> }).releaseDependents;
    await release(ctx.store, ctx.task.id);
  } catch {
    // a dependent that cannot start stays queued with its reason; jv task resume starts it
  }
}

async function loadStartStep(ctx: Ctx): Promise<StartStep> {
  if (ctx.options.startStep) return ctx.options.startStep;
  const mod = (await import('./advance.js')) as unknown as { startStep?: StartStep };
  if (typeof mod.startStep !== 'function') throw refused('verify-then-land needs advance.startStep, which this build does not have');
  return mod.startStep;
}

/** verify-then-land: appends one verify step and starts it; landing continues when it ends. */
async function verifyThenLand(ctx: Ctx, landing: LandingRow): Promise<LandResult> {
  return appendLandingStep(ctx, landing, 'verify', VERIFY_BEFORE_LANDING, 'verification before landing');
}

/** A forced landing whose merge conflicts: appends one implement step that resolves it; landing continues when it ends. */
async function resolveThenLand(ctx: Ctx, landing: LandingRow, into: string, branch: string, files: readonly string[]): Promise<LandResult> {
  ctx.store.setTaskState(ctx.task.id, 'landing', `landing: resolving the merge conflict in ${listText(files)} before landing`);
  return appendLandingStep(ctx, landing, 'implement', resolveConflictInstructions(into, branch, files), `merge conflict in ${listText(files)}, resolving before landing`);
}

/** Appends one step to the task for the landing (meta landing_step) and starts it; landing continues when it ends. */
async function appendLandingStep(ctx: Ctx, landing: LandingRow, duty: string, instructions: string, what: string): Promise<LandResult> {
  const { store, task } = ctx;
  const steps = store.listSteps(task.id);
  const ordinal = Math.max(0, ...steps.map((s) => s.ordinal)) + 1;
  const step = store.tx(() => {
    const created = store.createStep({ task_id: task.id, ordinal, duty, instructions, when_rule: 'always', on_fail_json: null });
    store.setMeta(`${LANDING_STEP_META_PREFIX}${landing.id}`, created.row.id);
    return created.row;
  });
  const row = store.setLandingState(landing.id, 'checking', `${what}: step ${step.ordinal} ${duty} (${step.id})`);
  const startStep = await loadStartStep(ctx);
  let started: unknown;
  try {
    started = await startStep(store, task.id, { reason: `${what} (${landing.id})`, stepId: step.id });
  } catch (error) {
    // The step stays pending with the placement's reason (advance records it); the landing waits for it.
    const message = error instanceof Error ? error.message : String(error);
    if (!ctx.options.auto) throw error;
    return { route: row.route, state: 'checking', reason: redact(message), taskId: task.id, landingId: row.id, stepId: step.id, ...(row.decision_id ? { decisionId: row.decision_id } : {}) };
  }
  // startStep reports a Jev refusal as a result (the step stays pending with the reason, the coordinator is told).
  const outcome = started as { state?: string; reason?: string } | undefined;
  const why = outcome && outcome.state !== 'started' && typeof outcome.reason === 'string' ? `; the step did not start: ${outcome.reason}` : '';
  return {
    route: row.route,
    state: 'checking',
    reason: `${row.reason}${redact(why)}`,
    taskId: task.id,
    landingId: row.id,
    stepId: step.id,
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
  };
}

/** A landing whose appended step (verify-then-land's verify, or a conflict resolution) ended (or is still running). */
async function continueVerify(ctx: Ctx, landing: LandingRow): Promise<LandResult> {
  const { store } = ctx;
  const stepId = landingStepId(store, landing.id)!;
  const step = store.getStep(stepId);
  const base = { route: landing.route, taskId: ctx.task.id, landingId: landing.id, stepId, ...(landing.decision_id ? { decisionId: landing.decision_id } : {}) };
  if (!step) return failLanding(ctx, landing, `the verify step ${stepId} of the landing is gone`, `verification step ${stepId} is gone`);
  const what = landingStepWhat(step.duty);
  if (step.state === 'pending' || step.state === 'running' || step.state === 'retrying') {
    if (ctx.options.auto) return { ...base, state: 'checking', reason: `${what} is ${step.state} (step ${step.id})` };
    throw refused(`task ${ctx.task.id}: ${what} (step ${step.ordinal}, ${step.id}) is ${step.state}; landing continues when it ends${step.state === 'pending' ? ` (jv task resume ${ctx.task.id} starts it)` : ''}`);
  }
  const reports = store.listReports({ step_id: step.id });
  const last = reports[reports.length - 1];
  const tests = last ? testsOf(last.tests_json) : undefined;
  const passed = step.state === 'done' && last?.status === 'done' && tests?.passed !== false;
  if (!passed) {
    const why = tests?.passed === false ? tests.summary || last!.summary : last ? last.summary : step.state_reason || step.state;
    const session = last?.session_id;
    const reason = `${what.replace(/^the /, '')} failed: ${oneLine(why, 1500)}`;
    const text = redact(reason);
    store.setLandingState(landing.id, 'failed', cut(text, 2000));
    store.setTaskState(ctx.task.id, 'waiting-owner', cut(text, 1000));
    const notify = ctx.options.notify ?? notifyCoordinator;
    try {
      await notify(store, {
        projectId: ctx.project.id,
        taskId: ctx.task.id,
        line: `[jv] ${ctx.task.id} (${oneLine(ctx.task.title, 80)}) step ${step.duty}: ${oneLine(text, 400)}. Run: ${session ? `jv report ${session}` : `jv task show ${ctx.task.id}`}`,
      });
    } catch {
      // see wake()
    }
    return { ...base, state: 'failed', reason: text };
  }
  const problem = await preconditions(ctx);
  if (problem) {
    store.setLandingState(landing.id, 'failed', cut(redact(problem), 2000));
    return refuse(ctx, problem);
  }
  const passedText = `${what.replace(/^the /, '')} passed`;
  store.setTaskState(ctx.task.id, 'landing', `${passedText}; landing`);
  const row = store.setLandingState(landing.id, 'checking', passedText);
  return guarded(ctx, row, () => land(ctx, row));
}

// ---- landTask --------------------------------------------------------------------------------------------------

/**
 * Lands a task (section 8). Returns the route taken and the landing's state: landed, checking (verify-then-land
 * waiting for its step), asked, failed, or refused (auto only). Throws JvError exit 2 for a refusal without auto, exit
 * 2 with the Jev message when Jev cannot answer (the task waits on the owner then), exit 3 for an unknown task.
 */
export async function landTask(store: Store, taskId: string, options: LandOptions = {}): Promise<LandResult> {
  const task = store.getTask(taskId);
  if (!task) throw notFound(`no task ${taskId}`);
  const project = store.getProject(task.project_id);
  if (!project) throw notFound(`no project ${task.project_id}`);
  const ctx: Ctx = { store, task, project, options };

  const landed = () => {
    const rows = store.listLandings({ task_id: task.id, states: ['landed'] });
    const row = rows[rows.length - 1];
    return {
      route: row?.route ?? 'land',
      state: 'landed',
      reason: `already landed at ${store.requireTask(task.id).landed_commit}`,
      taskId: task.id,
      commit: store.requireTask(task.id).landed_commit!,
      ...(row ? { landingId: row.id } : {}),
    };
  };
  if (task.landed_commit) return landed();
  if (task.state === 'stopped') {
    const reason = `task ${task.id} was stopped (${task.state_reason}); there is nothing to land`;
    if (!options.auto) throw refused(reason);
    return { route: 'none', state: 'refused', reason, taskId: task.id };
  }

  const open = openVerifyLanding(store, task.id);
  if (open && !options.force) {
    return withProjectLock(ctx, async () => {
      ctx.task = store.requireTask(task.id);
      if (ctx.task.landed_commit) return landed();
      return continueVerify(ctx, store.requireLanding(open.id));
    });
  }

  const problem = await preconditions(ctx);
  if (problem) return refuse(ctx, problem);

  return withProjectLock(ctx, async () => {
    ctx.task = store.requireTask(task.id);
    if (ctx.task.landed_commit) return landed();
    const again = await preconditions(ctx, true);
    if (again) return refuse(ctx, again);
    if (open) store.setLandingState(open.id, 'failed', `replaced: ${FORCED_REASON}`);
    // The owner's answer (or a new decision) closes the question an ask-owner landing left open; only after the
    // preconditions passed, so a refused "Land now" leaves the question standing.
    closeAskedLandings(store, task.id, options.force ? ANSWERED_LAND_NOW : REPLACED_ASK);
    ctx.task = store.setTaskState(task.id, 'landing', options.force ? `jv land --force: ${FORCED_REASON}` : 'deciding the landing route');

    if (options.force) {
      const row = store.createLanding({ task_id: task.id, route: 'land', state: 'pending', reason: FORCED_REASON });
      store.setMeta(`${LANDING_FORCED_META_PREFIX}${row.id}`, '1');
      return guarded(ctx, row, () => land(ctx, row));
    }

    let decided: RouteDecision;
    try {
      const policy = options.policyFile ? loadPolicy(LANDING_POLICY, options.policyFile) : loadPolicy(LANDING_POLICY);
      const rules = requireSection(policy, 'rules');
      const files = await changedFiles(ctx.task.worktree_path!, ctx.task.base_commit!, `refs/heads/${ctx.task.branch!}`);
      const { riskyPaths } = loadLandingConfig(project.name);
      const { json } = buildLandingState(store, {
        task: ctx.task,
        project,
        steps: store.listSteps(task.id),
        files,
        riskyPaths,
        rules,
        guidance: loadProjectGuidance(project.name),
      });
      decided = await decideRoute(ctx, policy, redact(json));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const text = redact(message);
      store.setTaskState(task.id, 'waiting-owner', `landing: ${cut(text, 1000)}`);
      await wake(ctx, message.startsWith('Jev:') ? `Jev refused (${text.replace(/^Jev:\s*/, '')})` : `could not decide the route: ${text}`);
      if (options.auto && error instanceof JvError) return { route: 'none', state: 'refused', reason: text, taskId: task.id };
      throw error;
    }

    const row = store.createLanding({
      task_id: task.id,
      decision_id: decided.decision?.id ?? null,
      route: decided.route,
      state: 'pending',
      reason: cut(decided.reason, 2000),
    });
    if (decided.route === 'ask-owner') return askOwner(ctx, row, decided.reason);
    if (decided.route === 'verify-then-land') return verifyThenLand(ctx, row);
    return guarded(ctx, row, () => land(ctx, row));
  });
}

// ---- text ------------------------------------------------------------------------------------------------------

/** The human text of a land result. */
export function formatLandResult(r: LandResult): string {
  const lines: string[] = [];
  const head =
    r.state === 'landed'
      ? `${r.taskId} landed${r.commit ? ` at ${r.commit.slice(0, 12)}` : ''} (route ${r.route})`
      : r.state === 'asked'
        ? `${r.taskId}: the owner decides (route ${r.route}). Options: ${optionsText(r.taskId)}`
        : r.state === 'checking'
          ? `${r.taskId}: ${r.route === 'verify-then-land' ? 'verifying' : 'resolving the merge conflict'} before landing (route ${r.route}${r.stepId ? `, step ${r.stepId}` : ''})`
          : `${r.taskId}: landing ${r.state} (route ${r.route})`;
  lines.push(head, `Reason: ${r.reason}`);
  for (const c of r.checks ?? []) {
    lines.push(`Check ${c.name}: ${c.passed ? 'passed' : c.timedOut ? 'timed out' : `failed (exit ${c.exitCode ?? 'none'})`} in ${(c.durationMs / 1000).toFixed(1)} s`);
    if (!c.passed && c.tail.trim() !== '') lines.push(...c.tail.trimEnd().split('\n').slice(-20).map((l) => `  ${l}`));
  }
  return lines.join('\n');
}
