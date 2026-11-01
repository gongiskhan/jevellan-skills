// jv gc [--project N] [--dry-run]: archives the worktrees of landed or discarded tasks older than project.json
// retentionDays (see src/gc.ts). --json lists every action.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagString } from '../command.js';
import { formatGc, gc } from '../gc.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const project = flagString(args, 'project');
  const dryRun = flagBool(args, 'dry-run');
  const store = openStore();
  try {
    const actions = await gc(store, { ...(project ? { project } : {}), dryRun });
    io.result({ dryRun, actions }, () => formatGc(actions));
    return 0;
  } finally {
    store.close();
  }
}
