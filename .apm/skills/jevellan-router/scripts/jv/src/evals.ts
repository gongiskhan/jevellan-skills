// Evals of the policy skills (section 12): the export of decision rows into eval cases (`jv evals route|landing`) and
// the replay of a policy's current text against those cases through Jev (each policy skill's `evals/run.mjs`, a thin
// wrapper over runEvalsMain below, so the replay is the same code for both policies and is compiled and tested here).
//
// A case: {id, kind, state, questions, expected, source, decisionId, split}.
//
// Export rules (exportCases):
// - `route` exports decisions of kind placement and workflow (skill jevellan-router), `landing` those of kind landing.
// - Skipped: owner placements (chosen_json.source "owner" or jev_model "none", D-033: no Jev answer to replay), rows
//   that asked Jev nothing (only-option placements, D-036), and rows whose outcome is not known yet or was stopped.
// - expected is the override when override_json is set (source override); else Jev's own answer when the outcome is a
//   success (source outcome); else null with source failed, for a person to label. Jev's answer is read from
//   answers_json with the router's resolution (highest probability, ties to Jev's choice; noul true at 0.5), and a
//   placement's model option is mapped back to the model id through the menu in the stored state. Only questions that
//   were asked get an expected value.
// - Success: a placement whose outcome_json says done on the attempt it was placed for (attempts at most the state's
//   step.attempt; a placement is made per attempt, section 7.6); a landing whose outcome_json says done or landed, or
//   whose landings row is landed; a workflow decision whose outcome_json says done, or (no outcome_json, which section
//   7.6 does not write for workflow rows) whose task is done. Failure: anything else that ended (failed, lost, a
//   placement done only after more attempts, a landing whose checks failed). A landing whose ask-owner row the owner
//   answered ("Land now", "Leave it") or a new landing replaced has no outcome of its own and is skipped as stopped.
// - Split: every fifth eligible row by creation order is held-out, the rest dev. The position counts every eligible
//   row of the set (not only the rows after --since), so a decision keeps its split across exports.
// - Merge into the cases file: cases with source hand are kept; an exported case replaces the case with the same
//   decisionId; exported cases the new export does not contain (older than --since) are kept; a case a person
//   labelled (source failed, expected set) keeps its label when the decision is exported again unlabelled.
//
// Replay rules (runEvals):
// - The policy is the SKILL.md next to the evals folder, as it is now. Each case's questions are rebuilt from it:
//   instructions from the policy sections, criteria from the current model descriptions and effort guide (router) or
//   routes (landing), the workflow questions from "## questions"; state.rules is replaced by the current rules section
//   and a placement state's menu descriptions by the current model descriptions. The provider question (no policy
//   text) is asked in a second call, as the router does, with the stored criteria.
// - A case whose question options the current policy cannot express (a model id with no description line, an effort
//   with no guide line, a question id or route the policy no longer has) is listed as stale and not scored. A case with
//   expected null is listed as unlabelled and not scored.
// - Agreement is counted per question and split; the run fails (exit 1) when held-out agreement over every scored
//   held-out question is below threshold.json {"heldOut": 0..1}. evals/RESULTS.md records the skill hash, the date, the
//   agreement table and every disagreement with Jev's probabilities.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { JevQuestion, JevQuestions, JevResponse } from './jev/contract.js';
import { JvError, refused } from './errors.js';
import { isClosedAsk } from './land.js';
import { paths } from './paths.js';
import { LANDING_POLICY, parsePolicy, parseRoutes, requireSection, ROUTER_POLICY, routerPolicy, splitFrontmatter, type Policy, type RouterPolicy } from './policy.js';
import { loadProviders, type ProvidersConfig } from './providers.js';
import {
  askJev,
  modelOptionKeys,
  PROVIDER_INSTRUCTIONS,
  resolveChoice,
  resolveNoul,
  STATE_LIMIT,
  stateJson,
  type JevDecider,
  type JevExchange,
  type MenuModel,
  type PlacementState,
  type WorkflowState,
} from './route.js';
import type { Store } from './store.js';
import type { DecisionKind, DecisionRow } from './types.js';

// ---- cases ----------------------------------------------------------------------------------------------------

export const CASE_SOURCES = ['override', 'outcome', 'hand', 'failed'] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];
export const SPLITS = ['dev', 'held-out'] as const;
export type Split = (typeof SPLITS)[number];
export type ExpectedValue = string | boolean;

export interface EvalCase {
  id: string;
  kind: DecisionKind;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  /** Question id to the expected answer (model id, effort, provider, route, or a boolean for a noul); null: unlabelled. */
  expected: Record<string, ExpectedValue> | null;
  source: CaseSource;
  decisionId: string | null;
  split: Split;
  /** Free text for people (what the case is about); hand cases carry one. */
  note?: string;
}

