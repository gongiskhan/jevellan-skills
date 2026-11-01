#!/usr/bin/env node
// J15 Evals (brief section 15; section 12): after J4 and J11, `jv evals route --since 2026-11-01` exports at least
// 12 cases with at least one override into the package's jevellan-router/evals/cases.json, merged with the hand
// cases already there; the router's evals/run.mjs replays the current policy through Jev (real calls), prints the
// agreement and writes evals/RESULTS.md; `jv evals landing --since 2026-11-01` and the landing policy's run.mjs the
// same for landings. The cases files and RESULTS.md are committed to a public repository, so every file the journey
// writes is searched for machine paths and for the owner's name and e-mail (fixed strings, case-insensitive).
//
// run.mjs exits 1 when held-out agreement is below evals/threshold.json by design (a policy quality signal, not a
// failure of the run) and 2 when it cannot run; the journey asserts 0 or 1 and records the agreement as evidence.
//
// Before writing, the journey copies both cases.json and both evals/RESULTS.md into jv-j15-backup-<stamp>/ under
// JV_ACCEPT_BACKUP_DIR (default the system temporary folder), an undo for a bad export. It creates no task, so --tag is recorded only; the export merges by decisionId, so a rerun
// replaces the exported cases instead of duplicating them.
//
// Usage: node acceptance/j15-evals.mjs [--tag T] [--since 2026-11-01]
// Writes acceptance/results/J15.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, git, jvJson, stamp } from './lib.mjs';
import { arg, journey } from './journey.mjs';

