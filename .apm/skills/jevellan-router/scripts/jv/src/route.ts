// The router (sections 7.2, 7.3, 7.5, 7.6): the only code path that chooses a runtime, provider, model and effort.
//
// Placement of a step, in the order of section 7.2:
//   1. load the router policy (~/.jv/skills/jevellan-router/SKILL.md), parse its sections, hash its body;
//   2. build the menu: providers that are enabled, logged in (meta provider_auth ready), under their ceiling and whose
//      kind can run the duty's runtimes (rankProviders, ported eligibility), one entry per model id named by its
//      best-ranked provider; efforts are the union of the models' efforts, mapped onto the chosen model afterwards;
//   3. build the state JSON, capped at 60 000 characters, task text shortened last;
//   4. ask Jev the model and effort questions in one call, then the provider question in a second call with the same
//      state when the chosen model is served by more than one eligible provider. A question with one option cannot be
//      sent (Jev's contract needs two to 255 options); when no question is left at all, Jev is still reached
//      (GET /v1/models: key, authentication, the configured model listed) before anything is written (D-036);
//   5. resolve (highest probability, ties to Jev's choice), apply the owner's rules.json (min/max effort), map the
//      effort onto the model's efforts, write the decisions row and return {runtime, provider, model, effort}.
//
// Ported from jevellan main at 8e2788ec: mapEffort (packages/core/src/models.ts), resolveChoice and the menu of
// packages/decisions/src/placement.ts, the provider choice of account-choice.ts (decideAccount: only-option when one
// provider is eligible, else Jev over the eligible ones), and the owner rules of jev-rules.ts (matchingJevRules,
// jevEffortBounds, applyJevEffortRules, applyJevRouteRules). What is not ported: Jevellan's deterministic fallback.
// No Jev, no placement: every Jev failure is exit 2 with the JevError message, and no default model exists here.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { jevClient } from './jev/client.js';
import { JevError, type JevModels, type JevQuestion, type JevQuestions, type JevRequest, type JevResponse } from './jev/contract.js';
import { notFound, refused } from './errors.js';
import { paths } from './paths.js';
import {
  CLAUDE_KINDS,
  currentUsage,
  loadProviderAuth,
  loadProviders,
  rankProviders,
  type Provider,
  type ProviderKind,
  type ProvidersConfig,
  type RankedProvider,
} from './providers.js';
import {
  frontmatterList,
  loadPolicy,
  loadRouterPolicy,
  ROUTER_POLICY,
  type Policy,
  type RouterPolicy,
} from './policy.js';
import type { Store } from './store.js';
import {
  LANDING_ROUTES,
  TASK_KINDS,
  type DecisionKind,
  type DecisionRow,
  type LandingRoute,
  type OverrideMode,
  type ProjectRow,
  type ProviderUsageRow,
  type Runtime,
  type StepRow,
  type TaskRow,
} from './types.js';

// ---- efforts (ported mapEffort) ------------------------------------------------------------------------------

/** Effort levels in order (Jevellan's EffortSchema). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

function effortIndex(e: Effort): number {
  return EFFORTS.indexOf(e);
}

/** The lowest supported effort at or above the requested one, else the highest supported (ported as it is). */
export function mapEffort(requested: Effort, supported: readonly string[]): Effort {
  if (!supported.length) throw refused('This model has no supported effort levels.');
  const unknown = supported.filter((e) => !isEffort(e));
  if (unknown.length) throw refused(`unknown effort ${unknown.join(', ')} (jv knows ${EFFORTS.join(', ')})`);
  const available = [...new Set(supported as Effort[])].sort((a, b) => effortIndex(a) - effortIndex(b));
  const target = effortIndex(requested);
  return available.find((e) => effortIndex(e) >= target) ?? available.at(-1)!;
}

// ---- duties and runtimes (section 7.3) ---------------------------------------------------------------------

/** Duties that always run on llm, whatever their needs (section 7.2 step 5). */
export const LLM_DUTIES: readonly string[] = ['answer', 'converse'];
export const KNOWN_NEEDS: readonly string[] = ['repo-read', 'repo-write', 'shell', 'browser'];
/** Runtimes of a duty that needs the repository, a shell or a browser. */
export const AGENT_RUNTIMES: readonly Runtime[] = ['claude-sdk', 'claude-tmux', 'codex'];

/** The runtimes a duty may run on: llm for answer, converse and duties with no needs, else the agent runtimes. */
export function dutyRuntimes(duty: string, needs: readonly string[]): Runtime[] {
  const unknown = needs.filter((n) => !KNOWN_NEEDS.includes(n));
  if (unknown.length) throw refused(`duty ${duty} declares unknown jv-needs: ${unknown.join(', ')} (known: ${KNOWN_NEEDS.join(', ')})`);
  if (LLM_DUTIES.includes(duty) || needs.length === 0) return ['llm'];
  return [...AGENT_RUNTIMES];
}

/** The jv-needs of a duty, from ~/.jv/skills/jevellan-duty-<duty>/SKILL.md. Exit 2 when the skill or the key is missing. */
export function loadDutyNeeds(duty: string, file: string = paths.skillFile(`jevellan-duty-${duty}`)): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw refused(`no duty ${duty}: ${file} is not installed; run jv update`);
  }
  const needs = frontmatterList(text, 'jv-needs');
  if (needs === undefined) throw refused(`the duty skill ${file} declares no jv-needs`);
  return needs;
}

/**
 * Provider kinds that can run any of the runtimes. llm runs on openai-compatible providers (chat/completions) and on
 * Claude kinds (one claude-sdk turn with no tools, section 6.5); the agent runtimes on Claude kinds and Codex.
 */
export function kindsForRuntimes(runtimes: readonly Runtime[]): ProviderKind[] {
  const kinds = new Set<ProviderKind>();
  for (const r of runtimes) {
    if (r === 'claude-sdk' || r === 'claude-tmux') CLAUDE_KINDS.forEach((k) => kinds.add(k));
    if (r === 'codex') kinds.add('codex-subscription');
    if (r === 'llm') {
      CLAUDE_KINDS.forEach((k) => kinds.add(k));
      kinds.add('openai-compatible');
    }
  }
  return [...kinds];
}

/**
 * The runtime a placement implies (section 7.2 step 5): llm when the duty runs on llm only; else claude-tmux when
 * visible and claude-sdk otherwise for Claude kinds, codex for Codex, llm for openai-compatible.
 */
export function impliedRuntime(kind: ProviderKind, runtimes: readonly Runtime[], visible: boolean): Runtime {
  if (runtimes.length === 1 && runtimes[0] === 'llm') return 'llm';
  if (CLAUDE_KINDS.includes(kind)) return visible ? 'claude-tmux' : 'claude-sdk';
  if (kind === 'codex-subscription') return 'codex';
  return 'llm';
}