export interface CasesFile {
  skill: string;
  cases: EvalCase[];
}

/** The two exportable sets: which skill's cases file they go to and which decision kinds they hold. */
export const EVAL_SETS = {
  route: { skill: ROUTER_POLICY, kinds: ['placement', 'workflow'] as DecisionKind[] },
  landing: { skill: LANDING_POLICY, kinds: ['landing'] as DecisionKind[] },
} as const;
export type EvalSetName = keyof typeof EVAL_SETS;

export function isEvalSet(name: string): name is EvalSetName {
  return Object.hasOwn(EVAL_SETS, name);
}

/** Every fifth case (positions 5, 10, ...) is held out. */
export function splitAt(index: number): Split {
  return (index + 1) % 5 === 0 ? 'held-out' : 'dev';
}

function parseJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

// ---- export -------------------------------------------------------------------------------------------------------

export type SkipReason = 'owner' | 'nothing-asked' | 'pending' | 'stopped' | 'unreadable';

export interface ExportResult {
  cases: EvalCase[];
  skipped: Record<SkipReason, number>;
}

type Verdict = 'success' | 'failure' | 'pending' | 'stopped';

function statusVerdict(status: unknown, success: readonly string[]): Verdict {
  if (typeof status !== 'string' || status === '' || status === 'pending' || status === 'running') return 'pending';
  if (status === 'stopped') return 'stopped';
  return success.includes(status) ? 'success' : 'failure';
}

/** How the decision's placed work ended (see the header). */
export function decisionVerdict(store: Store, row: DecisionRow, state: Record<string, unknown>): Verdict {
  const outcome = parseJson(row.outcome_json);
  if (row.kind === 'placement') {
    if (!isObject(outcome)) return 'pending';
    const verdict = statusVerdict(outcome.status, ['done']);
    if (verdict !== 'success') return verdict;
    const placedFor = asObject(state.step).attempt;
    const attempt = typeof placedFor === 'number' && placedFor >= 1 ? placedFor : 1;
    return typeof outcome.attempts === 'number' && outcome.attempts > attempt ? 'failure' : 'success';
  }
  if (row.kind === 'landing') {
    if (isObject(outcome)) return statusVerdict(outcome.status, ['done', 'landed']);
    const landing = store.listLandings(row.task_id ? { task_id: row.task_id } : {}).find((l) => l.decision_id === row.id);
    if (!landing) return 'pending';
    if (landing.state === 'landed') return 'success';
    // An ask-owner question the owner answered (or a new landing replaced) was closed as failed; its route was not
    // judged by an outcome, so it is skipped like a stopped task.
    if (landing.state === 'failed' && isClosedAsk(landing.reason)) return 'stopped';
    if (landing.state === 'failed') return 'failure';
    return 'pending';
  }
  if (isObject(outcome)) return statusVerdict(outcome.status, ['done']);
  const task = row.task_id ? store.getTask(row.task_id) : undefined;
  if (!task) return 'pending';
  if (task.state === 'done') return 'success';
  if (task.state === 'failed') return 'failure';
  if (task.state === 'stopped') return 'stopped';
  return 'pending';
}

/** The model option key of each menu model in a placement state (the router's modelOptionKeys over the stored menu). */
export function stateModelKeys(state: Record<string, unknown>): Map<string, string> {
  const models = asObject(state.menu).models;
  if (!Array.isArray(models)) return new Map();
  const usable = models.filter(
    (m): m is MenuModel => isObject(m) && typeof m.id === 'string' && typeof m.label === 'string' && typeof m.provider === 'string' && typeof m.runtime === 'string',
  );
  return modelOptionKeys(usable);
}

/** Jev's answers of a decision row, resolved the way the router resolves them, keyed by question id. */
export function jevAnswers(row: DecisionRow, questions: JevQuestions, state: Record<string, unknown>): Record<string, ExpectedValue> {
  const answers = asObject(parseJson(row.answers_json)) as JevResponse['answers'];
  const response = { schema: 'jev-response-v1', model: row.jev_model, answers, usage: { input_tokens: 0, output_tokens: 0 } } as JevResponse;
  const keys = row.kind === 'placement' ? stateModelKeys(state) : new Map<string, string>();
  const out: Record<string, ExpectedValue> = {};
  for (const [id, q] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer) continue;
    if (q.type === 'choice' && answer.type === 'choice') {
      const option = resolveChoice(questions, response, id).option;
      if (row.kind === 'placement' && id === 'model') {
        const modelId = keys.get(option);
        if (modelId !== undefined) out[id] = modelId;
      } else out[id] = option;
    } else if (q.type === 'noul' && answer.type === 'noul') out[id] = resolveNoul(response, id).value;
  }
  return out;
}