const J = journey(15, 'Evals');
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS = join(REPO, '.apm', 'skills');
const since = arg('--since', '2026-11-01');
const oneLine = (s, max = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

// What must never appear in the committed eval files: machine paths and the owner's identity (the git identity of
// this machine plus the account names it is known by). Matched as fixed strings, ignoring case.
const identity = [git(REPO, ['config', 'user.name']), git(REPO, ['config', 'user.email'])].filter(Boolean);
const PRIVATE = ['/home/', '/tmp/', '/Users/', '/root/', 'jevellan-projects', '.jv/', '.jevellan', 'ggomes', 'goncalo', 'gonçalo', 'gomes', 'ekoa', 'gmail', 'dev-madrid', ...identity];

function privateHits(file) {
  const text = readFileSync(file, 'utf8').toLowerCase();
  return PRIVATE.filter((p) => text.includes(p.toLowerCase()));
}

const backup = join(process.env.JV_ACCEPT_BACKUP_DIR || tmpdir(), `jv-j15-backup-${stamp()}`);
mkdirSync(backup, { recursive: true });

const SETS = [
  { set: 'route', skill: 'jevellan-router', minExported: 12, minOverride: 1 },
  { set: 'landing', skill: 'jevellan-landing', minExported: 1, minOverride: 0 },
];
const table = { title: 'Eval runs', columns: ['set', 'exported', 'by source', 'file total', 'run.mjs exit', 'held-out agreement', 'all questions', 'disagreements'], rows: [] };

for (const { set, skill, minExported, minOverride } of SETS) {
  const casesFile = join(SKILLS, skill, 'evals', 'cases.json');
  const resultsFile = join(SKILLS, skill, 'evals', 'RESULTS.md');
  for (const f of [casesFile, resultsFile]) if (existsSync(f)) copyFileSync(f, join(backup, `${skill}-${f.endsWith('.json') ? 'cases.json' : 'RESULTS.md'}`));
  const before = JSON.parse(readFileSync(casesFile, 'utf8')).cases;
  const handBefore = before.filter((c) => c.source === 'hand').map((c) => c.id);

  // The export.
  J.start(`export-${set}`);
  const e = jvJson(['evals', set, '--since', since], { cwd: REPO, timeoutMs: 5 * 60_000 });
  J.stop(`export-${set}`);
  const d = e.json ?? {};
  const bySource = Object.entries(d.exportedBySource ?? {})
    .map(([s, n]) => [s, n.dev + n['held-out'], n['held-out']])
    .filter(([, n]) => n > 0);
  const overrides = bySource.find(([s]) => s === 'override')?.[1] ?? 0;
  const sourceText = bySource.map(([s, n, h]) => `${s} ${n} (held-out ${h})`).join(', ') || 'none';
  check(`jv evals ${set} --since ${since} exits 0 and writes the package's ${skill}/evals/cases.json`, e.status === 0 && d.file === casesFile, `exit ${e.status}${e.status ? `: ${oneLine(e.json?.error ?? e.stderr)}` : ''}; file ${d.file ? relative(REPO, d.file) : 'none'}`);
  check(
    `jv evals ${set} exports at least ${minExported} case${minExported === 1 ? '' : 's'}${minOverride ? ` with at least ${minOverride} override` : ''}`,
    d.exported >= minExported && overrides >= minOverride,
    `${d.exported} exported: ${sourceText}; skipped ${JSON.stringify(d.skipped ?? {})}`,
  );
  const after = existsSync(casesFile) ? JSON.parse(readFileSync(casesFile, 'utf8')).cases : [];
  const handAfter = new Set(after.filter((c) => c.source === 'hand').map((c) => c.id));
  const missingHand = handBefore.filter((id) => !handAfter.has(id));
  const exportedIds = new Set(after.filter((c) => c.source !== 'hand').map((c) => c.decisionId));
  check(
    `the ${skill} cases file keeps every hand case and holds every exported decision once`,
    missingHand.length === 0 && d.total === after.length && exportedIds.size === after.filter((c) => c.source !== 'hand').length && after.length >= handBefore.length + d.exported,
    `${handBefore.length} hand cases before, ${handAfter.size} after${missingHand.length ? ` (missing ${missingHand.join(', ')})` : ''}; ${after.length} cases in the file (${d.labelled} labelled); ${exportedIds.size} distinct decisions`,
  );

  // The replay through Jev, from the package's own run.mjs (which loads the installed runtime's dist/evals.js).
  const runner = join(SKILLS, skill, 'evals', 'run.mjs');
  const mtimeBefore = existsSync(resultsFile) ? statSync(resultsFile).mtimeMs : 0;
  const runStarted = new Date().toISOString();
  J.start(`run-${set}`);
  const r = spawnSync(process.execPath, [runner], { cwd: join(SKILLS, skill), encoding: 'utf8', timeout: 30 * 60_000 });
  J.stop(`run-${set}`);
  const out = r.stdout ?? '';
  const heldLine = out.split('\n').find((l) => /held-out agreement/i.test(l)) ?? '';
  const allLine = out.split('\n').find((l) => /all questions/.test(l)) ?? '';
  check(
    `${skill} evals/run.mjs replays the cases through Jev and prints the agreement`,
    (r.status === 0 || r.status === 1) && /agreement/i.test(out) && heldLine !== '',
    `exit ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}; ${oneLine(heldLine, 200)}; ${oneLine(allLine, 200)}${r.status === 0 || r.status === 1 ? '' : `; stderr ${oneLine(r.stderr, 300)}`}`,
  );
  const md = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8') : '';
  const dateLine = md.split('\n').find((l) => l.startsWith('- Date:')) ?? '';
  const hashLine = md.split('\n').find((l) => l.startsWith('- Skill hash:')) ?? '';
  const casesLine = md.split('\n').find((l) => l.startsWith('- Cases:')) ?? '';
  const writtenAt = dateLine.replace('- Date:', '').trim();
  check(
    `${skill} evals/RESULTS.md is rewritten by this run with the skill hash and the date`,
    existsSync(resultsFile) && statSync(resultsFile).mtimeMs > mtimeBefore && writtenAt >= runStarted && /`[0-9a-f]{64}`/.test(hashLine),
    `${oneLine(dateLine)}; ${oneLine(hashLine)}; ${oneLine(casesLine)}`,
  );
  const disagreements = md.split('## Disagreements')[1]?.split('\n## ')[0] ?? '';
  const disagreementCount = (disagreements.match(/^- /gm) ?? []).length;
  table.rows.push([set, String(d.exported ?? '?'), sourceText, String(after.length), String(r.status), heldLine.replace(/^[-\s]*/, ''), allLine.replace(/\*\*/g, '').replace(/^\|\s*/, '').trim(), String(disagreementCount)]);

  // Privacy of what goes to the public repository.
  for (const f of [casesFile, resultsFile]) {
    const hits = privateHits(f);
    check(`${skill}/evals/${f.endsWith('.json') ? 'cases.json' : 'RESULTS.md'} holds no machine path and no owner name or e-mail`, hits.length === 0, hits.length ? `found: ${hits.join(', ')}` : `none of ${PRIVATE.length} strings (paths, names, e-mails; ignoring case) in ${statSync(f).size} bytes`);
  }
}

J.note('backups of both cases.json and both evals/RESULTS.md from before this run were copied to a temporary folder (JV_ACCEPT_BACKUP_DIR, default the system temporary folder; not recorded here because it is a machine path).');
J.note('the J12 decision (GPT for investigation) was made under a temporarily edited router policy (J12 restored it); it is exported as an outcome case and the replay uses the restored policy, so a disagreement on it is expected and is not a jv defect.');
J.note('run.mjs exits 1 by design when held-out agreement is below evals/threshold.json; the journey asserts that the run happened (exit 0 or 1, never 2) and records the agreement.');
J.finish({ tables: [table] });
