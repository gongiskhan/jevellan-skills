// jv attach S: the owner takes a session over in tmux (src/attach.ts). In a terminal it attaches; otherwise (the
// coordinator, a script) it prepares the window and prints the command to attach.

import type { CommandIo, ParsedArgs } from '../command.js';
import { requirePositional } from '../command.js';
import { attachSession } from '../attach.js';
import { normalizeId } from '../ids.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const id = normalizeId(requirePositional(args, 0, 'the session id (jv attach S)'));
  const store = openStore();
  try {
    const result = attachSession(store, id, io.json ? { tty: false } : {});
    io.result(result, () => {
      if (result.attached) return result.waiting ? `Detached from ${result.tmuxTarget}. Run jv task resume to continue the task.` : '';
      const lines = [`${result.created ? 'Started' : 'Found'} tmux session ${result.tmuxTarget} for ${result.session} (${result.runtime}).`];
      if (result.waiting) lines.push(`Run ${result.waiting} is waiting (attached by owner).`);
      lines.push(`Attach with: ${result.command.join(' ')}`);
      return lines.join('\n');
    });
    return 0;
  } finally {
    store.close();
  }
}