/** The owner's override as expected answers for the questions that were asked. */
export function overrideExpected(row: DecisionRow, questions: JevQuestions): Record<string, ExpectedValue> | undefined {
  const o = parseJson(row.override_json);
  if (!isObject(o)) return undefined;
  const out: Record<string, ExpectedValue> = {};
  const answers = asObject(o.answers);
  for (const [id, q] of Object.entries(questions)) {
    let value: unknown = o[id] ?? answers[id];
    if (row.kind === 'landing' && value === undefined) value = o.route;
    if (isObject(value) && 'value' in value) value = value.value;
    if (q.type === 'noul' && typeof value === 'boolean') out[id] = value;
    else if (q.type === 'choice' && typeof value === 'string' && value !== '') out[id] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The cases of one set, from the decisions table (see the header for every rule). */
export function exportCases(store: Store, set: EvalSetName, options: { since?: string } = {}): ExportResult {
  const kinds = EVAL_SETS[set].kinds;
  const skipped: Record<SkipReason, number> = { owner: 0, 'nothing-asked': 0, pending: 0, stopped: 0, unreadable: 0 };
  const cases: EvalCase[] = [];
  let position = 0;
  for (const row of store.listDecisions().filter((d) => kinds.includes(d.kind))) {
    const chosen = asObject(parseJson(row.chosen_json));
    if (chosen.source === 'owner' || row.jev_model === 'none') {
      skipped.owner++;
      continue;
    }
    const state = parseJson(row.state_json);
    const questions = parseJson(row.questions_json);
    if (!isObject(state) || !isObject(questions)) {
      skipped.unreadable++;
      continue;
    }
    if (Object.keys(questions).length === 0) {
      skipped['nothing-asked']++;
      continue;
    }
    const split = splitAt(position++);
    if (options.since !== undefined && row.created_at < options.since) continue;
    const asked = questions as JevQuestions;
    const base = { id: row.id, kind: row.kind, state, questions, decisionId: row.id, split };
    const override = overrideExpected(row, asked);
    if (override) {
      cases.push({ ...base, expected: override, source: 'override' });
      continue;
    }
    const verdict = decisionVerdict(store, row, state);
    if (verdict === 'pending' || verdict === 'stopped') {
      skipped[verdict]++;
      continue;
    }
    if (verdict === 'failure') {
      cases.push({ ...base, expected: null, source: 'failed' });
      continue;
    }
    const expected = jevAnswers(row, asked, state);
    if (!Object.keys(expected).length) {
      skipped.unreadable++;
      continue;
    }
    cases.push({ ...base, expected, source: 'outcome' });
  }
  return { cases, skipped };
}

/** Merges exported cases into the cases already in the file (see the header). */
export function mergeCases(existing: readonly EvalCase[], exported: readonly EvalCase[]): EvalCase[] {
  const fresh = new Map(exported.filter((c) => c.decisionId).map((c) => [c.decisionId!, c]));
  const out: EvalCase[] = [];
  const placed = new Set<string>();
  for (const c of existing) {
    const next = c.source !== 'hand' && c.decisionId ? fresh.get(c.decisionId) : undefined;
    if (!next) {
      out.push(c);
      continue;
    }
    placed.add(next.decisionId!);
    // A person's label on an unlabelled case survives a re-export that is still unlabelled.
    if (next.expected === null && c.expected !== null) out.push({ ...next, expected: c.expected, ...(c.note ? { note: c.note } : {}) });
    else out.push(c.note ? { ...next, note: c.note } : next);
  }
  for (const c of exported) if (!c.decisionId || !placed.has(c.decisionId)) out.push(c);
  return out;
}

// ---- the cases file ---------------------------------------------------------------------------------------------

function caseProblem(c: unknown): string | undefined {
  if (!isObject(c)) return 'is not an object';
  if (typeof c.id !== 'string' || c.id === '') return 'has no id';
  if (!['placement', 'landing', 'workflow'].includes(c.kind as string)) return `has kind ${String(c.kind)}`;
  if (!isObject(c.state)) return 'has no state object';
  if (!isObject(c.questions)) return 'has no questions object';
  if (c.expected !== null && !isObject(c.expected)) return 'has an expected that is neither an object nor null';
  if (!(CASE_SOURCES as readonly unknown[]).includes(c.source)) return `has source ${String(c.source)}`;
  if (!(SPLITS as readonly unknown[]).includes(c.split)) return `has split ${String(c.split)} (dev or held-out)`;
  return undefined;
}

/** Reads a cases file ({skill, cases} or a bare array). A missing file is an empty list; an invalid one is exit 2. */
export function readCasesFile(file: string, skill: string): CasesFile {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { skill, cases: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw) ? raw : isObject(raw) ? raw.cases : undefined;
  if (!Array.isArray(list)) throw refused(`${file} has no "cases" list`);
  const ids = new Set<string>();
  list.forEach((c, i) => {
    const problem = caseProblem(c);
    if (problem) throw refused(`${file}: case ${i + 1} ${problem}`);
    const id = (c as EvalCase).id;
    if (ids.has(id)) throw refused(`${file}: the case id ${id} is used twice`);
    ids.add(id);
  });
  return { skill: isObject(raw) && typeof raw.skill === 'string' ? raw.skill : skill, cases: list as EvalCase[] };
}

/** Writes a cases file atomically (a temporary file renamed over it). */
export function writeCasesFile(file: string, data: CasesFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * The package's cases file of a skill: from $JV_HOME/install.json "source" (the runtime folder inside the package),
 * the nearest folder above it that holds <skill>/SKILL.md is the package skills folder. Exit 2 when it cannot be found.
 */
export function defaultCasesFile(skill: string, installFile: string = paths.installFile): string {
  const install = asObject(parseJson(existsSync(installFile) ? readFileSync(installFile, 'utf8') : undefined));
  if (typeof install.source !== 'string' || install.source === '') {
    throw refused(`${installFile} names no package source; pass --out FILE`);
  }
  let dir = resolve(install.source);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, skill, 'SKILL.md'))) return join(dir, skill, 'evals', 'cases.json');
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw refused(`no ${skill}/SKILL.md above the package source ${install.source} (${installFile}); pass --out FILE`);
}

