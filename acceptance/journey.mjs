// The acceptance journeys' common frame (brief section 15): every journey script jNN-<slug>.mjs runs its checks
// through lib.mjs check(), then calls finish(), which writes acceptance/results/JNN.json:
//
//   {"id": "J1", "title", "status": "pass"|"fail"|"skipped", "startedAt", "endedAt",
//    "checks": [{"name", "ok", "evidence"}], "elapsed": {...}, "deviations": [...], "notes": "..."}
//
// File names are zero-padded (j01-install.mjs, results/J01.json) so they sort; the id inside is "J1". Every journey
// takes --tag <text> (the request id suffix of any task it creates, so a rerun reuses the same tasks instead of
// duplicating them); a journey that creates no task accepts it and records it.
//
// After writing the JSON, finish() runs results.mjs so acceptance/RESULTS.md is current, and exits 0 on pass, 1 on
// fail. --note "text" (repeatable) adds a note to the result.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkResults, log } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, 'results');

export function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export function flag(name) {
  return process.argv.includes(name);
}

/** Starts a journey: its number, title, and the frame that collects elapsed times, deviations and notes. */
export function journey(number, title) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const tag = arg('--tag', '');
  const elapsed = {};
  const deviations = [];
  const notes = [];
  // --note "text" (repeatable): a note from whoever ran the journey, e.g. what an earlier run found.
  process.argv.forEach((a, i) => {
    if (a === '--note' && process.argv[i + 1]) notes.push(process.argv[i + 1]);
  });
  const marks = new Map();
  log(`J${number} ${title}; tag ${tag || '(none)'}`);
  return {
    number,
    tag,
    /** Starts timing a named phase of the journey. */
    start(name) {
      marks.set(name, Date.now());
    },
    /** Ends timing a named phase; elapsed[name] is in milliseconds. */
    stop(name) {
      const s = marks.get(name);
      if (s !== undefined) elapsed[`${name}Ms`] = Date.now() - s;
    },
    set(name, value) {
      elapsed[name] = value;
    },
    deviation(text) {
      if (!deviations.includes(text)) deviations.push(text);
      log(`deviation: ${text}`);
    },
    note(text) {
      notes.push(text);
      log(`note: ${text}`);
    },
    /**
     * Writes results/JNN.json, rebuilds RESULTS.md, and exits. status "skipped" only with a reason. `tables`
     * ([{title, columns, rows}]) are rendered by results.mjs after the checks.
     */
    finish({ skipped, tables } = {}) {
      const checks = checkResults().map((c) => ({ name: c.name, ok: c.ok, evidence: c.detail, at: c.at }));
      const failed = checks.filter((c) => !c.ok).length;
      const status = skipped ? 'skipped' : failed === 0 && checks.length > 0 ? 'pass' : 'fail';
      if (skipped) notes.push(`skipped: ${skipped}`);
      elapsed.totalMs = Date.now() - t0;
      const result = {
        id: `J${number}`,
        title,
        status,
        startedAt,
        endedAt: new Date().toISOString(),
        ...(tag ? { tag } : {}),
        checks,
        elapsed,
        deviations,
        notes: notes.join('\n'),
        ...(tables?.length ? { tables } : {}),
      };
      mkdirSync(RESULTS_DIR, { recursive: true });
      const file = join(RESULTS_DIR, `J${String(number).padStart(2, '0')}.json`);
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      log(`J${number} ${status}: ${checks.length - failed}/${checks.length} checks passed; wrote ${file}`);
      const r = spawnSync(process.execPath, [join(HERE, 'results.mjs')], { encoding: 'utf8' });
      process.stdout.write(r.stdout ?? '');
      if (r.status !== 0) process.stderr.write(r.stderr ?? '');
      process.exit(status === 'fail' ? 1 : 0);
    },
  };
}
