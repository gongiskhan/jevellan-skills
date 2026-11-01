// The one route of the viewer that reads a file other than the store: report screenshots, served from
// <task worktree>/.jv-evidence/ and nowhere else.
//
// A request /evidence/<task id>/<path under .jv-evidence> is served only when every rule holds:
// - the task exists and has a worktree_path;
// - every path segment, once decoded, is a plain name (no empty, ".", "..", slash, backslash or NUL);
// - the file and the evidence folder resolve (symlinks followed) to a file inside that folder, and the folder itself
//   resolves inside the worktree (a .jv-evidence symlink pointing elsewhere serves nothing);
// - it is a regular file of at most 32 MB, its extension is an image extension, and its first bytes are the
//   signature of an image type, which is the type it is served as (a text file named .png is not served).
// Anything else is a 404 that names no path.

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { EVIDENCE_DIR, isInside } from '../paths.js';
import type { TaskRow } from '../types.js';
import type { ReadOnlyStore } from './db.js';
import { IMAGE_EXTENSIONS } from './views.js';

export const EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;

/** The image type the first bytes show, or undefined. */
export function sniffImage(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(head.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return undefined;
}

export interface EvidenceFile {
  file: string;
  size: number;
  contentType: string;
}

/** Decodes and checks the path segments of a request; undefined when any is not a plain name. */
export function evidenceSegments(rawPath: string): string[] | undefined {
  if (rawPath === '') return undefined;
  const out: string[] = [];
  for (const raw of rawPath.split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (seg === '' || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

function head(file: string): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** The file a request names, when every rule of the header holds; undefined otherwise. */
export function resolveEvidence(db: ReadOnlyStore, taskId: string, rawPath: string): EvidenceFile | undefined {
  const task = db.get<Pick<TaskRow, 'id' | 'worktree_path'>>('SELECT id, worktree_path FROM tasks WHERE id = ?', taskId);
  if (!task?.worktree_path) return undefined;
  const segments = evidenceSegments(rawPath);
  if (!segments) return undefined;
  const ext = extname(segments.at(-1)!).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) return undefined;
  try {
    const worktree = realpathSync(task.worktree_path);
    const dir = realpathSync(join(task.worktree_path, EVIDENCE_DIR));
    if (!isInside(dir, worktree)) return undefined;
    const file = realpathSync(join(task.worktree_path, EVIDENCE_DIR, ...segments));
    if (!isInside(file, dir)) return undefined;
    if (!IMAGE_EXTENSIONS.includes(extname(file).toLowerCase())) return undefined;
    const st = statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > EVIDENCE_MAX_BYTES) return undefined;
    // The signature decides the type it is served as (a PNG saved as .jpg is still a PNG).
    const sniffed = sniffImage(head(file));
    if (!sniffed) return undefined;
    return { file, size: st.size, contentType: sniffed };
  } catch {
    return undefined;
  }
}
