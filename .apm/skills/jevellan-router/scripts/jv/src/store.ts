// The store: one SQLite file (node:sqlite), the only state and the only history of jv.
//
// - The schema below is section 4 of the brief, verbatim. Schema version lives in meta.schema_version.
// - Pragmas: WAL, busy_timeout 5000, synchronous NORMAL, foreign_keys ON, set on every connection.
// - Several jv processes write concurrently, each in short transactions: tx() runs BEGIN IMMEDIATE (the write
//   lock is taken up front, so a transaction never fails half way on a lock upgrade) and retries a bounded number
//   of times when SQLite still reports SQLITE_BUSY after busy_timeout.
// - request_id rule: creating a task or a session with a request_id that exists returns the existing row
//   (created=false) when every input column is identical, and throws JvError exit 4 when any differs. Steps are
//   keyed the same way on (task_id, ordinal) and reports on session_id.
// - Every state setter writes state_reason (landings: reason) and the timestamps the state implies.
// - Nothing in this module deletes a row, and nothing else may: there is no delete helper.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { conflict, JvError, notFound, refused } from './errors.js';
import { newId, type IdKind } from './ids.js';
import { paths } from './paths.js';
import {
  DECISION_KINDS,
  EVENT_KINDS,
  LANDING_ROUTES,
  LANDING_STATES,
  MESSAGE_DIRECTIONS,
  OVERRIDE_MODES,
  REPORT_STATUSES,
  RUNTIMES,
  SESSION_KINDS,
  SESSION_STATES,
  STEP_STATES,
  TASK_KINDS,
  TASK_STATES,
  USAGE_SOURCES,
  type DecisionKind,
  type DecisionRow,
  type EventKind,
  type EventRow,
  type LandingRoute,
  type LandingRow,
  type LandingState,
  type MessageDirection,
  type MessageRow,
  type OverrideMode,
  type ProjectRow,
  type ProviderUsageRow,
  type ReportRow,
  type ReportStatus,
  type Runtime,
  type SessionKind,
  type SessionRow,
  type SessionState,
  type StepRow,
  type StepState,
  type TaskKind,
  type TaskRow,
  type TaskState,
  type UsageSource,
} from './types.js';

export const SCHEMA_VERSION = '1';

/** Section 4 of the brief, verbatim. */
export const SCHEMA_SQL = `CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, path TEXT NOT NULL, default_branch TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                 -- 'T' + 6 chars base32, unique
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_task_id TEXT REFERENCES tasks(id),
  after_task_id TEXT REFERENCES tasks(id),
  request_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feature','bug','automation','single')),
  title TEXT NOT NULL CHECK (length(title) <= 120),
  task_text TEXT NOT NULL CHECK (length(task_text) <= 32768),
  workflow_json TEXT NOT NULL,          -- the resolved workflow (steps) at creation
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting-owner','landing','done','failed','stopped')),
  state_reason TEXT NOT NULL DEFAULT '',
  current_step INTEGER NOT NULL DEFAULT 0,
  branch TEXT, worktree_path TEXT, base_commit TEXT, landed_commit TEXT,
  visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,                 -- 'S' + 6 chars
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL,
  duty TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  when_rule TEXT NOT NULL DEFAULT 'always',   -- 'always' | 'jev:<question_id>'
  on_fail_json TEXT,                           -- {"goto": "<duty>", "maxLoops": 2}
  state TEXT NOT NULL CHECK (state IN ('pending','running','retrying','done','failed','skipped')),
  state_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, ended_at TEXT,
  UNIQUE (task_id, ordinal)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- 'R' + 6 chars (a run)
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  step_id TEXT REFERENCES steps(id),
  request_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('step','coordinator','probe')),
  runtime TEXT NOT NULL CHECK (runtime IN ('claude-sdk','claude-tmux','codex','llm')),
  provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
  cwd TEXT NOT NULL,
  native_session_id TEXT,              -- Claude session uuid, Codex thread id, or NULL for llm
  pid INTEGER, pgid INTEGER, tmux_target TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','starting','running','waiting','done','failed','lost','stopped')),
  state_reason TEXT NOT NULL DEFAULT '',
  started_at TEXT, ended_at TEXT, last_event_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start','text','thinking','tool-call','tool-result','report','error','message','usage','rate-limit','end')),
  payload TEXT NOT NULL,               -- JSON; text payloads trimmed to 20000 chars with a 'truncated' flag
  UNIQUE (session_id, seq)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id),
  step_id TEXT REFERENCES steps(id), task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL CHECK (status IN ('progress','done','blocked','needs-decision')),
  summary TEXT NOT NULL CHECK (length(summary) <= 4000),
  question TEXT, options_json TEXT, tests_json TEXT, changed_files_json TEXT NOT NULL DEFAULT '[]',
  screenshots_json TEXT NOT NULL DEFAULT '[]', limitations TEXT, owner_commands_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('placement','landing','workflow')),
  project_id TEXT NOT NULL, task_id TEXT, step_id TEXT, session_id TEXT,
  skill_name TEXT NOT NULL, skill_hash TEXT NOT NULL,     -- sha256 of the SKILL.md body used
  jev_model TEXT NOT NULL,
  state_json TEXT NOT NULL, questions_json TEXT NOT NULL,
  answers_json TEXT NOT NULL, chosen_json TEXT NOT NULL,  -- what the script resolved from the answers
  override_json TEXT, override_mode TEXT CHECK (override_mode IN ('undo','keep')),
  outcome_json TEXT,                                      -- filled when the placed step ends: {status, attempts, durationMs, costUsd}
  latency_ms INTEGER NOT NULL, usage_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE landings (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), decision_id TEXT REFERENCES decisions(id),
  route TEXT NOT NULL CHECK (route IN ('land','verify-then-land','ask-owner')),
  state TEXT NOT NULL CHECK (state IN ('pending','checking','landing','landed','asked','failed')),
  checks_json TEXT NOT NULL DEFAULT '[]', commit_sha TEXT, reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, ended_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('owner','coordinator','answer')),
  text TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
);

CREATE TABLE provider_usage (
  provider TEXT NOT NULL, observed_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('probe','stream','local')),
  five_hour_pct REAL, weekly_pct REAL, five_hour_resets_at TEXT, weekly_resets_at TEXT,
  local_week TEXT, local_input_tokens INTEGER, local_output_tokens INTEGER, local_cost_usd REAL,
  PRIMARY KEY (provider, observed_at)
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, coordinator tmux targets, etc.`;

