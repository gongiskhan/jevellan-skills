// jv bootstrap / jv update when reached through the CLI (bin/jv.mjs normally runs bin/bootstrap.mjs itself):
// runs the plain JS bootstrap of this runtime with the same Node binary.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { CommandIo, ParsedArgs } from '../command.js';
import { RUNTIME_ROOT } from '../paths.js';

export async function run(args: ParsedArgs, _io: CommandIo): Promise<number> {
  const script = join(RUNTIME_ROOT, 'bin', 'bootstrap.mjs');
  const rest = args.raw.slice(args.raw.indexOf(args.command) + 1);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, args.command, ...rest], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}
