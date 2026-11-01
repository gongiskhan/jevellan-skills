// What a worker receives (section 7.4).
//
// The system append (Claude runtimes; the first message for Codex and llm) is, in this order:
//   1. the shared worker rules (7.9) from templates/worker-rules.md, with {{project}} {{cwd}} {{branch}} {{base}}
//      {{visible}} filled, and the duty-dependent parts {{isolation}}, {{report}} and {{work}} (D-037): a read-only
//      duty is not told to commit or save evidence, and an llm duty reports with a fenced block, not jv_report;
//   2. the duty body: ~/.jv/skills/jevellan-duty-<duty>/SKILL.md after its frontmatter;
//   3. the project's AGENTS.md (first 32 KiB; a longer file is cut with a note);
//   4. the task block, exactly as 7.4 shows it.
// The first prompt of a step is START_PROMPT; resume messages are the owner's or coordinator's text verbatim with
// the prefix "From the owner:" or "From the coordinator:".
//
// The duty skill's frontmatter `jv-needs` (a YAML block list or an inline [] list) says what the duty needs; a duty
// without repo-write runs with the read-only tool set (7.3).
//
// Test hook: JV_TEST_WORKER_RULES names another template file. It exists only so the detached `jv run` of the
// launcher tests can run before templates/worker-rules.md is written; nothing else sets it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notFound, refused } from './errors.js';
import { paths, RUNTIME_ROOT } from './paths.js';
import { LLM_DUTIES } from './route.js';
import type { MessageDirection, ProjectRow, ReportRow, StepRow, TaskRow } from './types.js';

export const START_PROMPT = 'Start the step now. End with jv_report.';
export const NO_REPORT_PROMPT = 'You ended without jv_report. Call it now with the correct status.';
export const CONTINUE_PROMPT = 'Continue.';

export const AGENTS_MAX_BYTES = 32 * 1024;
export const AGENTS_CUT_NOTE = '[AGENTS.md is longer than 32 KiB; the rest was cut. Read the file for the full text.]';
export const PREVIOUS_SUMMARY_MAX = 1500;

/** The worker rules template (templates/worker-rules.md of the runtime). */
export function workerRulesFile(): string {
  const override = process.env.JV_TEST_WORKER_RULES;
  if (override !== undefined && override.trim() !== '') return override;
  return join(RUNTIME_ROOT, 'templates', 'worker-rules.md');
}

export interface RuleValues {
  project: string;
  cwd: string;
  branch: string;
  base: string;
  visible: string;
  /** The isolation paragraph (dutyRuleValues); default: the write duties' one. */
  isolation?: string;
  /** The report rule after "Keep the coordinator informed."; default: the jv_report one. */
  report?: string;
  /** Bullets for duties that change the repository (evidence, tests); default: the write duties' ones. */
  work?: string;
}

/** Fills {{name}} placeholders; an unknown placeholder is left as written. */
export function fillPlaceholders(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : whole,
  );
}

/** How a duty may touch the repository: write duties, the read-only ones (plan writes plan.md only), llm duties. */
export type DutyMode = 'write' | 'plan' | 'read-only' | 'llm';

export function dutyMode(duty: string, needs: readonly string[]): DutyMode {
  if (LLM_DUTIES.includes(duty)) return 'llm';
  if (!isReadOnly(needs)) return 'write';
  return duty === 'plan' ? 'plan' : 'read-only';
}

const NO_REMOTE = 'Never push, never open a pull request, never touch main.';

const REPORT_TOOL =
  'End every turn with exactly one jv_report: progress while you are still working, done when the step is complete, blocked when something outside your control stops you, and needs-decision with two to four options when a choice belongs to the owner.';
const REPORT_BLOCK =
  'You have no jv_report tool in this step: end every reply with exactly one fenced json report block, in the format your duty instructions give, and nothing after it.';

const WORK_BULLETS = [
  '- For visual work, capture the affected screens at desktop and phone widths with the available browser tools. Save screenshots under .jv-evidence/ in your worktree and list them in the report with a caption each. Say clearly when a screen could not be checked.',
  '- Run only surgical tests: the ones that cover what you changed, unless your step instructions say to run the project\'s test command.',
].join('\n');

/** The duty-dependent parts of the worker rules (D-037). */
export function dutyRuleValues(mode: DutyMode, branch: string, base: string): Required<Pick<RuleValues, 'isolation' | 'report' | 'work'>> {
  const worktree = `Isolation: your own git worktree on branch ${branch}, based on ${base}. Other steps of this task ran here before you; other tasks work elsewhere.`;
  switch (mode) {
    case 'write':
      return {
        isolation: `${worktree} Commit your work on this branch with the machine's git identity and no attribution of any kind. ${NO_REMOTE}`,
        report: REPORT_TOOL,
        work: WORK_BULLETS,
      };
    case 'plan':
      return {
        isolation: `${worktree} This step writes only plan.md at the worktree root and changes nothing else: no other file, no notes, no evidence, and no commit. ${NO_REMOTE}`,
        report: REPORT_TOOL,
        work: '',
      };
    case 'read-only':
      return {
        isolation: `${worktree} This step changes nothing in this worktree: it creates, edits and deletes no file, saves no evidence and does not commit. ${NO_REMOTE}`,
        report: REPORT_TOOL,
        work: '',
      };
    case 'llm':
      return {
        isolation: 'Isolation: this step has no tools and no access to the repository; it reads, runs and changes nothing.',
        report: REPORT_BLOCK,
        work: '',
      };
  }
}

