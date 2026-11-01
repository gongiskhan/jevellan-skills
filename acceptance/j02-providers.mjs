#!/usr/bin/env node
// J2 Providers (brief section 15; sections 3, 6.6 and 11): `jv providers check` shows claude-main and claude-second
// ready with weekly percentages, codex ready or "needs login" with the exact login command, and Jev reachable with
// its model listed. Asserted on the --json output, on the human output, and on the provider_usage probe rows the
// check writes to the store.
//
// Usage: node acceptance/j02-providers.mjs [--tag T]
// Writes acceptance/results/J02.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, jv, JV_HOME, jvJson, query } from './lib.mjs';
import { journey } from './journey.mjs';

const J = journey(2, 'Providers');
const oneLine = (s, max = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};
const pct = (u) => (typeof u?.weeklyPct === 'number' ? `${u.weeklyPct}%` : 'no weekly %');

const configured = JSON.parse(readFileSync(join(JV_HOME, 'providers.json'), 'utf8'));
const jevModel = configured.jev?.model;
const since = new Date().toISOString();

J.start('checkJson');
const r = jvJson(['providers', 'check'], { timeoutMs: 300_000 });
J.stop('checkJson');
check('jv providers check --json exits 0', r.status === 0 && r.json, `exit ${r.status}${r.status ? `: ${oneLine(r.json?.error ?? r.stderr)}` : ''}`);
const byName = new Map((r.json?.providers ?? []).map((p) => [p.name, p]));

for (const name of ['claude-main', 'claude-second']) {
  const p = byName.get(name);
  check(`${name} is ready with a weekly percentage`, p?.auth === 'ready' && typeof p.usage?.weeklyPct === 'number' && p.usage.weeklyPct >= 0 && p.usage.weeklyPct <= 100, p ? `${p.auth}; ${p.detail}; week ${pct(p.usage)} (resets ${p.usage?.weeklyResetsAt ?? '?'})` : 'missing');
}

const codex = byName.get('codex');
if (codex?.auth === 'ready') {
  check('codex is ready (with its weekly percentage)', typeof codex.usage?.weeklyPct === 'number', `${codex.auth}; ${codex.detail}; week ${pct(codex.usage)}`);
} else {
  check('codex needs login and names the exact login command', codex?.auth === 'needs-login' && codex.fix === 'jv providers login codex', codex ? `${codex.auth}; ${codex.detail}; fix: ${codex.fix}` : 'missing');
}

const jev = r.json?.jev;
check('Jev is reachable and lists the configured model', jev?.reachable === true && jev.listed === true && jev.model === jevModel && !!jevModel, jev ? `${jev.detail} (providers.json jev.model ${jevModel})` : 'no jev block');
check('the check did not rewrite providers.json', r.json?.providersFile?.changed === false, JSON.stringify(r.json?.providersFile ?? {}));

// The human view of the same check.
J.start('checkText');
const t = jv(['providers', 'check'], { timeoutMs: 300_000 });
J.stop('checkText');
const lineOf = (name) => t.stdout.split('\n').find((l) => l.startsWith(`${name} `)) ?? '';
const textOk =
  /\bready\b.*week \d+%/.test(lineOf('claude-main')) &&
  /\bready\b.*week \d+%/.test(lineOf('claude-second')) &&
  (/\bready\b.*week \d+%/.test(lineOf('codex')) || /needs login.*jv providers login codex/.test(lineOf('codex'))) &&
  new RegExp(`^jev\\s+ready\\s+reachable, model ${jevModel} listed`).test(lineOf('jev'));
check('the text output shows the same', t.status === 0 && textOk, ['claude-main', 'claude-second', 'codex', 'jev'].map((n) => oneLine(lineOf(n), 170)).join(' / '));

// The store: the probes wrote provider_usage rows.
const rows = query("SELECT provider, observed_at, weekly_pct, weekly_resets_at FROM provider_usage WHERE source = 'probe' AND observed_at >= ? ORDER BY observed_at", since);
const probed = (name) => rows.filter((x) => x.provider === name && typeof x.weekly_pct === 'number');
check('the store has probe usage rows for claude-main, claude-second (and codex when ready)', probed('claude-main').length > 0 && probed('claude-second').length > 0 && (codex?.auth !== 'ready' || probed('codex').length > 0), rows.map((x) => `${x.provider} ${x.weekly_pct}% at ${x.observed_at}`).join('; ') || 'no rows');

J.set('weeklyPct', ['claude-main', 'claude-second', 'codex'].map((n) => `${n} ${pct(byName.get(n)?.usage)}`).join(', '));
const fiveHourKnown = ['claude-main', 'claude-second', 'codex'].filter((n) => typeof byName.get(n)?.usage?.fiveHourPct === 'number');
if (fiveHourKnown.length < 3) {
  J.note(`five-hour usage is not returned by the probes for ${['claude-main', 'claude-second', 'codex'].filter((n) => !fiveHourKnown.includes(n)).join(', ')} ("five hours unknown"; docs/findings.md); J2 asks only for weekly percentages.`);
}
const others = [...byName.values()].filter((p) => !['claude-main', 'claude-second', 'codex'].includes(p.name));
J.note(`other providers (not part of J2): ${others.map((p) => `${p.name} ${p.auth}${p.fix ? ` (fix: ${oneLine(p.fix, 120)})` : ''}`).join('; ')}`);
J.finish();
