#!/usr/bin/env node
// Assembles acceptance/RESULTS.md from acceptance/results/J*.json (written by the journey scripts through
// journey.mjs), in journey order: a summary table, then each journey's checks with their evidence, its tables (a
// result's optional "tables": [{title, columns, rows}]), its elapsed times, its deviations and its notes. Plain ESM, no dependencies. Usage: node acceptance/results.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'results');
const OUT = join(HERE, 'RESULTS.md');

const journeys = (existsSync(DIR) ? readdirSync(DIR) : [])
  .filter((f) => /^J\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')))
  .sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const minutes = (ms) => (typeof ms === 'number' ? `${(ms / 60000).toFixed(1)} min` : '');
const STATUS = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIPPED' };

const lines = [];
lines.push('# Acceptance results');
lines.push('');
lines.push('The journeys of brief section 15, run on dev-madrid against the project `jevellan-live-sandbox`. Each journey');
lines.push('is a script `acceptance/jNN-<slug>.mjs`; its last run is `acceptance/results/JNN.json`, and this file is rebuilt');
lines.push('from those by `node acceptance/results.mjs`.');
lines.push('');
lines.push('| Journey | Title | Status | Checks | Deviations | Ended | Took |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const j of journeys) {
  const ok = j.checks.filter((c) => c.ok).length;
  lines.push(`| ${j.id} | ${cell(j.title)} | ${STATUS[j.status] ?? j.status} | ${ok}/${j.checks.length} | ${j.deviations.length} | ${cell(j.endedAt)} | ${minutes(j.elapsed?.totalMs)} |`);
}
for (const j of journeys) {
  lines.push('');
  lines.push(`## ${j.id} ${j.title}: ${STATUS[j.status] ?? j.status}`);
  lines.push('');
  lines.push(`Run from ${j.startedAt} to ${j.endedAt}${j.tag ? `, tag \`${j.tag}\`` : ''}.`);
  lines.push('');
  lines.push('| | Check | Evidence |');
  lines.push('| --- | --- | --- |');
  for (const c of j.checks) lines.push(`| ${c.ok ? 'ok' : 'FAIL'} | ${cell(c.name)} | ${cell(c.evidence)} |`);
  for (const t of j.tables ?? []) {
    lines.push('');
    lines.push(`${cell(t.title)}:`);
    lines.push('');
    lines.push(`| ${t.columns.map(cell).join(' | ')} |`);
    lines.push(`| ${t.columns.map(() => '---').join(' | ')} |`);
    for (const r of t.rows) lines.push(`| ${r.map(cell).join(' | ')} |`);
    if (!t.rows.length) lines.push(`| ${t.columns.map((_, i) => (i === 0 ? 'none' : '')).join(' | ')} |`);
  }
  const elapsed = Object.entries(j.elapsed ?? {});
  if (elapsed.length) {
    lines.push('');
    lines.push('Elapsed:');
    lines.push('');
    for (const [k, v] of elapsed) lines.push(`- ${k}: ${typeof v === 'number' && /Ms$/.test(k) ? `${v} ms (${(v / 1000).toFixed(1)} s)` : cell(v)}`);
  }
  lines.push('');
  lines.push('Deviations:');
  lines.push('');
  if (j.deviations.length) for (const d of j.deviations) lines.push(`- ${d}`);
  else lines.push('- none');
  if (j.notes) {
    lines.push('');
    lines.push('Notes:');
    lines.push('');
    for (const n of String(j.notes).split('\n')) lines.push(n.trim() ? `- ${n}` : '');
  }
}
lines.push('');
writeFileSync(OUT, lines.join('\n'));
process.stdout.write(`wrote ${OUT} (${journeys.length} journeys)\n`);