export function workerRules(values: RuleValues, file: string = workerRulesFile()): string {
  let template: string;
  try {
    template = readFileSync(file, 'utf8');
  } catch {
    throw refused(`the worker rules template ${file} is missing; run jv update`);
  }
  const filled: Record<string, string> = { ...dutyRuleValues('write', values.branch, values.base) };
  for (const [k, v] of Object.entries(values)) if (v !== undefined) filled[k] = v;
  // A placeholder alone on its line that fills to nothing leaves no blank line behind.
  const lines = template.split('\n').filter((line) => {
    const only = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(line);
    return !(only && Object.hasOwn(filled, only[1]!) && filled[only[1]!]!.trim() === '');
  });
  return fillPlaceholders(lines.join('\n'), filled).trim();
}

// ---- skill files ------------------------------------------------------------------------------------------------

/** Splits a SKILL.md into its frontmatter text (without the --- lines) and its body. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[1]!, body: text.slice(m[0].length) };
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/**
 * A list value of simple YAML frontmatter: `key: [a, b]`, `key: []`, or `key:` followed by `  - item` lines.
 * undefined when the key is absent.
 */
export function frontmatterList(frontmatter: string, key: string): string[] | undefined {
  const lines = frontmatter.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*:`).test(l));
  if (at < 0) return undefined;
  const rest = lines[at]!.slice(lines[at]!.indexOf(':') + 1).trim();
  if (rest.startsWith('[')) {
    const inner = rest.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
    return inner === '' ? [] : inner.split(',').map(unquote).filter((s) => s !== '');
  }
  if (rest !== '' && rest !== '|' && rest !== '>') return [unquote(rest)];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      out.push(unquote(item[1]!));
      continue;
    }
    if (line.trim() === '') continue;
    break;
  }
  return out;
}

export interface DutySkill {
  duty: string;
  file: string;
  body: string;
  needs: string[];
}

/** The duty skill jevellan-duty-<duty> from ~/.jv/skills (or `skillsDir`). Exit 3 when it is not installed. */
export function loadDutySkill(duty: string, skillsDir: string = paths.skillsDir): DutySkill {
  if (!/^[a-z][a-z0-9-]*$/.test(duty)) throw refused(`unknown duty "${duty}"`);
  const file = join(skillsDir, `jevellan-duty-${duty}`, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw notFound(`no duty skill ${file}; run jv update`);
  }
  const { frontmatter, body } = splitFrontmatter(text);
  return { duty, file, body: body.trim(), needs: frontmatterList(frontmatter, 'jv-needs') ?? [] };
}

/** A duty that does not write the repository runs with the read-only tool set (7.3). */
export function isReadOnly(needs: readonly string[]): boolean {
  return !needs.includes('repo-write');
}

// ---- project instructions ---------------------------------------------------------------------------------------

/** The cut of a UTF-8 buffer at `max` bytes, moved back to a character boundary. */
function utf8Prefix(buffer: Buffer, max: number): string {
  let end = Math.min(max, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/** AGENTS.md at the project root: the first 32 KiB, a longer file cut with a note. undefined when there is none. */
export function projectInstructions(projectRoot: string, maxBytes: number = AGENTS_MAX_BYTES): string | undefined {
  const file = join(projectRoot, 'AGENTS.md');
  if (!existsSync(file)) return undefined;
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return undefined;
  }
  if (buffer.length <= maxBytes) {
    const text = buffer.toString('utf8').trim();
    return text === '' ? undefined : text;
  }
  return `${utf8Prefix(buffer, maxBytes).trimEnd()}\n\n${AGENTS_CUT_NOTE}`;
}

// ---- the task block ---------------------------------------------------------------------------------------------

export interface EarlierStep {
  duty: string;
  status: string;
  summary: string;
}

export interface TaskBlockInput {
  task: Pick<TaskRow, 'id' | 'title' | 'kind' | 'task_text'>;
  /** 1-based position of the step and the number of steps of the task. */
  position: number;
  total: number;
  duty: string;
  instructions: string;
  earlier: readonly EarlierStep[];
  /** An earlier plan step is done: plan.md is in the worktree root. */
  plan: boolean;
  /** project.json settings the duties read (testCommand, devCommand, automationDir), when set. */
  settings?: ProjectSettings;
}

/** The project.json settings a worker is told about (the verify and automate duties use them). */
export interface ProjectSettings {
  testCommand?: string;
  devCommand?: string;
  automationDir?: string;
}

export const PROJECT_SETTING_KEYS = ['testCommand', 'devCommand', 'automationDir'] as const;

/** The settings of ~/.jv/projects/<name>/project.json that are set (non-empty strings); none when the file is absent. */
export function projectSettings(projectName: string, file: string = paths.projectJson(projectName)): ProjectSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw refused(`${file} is not valid JSON`);
  }
  const out: ProjectSettings = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of PROJECT_SETTING_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return out;
}

function cutChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('').trimEnd()}...`;
}