/** The tables of SCHEMA_SQL, in creation order. */
export const TABLES = [
  'projects',
  'tasks',
  'steps',
  'sessions',
  'events',
  'reports',
  'decisions',
  'landings',
  'messages',
  'provider_usage',
  'meta',
] as const;

const BUSY_RETRIES = 6;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export function nowIso(): string {
  return new Date().toISOString();
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function sqliteCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code : undefined;
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), including their extended codes. */
export function isBusyError(error: unknown): boolean {
  const code = sqliteCode(error);
  if (code !== undefined) return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /database is locked|database table is locked/i.test(String((error as Error | null)?.message ?? ''));
}

function isIdCollision(error: unknown, table: string): boolean {
  const message = String((error as Error | null)?.message ?? '');
  return (
    sqliteCode(error) === 1555 ||
    message.includes(`UNIQUE constraint failed: ${table}.id`) ||
    message.includes(`PRIMARY KEY constraint failed: ${table}.id`)
  );
}

type Param = SQLInputValue | boolean | undefined;

function toParam(value: Param): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

function charLength(text: string): number {
  // SQLite's length() counts characters, not UTF-16 code units.
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function checkOneOf<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw refused(`unknown ${what} "${value}" (one of: ${allowed.join(', ')})`);
  }
  return value as T;
}

function checkReason(reason: string): string {
  const r = reason.trim();
  if (r === '') throw refused('a state change needs a reason');
  return r;
}

function same(a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a;
  const nb = b === undefined ? null : typeof b === 'boolean' ? (b ? 1 : 0) : b;
  return na === nb;
}

/** A create result: the row, and whether this call created it (false: an identical earlier create). */
export interface Created<T> {
  row: T;
  created: boolean;
}

export interface OpenStoreOptions {
  /** Store file; default ~/.jv/store.sqlite. */
  file?: string;
  /** Id generator, for tests of the collision retry. Default: newId. */
  idSource?: (kind: IdKind) => string;
}

// ---- inputs ------------------------------------------------------------------------------------------------

export interface NewProject {
  name: string;
  path: string;
  default_branch: string;
}

export interface NewTask {
  project_id: string;
  parent_task_id?: string | null;
  after_task_id?: string | null;
  request_id: string;
  kind: TaskKind;
  title: string;
  task_text: string;
  workflow_json: string;
  visible?: boolean | number;
  /** Initial state, default queued. Not an input column for the request_id rule. */
  state?: TaskState;
  state_reason?: string;
}

export interface NewStep {
  task_id: string;
  ordinal: number;
  duty: string;
  instructions?: string;
  when_rule?: string;
  on_fail_json?: string | null;
  /** Initial state, default pending. */
  state?: StepState;
  state_reason?: string;
}

export interface NewSession {
  project_id: string;
  task_id?: string | null;
  step_id?: string | null;
  request_id: string;
  kind: SessionKind;
  runtime: Runtime;
  provider: string;
  model: string;
  effort: string;
  cwd: string;
  /** Compared under the request_id rule only when given. */
  native_session_id?: string | null;
  /** Initial state, default queued. */
  state?: SessionState;
  state_reason?: string;
}

export interface NewReport {
  session_id: string;
  step_id?: string | null;
  task_id?: string | null;
  status: ReportStatus;
  summary: string;
  question?: string | null;
  options_json?: string | null;
  tests_json?: string | null;
  changed_files_json?: string;
  screenshots_json?: string;
  limitations?: string | null;
  owner_commands_json?: string | null;
}

export interface NewDecision {
  kind: DecisionKind;
  project_id: string;
  task_id?: string | null;
  step_id?: string | null;
  session_id?: string | null;
  skill_name: string;
  skill_hash: string;
  jev_model: string;
  state_json: string;
  questions_json: string;
  answers_json: string;
  chosen_json: string;
  override_json?: string | null;
  override_mode?: OverrideMode | null;
  outcome_json?: string | null;
  latency_ms: number;
  usage_json: string;
}

export interface NewLanding {
  task_id: string;
  decision_id?: string | null;
  route: LandingRoute;
  /** Initial state, default pending. */
  state?: LandingState;
  checks_json?: string;
  commit_sha?: string | null;
  reason?: string;
}

export interface NewMessage {
  task_id: string;
  session_id?: string | null;
  direction: MessageDirection;
  text: string;
}

export interface NewProviderUsage {
  provider: string;
  /** Default now; a clash on (provider, observed_at) moves it forward by a millisecond. */
  observed_at?: string;
  source: UsageSource;
  five_hour_pct?: number | null;
  weekly_pct?: number | null;
  five_hour_resets_at?: string | null;
  weekly_resets_at?: string | null;
  local_week?: string | null;
  local_input_tokens?: number | null;
  local_output_tokens?: number | null;
  local_cost_usd?: number | null;
}

export interface UsageDelta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

// ---- patches (non-state columns a caller may change) --------------------------------------------------------

export type TaskPatch = Partial<
  Pick<TaskRow, 'current_step' | 'branch' | 'worktree_path' | 'base_commit' | 'landed_commit' | 'visible'>
>;
export type StepPatch = Partial<Pick<StepRow, 'instructions' | 'when_rule' | 'on_fail_json' | 'attempts'>>;
export type SessionPatch = Partial<
  Pick<SessionRow, 'native_session_id' | 'pid' | 'pgid' | 'tmux_target' | 'last_event_at' | 'cwd'>