// ---- the menu ------------------------------------------------------------------------------------------------

export interface MenuModel {
  id: string;
  label: string;
  /** The best-ranked eligible provider serving it. */
  provider: string;
  runtime: Runtime;
  efforts: string[];
  description: string;
}

export interface MenuProvider {
  name: string;
  weeklyPct: number | null;
  fiveHourPct: number | null;
  ceilingPct: number;
  observedAt: string | null;
}

export interface Menu {
  models: MenuModel[];
  providers: MenuProvider[];
  /** Union of the menu models' efforts, in effort order. */
  efforts: Effort[];
  /** Every provider with its eligibility (excluded ones keep their reason). */
  ranking: RankedProvider[];
  /** Model id to the eligible providers serving it, best first. */
  servedBy: Map<string, string[]>;
}

export interface MenuInput {
  providers: ProvidersConfig;
  /** Newest usage row per provider (any order; the newest per provider is used). */
  usage: readonly ProviderUsageRow[];
  auth: Readonly<Record<string, 'ready' | 'needs-login' | 'unknown'>>;
  runtimes: readonly Runtime[];
  visible: boolean;
  descriptions: ReadonlyMap<string, string>;
  keyReady?: (p: Provider) => boolean;
  now?: number;
}

/** Builds the menu of section 7.2 step 2. Exit 2 when it is empty or a menu model has no description line. */
export function buildMenu(input: MenuInput): Menu {
  const now = input.now ?? Date.now();
  const ranking = rankProviders({
    providers: input.providers.providers,
    usage: input.usage,
    kinds: kindsForRuntimes(input.runtimes),
    auth: input.auth,
    ...(input.keyReady ? { keyReady: input.keyReady } : {}),
    now,
  });
  const eligible = ranking.filter((r) => r.eligible);
  if (!eligible.length) {
    const why = ranking.map((r) => `${r.provider.name} ${r.reason}`).join(', ');
    throw refused(`no provider can run this step (${input.runtimes.join(', ')}): ${why}`);
  }
  const models: MenuModel[] = [];
  const servedBy = new Map<string, string[]>();
  const missing: string[] = [];
  for (const r of eligible) {
    for (const m of r.provider.models) {
      const unknown = m.efforts.filter((e) => !isEffort(e));
      if (unknown.length) {
        throw refused(`${input.providers.file}: ${r.provider.name} model ${m.id} lists unknown effort ${unknown.join(', ')} (jv knows ${EFFORTS.join(', ')})`);
      }
      const list = servedBy.get(m.id);
      if (list) {
        list.push(r.provider.name);
        continue;
      }
      servedBy.set(m.id, [r.provider.name]);
      const description = input.descriptions.get(m.id);
      if (description === undefined) missing.push(m.id);
      models.push({
        id: m.id,
        label: m.label,
        provider: r.provider.name,
        runtime: impliedRuntime(r.provider.kind, input.runtimes, input.visible),
        efforts: [...m.efforts],
        description: description ?? '',
      });
    }
  }
  if (missing.length) {
    throw refused(`the router policy has no line in "## model descriptions" for ${missing.join(', ')}; add "<model id>: <text>" lines (jv doctor lists them)`);
  }
  const offered = new Set(models.flatMap((m) => m.efforts));
  const providers: MenuProvider[] = eligible.map((r) => {
    const u = currentUsage(r.usage, now);
    return {
      name: r.provider.name,
      weeklyPct: u.weeklyPct ?? null,
      fiveHourPct: u.fiveHourPct ?? null,
      ceilingPct: r.provider.ceilingPct,
      observedAt: r.usage?.observed_at ?? null,
    };
  });
  return { models, providers, efforts: EFFORTS.filter((e) => offered.has(e)), ranking, servedBy };
}

// ---- state (section 7.2 step 3) --------------------------------------------------------------------------------

export const STATE_LIMIT = 60_000;
export const TASK_SHORTENED = '[Task shortened.]';
export const PREVIOUS_SUMMARY_CHARS = 600;
export const HISTORY_LIMIT = 10;

export interface StateProject {
  name: string;
  guidance: string;
}
export interface StateTask {
  id: string;
  kind: string;
  title: string;
  text: string;
  parent: string | null;
  visible: boolean;
}
export interface StatePrevious {
  duty: string;
  status: string;
  summary: string;
}
export interface StateHistoryEntry {
  duty: string;
  model: string;
  effort: string;
  outcome: string;
  attempts: number | null;
}

export interface PlacementState {
  project: StateProject;
  task: StateTask;
  step: {
    ordinal: number;
    duty: string;
    instructions: string;
    attempt: number;
    previous: StatePrevious[];
    /** Present on a retry (section 7.6): the failure that sent the task back to this step. */
    failure?: string;
  };
  duty: { needs: string[]; runtimes: Runtime[] };
  menu: {
    models: Array<Omit<MenuModel, never>>;
    providers: MenuProvider[];
  };
  history: { recent: StateHistoryEntry[] };
  rules: string;
}

/** The workflow questions' state (section 7.5): the task, no step. */
export interface WorkflowState {
  project: StateProject;
  task: StateTask;
  rules: string;
}

type AnyState = PlacementState | WorkflowState;

/**
 * The state as JSON of at most `limit` characters. Shrinks, in order: history entries (oldest first), earlier-step
 * summaries (oldest first), then the task text, cut with the marker "[Task shortened.]". Still too large is JevError
 * state-too-large (exit 2).
 */