/**
 * The task block of 7.4:
 *
 *   Task T3: <title>
 *   Kind: feature. Step 2 of 4: implement.
 *
 *   <task text>
 *
 *   Step instructions:
 *   <instructions from the workflow step>
 *
 *   Project settings (project.json):
 *   - testCommand: npm test
 *
 *   Earlier steps of this task:
 *   - plan (done): <summary, up to 1500 characters>
 *   Plan: plan.md in the worktree root.
 *
 * A part with nothing to say (no instructions, no settings, no earlier steps, no plan) is left out. The project
 * settings part is a jv addition: the verify and automate duty bodies read the test and dev commands and the
 * automation folder from it.
 */
export function taskBlock(input: TaskBlockInput): string {
  const parts: string[] = [
    `Task ${input.task.id}: ${input.task.title}\nKind: ${input.task.kind}. Step ${input.position} of ${input.total}: ${input.duty}.`,
    input.task.task_text.trim(),
  ];
  if (input.instructions.trim() !== '') parts.push(`Step instructions:\n${input.instructions.trim()}`);
  const settings = PROJECT_SETTING_KEYS.filter((k) => input.settings?.[k] !== undefined).map((k) => `- ${k}: ${input.settings![k]}`);
  if (settings.length) parts.push(`Project settings (project.json):\n${settings.join('\n')}`);
  const earlier: string[] = [];
  if (input.earlier.length) {
    earlier.push('Earlier steps of this task:');
    for (const e of input.earlier) {
      earlier.push(`- ${e.duty} (${e.status}): ${cutChars(e.summary.replace(/\s+/g, ' ').trim(), PREVIOUS_SUMMARY_MAX)}`);
    }
  }
  if (input.plan) earlier.push('Plan: plan.md in the worktree root.');
  if (earlier.length) parts.push(earlier.join('\n'));
  return parts.filter((p) => p !== '').join('\n\n');
}

// ---- the whole append -------------------------------------------------------------------------------------------

export interface SystemAppendInput {
  project: ProjectRow;
  task: TaskRow;
  step: StepRow;
  /** Every step of the task, in ordinal order. */
  steps: readonly StepRow[];
  /** The newest report of each earlier step, by step id. */
  reports: ReadonlyMap<string, ReportRow>;
  cwd: string;
  /** Base branch of the task (the parent task's branch, else the project's default branch). */
  base: string;
  skillsDir?: string;
  rulesFile?: string;
  /** Default: projectSettings(project.name). */
  settings?: ProjectSettings;
}

export interface WorkerPrompt {
  systemAppend: string;
  duty: DutySkill;
  readOnly: boolean;
}

/** The system append of a step (7.4) and the duty facts the runtime needs. */
export function buildSystemAppend(input: SystemAppendInput): WorkerPrompt {
  const duty = loadDutySkill(input.step.duty, input.skillsDir);
  const branch = input.task.branch ?? input.project.default_branch;
  const rules = workerRules(
    {
      project: input.project.name,
      cwd: input.cwd,
      branch,
      base: input.base,
      visible: input.task.visible ? 'visible' : 'not visible',
      ...dutyRuleValues(dutyMode(duty.duty, duty.needs), branch, input.base),
    },
    input.rulesFile,
  );
  const ordered = [...input.steps].sort((a, b) => a.ordinal - b.ordinal);
  const position = ordered.findIndex((s) => s.id === input.step.id) + 1;
  const earlierSteps = ordered.filter((s) => s.ordinal < input.step.ordinal && s.state !== 'skipped' && s.state !== 'pending');
  const earlier: EarlierStep[] = [];
  for (const s of earlierSteps) {
    const report = input.reports.get(s.id);
    if (!report) continue;
    earlier.push({ duty: s.duty, status: report.status, summary: report.summary });
  }
  const plan = earlierSteps.some((s) => s.duty === 'plan' && s.state === 'done');
  const block = taskBlock({
    task: input.task,
    position: position > 0 ? position : input.step.ordinal,
    total: ordered.length || 1,
    duty: input.step.duty,
    instructions: input.step.instructions,
    earlier,
    plan,
    settings: input.settings ?? projectSettings(input.project.name),
  });
  // The worktree's copy is the one of the task's branch; the checkout's when the cwd has none.
  const agents = projectInstructions(input.cwd) ?? projectInstructions(input.project.path);
  const systemAppend = [rules, duty.body, agents, block].filter((p): p is string => p !== undefined && p.trim() !== '').join('\n\n');
  return { systemAppend, duty, readOnly: isReadOnly(duty.needs) };
}

/** A resume message: the text verbatim, prefixed by who sent it. Answers come from the owner. */
export function resumeMessage(direction: MessageDirection, text: string): string {
  return `${direction === 'coordinator' ? 'From the coordinator:' : 'From the owner:'} ${text.trim()}`;
}
