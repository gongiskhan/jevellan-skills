// jv doctor [--check NAME ...]: the preflights of section 11, one line each (OK, WARN or FAIL with the fix).
// --json prints {ok, checks: [{name, status, detail, fix?}]}. Exit 0 when nothing failed, 2 when a check is FAIL.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagStrings } from '../command.js';
import { formatCheck, runChecks } from '../doctor.js';
import { refused } from '../errors.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const names = [...flagStrings(args, 'check'), ...args.positionals];
  let checks;
  try {
    checks = await runChecks(names);
  } catch (error) {
    throw refused(error instanceof Error ? error.message : String(error));
  }
  const failed = checks.some((c) => c.status === 'FAIL');
  io.result({ ok: !failed, checks }, () => checks.map(formatCheck).join('\n'));
  return failed ? 2 : 0;
}
