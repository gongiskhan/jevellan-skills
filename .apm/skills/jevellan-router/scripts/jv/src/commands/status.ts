// jv status [--project N]: tasks and sessions that are not done, waiting-on-owner first (src/status.ts). Lost runs
// are marked at read time. --json is the shape the coordinator reads.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { formatStatus, statusView } from '../status.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const project = flagString(args, 'project') ?? args.positionals[0];
  const store = openStore();
  try {
    const view = statusView(store, project ? { project } : {});
    io.result(view, () => formatStatus(view));
    return 0;
  } finally {
    store.close();
  }
}