export interface CaseCounts {
  bySource: Record<CaseSource, { dev: number; 'held-out': number }>;
  labelled: number;
}

export function countCases(cases: readonly EvalCase[]): CaseCounts {
  const bySource = Object.fromEntries(CASE_SOURCES.map((s) => [s, { dev: 0, 'held-out': 0 }])) as CaseCounts['bySource'];
  let labelled = 0;
  for (const c of cases) {
    bySource[c.source][c.split]++;
    if (c.expected !== null) labelled++;
  }
  return { bySource, labelled };
}

// ---- replay -------------------------------------------------------------------------------------------------------

export type SplitFilter = Split | 'all';

/** The policy a skill folder holds, read for the replay. */
export interface ReplayPolicy {
  policy: Policy;
  router?: RouterPolicy;
  landing?: { instructions: string; routes: Map<string, string>; rules: string };
}

/** The name in the frontmatter (else the folder name). */
function skillName(text: string, dir: string): string {
  const m = /^name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(splitFrontmatter(text).frontmatter);
  return m ? m[1]! : basename(dir);
}

/** Reads <skillDir>/SKILL.md as the policy it is (router or landing). Exit 2 when it is neither or a section is missing. */
export function loadReplayPolicy(skillDir: string): ReplayPolicy {
  const file = join(skillDir, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw refused(`no policy at ${file}`);
  }
  const name = skillName(text, skillDir);
  const policy = parsePolicy(name, text, file);
  if (name === ROUTER_POLICY) return { policy, router: routerPolicy(policy) };
  if (name === LANDING_POLICY) {
    return {
      policy,
      landing: { instructions: requireSection(policy, 'landing_route'), routes: parseRoutes(policy), rules: requireSection(policy, 'rules') },
    };
  }
  throw refused(`${file} is ${name}; evals replay ${ROUTER_POLICY} and ${LANDING_POLICY} only`);
}

class Stale extends Error {}

/** One case rebuilt from the current policy: the state text, the calls to make and how to read each answer. */
export interface RebuiltCase {
  state: string;
  calls: JevQuestions[];
  /** Question id to a decoder from Jev's option to the value compared with expected. */
  decode: Record<string, (option: string) => string>;
}

function storedQuestion(c: EvalCase, id: string): { criteria: Record<string, unknown> } | undefined {
  const q = c.questions[id];
  return isObject(q) && isObject(q.criteria) ? { criteria: q.criteria } : undefined;
}