export function stateJson<T extends AnyState>(state: T, limit: number = STATE_LIMIT): string {
  const s = structuredClone(state) as AnyState;
  const text = () => JSON.stringify(s);
  if (text().length <= limit) return text();
  if ('history' in s) while (text().length > limit && s.history.recent.length) s.history.recent.shift();
  if ('step' in s) while (text().length > limit && s.step.previous.length) s.step.previous.shift();
  if (text().length <= limit) return text();
  const full = s.task.text;
  const withCut = (n: number) => {
    let end = n;
    const code = full.charCodeAt(end - 1);
    if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--; // never split a surrogate pair
    s.task.text = `${full.slice(0, end)}${TASK_SHORTENED}`;
    return text().length;
  };
  if (withCut(0) > limit) throw refused(`Jev: ${new JevError('state-too-large').message}`, { jevError: 'state-too-large' });
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (withCut(mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  withCut(lo);
  return text();
}

// ---- questions and answers ----------------------------------------------------------------------------------------

/** The model question's criterion key of a menu model: "<label> via <provider> (<runtime>)". */
export function modelOptionKey(m: Pick<MenuModel, 'label' | 'provider' | 'runtime'>): string {
  return `${m.label} via ${m.provider} (${m.runtime})`;
}

/** Criterion keys per menu model; keys that would repeat get " [<model id>]" so every option is distinct. */
export function modelOptionKeys(models: readonly MenuModel[]): Map<string, string> {
  const base = models.map((m) => modelOptionKey(m));
  const count = new Map<string, number>();
  for (const k of base) count.set(k, (count.get(k) ?? 0) + 1);
  const out = new Map<string, string>();
  models.forEach((m, i) => out.set(count.get(base[i]!)! > 1 ? `${base[i]} [${m.id}]` : base[i]!, m.id));
  return out;
}

export interface PlacementQuestions {
  questions: JevQuestions;
  /** Model criterion key to model id. */
  modelKeys: Map<string, string>;
}

/**
 * The model and effort questions (section 7.2 step 4). A question with a single option is not asked (Jev's contract
 * refuses a choice with fewer than two options); the caller records it as only-option and, when no question is left,
 * still checks that Jev answers (checkJev) before writing the row (D-036).
 */
export function placementQuestions(policy: RouterPolicy, menu: Menu): PlacementQuestions {
  const modelKeys = modelOptionKeys(menu.models);
  const questions: JevQuestions = {};
  if (menu.models.length > 1) {
    questions.model = {
      type: 'choice',
      instructions: policy.modelInstructions,
      criteria: Object.fromEntries([...modelKeys].map(([key, id]) => [key, menu.models.find((m) => m.id === id)!.description])),
    };
  }
  const missing = menu.efforts.filter((e) => !policy.effortGuide.has(e));
  if (missing.length) {
    throw refused(`the router policy has no line in "## effort guide" for ${missing.join(', ')}`);
  }
  if (menu.efforts.length > 1) {
    questions.effort = {
      type: 'choice',
      instructions: policy.effortInstructions,
      criteria: Object.fromEntries(menu.efforts.map((e) => [e, policy.effortGuide.get(e)!])),
    };
  }
  return { questions, modelKeys };
}

function pctText(value: number | null): string {
  return value === null ? 'unknown' : `${Number(value.toFixed(1))}%`;
}

/** The provider criterion of section 7.2: "<name>: week <pct>% of <ceiling>%, five hours <pct>%" ("unknown" when not known). */
export function providerCriterion(p: MenuProvider): string {
  return `${p.name}: week ${pctText(p.weeklyPct)} of ${p.ceilingPct}%, five hours ${pctText(p.fiveHourPct)}`;
}

/** The provider question; undefined when the model has a single eligible provider. */
export function providerQuestion(menu: Menu, modelId: string, instructions: string = PROVIDER_INSTRUCTIONS): JevQuestion | undefined {
  const names = menu.servedBy.get(modelId) ?? [];
  if (names.length < 2) return undefined;
  return {
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(names.map((n) => [n, providerCriterion(menu.providers.find((p) => p.name === n)!)])),
  };
}

/** Instructions of the provider question, adapted from Jevellan's account question (account-choice.ts). */
export const PROVIDER_INSTRUCTIONS =
  'Choose the provider account for this step. Respect the owner routing rules. Prefer known usage with headroom below the ceiling in both the weekly and the five-hour window. Earlier options have the better resource rank.';

/**
 * The highest-probability option; an exact tie goes to Jev's choice, else to the first tied option in criteria order
 * (ported resolveChoice). Exit 2 (invalid response) when the answer is missing or not a choice.
 */
export function resolveChoice(questions: JevQuestions, response: JevResponse, id: string): { option: string; probabilities: Record<string, number> } {
  const question = questions[id];
  const answer = response.answers[id];
  if (question?.type !== 'choice' || answer?.type !== 'choice') throw jevRefusal(new JevError('invalid-response'));
  const keys = Object.keys(question.criteria);
  const p = (key: string) => answer.probabilities[key] ?? 0;
  const max = Math.max(...keys.map(p));
  return { option: p(answer.choice) === max ? answer.choice : keys.find((key) => p(key) === max)!, probabilities: answer.probabilities };
}

/** A noul answer as a boolean: true when its probability is 0.5 or more. */
export function resolveNoul(response: JevResponse, id: string): { value: boolean; probability: number } {
  const answer = response.answers[id];
  if (answer?.type !== 'noul') throw jevRefusal(new JevError('invalid-response'));
  return { value: answer.noul >= 0.5, probability: answer.noul };
}

// ---- Jev calls (generic, reused by landing) --------------------------------------------------------------------

export interface JevDecider {
  decide(input: JevRequest, signal?: AbortSignal): Promise<JevResponse>;
  models(signal?: AbortSignal): Promise<JevModels>;
}

export interface JevCallRecord {
  questions: string[];
  model: string;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number };
  /** Set on a call that asked no question: the reachability check of a placement with nothing to ask (D-036). */
  check?: 'GET /v1/models';
}

/** One or more Jev calls over the same state and policy: what a decisions row records. */
export interface JevExchange {
  policy: Policy;
  /** The Jev model asked for (providers.json jev.model). */
  jevModel: string;
  state: string;
  questions: JevQuestions;
  answers: JevResponse['answers'];
  calls: JevCallRecord[];
  latencyMs: number;
  /** The last response. */
  response: JevResponse;
}

export interface AskJevOptions {
  providers?: ProvidersConfig;
  client?: JevDecider;
  fetch?: typeof fetch;
  /** The policy already loaded (its name must be the one asked for). */
  policy?: Policy;
  policyFile?: string;
  signal?: AbortSignal;
  /** Continue an exchange: same policy and state, the new questions and answers are added. */
  into?: JevExchange;
}

function jevRefusal(error: JevError): Error {
  return refused(`Jev: ${error.message}`, { jevError: error.kind });
}

function clientFor(options: Pick<AskJevOptions, 'client' | 'fetch'>, providers: ProvidersConfig): JevDecider {
  return options.client ?? jevClient(providers.jev, options.fetch ? { fetch: options.fetch } : {});
}

/**
 * Asks Jev `questions` over `state` with the policy `policyName` (its body hash goes into the decision row). The
 * state is JSON text, or an object serialized here; over 60 000 characters is refused. Every Jev failure is exit 2
 * with the JevError message ("Jev: no key configured"); there is no fallback.
 */
export async function askJev(
  policyName: string,
  state: string | object,
  questions: JevQuestions,
  options: AskJevOptions = {},
): Promise<JevExchange> {
  const providers = options.providers ?? loadProviders();
  const policy =
    options.into?.policy ?? options.policy ?? (options.policyFile ? loadPolicy(policyName, options.policyFile) : loadPolicy(policyName));
  if (policy.name !== policyName) throw refused(`askJev: the policy given is ${policy.name}, not ${policyName}`);
  const stateText = options.into?.state ?? (typeof state === 'string' ? state : JSON.stringify(state));
  if (stateText.length > STATE_LIMIT) throw jevRefusal(new JevError('state-too-large'));
  const client = clientFor(options, providers);
  const started = Date.now();
  let response: JevResponse;
  try {
    response = await client.decide({ schema: 'jev-request-v1', model: providers.jev.model, state: stateText, questions }, options.signal);
  } catch (error) {
    if (error instanceof JevError) throw jevRefusal(error);
    throw error;
  }
  const latencyMs = Date.now() - started;
  const call: JevCallRecord = {
    questions: Object.keys(questions),
    model: response.model,
    latencyMs,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  };
  const prev = options.into;
  return {
    policy,
    jevModel: providers.jev.model,
    state: stateText,
    questions: { ...(prev?.questions ?? {}), ...questions },
    answers: { ...(prev?.answers ?? {}), ...response.answers },
    calls: [...(prev?.calls ?? []), call],
    latencyMs: (prev?.latencyMs ?? 0) + latencyMs,
    response,
  };
}

/**
 * A placement with nothing to ask still needs Jev (section 7.2: "No Jev, no placement"): GET /v1/models proves the
 * key, the authentication and the reachability, and the configured model must be listed. Every failure is exit 2
 * with the JevError message, before anything is written. Returns the call for the decision row's usage.
 */
export async function checkJev(client: JevDecider, providers: ProvidersConfig, signal?: AbortSignal): Promise<JevCallRecord> {
  const started = Date.now();
  let models: JevModels;
  try {
    models = await client.models(signal);
  } catch (error) {
    if (error instanceof JevError) throw jevRefusal(error);
    throw error;
  }
  const names = models.models.map((m) => m.name);
  if (!names.includes(providers.jev.model)) {
    throw refused(`Jev: the configured model ${providers.jev.model} is not listed by GET /v1/models; run jv doctor --check jev`, {
      jevError: 'invalid-request',
    });
  }
  return {
    questions: [],
    model: providers.jev.model,
    latencyMs: Date.now() - started,
    usage: { input_tokens: 0, output_tokens: 0 },
    check: 'GET /v1/models',
  };
}

export interface RecordDecisionInput {
  kind: DecisionKind;
  projectId: string;
  taskId?: string | null;
  stepId?: string | null;
  sessionId?: string | null;
  /** What the script resolved from the answers. */
  chosen: unknown;
}

/** usage_json of an exchange: token sums and every call. */
export function exchangeUsage(ex: Pick<JevExchange, 'calls'>): { input_tokens: number; output_tokens: number; calls: JevCallRecord[] } {
  return {
    input_tokens: ex.calls.reduce((n, c) => n + c.usage.input_tokens, 0),
    output_tokens: ex.calls.reduce((n, c) => n + c.usage.output_tokens, 0),
    calls: ex.calls,
  };
}

/** Writes the decisions row of an exchange (every column of section 4). */
export function recordDecision(store: Store, ex: JevExchange, input: RecordDecisionInput): DecisionRow {
  return store.createDecision({
    kind: input.kind,
    project_id: input.projectId,
    task_id: input.taskId ?? null,
    step_id: input.stepId ?? null,
    session_id: input.sessionId ?? null,
    skill_name: ex.policy.name,
    skill_hash: ex.policy.hash,
    jev_model: ex.calls[0]?.model ?? ex.jevModel,
    state_json: ex.state,
    questions_json: JSON.stringify(ex.questions),
    answers_json: JSON.stringify(ex.answers),
    chosen_json: JSON.stringify(input.chosen),
    latency_ms: ex.latencyMs,
    usage_json: JSON.stringify(exchangeUsage(ex)),
  });
}

// ---- owner rules (~/.jv/projects/<name>/rules.json, ported jev-rules.ts) ----------------------------------------

const OwnerRuleSchema = z.strictObject({
  id: z.string().regex(/^R[1-9][0-9]*$/, 'R followed by a number'),
  when: z
    .strictObject({
      /** Task kind (Jevellan's taskType). */
      kind: z.enum(TASK_KINDS).optional(),
      /** Duty of the step (Jevellan's label), compared case-insensitively. */
      duty: z.string().min(1).max(40).optional(),
      /** Any of these words in the task title or text, case-insensitively. */
      keywords: z.array(z.string().min(1).max(60)).max(20).optional(),
    })
    .default({}),
  set: z
    .strictObject({
      minEffort: z.enum(EFFORTS).optional(),
      maxEffort: z.enum(EFFORTS).optional(),
      landingRoute: z.enum(LANDING_ROUTES).optional(),
    })
    .refine((s) => s.minEffort || s.maxEffort || s.landingRoute, 'set needs minEffort, maxEffort or landingRoute'),
  note: z.string().max(400).default(''),
  enabled: z.boolean().default(true),
});
export type OwnerRule = z.infer<typeof OwnerRuleSchema>;
const RulesFileSchema = z.strictObject({ rules: z.array(OwnerRuleSchema).max(1000) });

/** The owner's rules of a project; none when the file does not exist. Exit 2 when it is not valid. */
export function loadOwnerRules(project: string, file: string = paths.projectRules(project)): OwnerRule[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = RulesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw refused(`${file} is not valid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
  }
  const ids = new Set<string>();
  for (const r of parsed.data.rules) {
    if (ids.has(r.id)) throw refused(`${file} is not valid: rule ${r.id} is written twice`);
    ids.add(r.id);
  }
  return parsed.data.rules;
}

export interface RuleContext {
  kind?: string;
  duty?: string;
  /** Task title and text. */
  text: string;
}

const ruleNumber = (r: OwnerRule) => Number(r.id.slice(1));

/** Rules whose every configured predicate matches, with the number of predicates (specificity). */
export function matchingRules(rules: readonly OwnerRule[], ctx: RuleContext): Array<{ rule: OwnerRule; fields: number }> {
  return rules.flatMap((rule) => {
    if (!rule.enabled) return [];
    let fields = 0;
    if (rule.when.kind) {
      if (rule.when.kind !== ctx.kind) return [];
      fields++;
    }
    if (rule.when.duty) {
      if (rule.when.duty.toLowerCase() !== (ctx.duty ?? '').toLowerCase()) return [];
      fields++;
    }
    if (rule.when.keywords?.length) {
      const text = ctx.text.toLowerCase();
      if (!rule.when.keywords.some((w) => text.includes(w.toLowerCase()))) return [];
      fields++;
    }
    return [{ rule, fields }];
  });
}

/**
 * The effort bounds: the most specific floor and ceiling (ties: the higher floor, the lower ceiling, then the lower
 * rule number). When the floor is above the ceiling, the more specific of the two wins (ported jevEffortBounds; all
 * rules of a project's file have the same scope).
 */
export function effortBounds(rules: readonly OwnerRule[], ctx: RuleContext): { minimum: Effort; maximum: Effort; accepted: OwnerRule[]; ignored: string[] } {
  const ranked = matchingRules(rules, ctx).filter(({ rule }) => rule.set.minEffort || rule.set.maxEffort);
  type Match = (typeof ranked)[number];
  const priority = (a: Match, b: Match) => b.fields - a.fields;
  let lower = ranked
    .filter((r) => r.rule.set.minEffort)
    .sort((a, b) => priority(a, b) || effortIndex(b.rule.set.minEffort!) - effortIndex(a.rule.set.minEffort!) || ruleNumber(a.rule) - ruleNumber(b.rule))[0];
  let upper = ranked
    .filter((r) => r.rule.set.maxEffort)
    .sort((a, b) => priority(a, b) || effortIndex(a.rule.set.maxEffort!) - effortIndex(b.rule.set.maxEffort!) || ruleNumber(a.rule) - ruleNumber(b.rule))[0];
  if (lower && upper && effortIndex(lower.rule.set.minEffort!) > effortIndex(upper.rule.set.maxEffort!)) {
    if (priority(lower, upper) <= 0) upper = undefined;
    else lower = undefined;
  }
  const accepted = [...new Map([lower, upper].flatMap((r) => (r ? [r.rule] : [])).map((rule) => [rule.id, rule])).values()];
  return {
    minimum: lower?.rule.set.minEffort ?? 'low',
    maximum: upper?.rule.set.maxEffort ?? 'max',
    accepted,
    ignored: ranked.filter((r) => !accepted.some((a) => a.id === r.rule.id)).map((r) => r.rule.id),
  };
}

export interface EffortRuleResult {
  effort: Effort;
  minimum: Effort;
  maximum: Effort;
  rulesApplied: string[];
  ignored: string[];
  reason: string;
}

/** Clamps an effort into the owner's bounds and says which rule changed it (ported applyJevEffortRules). */
export function applyEffortRules(effort: Effort, rules: readonly OwnerRule[], ctx: RuleContext): EffortRuleResult {
  const bounds = effortBounds(rules, ctx);
  const from = effortIndex(effort);
  const effective = EFFORTS[Math.min(effortIndex(bounds.maximum), Math.max(effortIndex(bounds.minimum), from))]!;
  const changed = effective !== effort;
  const raised = effortIndex(effective) > from;
  const rule = changed ? bounds.accepted.find((r) => (raised ? r.set.minEffort === bounds.minimum : r.set.maxEffort === bounds.maximum)) : undefined;
  return {
    effort: effective,
    minimum: bounds.minimum,
    maximum: bounds.maximum,
    rulesApplied: rule ? [rule.id] : [],
    ignored: bounds.ignored,
    reason: rule ? `${rule.id} ${raised ? 'raised' : 'lowered'} effort from ${effort} to ${effective}${rule.note ? ` (${rule.note})` : ''}.` : '',
  };
}

/**
 * The landing route after the owner's rules: the most specific rule with a landingRoute wins (ties: the more
 * cautious route); ported applyJevRouteRules, for the landing phase.
 */
export function applyRouteRules(route: LandingRoute, rules: readonly OwnerRule[], ctx: RuleContext): { route: LandingRoute; rulesApplied: string[]; reason: string } {
  const ranked = matchingRules(rules, ctx)
    .filter((r) => r.rule.set.landingRoute)
    .sort((a, b) => b.fields - a.fields || LANDING_ROUTES.indexOf(b.rule.set.landingRoute!) - LANDING_ROUTES.indexOf(a.rule.set.landingRoute!) || ruleNumber(a.rule) - ruleNumber(b.rule));
  const top = ranked[0];
  if (!top || top.rule.set.landingRoute === route) return { route, rulesApplied: [], reason: '' };
  return {
    route: top.rule.set.landingRoute!,
    rulesApplied: [top.rule.id],
    reason: `${top.rule.id} changed the landing route from ${route} to ${top.rule.set.landingRoute}${top.rule.note ? ` (${top.rule.note})` : ''}.`,
  };
}

/** The effort a model runs at after the owner's bounds: mapped onto the model's efforts within the bounds when it has any. */
export function boundedEffort(desired: Effort, modelEfforts: readonly string[], bounds: { minimum: Effort; maximum: Effort }): Effort {
  const within = modelEfforts.filter((e) => isEffort(e) && effortIndex(e) >= effortIndex(bounds.minimum) && effortIndex(e) <= effortIndex(bounds.maximum));
  return mapEffort(desired, within.length ? within : modelEfforts);
}

// ---- reading the task, step and project ---------------------------------------------------------------------------

/** project.json guidance ('' when the file or the field is missing). Exit 2 when the file is not valid JSON. */
export function loadProjectGuidance(project: string, file: string = paths.projectJson(project)): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  try {
    const raw = JSON.parse(text) as { guidance?: unknown };
    return typeof raw.guidance === 'string' ? raw.guidance : '';
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stateTask(task: TaskRow): StateTask {
  return { id: task.id, kind: task.kind, title: task.title, text: task.task_text, parent: task.parent_task_id, visible: task.visible === 1 };
}

/** Earlier steps of the task with their latest report (summary cut to 600 characters). */
export function previousSteps(store: Store, step: StepRow): StatePrevious[] {
  return store
    .listSteps(step.task_id)
    .filter((s) => s.ordinal < step.ordinal && s.state !== 'pending')
    .map((s) => {
      const report = store.listReports({ step_id: s.id }).at(-1);
      return {
        duty: s.duty,
        status: s.state === 'skipped' ? 'skipped' : (report?.status ?? s.state),
        summary: (report?.summary ?? s.state_reason).slice(0, PREVIOUS_SUMMARY_CHARS),
      };
    });
}

function parseJson<T>(text: string | null): T | undefined {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

interface ChosenLike {
  duty?: string;
  model?: string;
  effort?: string;
}

/** Recent placements of the project, newest last: what ran (the override when the owner undid Jev's choice) and how it ended. */
export function recentHistory(store: Store, projectId: string, limit = HISTORY_LIMIT): StateHistoryEntry[] {
  return store
    .listDecisions({ kind: 'placement', project_id: projectId })
    .flatMap((d) => {
      const chosen = parseJson<ChosenLike>(d.chosen_json);
      const override = d.override_mode === 'undo' ? parseJson<ChosenLike>(d.override_json) : undefined;
      const outcome = parseJson<{ status?: string; attempts?: number }>(d.outcome_json);
      if (!chosen?.model || !chosen.duty) return [];
      return [
        {
          duty: chosen.duty,
          model: override?.model ?? chosen.model,
          effort: override?.effort ?? chosen.effort ?? '',
          outcome: outcome?.status ?? 'pending',
          attempts: typeof outcome?.attempts === 'number' ? outcome.attempts : null,
        },
      ];
    })
    .slice(-limit);
}

// ---- placement --------------------------------------------------------------------------------------------------

export interface PlaceStepInput {
  store: Store;
  taskId: string;
  stepId: string;
  /** The session the placement is for, when it already exists. */
  sessionId?: string;
  providers?: ProvidersConfig;
  policy?: RouterPolicy;
  client?: JevDecider;
  fetch?: typeof fetch;
  /** Default: the step's attempts, at least 1. */
  attempt?: number;
  /** The failure summary of a retry (section 7.6). */
  failure?: string;
  /** Default: the task's visible flag. A workflow step with "visible": true passes true. */
  visible?: boolean;
  /** Default: the duty skill's jv-needs. */
  needs?: string[];
  /** Default: ~/.jv/projects/<name>/rules.json. */
  rules?: OwnerRule[];
  /** Default: project.json guidance. */
  guidance?: string;
  keyReady?: (p: Provider) => boolean;
  now?: number;
  signal?: AbortSignal;
}

export interface Placement {
  runtime: Runtime;
  provider: string;
  model: string;
  effort: Effort;
  decisionId: string;
}

export interface ChoiceRecord {
  source: 'jev' | 'only-option';
  option: string;
  probabilities?: Record<string, number>;
}

export interface PlacementChosen {
  source: 'jev' | 'owner';
  duty: string;
  visible: boolean;
  runtime: Runtime;
  provider: string;
  model: string;
  label: string;
  effort: Effort;
  /** Jev's effort answer, before the owner's rules and the model's mapping. */
  effortRequested: Effort;
  /** After the owner's rules, before the mapping onto the model's efforts. */
  effortAfterRules: Effort;
  choices: { model: ChoiceRecord; effort: ChoiceRecord; provider: ChoiceRecord };
  /** Every provider and why it was or was not in the menu (ported account choice candidates). */
  candidates: Array<{ name: string; kind: ProviderKind; eligible: boolean; reason: string; ceilingPct: number; weeklyPct: number | null; fiveHourPct: number | null }>;
  rules: { applied: string[]; ignored: string[]; minimum: Effort; maximum: Effort; reason: string };
}

function requireTaskStep(store: Store, taskId: string, stepId: string): { task: TaskRow; step: StepRow; project: ProjectRow } {
  const task = store.requireTask(taskId);
  const step = store.requireStep(stepId);
  if (step.task_id !== task.id) throw refused(`step ${step.id} belongs to task ${step.task_id}, not ${task.id}`);
  const project = store.getProject(task.project_id);
  if (!project) throw notFound(`no project ${task.project_id}`);
  return { task, step, project };
}

function latestUsage(store: Store, providers: ProvidersConfig): ProviderUsageRow[] {
  return providers.providers.flatMap((p) => {
    const row = store.latestProviderUsage(p.name);
    return row ? [row] : [];
  });
}

function candidates(ranking: readonly RankedProvider[], now: number): PlacementChosen['candidates'] {
  return ranking.map((r) => {
    const u = currentUsage(r.usage, now);
    return {
      name: r.provider.name,
      kind: r.provider.kind,
      eligible: r.eligible,
      reason: r.reason,
      ceilingPct: r.provider.ceilingPct,
      weeklyPct: u.weeklyPct ?? null,
      fiveHourPct: u.fiveHourPct ?? null,
    };
  });
}

/** Everything a placement is built from, read from the store and the files (exported for jv evals and tests). */
export function placementContext(input: PlaceStepInput): {
  task: TaskRow;
  step: StepRow;
  project: ProjectRow;
  providers: ProvidersConfig;
  policy: RouterPolicy;
  menu: Menu;
  state: PlacementState;
  visible: boolean;
  rules: OwnerRule[];
} {
  const { store } = input;
  const now = input.now ?? Date.now();
  const { task, step, project } = requireTaskStep(store, input.taskId, input.stepId);
  const policy = input.policy ?? loadRouterPolicy();
  const providers = input.providers ?? loadProviders();
  const needs = input.needs ?? loadDutyNeeds(step.duty);
  const runtimes = dutyRuntimes(step.duty, needs);
  const visible = input.visible ?? task.visible === 1;
  const menu = buildMenu({
    providers,
    usage: latestUsage(store, providers),
    auth: loadProviderAuth(store),
    runtimes,
    visible,
    descriptions: policy.modelDescriptions,
    ...(input.keyReady ? { keyReady: input.keyReady } : {}),
    now,
  });
  const state: PlacementState = {
    project: { name: project.name, guidance: input.guidance ?? loadProjectGuidance(project.name) },
    task: stateTask(task),
    step: {
      ordinal: step.ordinal,
      duty: step.duty,
      instructions: step.instructions,
      attempt: input.attempt ?? Math.max(1, step.attempts),
      previous: previousSteps(store, step),
      ...(input.failure ? { failure: input.failure } : {}),
    },
    duty: { needs: [...needs], runtimes },
    menu: { models: menu.models.map((m) => ({ ...m })), providers: menu.providers },
    history: { recent: recentHistory(store, project.id) },
    rules: policy.rules,
  };
  return { task, step, project, providers, policy, menu, state, visible, rules: input.rules ?? loadOwnerRules(project.name) };
}

/**
 * Places a step (section 7.2): one Jev call for model and effort, a second for the provider when needed, owner rules,
 * the decisions row (kind placement). Exit 2 with the JevError message when Jev cannot answer; nothing is written then.
 * The caller (the launcher) keeps the step pending with that message as state_reason.
 */
export async function placeStep(input: PlaceStepInput): Promise<Placement & { decision: DecisionRow }> {
  const now = input.now ?? Date.now();
  const ctx = placementContext(input);
  const { menu, policy, providers, task, step, project } = ctx;
  const { questions, modelKeys } = placementQuestions(policy, menu);
  const state = stateJson(ctx.state);
  const askOptions = {
    providers,
    policy: policy.policy,
    client: clientFor(input, providers),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  let exchange: JevExchange | undefined;
  if (Object.keys(questions).length) exchange = await askJev(ROUTER_POLICY, state, questions, askOptions);
  // Nothing to ask (one model with one effort): Jev must still answer before the step may run (D-036).
  const check = exchange || providerQuestion(menu, menu.models[0]!.id) ? undefined : await checkJev(askOptions.client, providers, input.signal);

  let modelChoice: ChoiceRecord;
  if (questions.model) {
    const r = resolveChoice(exchange!.questions, exchange!.response, 'model');
    modelChoice = { source: 'jev', option: r.option, probabilities: r.probabilities };
  } else modelChoice = { source: 'only-option', option: [...modelKeys.keys()][0]! };
  const modelId = modelKeys.get(modelChoice.option);
  if (modelId === undefined) throw jevRefusal(new JevError('invalid-response'));
  const model = menu.models.find((m) => m.id === modelId)!;

  let effortChoice: ChoiceRecord;
  if (questions.effort) {
    const r = resolveChoice(exchange!.questions, exchange!.response, 'effort');
    effortChoice = { source: 'jev', option: r.option, probabilities: r.probabilities };
  } else effortChoice = { source: 'only-option', option: menu.efforts[0]! };
  if (!isEffort(effortChoice.option)) throw jevRefusal(new JevError('invalid-response'));
  const effortRequested = effortChoice.option;

  // The provider (ported decideAccount): only-option when one eligible provider serves the model, else Jev.
  const pq = providerQuestion(menu, model.id);
  let providerChoice: ChoiceRecord;
  if (pq) {
    exchange = await askJev(ROUTER_POLICY, state, { provider: pq }, { ...askOptions, ...(exchange ? { into: exchange } : {}) });
    const r = resolveChoice({ provider: pq }, exchange.response, 'provider');
    providerChoice = { source: 'jev', option: r.option, probabilities: r.probabilities };
  } else providerChoice = { source: 'only-option', option: model.provider };
  const providerRanked = menu.ranking.find((r) => r.eligible && r.provider.name === providerChoice.option);
  const providerModel = providerRanked?.provider.models.find((m) => m.id === model.id);
  if (!providerRanked || !providerModel) throw jevRefusal(new JevError('invalid-response'));

  // Owner rules after Jev, then the effort onto the model's efforts.
  const ruleCtx: RuleContext = { kind: task.kind, duty: step.duty, text: `${task.title}\n${task.task_text}` };
  const ruled = applyEffortRules(effortRequested, ctx.rules, ruleCtx);
  const effort = boundedEffort(ruled.effort, providerModel.efforts, ruled);
  const runtime = impliedRuntime(providerRanked.provider.kind, ctx.state.duty.runtimes, ctx.visible);

  const chosen: PlacementChosen = {
    source: 'jev',
    duty: step.duty,
    visible: ctx.visible,
    runtime,
    provider: providerRanked.provider.name,
    model: model.id,
    label: model.label,
    effort,
    effortRequested,
    effortAfterRules: ruled.effort,
    choices: { model: modelChoice, effort: effortChoice, provider: providerChoice },
    candidates: candidates(menu.ranking, now),
    rules: { applied: ruled.rulesApplied, ignored: ruled.ignored, minimum: ruled.minimum, maximum: ruled.maximum, reason: ruled.reason },
  };
  const decision = exchange
    ? recordDecision(input.store, exchange, { kind: 'placement', projectId: project.id, taskId: task.id, stepId: step.id, sessionId: input.sessionId ?? null, chosen })
    : input.store.createDecision({
        kind: 'placement',
        project_id: project.id,
        task_id: task.id,
        step_id: step.id,
        session_id: input.sessionId ?? null,
        skill_name: ROUTER_POLICY,
        skill_hash: policy.policy.hash,
        jev_model: providers.jev.model,
        state_json: state,
        questions_json: '{}',
        answers_json: '{}',
        chosen_json: JSON.stringify(chosen),
        latency_ms: check?.latencyMs ?? 0,
        usage_json: JSON.stringify({ input_tokens: 0, output_tokens: 0, calls: check ? [check] : [] }),
      });
  return { runtime, provider: chosen.provider, model: chosen.model, effort, decisionId: decision.id, decision };
}

// ---- workflow questions (section 7.5) ---------------------------------------------------------------------------

export const SKIP_REASON = 'Jev: not needed';

export interface WorkflowQuestionsInput {
  store: Store;
  taskId: string;
  providers?: ProvidersConfig;
  policy?: RouterPolicy;
  client?: JevDecider;
  fetch?: typeof fetch;
  guidance?: string;
  signal?: AbortSignal;
}

export interface WorkflowAnswers {
  /** The decisions row (kind workflow); undefined when no step has a jev: rule (no call was made). */
  decision?: DecisionRow;
  answers: Record<string, { value: boolean; probability: number }>;
  /** Steps Jev said are not needed; the caller marks them skipped with `reason`. */
  skip: Array<{ stepId: string; ordinal: number; duty: string; question: string; reason: string }>;
}

/** The question id of a when rule "jev:<id>", or undefined for "always". */
export function whenQuestion(whenRule: string): string | undefined {
  return whenRule.startsWith('jev:') ? whenRule.slice(4) : undefined;
}

/**
 * Asks Jev, in one call with the task state and no step, a noul question per distinct jev:<id> rule of the task's
 * steps, with the instructions and criteria of the policy's "## questions". Writes a decisions row of kind workflow
 * and returns the steps to skip. No jev: rule: no call, no row.
 */
export async function askWorkflowQuestions(input: WorkflowQuestionsInput): Promise<WorkflowAnswers> {
  const { store } = input;
  const task = store.requireTask(input.taskId);
  const project = store.getProject(task.project_id);
  if (!project) throw notFound(`no project ${task.project_id}`);
  const steps = store.listSteps(task.id).filter((s) => whenQuestion(s.when_rule) !== undefined);
  if (!steps.length) return { answers: {}, skip: [] };
  const policy = input.policy ?? loadRouterPolicy();
  const providers = input.providers ?? loadProviders();
  const questions: JevQuestions = {};
  for (const s of steps) {
    const id = whenQuestion(s.when_rule)!;
    const q = policy.questions.get(id);
    if (!q) throw refused(`step ${s.ordinal} (${s.duty}) has the rule jev:${id}, and the router policy's "## questions" has no ${id} line`);
    questions[id] = { type: 'noul', instructions: q.question, criteria: { true: q.true, false: q.false } };
  }
  const state: WorkflowState = {
    project: { name: project.name, guidance: input.guidance ?? loadProjectGuidance(project.name) },
    task: stateTask(task),
    rules: policy.rules,
  };
  const exchange = await askJev(ROUTER_POLICY, stateJson(state), questions, {
    providers,
    policy: policy.policy,
    client: clientFor(input, providers),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const answers: WorkflowAnswers['answers'] = {};
  for (const id of Object.keys(questions)) answers[id] = resolveNoul(exchange.response, id);
  const skip = steps
    .filter((s) => !answers[whenQuestion(s.when_rule)!]!.value)
    .map((s) => ({ stepId: s.id, ordinal: s.ordinal, duty: s.duty, question: whenQuestion(s.when_rule)!, reason: SKIP_REASON }));
  const decision = recordDecision(store, exchange, {
    kind: 'workflow',
    projectId: project.id,
    taskId: task.id,
    chosen: { answers, skip: skip.map((s) => ({ stepId: s.stepId, ordinal: s.ordinal, duty: s.duty, question: s.question })) },
  });
  return { decision, answers, skip };
}

// ---- owner placement (jv task override, section 7.6) -------------------------------------------------------------

export interface OwnerPlacementInput {
  store: Store;
  taskId: string;
  /** Default: the step of the task's latest placement decision. */
  stepId?: string;
  model: string;
  effort?: string;
  provider?: string;
  mode: OverrideMode;
  sessionId?: string;
  providers?: ProvidersConfig;
  visible?: boolean;
  needs?: string[];
  keyReady?: (p: Provider) => boolean;
  now?: number;
}

export interface OwnerPlacementResult {
  mode: OverrideMode;
  placement: Omit<Placement, 'decisionId'>;
  /** The latest placement decision of the step, with override_json and override_mode recorded (when there was one). */
  overridden?: DecisionRow;
  /** undo only: the new placement decision (chosen_json.source owner, no Jev call). */
  decision?: DecisionRow;
}

/**
 * The owner's placement (jv task override): no Jev call. Records the override on the step's latest placement
 * decision (override_mode undo or keep); with undo also writes a new placement decision whose chosen_json says
 * source owner, which the launcher starts the step again with. keep needs an earlier placement to record on.
 */
export function ownerPlacement(input: OwnerPlacementInput): OwnerPlacementResult {
  const { store } = input;
  const now = input.now ?? Date.now();
  const task = store.requireTask(input.taskId);
  const latestOfTask = store.latestDecision({ kind: 'placement', task_id: task.id });
  const stepId = input.stepId ?? latestOfTask?.step_id ?? undefined;
  if (!stepId) throw notFound(`task ${task.id} has no placed step to override; name the step`);
  const { step, project } = requireTaskStep(store, task.id, stepId);
  const providers = input.providers ?? loadProviders();
  const needs = input.needs ?? loadDutyNeeds(step.duty);
  const runtimes = dutyRuntimes(step.duty, needs);
  const visible = input.visible ?? task.visible === 1;

  const ranking = rankProviders({
    providers: providers.providers,
    usage: latestUsage(store, providers),
    kinds: kindsForRuntimes(runtimes),
    model: input.model,
    auth: loadProviderAuth(store),
    ...(input.keyReady ? { keyReady: input.keyReady } : {}),
    now,
  });
  // The owner may place on a provider over its ceiling or with a stale login probe; never on one that cannot serve.
  const hard = new Set(['unsupported', 'model-not-served', 'disabled', 'no-key']);
  let chosen: RankedProvider | undefined;
  if (input.provider !== undefined) {
    chosen = ranking.find((r) => r.provider.name === input.provider);
    if (!chosen) throw notFound(`no provider ${input.provider} in ${providers.file}`);
    if (hard.has(chosen.reason)) throw refused(`provider ${input.provider} cannot run ${input.model} for the duty ${step.duty}: ${chosen.reason}`);
  } else {
    chosen = ranking.find((r) => r.eligible);
    if (!chosen) {
      const serving = ranking.filter((r) => r.reason !== 'model-not-served' && r.reason !== 'unsupported');
      if (!serving.length) throw refused(`no provider in ${providers.file} serves ${input.model} for the duty ${step.duty}`);
      throw refused(`no eligible provider serves ${input.model}: ${serving.map((r) => `${r.provider.name} ${r.reason}`).join(', ')}; name one with --provider`);
    }
  }
  const providerModel = chosen.provider.models.find((m) => m.id === input.model)!;
  const previous = store.latestDecision({ kind: 'placement', step_id: step.id });
  const previousChosen = parseJson<ChosenLike>(previous?.chosen_json ?? null);
  const requested = input.effort ?? previousChosen?.effort;
  if (requested !== undefined && !isEffort(requested)) throw refused(`unknown effort ${requested} (jv knows ${EFFORTS.join(', ')})`);
  const effort = requested === undefined ? mapEffort('high', providerModel.efforts) : mapEffort(requested, providerModel.efforts);
  const runtime = impliedRuntime(chosen.provider.kind, runtimes, visible);
  const placement = { runtime, provider: chosen.provider.name, model: input.model, effort };
  const override = { source: 'owner', ...placement, ...(input.effort ? { effortRequested: input.effort } : {}), at: new Date(now).toISOString() };

  if (input.mode === 'keep' && !previous) throw notFound(`step ${step.id} has no placement decision to record the override on`);
  const overridden = previous
    ? store.updateDecision(previous.id, { override_json: JSON.stringify(override), override_mode: input.mode })
    : undefined;
  if (input.mode === 'keep') return { mode: 'keep', placement, ...(overridden ? { overridden } : {}) };

  let skillHash = '';
  try {
    skillHash = loadPolicy(ROUTER_POLICY).hash;
  } catch {
    // the owner's placement does not read the policy; the hash is informational
  }
  const decision = store.createDecision({
    kind: 'placement',
    project_id: project.id,
    task_id: task.id,
    step_id: step.id,
    session_id: input.sessionId ?? null,
    skill_name: ROUTER_POLICY,
    skill_hash: skillHash,
    jev_model: 'none',
    state_json: previous?.state_json ?? '{}',
    questions_json: '{}',
    answers_json: '{}',
    chosen_json: JSON.stringify({
      source: 'owner',
      duty: step.duty,
      visible,
      ...placement,
      label: providerModel.label,
      ...(input.effort ? { effortRequested: input.effort } : {}),
      overrides: previous?.id ?? null,
      providerReason: chosen.reason,
    }),
    latency_ms: 0,
    usage_json: JSON.stringify({ input_tokens: 0, output_tokens: 0, calls: [] }),
  });
  return { mode: 'undo', placement, ...(overridden ? { overridden } : {}), decision };
}
