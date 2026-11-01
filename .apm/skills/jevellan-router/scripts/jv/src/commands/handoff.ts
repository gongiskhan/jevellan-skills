// jv handoff --project N: prints the handoff (section 9.5) a new coordinator session starts from.

import type { CommandIo, ParsedArgs } from '../command.js';
import { requireFlag } from '../command.js';
import { buildHandoff, formatHandoff } from '../handoff.js';
import { redact, redactValue } from '../redact.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const project = requireFlag(args, 'project');
  const store = openStore();
  try {
    const handoff = buildHandoff(store, project);
    io.result(redactValue(handoff), () => redact(formatHandoff(handoff)));
    return 0;
  } finally {
    store.close();
  }
}
