// jv land T [--force]: the landing decision and the landing (section 8). Text for people, the result with --json.
//
// Exit codes: 0 when the task landed, waits for its verification before landing, or waits for the owner's answer
// (route ask-owner); 2 when the landing was refused (steps not done, uncommitted changes, Jev could not answer) or
// failed (a check failed, the default branch could not be updated); 3 for an unknown task.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, requirePositional } from '../command.js';
import { EXIT } from '../errors.js';
import { normalizeId } from '../ids.js';
import { formatLandResult, landTask } from '../land.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const id = normalizeId(requirePositional(args, 0, 'the task id (jv land T)'));
  const force = flagBool(args, 'force');
  const store = openStore();
  try {
    if (!io.json) io.info(force ? `Landing ${id} (forced by the owner)...` : `Deciding how ${id} lands...`);
    const result = await landTask(store, id, { force });
    const landing = result.landingId ? store.getLanding(result.landingId) : undefined;
    io.result({ ...result, ...(landing ? { landing } : {}) }, () => formatLandResult(result));
    return result.state === 'failed' || result.state === 'refused' ? EXIT.refused : EXIT.ok;
  } finally {
    store.close();
  }
}