/** Rebuilds a case's questions and state from the current policy. Throws Stale when the policy cannot express them. */
export function rebuildCase(rp: ReplayPolicy, c: EvalCase): RebuiltCase {
  const state = structuredClone(c.state);
  const decode: RebuiltCase['decode'] = {};
  if (c.kind === 'landing') {
    if (!rp.landing) throw new Stale(`a landing case does not belong to ${rp.policy.name}`);
    state.rules = rp.landing.rules;
    const text = JSON.stringify(state);
    if (text.length > STATE_LIMIT) throw new Stale(`the state is over ${STATE_LIMIT} characters`);
    const expectedRoute = c.expected?.landing_route;
    if (typeof expectedRoute === 'string' && !rp.landing.routes.has(expectedRoute)) throw new Stale(`the policy has no route ${expectedRoute}`);
    const q: JevQuestion = { type: 'choice', instructions: rp.landing.instructions, criteria: Object.fromEntries(rp.landing.routes) };
    return { state: text, calls: [{ landing_route: q }], decode };
  }
  const router = rp.router;
  if (!router) throw new Stale(`a ${c.kind} case does not belong to ${rp.policy.name}`);
  state.rules = router.rules;

  if (c.kind === 'workflow') {
    const questions: JevQuestions = {};
    for (const id of Object.keys(c.questions)) {
      const q = router.questions.get(id);
      if (!q) throw new Stale(`the policy's "## questions" has no ${id}`);
      questions[id] = { type: 'noul', instructions: q.question, criteria: { true: q.true, false: q.false } };
    }
    if (!Object.keys(questions).length) throw new Stale('the case asks no question');
    return { state: stateJson(state as unknown as WorkflowState), calls: [questions], decode };
  }

  // placement
  const first: JevQuestions = {};
  const menu = asObject(state.menu);
  if (Array.isArray(menu.models)) {
    for (const m of menu.models) {
      if (isObject(m) && typeof m.id === 'string' && router.modelDescriptions.has(m.id)) m.description = router.modelDescriptions.get(m.id)!;
    }
  }
  const storedModel = storedQuestion(c, 'model');
  if (storedModel) {
    const keys = stateModelKeys(state);
    const criteria: Record<string, string> = {};
    for (const key of Object.keys(storedModel.criteria)) {
      const id = keys.get(key);
      if (id === undefined) throw new Stale(`the model option "${key}" is not in the state's menu`);
      const description = router.modelDescriptions.get(id);
      if (description === undefined) throw new Stale(`the policy's "## model descriptions" has no line for ${id}`);
      criteria[key] = description;
    }
    first.model = { type: 'choice', instructions: router.modelInstructions, criteria };
    decode.model = (option) => keys.get(option) ?? option;
  }
  const storedEffort = storedQuestion(c, 'effort');
  if (storedEffort) {
    const criteria: Record<string, string> = {};
    for (const e of Object.keys(storedEffort.criteria)) {
      const line = router.effortGuide.get(e);
      if (line === undefined) throw new Stale(`the policy's "## effort guide" has no line for ${e}`);
      criteria[e] = line;
    }
    first.effort = { type: 'choice', instructions: router.effortInstructions, criteria };
  }
  const calls: JevQuestions[] = [];
  if (Object.keys(first).length) calls.push(first);
  const storedProvider = storedQuestion(c, 'provider');
  if (storedProvider) {
    const criteria = Object.fromEntries(Object.entries(storedProvider.criteria).filter((e): e is [string, string] => typeof e[1] === 'string'));
    calls.push({ provider: { type: 'choice', instructions: PROVIDER_INSTRUCTIONS, criteria } });
  }
  if (!calls.length) throw new Stale('the case asks no question');
  return { state: stateJson(state as unknown as PlacementState), calls, decode };
}

export interface QuestionResult {
  question: string;
  expected: ExpectedValue;
  got: ExpectedValue;
  agree: boolean;
  /** Jev's probabilities, option keys decoded (model ids for the model question); for a noul, {true: p}. */
  probabilities: Record<string, number>;
}

export interface CaseResult {
  id: string;
  kind: DecisionKind;
  split: Split;
  source: CaseSource;
  status: 'scored' | 'unlabelled' | 'stale';
  reason?: string;
  results: QuestionResult[];
  jevModel?: string;
}

export interface Tally {
  agreed: number;
  total: number;
}

export interface EvalRun {
  skill: string;
  hash: string;
  date: string;
  casesFile: string;
  split: SplitFilter;
  jevModel: string;
  answeredBy: string[];
  cases: CaseResult[];
  /** question id (and "all") to split (and "all") to the tally. */
  agreement: Record<string, Record<Split | 'all', Tally>>;
  threshold: number;
  heldOut: { rate: number | null; pass: boolean | null };
  usage: { calls: number; input_tokens: number; output_tokens: number };
}

export interface RunEvalsOptions {
  skillDir: string;
  casesFile?: string;
  split?: SplitFilter;
  thresholdFile?: string;
  providers?: ProvidersConfig;
  client?: JevDecider;
  now?: Date;
  concurrency?: number;
}

