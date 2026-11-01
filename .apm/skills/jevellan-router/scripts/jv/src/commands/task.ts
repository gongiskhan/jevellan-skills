// jv task create|show|message|answer|stop|resume|override (section 3). Argument parsing and output only; the work is
// in src/tasks.ts.
//
//   jv task create --project N --kind feature|bug|automation|single [--duty D] --title T (--text "..." | --file F)
//                  [--parent T] [--after T] [--visible] [--request-id ID]
//   jv task show T
//   jv task message T "text"
//   jv task answer T "<option label or text>"
//   jv task stop T [--discard]
//   jv task resume T
//   jv task override T --model M [--effort E] [--provider P] --undo|--keep

import { readFileSync } from 'node:fs';
import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagString, requireFlag, requirePositional } from '../command.js';
import { refused } from '../errors.js';
import { openStore, type Store } from '../store.js';
import {
  answerTask,
  createTask,
  formatTaskView,
  messageTask,
  overrideTask,
  requireTaskId,
  resumeTask,
  stopTask,
  taskView,
  type CreateTaskResult,
} from '../tasks.js';

const SUBCOMMANDS = ['create', 'show', 'message', 'answer', 'stop', 'resume', 'override'] as const;

function rest(args: ParsedArgs, from: number, what: string): string {
  const text = args.positionals.slice(from).join(' ').trim();
  if (text === '') throw refused(`${what} is required`);
  return text;
}

function formatCreated(r: CreateTaskResult): string {
  const lines = [
    `Workflow: ${r.workflow.source === 'single' ? 'single (one step)' : r.workflow.source}`,
    `Task ${r.task.id}: ${r.task.title} (${r.task.kind})${r.created ? '' : ' - already created by this request'}`,
    `State ${r.task.state}: ${r.task.state_reason}`,
  ];
  if (r.task.worktree_path) lines.push(`Worktree ${r.task.worktree_path} on ${r.task.branch}`);
  for (const s of r.steps) lines.push(`  ${s.ordinal}. ${s.duty} - ${s.state}${s.state_reason && s.state !== 'pending' ? `: ${s.state_reason}` : ''}`);
  if (r.start?.state === 'started') {
    const p = r.start.placement;
    lines.push(`Started step ${r.start.step.ordinal} (${r.start.step.duty}) as ${r.start.session.id}: ${p.model} ${p.effort} on ${p.provider} (${p.runtime}), decision ${p.decisionId}`);
  }
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
  return lines.join('\n');
}

async function create(store: Store, args: ParsedArgs, io: CommandIo): Promise<number> {
  const textFlag = flagString(args, 'text');
  const file = flagString(args, 'file');
  if (textFlag !== undefined && file !== undefined) throw refused('give the task text with --text or --file, not both');
  let text: string;
  if (file !== undefined) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw refused(`cannot read --file ${file}`);
    }
  } else if (textFlag !== undefined) text = textFlag;
  else throw refused('the task text is required: --text "..." or --file F');
  const parent = flagString(args, 'parent');
  const after = flagString(args, 'after');
  const duty = flagString(args, 'duty');
  const requestId = flagString(args, 'request-id');
  const result = await createTask(store, {
    project: requireFlag(args, 'project'),
    kind: requireFlag(args, 'kind'),
    title: requireFlag(args, 'title'),
    text,
    visible: flagBool(args, 'visible'),
    ...(duty !== undefined ? { duty } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  });
  io.result(
    {
      task: result.task,
      steps: result.steps,
      created: result.created,
      workflow: result.workflow,
      ...(result.questions ? { questions: result.questions } : {}),
      ...(result.start ? { start: result.start } : {}),
      warnings: result.warnings,
    },
    () => formatCreated(result),
  );
  return 0;
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw refused(`jv task needs one of: ${SUBCOMMANDS.join(', ')}`);
  }
  const store = openStore();
  try {
    if (sub === 'create') return await create(store, args, io);
    const id = requirePositional(args, 1, `the task id (jv task ${sub} T)`);
    switch (sub) {
      case 'show': {
        const view = taskView(store, requireTaskId(store, id));
        io.result(view, () => formatTaskView(view));
        return 0;
      }
      case 'message': {
        const r = await messageTask(store, id, rest(args, 2, 'the message text'));
        const how = {
          typed: `typed into the live session ${r.session}`,
          'next-turn': `delivered when the turn of ${r.session} ends`,
          resumed: `the task was waiting; resumed as ${r.session}`,
          'next-run': 'delivered with the next run of the task',
        }[r.delivery];
        io.result(r, `Message ${r.message.id} stored: ${how}.`);
        return 0;
      }
      case 'answer': {
        const r = await answerTask(store, id, rest(args, 2, 'the answer'));
        const text = r.session
          ? `Answer "${r.answer}" sent; the session continues as ${r.session}.`
          : r.stopped
            ? `Left it: task ${r.stopped.task.id} is stopped; the worktree stays.`
            : `Land now: ${JSON.stringify(r.landing)}`;
        io.result(r, text);
        return 0;
      }
      case 'stop': {
        const r = await stopTask(store, id, { discard: flagBool(args, 'discard') });
        io.result(r, `${r.stopped.length ? `Stopped ${r.stopped.join(', ')}.` : 'Nothing was running.'} Task ${r.task.id} is ${r.task.state}: ${r.task.state_reason}`);
        return 0;
      }
      case 'resume': {
        const r = await resumeTask(store, id);
        io.result(r, `Task ${r.task.id} ${r.how === 'native' ? `resumed natively as ${r.session}` : r.how === 'placed' ? `placed and started as ${r.session}` : r.how}: ${r.task.state_reason}`);
        return 0;
      }
      case 'override': {
        const undo = flagBool(args, 'undo');
        const keep = flagBool(args, 'keep');
        if (undo === keep) throw refused('jv task override needs exactly one of --undo or --keep');
        const effort = flagString(args, 'effort');
        const provider = flagString(args, 'provider');
        const r = await overrideTask(store, id, {
          model: requireFlag(args, 'model'),
          mode: undo ? 'undo' : 'keep',
          ...(effort !== undefined ? { effort } : {}),
          ...(provider !== undefined ? { provider } : {}),
        });
        const p = r.placement;
        io.result(
          r,
          r.mode === 'keep'
            ? `Override recorded on ${r.overridden}: ${p.model} ${p.effort} on ${p.provider}; the running session continues.`
            : `Override: ${r.stopped ? `stopped ${r.stopped}, ` : ''}restarted on ${p.model} ${p.effort} on ${p.provider} (${p.runtime})${r.session ? ` as ${r.session}` : ''}, decision ${r.decision}.`,
        );
        return 0;
      }
    }
    return 0;
  } finally {
    store.close();
  }
}
