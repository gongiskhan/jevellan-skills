// jv exec (internal): jv exec (--session R | --provider P) [--project N] [--cwd DIR] -- <command> [args...]
// See src/exec.ts. Prints nothing of its own on success; the exit code is the child's.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { planExec, runExec } from '../exec.js';
import { normalizeId } from '../ids.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, _io: CommandIo): Promise<number> {
  const session = flagString(args, 'session');
  const provider = flagString(args, 'provider');
  const project = flagString(args, 'project');
  const cwd = flagString(args, 'cwd');
  const store = openStore();
  let plan;
  try {
    plan = planExec(store, {
      ...(session ? { sessionId: normalizeId(session) } : {}),
      ...(provider ? { providerName: provider } : {}),
      ...(project ? { projectName: project } : {}),
      ...(cwd ? { cwd } : {}),
      command: args.positionals,
    });
  } finally {
    store.close();
  }
  return runExec(plan);
}
