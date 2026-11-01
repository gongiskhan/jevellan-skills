#!/usr/bin/env node
// J12 Codex (brief section 15, sections 6.3 and 7.8): a single investigate task, steered onto GPT through the policy
// (not through an override), runs on the codex runtime and reports through jv-report-mcp.
//
// 0. Gate: jv status --json shows no running work (waits until it does).
// 1. The INSTALLED router policy (~/.jv/skills/jevellan-router/SKILL.md, followed through the skill-set link to the
//    real file) is backed up byte for byte (--backup) and its "## model descriptions" lines are edited: gpt-6-astra
//    becomes the model for investigation, and every other model's line starts "Not for investigation." Nothing else
//    in the policy changes, so every providers.json model keeps its line.
// 2. A single investigate task: its Jev placement (made with the edited policy: the decision's skill_hash differs
//    from the repository policy's) chose gpt-6-astra on codex; the run is on the codex runtime with a thread id; the
//    events show the jv report tool call (jv.jv_report, the jv-report-mcp server) and a report event; the reports row
//    exists; the task finishes.
// 3. Restore (finally block, and on SIGINT/SIGTERM): the backup bytes are written back to the real file recorded at
//    the start; the checks after it are evidence that its sha256 equals the repository copy
//    .apm/skills/jevellan-router/SKILL.md and that the installed link still resolves to that file.
// If Codex needs a login, the exact message is recorded as a fail with NEEDS-OWNER in the notes.
//
// Usage: node acceptance/j12-codex.mjs [--tag T] [--backup FILE] [--note "..."]
// A rerun with the same tag refuses to run once its task exists (use a new tag).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, JV_HOME, log, queryOne, taskByRequest } from './lib.mjs';
import { arg, journey } from './journey.mjs';
import { createTask, err, eventsOf, parse, placementsOf, reportOf, runLine, runsOf, settle, stateFile, stepsOf, waitQuiet } from './task-lib.mjs';

const J = journey(12, 'Codex');
const S = stateFile(12, J.tag);
const REPO_POLICY = join(dirname(fileURLToPath(import.meta.url)), '..', '.apm', 'skills', 'jevellan-router', 'SKILL.md');
const LINK = join(JV_HOME, 'skills', 'jevellan-router', 'SKILL.md');
const BACKUP = arg('--backup', join(tmpdir(), 'router-SKILL.md.j12'));
const MARKER = `${S.file}.policy-edited`;
const REQUEST = `acceptance-j12-${J.tag || 'default'}`;
const GPT = 'gpt-6-astra';
const GPT_LINE = `${GPT}: The model for investigation: reading code and answering questions about it with file and line references. Every investigate step goes to GPT through Codex.`;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

let real;
let backupBytes;
let edited = false;

/** Writes the backup bytes back to the real policy file if this run edited it (synchronous, for signal handlers). */
function restore() {
  if (!edited) return;
  writeFileSync(real, backupBytes);
  edited = false;
  rmSync(MARKER, { force: true });
  log(`policy restored: ${real}`);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

/** The policy text with the model descriptions edited for J12; every other line as it was. */
function editPolicy(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## model descriptions');
  if (start < 0) throw new Error('no "## model descriptions" section');
  const changed = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    const m = /^(\S+):\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, id, description] = m;
    lines[i] = id === GPT ? GPT_LINE : `${id}: Not for investigation. ${description}`;
    changed.push(id);
  }
  return { text: lines.join('\n'), changed };
}