function normalizeExpected(value: ExpectedValue): ExpectedValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** threshold.json {"heldOut": 0..1}; 0.6 when the file is missing. Exit 2 when it is not valid. */
export function readThreshold(file: string): number {
  if (!existsSync(file)) return 0.6;
  const raw = asObject(parseJson(readFileSync(file, 'utf8')));
  const value = raw.heldOut;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw refused(`${file} needs {"heldOut": <number 0..1>}`);
  return value;
}

async function replayCase(rp: ReplayPolicy, c: EvalCase, ask: (state: string, q: JevQuestions, into?: JevExchange) => Promise<JevExchange>): Promise<CaseResult> {
  const base = { id: c.id, kind: c.kind, split: c.split, source: c.source };
  if (c.expected === null) return { ...base, status: 'unlabelled', results: [] };
  let rebuilt: RebuiltCase;
  try {
    rebuilt = rebuildCase(rp, c);
  } catch (error) {
    if (error instanceof Stale || error instanceof JvError) return { ...base, status: 'stale', reason: error.message, results: [] };
    throw error;
  }
  const asked = new Set(rebuilt.calls.flatMap((q) => Object.keys(q)));
  const scored = Object.keys(c.expected).filter((id) => asked.has(id));
  if (!scored.length) return { ...base, status: 'stale', reason: `no expected answer for the questions asked (${[...asked].join(', ')})`, results: [] };
  let exchange: JevExchange | undefined;
  for (const questions of rebuilt.calls) exchange = await ask(rebuilt.state, questions, exchange);
  const ex = exchange!;
  const response: JevResponse = { ...ex.response, answers: ex.answers };
  const results: QuestionResult[] = scored.map((id) => {
    const expected = normalizeExpected(c.expected![id]!);
    const q = ex.questions[id]!;
    if (q.type === 'noul') {
      const r = resolveNoul(response, id);
      return { question: id, expected, got: r.value, agree: r.value === expected, probabilities: { true: r.probability } };
    }
    const r = resolveChoice(ex.questions, response, id);
    const dec = rebuilt.decode[id] ?? ((o: string) => o);
    const got = dec(r.option);
    const probabilities = Object.fromEntries(Object.entries(r.probabilities).map(([k, p]) => [dec(k), p]));
    return { question: id, expected, got, agree: got === expected, probabilities };
  });
  return { ...base, status: 'scored', results, jevModel: ex.calls.at(-1)?.model ?? ex.jevModel };
}

async function pool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

