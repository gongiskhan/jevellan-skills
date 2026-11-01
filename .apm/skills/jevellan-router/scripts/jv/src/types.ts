// Row interfaces of the store (section 4). Property names are the SQL column names, exactly; JSON columns are
// strings (the *_json suffix) and are parsed by the code that reads them. INTEGER booleans are 0 or 1.

export const TASK_KINDS = ['feature', 'bug', 'automation', 'single'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATES = ['queued', 'running', 'waiting-owner', 'landing', 'done', 'failed', 'stopped'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const STEP_STATES = ['pending', 'running', 'retrying', 'done', 'failed', 'skipped'] as const;
export type StepState = (typeof STEP_STATES)[number];

export const SESSION_KINDS = ['step', 'coordinator', 'probe'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const RUNTIMES = ['claude-sdk', 'claude-tmux', 'codex', 'llm'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const SESSION_STATES = ['queued', 'starting', 'running', 'waiting', 'done', 'failed', 'lost', 'stopped'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const EVENT_KINDS = [
  'start',
  'text',
  'thinking',
  'tool-call',
  'tool-result',
  'report',
  'error',
  'message',
  'usage',
  'rate-limit',
  'end',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const REPORT_STATUSES = ['progress', 'done', 'blocked', 'needs-decision'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const DECISION_KINDS = ['placement', 'landing', 'workflow'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const OVERRIDE_MODES = ['undo', 'keep'] as const;
export type OverrideMode = (typeof OVERRIDE_MODES)[number];

export const LANDING_ROUTES = ['land', 'verify-then-land', 'ask-owner'] as const;
export type LandingRoute = (typeof LANDING_ROUTES)[number];

export const LANDING_STATES = ['pending', 'checking', 'landing', 'landed', 'asked', 'failed'] as const;
export type LandingState = (typeof LANDING_STATES)[number];

export const MESSAGE_DIRECTIONS = ['owner', 'coordinator', 'answer'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const USAGE_SOURCES = ['probe', 'stream', 'local'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  default_branch: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  after_task_id: string | null;
  request_id: string;
  kind: TaskKind;
  title: string;
  task_text: string;
  workflow_json: string;
  state: TaskState;
  state_reason: string;
  current_step: number;
  branch: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  landed_commit: string | null;
  visible: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface StepRow {
  id: string;
  task_id: string;
  ordinal: number;
  duty: string;
  instructions: string;
  when_rule: string;
  on_fail_json: string | null;
  state: StepState;
  state_reason: string;
  attempts: number;
  started_at: string | null;
  ended_at: string | null;
}

export interface SessionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  step_id: string | null;
  request_id: string;
  kind: SessionKind;
  runtime: Runtime;
  provider: string;
  model: string;
  effort: string;
  cwd: string;
  native_session_id: string | null;
  pid: number | null;
  pgid: number | null;
  tmux_target: string | null;
  state: SessionState;
  state_reason: string;
  started_at: string | null;
  ended_at: string | null;
  last_event_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
}

export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  at: string;
  kind: EventKind;
  payload: string;
}

export interface ReportRow {
  id: string;
  session_id: string;
  step_id: string | null;
  task_id: string | null;
  status: ReportStatus;
  summary: string;
  question: string | null;
  options_json: string | null;
  tests_json: string | null;
  changed_files_json: string;
  screenshots_json: string;
  limitations: string | null;
  owner_commands_json: string | null;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  kind: DecisionKind;
  project_id: string;
  task_id: string | null;
  step_id: string | null;
  session_id: string | null;
  skill_name: string;
  skill_hash: string;
  jev_model: string;
  state_json: string;
  questions_json: string;
  answers_json: string;
  chosen_json: string;
  override_json: string | null;
  override_mode: OverrideMode | null;
  outcome_json: string | null;
  latency_ms: number;
  usage_json: string;
  created_at: string;
}

export interface LandingRow {
  id: string;
  task_id: string;
  decision_id: string | null;
  route: LandingRoute;
  state: LandingState;
  checks_json: string;
  commit_sha: string | null;
  reason: string;
  created_at: string;
  ended_at: string | null;
}

export interface MessageRow {
  id: string;
  task_id: string;
  session_id: string | null;
  direction: MessageDirection;
  text: string;
  created_at: string;
  delivered_at: string | null;
}

export interface ProviderUsageRow {
  provider: string;
  observed_at: string;
  source: UsageSource;
  five_hour_pct: number | null;
  weekly_pct: number | null;
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
  local_week: string | null;
  local_input_tokens: number | null;
  local_output_tokens: number | null;
  local_cost_usd: number | null;
}

export interface MetaRow {
  key: string;
  value: string;
}

/** Every table of the store and its row type. */
export interface Tables {
  projects: ProjectRow;
  tasks: TaskRow;
  steps: StepRow;
  sessions: SessionRow;
  events: EventRow;
  reports: ReportRow;
  decisions: DecisionRow;
  landings: LandingRow;
  messages: MessageRow;
  provider_usage: ProviderUsageRow;
  meta: MetaRow;
}

export type TableName = keyof Tables;