async function main() {
  if (taskByRequest(REQUEST)) {
    log(`tag ${J.tag || 'default'} already has its task (${taskByRequest(REQUEST).id}); use a new --tag`);
    process.exit(2);
  }
  const gate = await waitQuiet();
  if (!check('gate: jv status shows no running work', gate.quiet, `${gate.evidence}; waited ${gate.waitedMs} ms`)) return;

  // 1. Back up and edit the installed policy.
  real = realpathSync(LINK);
  backupBytes = readFileSync(real);
  const repoSha = sha(readFileSync(REPO_POLICY));
  if (!check('the installed policy equals the repository copy before the journey', sha(backupBytes) === repoSha, `${LINK} -> ${real}; sha256 ${sha(backupBytes).slice(0, 16)}..., repository ${repoSha.slice(0, 16)}...`)) return;
  writeFileSync(BACKUP, backupBytes);
  check('backup written', sha(readFileSync(BACKUP)) === sha(backupBytes), `${BACKUP}, ${backupBytes.length} bytes`);
  const { text, changed } = editPolicy(backupBytes.toString('utf8'));
  writeFileSync(MARKER, `policy edited by J12; restore with: cp ${BACKUP} ${real}\n`);
  edited = true;
  writeFileSync(real, text);
  const mode = (statSync(real).mode & 0o777).toString(8);
  check('the model descriptions were edited (GPT for investigation, the others not)', changed.includes(GPT) && changed.length >= 2, `${changed.length} lines: ${changed.join(', ')}; mode ${mode}; GPT line "${GPT_LINE}"`);
  S.set({ real, editedAt: new Date().toISOString(), changed });

  // 2. The task.
  J.start('task');
  const c = createTask({
    duty: 'investigate',
    title: 'Customer search behaviour',
    text: 'How does the customer search on the customers page match a query (case, fields, partial matches)? Answer in two or three sentences with file and line references.',
    request: REQUEST,
  });
  const created = check('jv task create exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; ${c.json.start?.placement?.model} ${c.json.start?.placement?.effort} on ${c.json.start?.placement?.provider} (${c.json.start?.placement?.runtime})`);
  if (!created) {
    if (/login|sign in|signed in|auth/i.test(c.json?.error ?? c.stderr)) J.note(`NEEDS-OWNER: Codex needs a login: ${c.json?.error ?? c.stderr.trim()}`);
    return;
  }
  const id = c.json.task.id;
  S.set({ task: id });
  const t = await settle(id, { timeoutMs: 20 * 60_000 });
  J.stop('task');
  const runs = runsOf(id);
  const run = runs.at(-1);
  if (t?.state !== 'done') {
    const why = `${t?.state}: ${t?.state_reason}; ${run ? runLine(run) : 'no run'}; errors ${run ? eventsOf(run.id).filter((e) => e.kind === 'error').map((e) => oneLine(e.payload, 200)).join(' | ') : ''}`;
    if (/login|sign in|signed in|auth/i.test(why)) J.note(`NEEDS-OWNER: Codex needs a login: ${why}`);
  }
  check('the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');

  const [step] = stepsOf(id);
  const decision = placementsOf(step.id)[0];
  const chosen = parse(decision?.chosen_json, {});
  check('Jev placed the step on gpt-6-astra via codex (a Jev decision, not an override)', !!decision && decision.jev_model !== 'none' && !decision.override_mode && chosen.model === GPT && chosen.provider === 'codex', decision ? `${decision.id} by ${decision.jev_model}: ${chosen.model} ${chosen.effort} on ${chosen.provider} (${chosen.runtime}); model answer ${oneLine(JSON.stringify(chosen.choices?.model ?? {}), 300)}` : 'no decision');
  const repoDecision = queryOne("SELECT skill_hash FROM decisions WHERE kind = 'placement' AND created_at < ? AND jev_model != 'none' ORDER BY created_at DESC LIMIT 1", decision?.created_at ?? '');
  check('the placement used the edited policy (its skill_hash differs from the placement before it)', !!decision && !!repoDecision && decision.skill_hash !== repoDecision.skill_hash, `${decision?.skill_hash?.slice(0, 16)}... vs ${repoDecision?.skill_hash?.slice(0, 16)}...`);
  check('one run, on the codex runtime with gpt-6-astra and a thread id', runs.length === 1 && run.runtime === 'codex' && run.provider === 'codex' && run.model === GPT && !!run.native_session_id, `${runs.map(runLine).join('; ')}; thread ${run?.native_session_id}`);
  const events = run ? eventsOf(run.id) : [];
  const calls = events.filter((e) => e.kind === 'tool-call').map((e) => parse(e.payload, {}));
  const reportCall = calls.find((p) => /jv_report/.test(p.name ?? ''));
  check('the events show the jv report tool call (jv-report-mcp)', !!reportCall, reportCall ? `${reportCall.name}: ${oneLine(reportCall.input, 200)}` : `tool calls: ${calls.map((p) => p.name).join(', ') || 'none'}`);
  const reportEvent = events.find((e) => e.kind === 'report');
  const report = run ? reportOf(run.id) : undefined;
  check('the report row exists (and a report event)', !!report && !!reportEvent && !/synthesi/i.test(report.limitations ?? ''), report ? `${report.id} ${report.status}: ${oneLine(report.summary, 240)}` : 'no report row');
  const start = parse(events.find((e) => e.kind === 'start')?.payload, {});
  log(`start event: ${oneLine(JSON.stringify(start), 300)}; ${calls.length} tool calls: ${calls.map((p) => p.name).join(', ')}; tokens ${run?.input_tokens} in, ${run?.output_tokens} out`);
  J.set('runMs', run?.started_at && run?.ended_at ? Date.parse(run.ended_at) - Date.parse(run.started_at) : null);
}

try {
  await main();
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (edited) {
    restore();
    const now = realpathSync(LINK);
    const s = sha(readFileSync(real));
    const repo = sha(readFileSync(REPO_POLICY));
    check('after the restore: the policy sha256 equals the repository copy', s === repo, `${real}: ${s}; ${REPO_POLICY}: ${repo}`);
    check('after the restore: the installed link still resolves to the restored file', now === real && existsSync(real), `${LINK} -> ${now}`);
  }
}
J.finish();
