// Workflows (sections 7.1 and 7.7): the steps a task of a kind runs, resolved once at task creation and stored in the
// task's workflow_json.
//
// Resolution: `single` is one step with the duty given by --duty (no instructions, always). Every other kind reads
// ~/.jv/projects/<name>/workflows/<kind>.json when the project has one, else the package default
// ~/.jv/skills/jevellan-workflow-<kind>/workflow.json. The file used is returned so jv task create can print it.
//
// A workflow file: {"name": "<kind>", "steps": [{"duty", "when"?, "instructions"?, "onFail"?, "visible"?}]}.
// - when: "always" (the default) or "jev:<question id>" (a workflow question of section 7.5);
// - onFail: {"goto": "<duty of this step or an earlier one>", "maxLoops": <0..10, default 2>};
// - visible: the step runs on claude-tmux even when the task is not visible (7.7).
// Unknown keys are refused, so a typo never silently drops a rule; every duty must be installed as a duty skill.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { refused } from './errors.js';
import { paths } from './paths.js';
import { TASK_KINDS, type TaskKind } from './types.js';
import type { NewStep } from './store.js';

export const DEFAULT_MAX_LOOPS = 2;
const DUTY = /^[a-z][a-z0-9-]{0,39}$/;
const WHEN = /^(always|jev:[A-Za-z_][A-Za-z0-9_]{0,63})$/;

const OnFailSchema = z.strictObject({
  goto: z.string().regex(DUTY, 'a duty name'),
  maxLoops: z.number().int().min(0).max(10).default(DEFAULT_MAX_LOOPS),
});

const StepSchema = z.strictObject({
  duty: z.string().regex(DUTY, 'a duty name (lower case letters, digits and dashes)'),
  when: z.string().regex(WHEN, '"always" or "jev:<question id>"').default('always'),
  instructions: z.string().max(8000).default(''),
  onFail: OnFailSchema.optional(),
  visible: z.boolean().optional(),
});

const WorkflowSchema = z.strictObject({
  name: z.string().min(1).max(64),
  steps: z.array(StepSchema).min(1).max(20),
});

export type OnFail = z.output<typeof OnFailSchema>;
export type WorkflowStep = z.output<typeof StepSchema>;
export type Workflow = z.output<typeof WorkflowSchema>;

export interface ResolvedWorkflow {
  workflow: Workflow;
  /** The file the workflow came from, or "single" for a single task. */
  source: string;
}

/** Validates a workflow (parsed JSON). Exit 2 naming the file and the first problem. */
export function parseWorkflow(raw: unknown, file: string): Workflow {
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? issue.path.join('.') : 'the file';
    throw refused(`${file}: ${where}: ${issue.message}`);
  }
  const wf = parsed.data;
  wf.steps.forEach((s, i) => {
    if (!s.onFail) return;
    const target = wf.steps.slice(0, i + 1).some((e) => e.duty === s.onFail!.goto);
    if (!target) throw refused(`${file}: steps.${i}.onFail.goto names ${s.onFail.goto}, which is not this step or an earlier one`);
  });
  return wf;
}

function readWorkflowFile(file: string): Workflow {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseWorkflow(raw, file);
}

/** The package default of a kind: ~/.jv/skills/jevellan-workflow-<kind>/workflow.json. */
export function defaultWorkflowFile(kind: string, skillsDir: string = paths.skillsDir): string {
  return join(skillsDir, `jevellan-workflow-${kind}`, 'workflow.json');
}

/** The duty skill file a step needs (~/.jv/skills/jevellan-duty-<duty>/SKILL.md). */
export function dutySkillFile(duty: string, skillsDir: string = paths.skillsDir): string {
  return join(skillsDir, `jevellan-duty-${duty}`, 'SKILL.md');
}

export interface ResolveWorkflowInput {
  project: string;
  kind: string;
  duty?: string;
  skillsDir?: string;
}

/** Resolves the workflow of a new task (7.1, 7.7). Exit 2 for an unknown kind, a missing duty or an invalid file. */
export function resolveWorkflow(input: ResolveWorkflowInput): ResolvedWorkflow {
  const skillsDir = input.skillsDir ?? paths.skillsDir;
  if (!(TASK_KINDS as readonly string[]).includes(input.kind)) {
    throw refused(`unknown kind "${input.kind}" (one of: ${TASK_KINDS.join(', ')})`);
  }
  const kind = input.kind as TaskKind;
  let resolved: ResolvedWorkflow;
  if (kind === 'single') {
    if (input.duty === undefined || input.duty === '') throw refused('--kind single needs --duty D (the one duty the task runs)');
    if (!DUTY.test(input.duty)) throw refused(`unknown duty "${input.duty}"`);
    resolved = { workflow: { name: 'single', steps: [{ duty: input.duty, when: 'always', instructions: '' }] }, source: 'single' };
  } else {
    if (input.duty !== undefined) throw refused(`--duty is for --kind single only; a ${kind} task runs its workflow`);
    const override = paths.projectWorkflow(input.project, kind);
    const file = existsSync(override) ? override : defaultWorkflowFile(kind, skillsDir);
    if (!existsSync(file)) throw refused(`no workflow for ${kind}: neither ${override} nor ${file} exists; run jv update`);
    resolved = { workflow: readWorkflowFile(file), source: file };
  }
  for (const s of resolved.workflow.steps) {
    if (!existsSync(dutySkillFile(s.duty, skillsDir))) {
      throw refused(`the workflow ${resolved.source} uses the duty ${s.duty}, and no duty skill ${dutySkillFile(s.duty, skillsDir)} is installed`);
    }
  }
  return resolved;
}

/** The steps rows of a workflow (ordinal from 1, when_rule, on_fail_json). */
export function workflowSteps(taskId: string, workflow: Workflow): NewStep[] {
  return workflow.steps.map((s, i) => ({
    task_id: taskId,
    ordinal: i + 1,
    duty: s.duty,
    instructions: s.instructions,
    when_rule: s.when,
    on_fail_json: s.onFail ? JSON.stringify({ goto: s.onFail.goto, maxLoops: s.onFail.maxLoops }) : null,
  }));
}

/** The workflow stored on a task (its workflow_json), or undefined when it cannot be read. */
export function storedWorkflow(workflowJson: string): Workflow | undefined {
  try {
    const raw = JSON.parse(workflowJson) as Record<string, unknown> | null;
    // jv task create stores the workflow with the file it came from ("source").
    const { source: _source, ...workflow } = raw && typeof raw === 'object' ? raw : {};
    const parsed = WorkflowSchema.safeParse(workflow);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the workflow marks the step at `ordinal` visible ("visible": true on the step). */
export function stepVisible(workflowJson: string, ordinal: number): boolean {
  return storedWorkflow(workflowJson)?.steps[ordinal - 1]?.visible === true;
}

/** A step's on_fail rule, or undefined. */
export function parseOnFail(onFailJson: string | null): OnFail | undefined {
  if (!onFailJson) return undefined;
  try {
    const parsed = OnFailSchema.safeParse(JSON.parse(onFailJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
