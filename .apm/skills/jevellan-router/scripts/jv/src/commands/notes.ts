// jv notes write --project N < text: replaces the project's notes.md (src/notes.ts). jv notes show --project N
// prints them.

import type { CommandIo, ParsedArgs } from '../command.js';
import { requireFlag } from '../command.js';
import { refused } from '../errors.js';
import { readNotes } from '../handoff.js';
import { readStdin, writeNotes } from '../notes.js';
import { paths } from '../paths.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  const projectFlag = requireFlag(args, 'project');
  const store = openStore();
  let name: string;
  try {
    name = store.requireProject(projectFlag).name;
  } finally {
    store.close();
  }
  if (sub === 'write') {
    const text = await readStdin();
    const r = writeNotes(name, text);
    io.result(
      { project: name, file: r.file, bytes: r.bytes, unchanged: r.unchanged, ...(r.archived ? { archived: r.archived } : {}) },
      r.unchanged ? `Notes of ${name} unchanged (${r.file}).` : `Notes of ${name} written (${r.bytes} bytes, ${r.file}).`,
    );
    return 0;
  }
  if (sub === 'show' || sub === undefined) {
    const notes = readNotes(name);
    io.result({ project: name, file: paths.projectNotes(name), notes }, notes.trim() === '' ? `No notes for ${name} yet.` : notes);
    return 0;
  }
  throw refused(`unknown subcommand "jv notes ${sub}" (write or show)`);
}
