// jv evals route|landing [--since DATE] [--out FILE] [--json]: exports eval cases from the decisions table into the
// policy skill's evals/cases.json (default: the package's copy, found from $JV_HOME/install.json), merging with the
// cases already there, and prints the counts per source and split. The rules are in src/evals.ts.

import { relative } from 'node:path';
import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import { refused } from '../errors.js';
import {
  CASE_SOURCES,
  countCases,
  defaultCasesFile,
  EVAL_SETS,
  exportCases,
  isEvalSet,
  mergeCases,
  readCasesFile,
  writeCasesFile,
  type CaseCounts,
} from '../evals.js';
import { openStore } from '../store.js';

const USAGE = 'jv evals route|landing [--since DATE] [--out FILE] [--json]';

function sinceFlag(args: ParsedArgs): string | undefined {
  const since = flagString(args, 'since');
  if (since === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+Z?)?$/.test(since) || Number.isNaN(Date.parse(since))) {
    throw refused(`--since needs a date such as 2026-11-01, not ${since}`);
  }
  return since;
}

function countsText(c: CaseCounts): string[] {
  return CASE_SOURCES.flatMap((s) => {
    const n = c.bySource[s];
    return n.dev + n['held-out'] ? [`  ${s.padEnd(9)} ${String(n.dev + n['held-out']).padStart(4)}  (dev ${n.dev}, held-out ${n['held-out']})`] : [];
  });
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const set = args.positionals[0];
  if (set === undefined || !isEvalSet(set)) throw refused(`which cases? ${USAGE}`);
  if (args.positionals.length > 1) throw refused(`unexpected ${args.positionals.slice(1).join(' ')} (${USAGE})`);
  const since = sinceFlag(args);
  const { skill } = EVAL_SETS[set];
  const file = flagString(args, 'out') ?? defaultCasesFile(skill);

  const store = openStore();
  let exported: ReturnType<typeof exportCases>;
  try {
    exported = exportCases(store, set, since === undefined ? {} : { since });
  } finally {
    store.close();
  }
  const current = readCasesFile(file, skill);
  const merged = mergeCases(current.cases, exported.cases);
  writeCasesFile(file, { skill: current.skill, cases: merged });

  const exportCounts = countCases(exported.cases);
  const fileCounts = countCases(merged);
  const shown = relative(process.cwd(), file).startsWith('..') ? file : relative(process.cwd(), file) || file;
  const data = {
    set,
    skill,
    file,
    since: since ?? null,
    exported: exported.cases.length,
    exportedBySource: exportCounts.bySource,
    skipped: exported.skipped,
    total: merged.length,
    labelled: fileCounts.labelled,
    totalBySource: fileCounts.bySource,
  };
  io.result(data, () => {
    const skipped = Object.entries(exported.skipped)
      .filter(([, n]) => n > 0)
      .map(([why, n]) => `${why} ${n}`);
    return [
      `jv evals ${set}: ${exported.cases.length} cases exported${since ? ` since ${since}` : ''} into ${shown}`,
      ...countsText(exportCounts),
      `  skipped: ${skipped.length ? skipped.join(', ') : 'none'}`,
      `The file now holds ${merged.length} cases (${fileCounts.labelled} labelled):`,
      ...countsText(fileCounts),
    ].join('\n');
  });
  return 0;
}