/** Replays the current policy of `skillDir` against its cases through Jev. Jev failures are exit 2. */
export async function runEvals(options: RunEvalsOptions): Promise<EvalRun> {
  const rp = loadReplayPolicy(options.skillDir);
  const casesFile = options.casesFile ?? join(options.skillDir, 'evals', 'cases.json');
  if (!existsSync(casesFile)) throw refused(`no cases file at ${casesFile}`);
  const split = options.split ?? 'all';
  const threshold = readThreshold(options.thresholdFile ?? join(options.skillDir, 'evals', 'threshold.json'));
  const all = readCasesFile(casesFile, rp.policy.name).cases;
  const cases = split === 'all' ? all : all.filter((c) => c.split === split);
  const providers = options.providers ?? loadProviders();
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const ask = async (state: string, questions: JevQuestions, into?: JevExchange): Promise<JevExchange> => {
    const ex = await askJev(rp.policy.name, state, questions, {
      providers,
      policy: rp.policy,
      ...(options.client ? { client: options.client } : {}),
      ...(into ? { into } : {}),
    });
    const call = ex.calls.at(-1)!;
    calls++;
    inputTokens += call.usage.input_tokens;
    outputTokens += call.usage.output_tokens;
    return ex;
  };
  const results = await pool(cases, options.concurrency ?? 4, (c) => replayCase(rp, c, ask));

  const agreement: EvalRun['agreement'] = {};
  const tally = (q: string, s: Split | 'all', agree: boolean) => {
    agreement[q] ??= { dev: { agreed: 0, total: 0 }, 'held-out': { agreed: 0, total: 0 }, all: { agreed: 0, total: 0 } };
    agreement[q][s].total++;
    if (agree) agreement[q][s].agreed++;
  };
  for (const r of results) {
    for (const q of r.results) {
      for (const key of [q.question, 'all']) {
        tally(key, r.split, q.agree);
        tally(key, 'all', q.agree);
      }
    }
  }
  const held = agreement.all?.['held-out'];
  const rate = held && held.total ? held.agreed / held.total : null;
  return {
    skill: rp.policy.name,
    hash: rp.policy.hash,
    date: (options.now ?? new Date()).toISOString(),
    casesFile,
    split,
    jevModel: providers.jev.model,
    answeredBy: [...new Set(results.flatMap((r) => (r.jevModel ? [r.jevModel] : [])))],
    cases: results,
    agreement,
    threshold,
    heldOut: { rate, pass: rate === null ? null : rate >= threshold },
    usage: { calls, input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ---- reporting ----------------------------------------------------------------------------------------------------

function pct(t: Tally | undefined): string {
  if (!t || t.total === 0) return '-';
  return `${t.agreed}/${t.total} (${Math.round((t.agreed / t.total) * 100)}%)`;
}

function topProbabilities(p: Record<string, number>, n = 4): string {
  return Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ');
}

/** Question ids in a stable order: the router's and landing's first, then any other, "all" last. */
function questionOrder(run: EvalRun): string[] {
  const known = ['model', 'effort', 'provider', 'landing_route'];
  const ids = Object.keys(run.agreement).filter((q) => q !== 'all');
  return [...known.filter((q) => ids.includes(q)), ...ids.filter((q) => !known.includes(q)).sort(), ...(run.agreement.all ? ['all'] : [])];
}

function disagreements(run: EvalRun): string[] {
  return run.cases.flatMap((c) =>
    c.results
      .filter((r) => !r.agree)
      .map((r) => `${c.id} (${c.split}, ${c.source}) ${r.question}: expected ${String(r.expected)}, Jev ${String(r.got)} [${topProbabilities(r.probabilities)}]`),
  );
}

function verdictLine(run: EvalRun): string {
  if (run.heldOut.rate === null) return `Held-out agreement: no held-out case scored (threshold ${Math.round(run.threshold * 100)}%)`;
  return `Held-out agreement: ${Math.round(run.heldOut.rate * 100)}% (threshold ${Math.round(run.threshold * 100)}%): ${run.heldOut.pass ? 'pass' : 'FAIL'}`;
}

function counts(run: EvalRun): string {
  const n = (s: CaseResult['status']) => run.cases.filter((c) => c.status === s).length;
  return `${run.cases.length} cases (${n('scored')} scored, ${n('unlabelled')} unlabelled, ${n('stale')} stale), split ${run.split}`;
}

/** The text a run prints. */
export function formatRun(run: EvalRun): string {
  const lines = [`${run.skill} ${run.hash.slice(0, 12)}: ${counts(run)}`, ''];
  const rows = questionOrder(run).map((q) => [q === 'all' ? 'all questions' : q, pct(run.agreement[q]?.dev), pct(run.agreement[q]?.['held-out']), pct(run.agreement[q]?.all)]);
  const table = [['question', 'dev', 'held-out', 'all'], ...rows];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  for (const r of table) lines.push(`  ${r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()}`);
  const dis = disagreements(run);
  lines.push('', dis.length ? 'Disagreements:' : 'Disagreements: none');
  for (const d of dis) lines.push(`  ${d}`);
  const unlabelled = run.cases.filter((c) => c.status === 'unlabelled');
  if (unlabelled.length) lines.push('', `Unlabelled (not scored; set "expected" to label): ${unlabelled.map((c) => c.id).join(', ')}`);
  const stale = run.cases.filter((c) => c.status === 'stale');
  if (stale.length) {
    lines.push('', 'Stale (the current policy cannot ask them; not scored):');
    for (const c of stale) lines.push(`  ${c.id}: ${c.reason}`);
  }
  lines.push('', verdictLine(run));
  // Machine-readable lines for Skillio's runner contract: "<split> agreement: <n>%" per split, then the bare
  // "agreement:" line for the split this run was asked for.
  const rate = (t?: Tally) => (t && t.total ? `${Math.round((t.agreed / t.total) * 100)}%` : 'n/a');
  const overall = run.agreement.all;
  lines.push(`held-out agreement: ${rate(overall?.['held-out'])}`, `tuning agreement: ${rate(overall?.dev)}`, `all agreement: ${rate(overall?.all)}`);
  lines.push(`agreement: ${rate(run.split === 'dev' ? overall?.dev : run.split === 'held-out' ? overall?.['held-out'] : overall?.all)}`);
  return lines.join('\n');
}

/** evals/RESULTS.md of a run. */
export function resultsMarkdown(run: EvalRun, relativeTo?: string): string {
  const casesFile = relativeTo ? relative(relativeTo, run.casesFile) || run.casesFile : run.casesFile;
  const lines = [
    `# Eval results: ${run.skill}`,
    '',
    `- Date: ${run.date}`,
    `- Skill hash: \`${run.hash}\``,
    `- Cases: ${counts(run)} from \`${casesFile}\``,
    `- Jev: ${run.jevModel}${run.answeredBy.length ? ` (answered by ${run.answeredBy.join(', ')})` : ''}, ${run.usage.calls} calls, ${run.usage.input_tokens} input and ${run.usage.output_tokens} output tokens`,
    `- ${verdictLine(run)}`,
    '',
    '## Agreement',
    '',
    '| question | dev | held-out | all |',
    '| --- | --- | --- | --- |',
    ...questionOrder(run).map((q) => `| ${q === 'all' ? '**all questions**' : q} | ${pct(run.agreement[q]?.dev)} | ${pct(run.agreement[q]?.['held-out'])} | ${pct(run.agreement[q]?.all)} |`),
    '',
    '## Disagreements',
    '',
  ];
  const dis = disagreements(run);
  lines.push(...(dis.length ? dis.map((d) => `- ${d}`) : ['None.']));
  const unlabelled = run.cases.filter((c) => c.status === 'unlabelled');
  lines.push('', '## Unlabelled', '', ...(unlabelled.length ? unlabelled.map((c) => `- ${c.id} (${c.split}, ${c.source})`) : ['None.']));
  const stale = run.cases.filter((c) => c.status === 'stale');
  lines.push('', '## Stale', '', ...(stale.length ? stale.map((c) => `- ${c.id}: ${c.reason}`) : ['None.']));
  return `${lines.join('\n')}\n`;
}

// ---- the runner's command line (evals/run.mjs) -----------------------------------------------------------------

export const RUN_USAGE = 'node evals/run.mjs [--cases FILE] [--split held-out|dev|all] [--results FILE] [--json] [--runtime DIST]';

interface RunnerIo {
  out(text: string): void;
  err(text: string): void;
}

const processRunnerIo: RunnerIo = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

function parseRunnerArgs(argv: readonly string[]): { cases?: string; split: SplitFilter; results?: string; json: boolean; help: boolean } {
  const out: { cases?: string; split: SplitFilter; results?: string; json: boolean; help: boolean } = { split: 'all', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const value = (): string => {
      if (eq > 0 && a.startsWith('--')) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw refused(`${name} needs a value (${RUN_USAGE})`);
      return v;
    };
    if (name === '--cases') out.cases = value();
    else if (name === '--results') out.results = value();
    else if (name === '--runtime') value(); // read by run.mjs itself
    else if (name === '--split') {
      // Skillio's runner contract names the dev split "tuning".
      const raw = value();
      const v = raw === 'tuning' ? 'dev' : raw;
      if (v !== 'all' && !(SPLITS as readonly string[]).includes(v)) throw refused(`--split is held-out, dev (tuning) or all, not ${v}`);
      out.split = v as SplitFilter;
    } else if (name === '--json') out.json = true;
    else if (name === '--help' || name === '-h') out.help = true;
    else throw refused(`unknown argument ${a} (${RUN_USAGE})`);
  }
  return out;
}

/**
 * evals/run.mjs: replays the policy of `skillDir`, prints the agreement and the disagreements, writes
 * evals/RESULTS.md (or --results) and returns the exit code: 0, 1 when held-out agreement is below the threshold,
 * 2 when the run cannot be made (no key, a Jev failure, an invalid cases file).
 */
export async function runEvalsMain(
  skillDir: string,
  argv: readonly string[],
  extra: Pick<RunEvalsOptions, 'client' | 'providers' | 'now' | 'concurrency'> & { io?: RunnerIo } = {},
): Promise<number> {
  const io = extra.io ?? processRunnerIo;
  try {
    const args = parseRunnerArgs(argv);
    if (args.help) {
      io.out(RUN_USAGE);
      return 0;
    }
    const cwd = process.cwd();
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
    const run = await runEvals({
      skillDir,
      ...(args.cases ? { casesFile: abs(args.cases) } : {}),
      split: args.split,
      ...(extra.client ? { client: extra.client } : {}),
      ...(extra.providers ? { providers: extra.providers } : {}),
      ...(extra.now ? { now: extra.now } : {}),
      ...(extra.concurrency ? { concurrency: extra.concurrency } : {}),
    });
    const resultsFile = args.results ? abs(args.results) : join(skillDir, 'evals', 'RESULTS.md');
    mkdirSync(dirname(resultsFile), { recursive: true });
    writeFileSync(resultsFile, resultsMarkdown(run, dirname(resultsFile)));
    if (args.json) io.out(JSON.stringify({ ...run, resultsFile }, null, 2));
    else io.out(`${formatRun(run)}\nWrote ${resultsFile}`);
    return run.heldOut.pass === false ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`evals: ${message}`);
    return error instanceof JvError ? error.exitCode : 1;
  }
}
