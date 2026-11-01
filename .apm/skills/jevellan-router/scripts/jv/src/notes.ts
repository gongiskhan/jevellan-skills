// The coordinator's notes (section 1 and 9.2): ~/.jv/projects/<name>/notes.md, replaced whole by
// `jv notes write --project N < text`.
//
// - The new text replaces the file atomically (temporary file, then rename), so a reader never sees half a file.
// - The previous version is moved to ~/.jv/archive/<project>/notes/notes-<time>.md first: archive, never delete.
// - Empty input is refused: `jv notes write` run with nothing on stdin would otherwise wipe the notes. To clear them,
//   write a line that says so ("No notes.").
// - Loaded secrets are masked before the text is written (the redactor of src/redact.ts).

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { refused } from './errors.js';
import { paths } from './paths.js';
import { redact } from './redact.js';

export const NOTES_MAX_BYTES = 256 * 1024;

export interface WriteNotesResult {
  file: string;
  bytes: number;
  /** Where the previous notes were archived, when there were any and they differed. */
  archived?: string;
  unchanged: boolean;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Replaces the notes of `projectName` with `text`. Refuses empty or oversized text. */
export function writeNotes(projectName: string, text: string, options: { now?: Date } = {}): WriteNotesResult {
  if (text.trim() === '') {
    throw refused('jv notes write read no text on stdin; the notes are unchanged (to clear them, write a line such as "No notes.")');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > NOTES_MAX_BYTES) throw refused(`the notes are ${bytes} bytes; at most ${NOTES_MAX_BYTES} are kept`);
  const content = redact(text.endsWith('\n') ? text : `${text}\n`);
  const file = paths.projectNotes(projectName);
  mkdirSync(dirname(file), { recursive: true });
  let previous: string | undefined;
  try {
    previous = readFileSync(file, 'utf8');
  } catch {
    previous = undefined;
  }
  if (previous === content) return { file, bytes: Buffer.byteLength(content), unchanged: true };
  let archived: string | undefined;
  if (previous !== undefined && previous.trim() !== '') {
    const dir = join(paths.projectArchiveDir(projectName), 'notes');
    mkdirSync(dir, { recursive: true });
    const now = options.now ?? new Date();
    archived = join(dir, `notes-${stamp(now)}.md`);
    for (let n = 1; existsSync(archived); n++) archived = join(dir, `notes-${stamp(now)}-${n}.md`);
    copyFileSync(file, archived);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(content), ...(archived ? { archived } : {}), unchanged: false };
}

/** Reads all of stdin as UTF-8 text. Refuses when stdin is a terminal (nothing was piped in). */
export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) throw refused('jv notes write reads the notes from stdin: jv notes write --project N < notes.md');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