>;
export type LandingPatch = Partial<Pick<LandingRow, 'decision_id' | 'route' | 'checks_json' | 'commit_sha'>>;
export type DecisionPatch = Partial<
  Pick<DecisionRow, 'task_id' | 'step_id' | 'session_id' | 'override_json' | 'override_mode' | 'outcome_json'>
>;

const TASK_PATCH_KEYS = ['current_step', 'branch', 'worktree_path', 'base_commit', 'landed_commit', 'visible'] as const;
const STEP_PATCH_KEYS = ['instructions', 'when_rule', 'on_fail_json', 'attempts'] as const;
const SESSION_PATCH_KEYS = ['native_session_id', 'pid', 'pgid', 'tmux_target', 'last_event_at', 'cwd'] as const;
const LANDING_PATCH_KEYS = ['decision_id', 'route', 'checks_json', 'commit_sha'] as const;
const DECISION_PATCH_KEYS = ['task_id', 'step_id', 'session_id', 'override_json', 'override_mode', 'outcome_json'] as const;

// ---- filters ------------------------------------------------------------------------------------------------

export interface TaskFilter {
  project_id?: string;
  parent_task_id?: string;
  kind?: TaskKind;
  states?: readonly TaskState[];
}
export interface SessionFilter {
  project_id?: string;
  task_id?: string;
  step_id?: string;
  kind?: SessionKind;
  runtime?: Runtime;
  native_session_id?: string;
  states?: readonly SessionState[];
}
export interface ReportFilter {
  task_id?: string;
  step_id?: string;
}
export interface DecisionFilter {
  kind?: DecisionKind;
  project_id?: string;
  task_id?: string;
  step_id?: string;
  session_id?: string;
  /** created_at >= since (ISO date or timestamp). */
  since?: string;
}
export interface LandingFilter {
  task_id?: string;
  states?: readonly LandingState[];
}
export interface MessageFilter {
  task_id?: string;
  session_id?: string;
  direction?: MessageDirection;
  undelivered?: boolean;
}
export interface ProviderUsageFilter {
  provider?: string;
  source?: UsageSource;
  since?: string;
}

/**
 * Timestamps a state implies. Entering a start state sets started_at once (never overwritten); entering an end
 * state sets ended_at; entering any other state clears ended_at (the row is live again).
 */
export const STATE_TIMESTAMPS = {
  tasks: { start: ['running'], end: ['done', 'failed', 'stopped'] },
  steps: { start: ['running', 'retrying'], end: ['done', 'failed', 'skipped'] },
  sessions: { start: ['starting', 'running'], end: ['done', 'failed', 'lost', 'stopped'] },
  landings: { start: [], end: ['landed', 'asked', 'failed'] },
} as const satisfies Record<string, { start: readonly string[]; end: readonly string[] }>;

type TimedTable = keyof typeof STATE_TIMESTAMPS;

function impliedTimes(
  table: TimedTable,
  state: string,
  current: { started_at?: string | null; ended_at: string | null } | undefined,
  at: string,
): { started_at?: string | null; ended_at: string | null } {
  const rule = STATE_TIMESTAMPS[table];
  const out: { started_at?: string | null; ended_at: string | null } = {
    ended_at: (rule.end as readonly string[]).includes(state) ? at : null,
  };
  if (table !== 'landings') {
    const started = current?.started_at ?? null;
    out.started_at = started ?? ((rule.start as readonly string[]).includes(state) ? at : null);
  }
  return out;
}

function where(
  clauses: Array<[string, Param | readonly string[] | undefined]>,
): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [clause, value] of clauses) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push('0');
        continue;
      }
      parts.push(`${clause} IN (${value.map(() => '?').join(', ')})`);
      params.push(...(value as string[]));
    } else {
      parts.push(clause);
      params.push(toParam(value as Param));
    }
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

export class Store {
  readonly db: DatabaseSync;
  readonly file: string;
  private readonly statements = new Map<string, StatementSync>();
  private readonly idSource: (kind: IdKind) => string;
  private depth = 0;
  private closed = false;

  private constructor(file: string, idSource: (kind: IdKind) => string) {
    this.file = file;
    this.idSource = idSource;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.retryBusy(() => this.db.exec('PRAGMA journal_mode = WAL'));
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** Opens (creating and migrating when needed) the store file. */
  static open(options: OpenStoreOptions = {}): Store {
    const store = new Store(options.file ?? paths.store, options.idSource ?? newId);
    try {
      store.migrate();
    } catch (error) {
      store.close();
      throw error;
    }
    return store;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private get<T>(sql: string, ...params: Param[]): T | undefined {
    const row = this.stmt(sql).get(...params.map(toParam));
    return row === undefined ? undefined : plain<T>(row);
  }

  private all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(toParam)).map((r) => plain<T>(r));
  }

