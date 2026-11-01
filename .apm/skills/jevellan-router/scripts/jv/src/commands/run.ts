// jv run <R> | jv run --session R (internal): the detached process the launcher starts for one run.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { refused } from '../errors.js';
import { normalizeId } from '../ids.js';
import { executeRun } from '../run.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const raw = flagString(args, 'session') ?? args.positionals[0];
  if (!raw) throw refused('jv run <R>: the session id is required');
  const outcome = await executeRun(normalizeId(raw));
  io.result({ session: outcome.session.id, state: outcome.state, reason: outcome.session.state_reason }, '');
  // The run is over and recorded: a handle the SDK or a child left open must not keep this detached process alive.
  setTimeout(() => process.exit(outcome.exitCode), 2000).unref();
  return outcome.exitCode;
}