  private run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params.map(toParam));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  private retryBusy<T>(fn: () => T): T {
    for (let attempt = 1; ; attempt++) {
      try {
        return fn();
      } catch (error) {
        if (!isBusyError(error) || attempt >= BUSY_RETRIES) throw error;
        sleepSync(Math.min(500, 20 * 2 ** attempt) + Math.floor(Math.random() * 20));
      }
    }
  }

  /**
   * Runs fn in one write transaction (BEGIN IMMEDIATE). Nested calls join the outer transaction. fn must be
   * synchronous. On SQLITE_BUSY the transaction is rolled back and retried, a bounded number of times.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    for (let attempt = 1; ; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (isBusyError(error) && attempt < BUSY_RETRIES) {
          sleepSync(Math.min(500, 20 * 2 ** attempt) + Math.floor(Math.random() * 20));
          continue;
        }
        if (isBusyError(error)) throw new JvError(`the store is busy (${this.file}); try again`, 2);
        throw error;
      }
      this.depth = 1;
      try {
        const result = fn();
        if (result instanceof Promise) throw new Error('store.tx() takes a synchronous function');
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // no transaction left to roll back
        }
        if (isBusyError(error) && attempt < BUSY_RETRIES) {
          sleepSync(Math.min(500, 20 * 2 ** attempt) + Math.floor(Math.random() * 20));
          continue;
        }
        throw error;
      } finally {
        this.depth = 0;
      }
    }
  }

  /** Inserts a row under a fresh id of `kind`, retrying with another id when the id collides. */
  private insertWithId(kind: IdKind, table: string, row: Record<string, Param>): string {
    const columns = ['id', ...Object.keys(row)];
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    for (let attempt = 1; ; attempt++) {
      const id = this.idSource(kind);
      try {
        this.run(sql, id, ...Object.values(row));
        return id;
      } catch (error) {
        if (isIdCollision(error, table) && attempt < 10) continue;
        throw error;
      }
    }
  }

  private update(table: string, key: string, id: string | number, fields: Record<string, Param>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${key} = ?`;
    this.run(sql, ...keys.map((k) => fields[k]), id);
  }

  private pick(patch: object | undefined, allowed: readonly string[]): Record<string, Param> {
    const out: Record<string, Param> = {};
    if (!patch) return out;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (!allowed.includes(k)) throw new Error(`column ${k} cannot be changed this way`);
      out[k] = v as Param;
    }
    return out;
  }

  private assertSameInput(
    what: string,
    key: string,
    existing: Record<string, unknown>,
    input: Record<string, unknown>,
    columns: readonly string[],
  ): void {
    const differing = columns.filter((c) => !same(existing[c], input[c]));
    if (differing.length > 0) {
      throw conflict(
        `${key} was already used for ${what} ${String(existing.id)} with different input (${differing.join(', ')})`,
        { id: existing.id, fields: differing },
      );
    }
  }

  // ---- schema -----------------------------------------------------------------------------------------------

  /**
   * Checks the schema version, creating the schema in a new file. An existing store is only read (no write lock), so
   * opening the store for a read never queues behind a writer; BEGIN IMMEDIATE is taken only when the meta table is
   * missing, and the check is repeated inside that transaction in case another process created the schema first.
   */
  private migrate(): void {
    const checkVersion = (): void => {
      const version = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value;
      if (version === SCHEMA_VERSION) return;
      if (version === undefined) throw refused(`${this.file} has no schema_version in meta`);
      throw refused(
        `store schema version ${version} does not match this runtime (${SCHEMA_VERSION}); run jv update`,
      );
    };
    const metaExists = () =>
      this.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'") !== undefined;
    if (this.retryBusy(metaExists)) {
      this.retryBusy(checkVersion);
      return;
    }
    this.tx(() => {
      const hasMeta = metaExists();
      if (!hasMeta) {
        const tables = this.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        );
        if (tables.length > 0) {
          throw refused(`${this.file} has tables but no schema version; it is not a jv store`);
        }
        this.db.exec(SCHEMA_SQL);
        this.run('INSERT INTO meta (key, value) VALUES (?, ?)', 'schema_version', SCHEMA_VERSION);
        return;
      }
      checkVersion();
    });
  }

  /** meta.schema_version of this store. */
  schemaVersion(): string {
    return this.getMeta('schema_version') ?? '';
  }

  // ---- meta -------------------------------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.tx(() => {
      this.run(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        key,
        value,
      );
    });
  }

  listMeta(prefix = ''): Array<{ key: string; value: string }> {
    return this.all('SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key', prefix.length, prefix);
  }

  // ---- projects ---------------------------------------------------------------------------------------------

  /**
   * Creates a project. The name is the key: an identical repeat returns the row; the same name and path with another
   * default branch updates default_branch (the repository renamed its branch; projects are not request-id rows);
   * a different path exits 4, and so does a path another project already holds.
   */
  createProject(input: NewProject): Created<ProjectRow> & { branchChangedFrom?: string } {
    if (input.name.trim() === '') throw refused('a project needs a name');
    return this.tx(() => {
      const existing = this.getProjectByName(input.name);
      if (existing) {
        this.assertSameInput('project', `project name ${input.name}`, { ...existing }, { ...input }, ['path']);
        if (existing.default_branch !== input.default_branch) {
          this.update('projects', 'id', existing.id, { default_branch: input.default_branch });
          return { row: this.getProject(existing.id)!, created: false, branchChangedFrom: existing.default_branch };
        }
        return { row: existing, created: false };
      }
      const samePath = this.get<ProjectRow>('SELECT * FROM projects WHERE path = ?', input.path);
      if (samePath) {
        throw conflict(`${input.path} is already registered as project ${samePath.name} (${samePath.id})`, {
          id: samePath.id,
          fields: ['path'],
        });
      }
      const id = this.insertWithId('project', 'projects', {
        name: input.name,
        path: input.path,
        default_branch: input.default_branch,
        created_at: nowIso(),
      });
      return { row: this.getProject(id)!, created: true };
    });
  }

  getProject(id: string): ProjectRow | undefined {
    return this.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  }

  getProjectByName(name: string): ProjectRow | undefined {
    return this.get<ProjectRow>('SELECT * FROM projects WHERE name = ?', name);
  }

  /** A project by id or by name; JvError exit 3 when there is none. */
  requireProject(idOrName: string): ProjectRow {
    const row = this.getProject(idOrName) ?? this.getProjectByName(idOrName);
    if (!row) throw notFound(`no project ${idOrName}`);
    return row;
  }

  listProjects(): ProjectRow[] {
    return this.all<ProjectRow>('SELECT * FROM projects ORDER BY name');
  }

  // ---- tasks ------------------------------------------------------------------------------------------------

  createTask(input: NewTask): Created<TaskRow> {
    checkOneOf('task kind', input.kind, TASK_KINDS);
    const state = checkOneOf('task state', input.state ?? 'queued', TASK_STATES);
    if (input.request_id.trim() === '') throw refused('a task needs a request id');
    if (input.title.trim() === '') throw refused('a task needs a title');
    if (charLength(input.title) > 120) throw refused('the task title is longer than 120 characters');
    if (charLength(input.task_text) > 32768) throw refused('the task text is longer than 32768 characters');
    const columns = ['project_id', 'parent_task_id', 'after_task_id', 'kind', 'title', 'task_text', 'workflow_json', 'visible'];
    const values: Record<string, Param> = {
      project_id: input.project_id,
      parent_task_id: input.parent_task_id ?? null,
      after_task_id: input.after_task_id ?? null,
      kind: input.kind,
      title: input.title,
      task_text: input.task_text,
      workflow_json: input.workflow_json,
      visible: input.visible ? 1 : 0,
    };
    return this.tx(() => {
      const existing = this.getTaskByRequestId(input.request_id);
      if (existing) {
        this.assertSameInput('task', `request id ${input.request_id}`, { ...existing }, values, columns);
        return { row: existing, created: false };
      }
      if (!this.getProject(input.project_id)) throw notFound(`no project ${input.project_id}`);
      if (input.parent_task_id && !this.getTask(input.parent_task_id)) {
        throw notFound(`no task ${input.parent_task_id}`);
      }
      if (input.after_task_id && !this.getTask(input.after_task_id)) throw notFound(`no task ${input.after_task_id}`);
      const at = nowIso();
      const times = impliedTimes('tasks', state, undefined, at);
      const id = this.insertWithId('task', 'tasks', {
        ...values,
        request_id: input.request_id,
        state,
        state_reason: checkReason(input.state_reason ?? 'created'),
        created_at: at,
        started_at: times.started_at,
        ended_at: times.ended_at,
      });
      return { row: this.getTask(id)!, created: true };
    });
  }

  getTask(id: string): TaskRow | undefined {
    return this.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  }

  getTaskByRequestId(requestId: string): TaskRow | undefined {
    return this.get<TaskRow>('SELECT * FROM tasks WHERE request_id = ?', requestId);
  }

  requireTask(id: string): TaskRow {
    const row = this.getTask(id);
    if (!row) throw notFound(`no task ${id}`);
    return row;
  }

  listTasks(filter: TaskFilter = {}): TaskRow[] {
    const w = where([
      ['project_id = ?', filter.project_id],
      ['parent_task_id = ?', filter.parent_task_id],
      ['kind = ?', filter.kind],
      ['state', filter.states],
    ]);
    return this.all<TaskRow>(`SELECT * FROM tasks${w.sql} ORDER BY created_at, id`, ...w.params);
  }

  updateTask(id: string, patch: TaskPatch): TaskRow {
    return this.tx(() => {
      this.requireTask(id);
      const fields = this.pick(patch, TASK_PATCH_KEYS);
      if (fields.visible !== undefined) fields.visible = fields.visible ? 1 : 0;
      this.update('tasks', 'id', id, fields);
      return this.getTask(id)!;
    });
  }

  setTaskState(id: string, state: TaskState, reason: string, patch?: TaskPatch): TaskRow {
    checkOneOf('task state', state, TASK_STATES);
    const stateReason = checkReason(reason);
    return this.tx(() => {
      const current = this.requireTask(id);
      const fields = this.pick(patch, TASK_PATCH_KEYS);
      if (fields.visible !== undefined) fields.visible = fields.visible ? 1 : 0;
      this.update('tasks', 'id', id, {
        ...fields,
        state,
        state_reason: stateReason,
        ...impliedTimes('tasks', state, current, nowIso()),
      });
      return this.getTask(id)!;
    });
  }

  // ---- steps ------------------------------------------------------------------------------------------------

  /** Creates a step. (task_id, ordinal) is the key: an identical repeat returns the row, a different one exits 4. */
  createStep(input: NewStep): Created<StepRow> {
    const state = checkOneOf('step state', input.state ?? 'pending', STEP_STATES);
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) throw refused('a step ordinal is an integer from 1');
    if (input.duty.trim() === '') throw refused('a step needs a duty');
    const columns = ['duty', 'instructions', 'when_rule', 'on_fail_json'];
    const values: Record<string, Param> = {
      duty: input.duty,
      instructions: input.instructions ?? '',
      when_rule: input.when_rule ?? 'always',
      on_fail_json: input.on_fail_json ?? null,
    };
    return this.tx(() => {
      const existing = this.getStepByOrdinal(input.task_id, input.ordinal);
      if (existing) {
        this.assertSameInput('step', `step ${input.ordinal} of task ${input.task_id}`, { ...existing }, values, columns);
        return { row: existing, created: false };
      }
      this.requireTask(input.task_id);
      const times = impliedTimes('steps', state, undefined, nowIso());
      const id = this.insertWithId('step', 'steps', {
        task_id: input.task_id,
        ordinal: input.ordinal,
        ...values,
        state,
        state_reason: checkReason(input.state_reason ?? 'created'),
        started_at: times.started_at,
        ended_at: times.ended_at,
      });
      return { row: this.getStep(id)!, created: true };
    });
  }

  getStep(id: string): StepRow | undefined {
    return this.get<StepRow>('SELECT * FROM steps WHERE id = ?', id);
  }

  getStepByOrdinal(taskId: string, ordinal: number): StepRow | undefined {
    return this.get<StepRow>('SELECT * FROM steps WHERE task_id = ? AND ordinal = ?', taskId, ordinal);
  }

  requireStep(id: string): StepRow {
    const row = this.getStep(id);
    if (!row) throw notFound(`no step ${id}`);
    return row;
  }

  listSteps(taskId: string): StepRow[] {
    return this.all<StepRow>('SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal', taskId);
  }

  updateStep(id: string, patch: StepPatch): StepRow {
    return this.tx(() => {
      this.requireStep(id);
      this.update('steps', 'id', id, this.pick(patch, STEP_PATCH_KEYS));
      return this.getStep(id)!;
    });
  }

  /** attempts + 1; returns the new count. */
  incrementStepAttempts(id: string): number {
    return this.tx(() => {
      this.requireStep(id);
      this.run('UPDATE steps SET attempts = attempts + 1 WHERE id = ?', id);
      return this.getStep(id)!.attempts;
    });
  }

  setStepState(id: string, state: StepState, reason: string, patch?: StepPatch): StepRow {
    checkOneOf('step state', state, STEP_STATES);
    const stateReason = checkReason(reason);
    return this.tx(() => {
      const current = this.requireStep(id);
      this.update('steps', 'id', id, {
        ...this.pick(patch, STEP_PATCH_KEYS),
        state,
        state_reason: stateReason,
        ...impliedTimes('steps', state, current, nowIso()),
      });
      return this.getStep(id)!;
    });
  }

  // ---- sessions ---------------------------------------------------------------------------------------------

  createSession(input: NewSession): Created<SessionRow> {
    checkOneOf('session kind', input.kind, SESSION_KINDS);
    checkOneOf('runtime', input.runtime, RUNTIMES);
    const state = checkOneOf('session state', input.state ?? 'queued', SESSION_STATES);
    if (input.request_id.trim() === '') throw refused('a session needs a request id');
    const columns = ['project_id', 'task_id', 'step_id', 'kind', 'runtime', 'provider', 'model', 'effort', 'cwd'];
    if (input.native_session_id !== undefined) columns.push('native_session_id');
    const values: Record<string, Param> = {
      project_id: input.project_id,
      task_id: input.task_id ?? null,
      step_id: input.step_id ?? null,
      kind: input.kind,
      runtime: input.runtime,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      native_session_id: input.native_session_id ?? null,
    };
    return this.tx(() => {
      const existing = this.getSessionByRequestId(input.request_id);
      if (existing) {
        this.assertSameInput('session', `request id ${input.request_id}`, { ...existing }, values, columns);
        return { row: existing, created: false };
      }
      if (!this.getProject(input.project_id)) throw notFound(`no project ${input.project_id}`);
      if (input.task_id && !this.getTask(input.task_id)) throw notFound(`no task ${input.task_id}`);
      if (input.step_id && !this.getStep(input.step_id)) throw notFound(`no step ${input.step_id}`);
      const times = impliedTimes('sessions', state, undefined, nowIso());
      const id = this.insertWithId('session', 'sessions', {
        ...values,
        request_id: input.request_id,
        state,
        state_reason: checkReason(input.state_reason ?? 'created'),
        started_at: times.started_at,
        ended_at: times.ended_at,
      });
      return { row: this.getSession(id)!, created: true };
    });
  }

  getSession(id: string): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  }

  getSessionByRequestId(requestId: string): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE request_id = ?', requestId);
  }

  requireSession(id: string): SessionRow {
    const row = this.getSession(id);
    if (!row) throw notFound(`no session ${id}`);
    return row;
  }

  listSessions(filter: SessionFilter = {}): SessionRow[] {
    const w = where([
      ['project_id = ?', filter.project_id],
      ['task_id = ?', filter.task_id],
      ['step_id = ?', filter.step_id],
      ['kind = ?', filter.kind],
      ['runtime = ?', filter.runtime],
      ['native_session_id = ?', filter.native_session_id],
      ['state', filter.states],
    ]);
    return this.all<SessionRow>(`SELECT * FROM sessions${w.sql} ORDER BY rowid`, ...w.params);
  }

  updateSession(id: string, patch: SessionPatch): SessionRow {
    return this.tx(() => {
      this.requireSession(id);
      this.update('sessions', 'id', id, this.pick(patch, SESSION_PATCH_KEYS));
      return this.getSession(id)!;
    });
  }

  setSessionState(id: string, state: SessionState, reason: string, patch?: SessionPatch): SessionRow {
    checkOneOf('session state', state, SESSION_STATES);
    const stateReason = checkReason(reason);
    return this.tx(() => {
      const current = this.requireSession(id);
      this.update('sessions', 'id', id, {
        ...this.pick(patch, SESSION_PATCH_KEYS),
        state,
        state_reason: stateReason,
        ...impliedTimes('sessions', state, current, nowIso()),
      });
      return this.getSession(id)!;
    });
  }

  /** Adds token counts and cost to a session's totals. */
  addSessionUsage(id: string, delta: UsageDelta): SessionRow {
    return this.tx(() => {
      this.requireSession(id);
      this.run(
        `UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
           cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
           cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE coalesce(cost_usd, 0) + ? END
         WHERE id = ?`,
        delta.input_tokens ?? 0,
        delta.output_tokens ?? 0,
        delta.cache_read_tokens ?? 0,
        delta.cache_write_tokens ?? 0,
        delta.cost_usd ?? null,
        delta.cost_usd ?? null,
        id,
      );
      return this.getSession(id)!;
    });
  }

  // ---- events -----------------------------------------------------------------------------------------------

  /**
   * Appends one event: assigns the next seq of the session in the same transaction, stores payload as JSON and
   * sets the session's last_event_at. Callers redact and trim the payload first (recordEvent does).
   */
  appendEvent(sessionId: string, kind: EventKind, payload: unknown, at: string = nowIso()): EventRow {
    checkOneOf('event kind', kind, EVENT_KINDS);
    const json = JSON.stringify(payload ?? {});
    return this.tx(() => {
      this.requireSession(sessionId);
      const seq =
        (this.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM events WHERE session_id = ?', sessionId)?.seq ??
          0) + 1;
      const r = this.run(
        'INSERT INTO events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)',
        sessionId,
        seq,
        at,
        kind,
        json,
      );
      this.run('UPDATE sessions SET last_event_at = ? WHERE id = ?', at, sessionId);
      return this.get<EventRow>('SELECT * FROM events WHERE id = ?', r.lastInsertRowid)!;
    });
  }

  /** Events of a session with seq > afterSeq, oldest first. */
  listEvents(sessionId: string, options: { afterSeq?: number; limit?: number } = {}): EventRow[] {
    const limit = options.limit ?? -1;
    return this.all<EventRow>(
      'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      sessionId,
      options.afterSeq ?? 0,
      limit,
    );
  }

  lastEvent(sessionId: string, kind?: EventKind): EventRow | undefined {
    if (kind) {
      return this.get<EventRow>(
        'SELECT * FROM events WHERE session_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1',
        sessionId,
        kind,
      );
    }
    return this.get<EventRow>('SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1', sessionId);
  }

  // ---- reports ----------------------------------------------------------------------------------------------

  /** One report per session: an identical repeat returns the row, a different one exits 4. */
  createReport(input: NewReport): Created<ReportRow> {
    checkOneOf('report status', input.status, REPORT_STATUSES);
    if (charLength(input.summary) > 4000) throw refused('the report summary is longer than 4000 characters');
    const columns = [
      'step_id',
      'task_id',
      'status',
      'summary',
      'question',
      'options_json',
      'tests_json',
      'changed_files_json',
      'screenshots_json',
      'limitations',
      'owner_commands_json',
    ];
    const values: Record<string, Param> = {
      step_id: input.step_id ?? null,
      task_id: input.task_id ?? null,
      status: input.status,
      summary: input.summary,
      question: input.question ?? null,
      options_json: input.options_json ?? null,
      tests_json: input.tests_json ?? null,
      changed_files_json: input.changed_files_json ?? '[]',
      screenshots_json: input.screenshots_json ?? '[]',
      limitations: input.limitations ?? null,
      owner_commands_json: input.owner_commands_json ?? null,
    };
    return this.tx(() => {
      const existing = this.getReportBySession(input.session_id);
      if (existing) {
        this.assertSameInput('report', `session ${input.session_id}`, { ...existing }, values, columns);
        return { row: existing, created: false };
      }
      this.requireSession(input.session_id);
      const id = this.insertWithId('report', 'reports', {
        session_id: input.session_id,
        ...values,
        created_at: nowIso(),
      });
      return { row: this.getReport(id)!, created: true };
    });
  }

  getReport(id: string): ReportRow | undefined {
    return this.get<ReportRow>('SELECT * FROM reports WHERE id = ?', id);
  }

  getReportBySession(sessionId: string): ReportRow | undefined {
    return this.get<ReportRow>('SELECT * FROM reports WHERE session_id = ?', sessionId);
  }

  listReports(filter: ReportFilter = {}): ReportRow[] {
    const w = where([
      ['task_id = ?', filter.task_id],
      ['step_id = ?', filter.step_id],
    ]);
    return this.all<ReportRow>(`SELECT * FROM reports${w.sql} ORDER BY created_at, rowid`, ...w.params);
  }

  // ---- decisions --------------------------------------------------------------------------------------------

  createDecision(input: NewDecision): DecisionRow {
    checkOneOf('decision kind', input.kind, DECISION_KINDS);
    if (input.override_mode != null) checkOneOf('override mode', input.override_mode, OVERRIDE_MODES);
    return this.tx(() => {
      const id = this.insertWithId('decision', 'decisions', {
        kind: input.kind,
        project_id: input.project_id,
        task_id: input.task_id ?? null,
        step_id: input.step_id ?? null,
        session_id: input.session_id ?? null,
        skill_name: input.skill_name,
        skill_hash: input.skill_hash,
        jev_model: input.jev_model,
        state_json: input.state_json,
        questions_json: input.questions_json,
        answers_json: input.answers_json,
        chosen_json: input.chosen_json,
        override_json: input.override_json ?? null,
        override_mode: input.override_mode ?? null,
        outcome_json: input.outcome_json ?? null,
        latency_ms: Math.round(input.latency_ms),
        usage_json: input.usage_json,
        created_at: nowIso(),
      });
      return this.getDecision(id)!;
    });
  }

  getDecision(id: string): DecisionRow | undefined {
    return this.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id);
  }

  requireDecision(id: string): DecisionRow {
    const row = this.getDecision(id);
    if (!row) throw notFound(`no decision ${id}`);
    return row;
  }

  listDecisions(filter: DecisionFilter = {}): DecisionRow[] {
    const w = where([
      ['kind = ?', filter.kind],
      ['project_id = ?', filter.project_id],
      ['task_id = ?', filter.task_id],
      ['step_id = ?', filter.step_id],
      ['session_id = ?', filter.session_id],
      ['created_at >= ?', filter.since],
    ]);
    return this.all<DecisionRow>(`SELECT * FROM decisions${w.sql} ORDER BY created_at, rowid`, ...w.params);
  }

  /** The newest decision matching the filter. */
  latestDecision(filter: DecisionFilter = {}): DecisionRow | undefined {
    const w = where([
      ['kind = ?', filter.kind],
      ['project_id = ?', filter.project_id],
      ['task_id = ?', filter.task_id],
      ['step_id = ?', filter.step_id],
      ['session_id = ?', filter.session_id],
      ['created_at >= ?', filter.since],
    ]);
    return this.get<DecisionRow>(
      `SELECT * FROM decisions${w.sql} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ...w.params,
    );
  }

  /** Links, override and outcome are the only columns of a decision that change after it is written. */
  updateDecision(id: string, patch: DecisionPatch): DecisionRow {
    if (patch.override_mode != null) checkOneOf('override mode', patch.override_mode, OVERRIDE_MODES);
    return this.tx(() => {
      this.requireDecision(id);
      this.update('decisions', 'id', id, this.pick(patch, DECISION_PATCH_KEYS));
      return this.getDecision(id)!;
    });
  }

  // ---- landings ---------------------------------------------------------------------------------------------

  createLanding(input: NewLanding): LandingRow {
    checkOneOf('landing route', input.route, LANDING_ROUTES);
    const state = checkOneOf('landing state', input.state ?? 'pending', LANDING_STATES);
    return this.tx(() => {
      this.requireTask(input.task_id);
      if (input.decision_id) this.requireDecision(input.decision_id);
      const at = nowIso();
      const id = this.insertWithId('landing', 'landings', {
        task_id: input.task_id,
        decision_id: input.decision_id ?? null,
        route: input.route,
        state,
        checks_json: input.checks_json ?? '[]',
        commit_sha: input.commit_sha ?? null,
        reason: checkReason(input.reason ?? 'created'),
        created_at: at,
        ended_at: impliedTimes('landings', state, undefined, at).ended_at,
      });
      return this.getLanding(id)!;
    });
  }

  getLanding(id: string): LandingRow | undefined {
    return this.get<LandingRow>('SELECT * FROM landings WHERE id = ?', id);
  }

  requireLanding(id: string): LandingRow {
    const row = this.getLanding(id);
    if (!row) throw notFound(`no landing ${id}`);
    return row;
  }

  listLandings(filter: LandingFilter = {}): LandingRow[] {
    const w = where([
      ['task_id = ?', filter.task_id],
      ['state', filter.states],
    ]);
    return this.all<LandingRow>(`SELECT * FROM landings${w.sql} ORDER BY created_at, rowid`, ...w.params);
  }

  /** Landings keep their state reason in the `reason` column. */
  setLandingState(id: string, state: LandingState, reason: string, patch?: LandingPatch): LandingRow {
    checkOneOf('landing state', state, LANDING_STATES);
    if (patch?.route !== undefined) checkOneOf('landing route', patch.route, LANDING_ROUTES);
    const stateReason = checkReason(reason);
    return this.tx(() => {
      const current = this.requireLanding(id);
      this.update('landings', 'id', id, {
        ...this.pick(patch, LANDING_PATCH_KEYS),
        state,
        reason: stateReason,
        ...impliedTimes('landings', state, current, nowIso()),
      });
      return this.getLanding(id)!;
    });
  }

  // ---- messages ---------------------------------------------------------------------------------------------

  createMessage(input: NewMessage): MessageRow {
    checkOneOf('message direction', input.direction, MESSAGE_DIRECTIONS);
    return this.tx(() => {
      this.requireTask(input.task_id);
      const id = this.insertWithId('message', 'messages', {
        task_id: input.task_id,
        session_id: input.session_id ?? null,
        direction: input.direction,
        text: input.text,
        created_at: nowIso(),
        delivered_at: null,
      });
      return this.getMessage(id)!;
    });
  }

  getMessage(id: string): MessageRow | undefined {
    return this.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  }

  listMessages(filter: MessageFilter = {}): MessageRow[] {
    const w = where([
      ['task_id = ?', filter.task_id],
      ['session_id = ?', filter.session_id],
      ['direction = ?', filter.direction],
    ]);
    const undelivered = filter.undelivered ? `${w.sql ? ' AND' : ' WHERE'} delivered_at IS NULL` : '';
    return this.all<MessageRow>(
      `SELECT * FROM messages${w.sql}${undelivered} ORDER BY created_at, rowid`,
      ...w.params,
    );
  }

  /** Marks a message delivered (to `sessionId` when given). Delivering twice keeps the first time. */
  markMessageDelivered(id: string, sessionId?: string): MessageRow {
    return this.tx(() => {
      const current = this.getMessage(id);
      if (!current) throw notFound(`no message ${id}`);
      this.run(
        'UPDATE messages SET delivered_at = coalesce(delivered_at, ?), session_id = coalesce(?, session_id) WHERE id = ?',
        nowIso(),
        sessionId ?? null,
        id,
      );
      return this.getMessage(id)!;
    });
  }

  // ---- provider usage ---------------------------------------------------------------------------------------

  recordProviderUsage(input: NewProviderUsage): ProviderUsageRow {
    checkOneOf('usage source', input.source, USAGE_SOURCES);
    return this.tx(() => {
      let observed = input.observed_at ?? nowIso();
      for (let attempt = 1; ; attempt++) {
        const r = this.run(
          `INSERT INTO provider_usage (provider, observed_at, source, five_hour_pct, weekly_pct, five_hour_resets_at,
             weekly_resets_at, local_week, local_input_tokens, local_output_tokens, local_cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, observed_at) DO NOTHING`,
          input.provider,
          observed,
          input.source,
          input.five_hour_pct ?? null,
          input.weekly_pct ?? null,
          input.five_hour_resets_at ?? null,
          input.weekly_resets_at ?? null,
          input.local_week ?? null,
          input.local_input_tokens ?? null,
          input.local_output_tokens ?? null,
          input.local_cost_usd ?? null,
        );
        if (r.changes === 1 || attempt >= 50) break;
        observed = new Date(Date.parse(observed) + 1).toISOString();
      }
      return this.get<ProviderUsageRow>(
        'SELECT * FROM provider_usage WHERE provider = ? AND observed_at = ?',
        input.provider,
        observed,
      )!;
    });
  }

  listProviderUsage(filter: ProviderUsageFilter = {}): ProviderUsageRow[] {
    const w = where([
      ['provider = ?', filter.provider],
      ['source = ?', filter.source],
      ['observed_at >= ?', filter.since],
    ]);
    return this.all<ProviderUsageRow>(
      `SELECT * FROM provider_usage${w.sql} ORDER BY observed_at, provider`,
      ...w.params,
    );
  }

  /** The newest usage row of a provider, optionally of one source. */
  latestProviderUsage(provider: string, source?: UsageSource): ProviderUsageRow | undefined {
    const w = where([
      ['provider = ?', provider],
      ['source = ?', source],
    ]);
    return this.get<ProviderUsageRow>(
      `SELECT * FROM provider_usage${w.sql} ORDER BY observed_at DESC LIMIT 1`,
      ...w.params,
    );
  }
}

/** Opens the store (default ~/.jv/store.sqlite), creating and migrating it when needed. */
export function openStore(options: OpenStoreOptions = {}): Store {
  return Store.open(options);
}

/** Opens the store, runs fn, closes the store. */
export async function withStore<T>(fn: (store: Store) => T | Promise<T>, options: OpenStoreOptions = {}): Promise<T> {
  const store = Store.open(options);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * meta.schema_version of an existing store file, read only (no file is created, nothing migrates).
 * undefined when the file does not exist or holds no version.
 */
export function readStoreSchemaVersion(file: string = paths.store): string | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value?: unknown }
      | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
