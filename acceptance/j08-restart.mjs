#!/usr/bin/env node
// J8 Restart from handoff (brief section 15, sections 9.5 and 9.6): jv coordinator restart while a task waits on the
// owner; the new session's first reply names that task and its options.
//
// 1. The coordinator is running (J6 started it again). A single investigate task whose question is the owner's: the
//    customers page title, "Clients" or "Customers", reported as needs-decision with those two options. The
//    coordinator gets the wake line; the script waits until the task waits on the owner and the coordinator is idle,
//    and records what the coordinator said about it.
// 2. jv coordinator restart --project jevellan-live-sandbox: /exit, a new session, the handoff typed as its first
//    message. The new session's first reply (its first assistant text after the handoff, read from its native
//    transcript once it is idle) must name the task (id or title) and both options.
// 3. The owner answers through the coordinator (typed into its window); the coordinator runs jv task answer and the
//    task finishes.
//
// Usage: node acceptance/j08-restart.mjs [--tag T] [--note "..."]
// A rerun with the same tag reuses the task; a restart already made by this tag is not repeated
// (results/J08-state-<tag>.json).

import { check, jvJson, log, query, queryOne, SANDBOX_NAME, sleep } from './lib.mjs';
import { journey } from './journey.mjs';
import { coordinator, oneLine } from './coord.mjs';
import { createTask, err, parse, reportOf, runLine, runsOf, settle, stateFile, taskRow } from './task-lib.mjs';

const J = journey(8, 'Restart from handoff');
const S = stateFile(8, J.tag);
const OPTIONS = ['Clients', 'Customers'];

async function main() {
  const project = queryOne('SELECT * FROM projects WHERE name = ?', SANDBOX_NAME);
  const co = coordinator(SANDBOX_NAME, project.path);
  let status = co.status();
  if (!status?.running) {
    const s = jvJson(['coordinator', 'start', '--project', SANDBOX_NAME], { timeoutMs: 5 * 60_000 });
    check('the coordinator was not running: jv coordinator start exits 0', s.status === 0, s.status ? err(s) : s.json?.sessionId);
    status = co.status();
  }
  if (!check('the coordinator is running before the journey', status?.running === true, `${status?.sessionId} ${status?.sessionState}, screen ${status?.screen}`)) return;

  // 1. The owner's question.
  const c = createTask({
    duty: 'investigate',
    title: 'Customers page title: Clients or Customers?',
    text: "The customers page title is a product naming choice that only the owner can make. Read src/web/customers.ts to see the current title, then ask the owner, as a needs-decision report with exactly the options 'Clients' and 'Customers', which word the page title should use. Do not decide it yourself and change nothing.",
    request: `acceptance-j08-${J.tag || 'default'}`,
  });
  if (!check('jv task create (single investigate) exits 0', c.status === 0, c.status ? err(c) : `${c.json.task.id}; ${c.json.start?.placement?.model} ${c.json.start?.placement?.effort} on ${c.json.start?.placement?.provider} (${c.json.start?.placement?.runtime})`)) return;
  const id = c.json.task.id;
  S.set({ task: id });
  let t = await settle(id, { timeoutMs: 15 * 60_000, until: (x) => x.state === 'waiting-owner' || x.state === 'done' });
  const run = runsOf(id).at(-1);
  const report = reportOf(run.id);
  const options = (parse(report?.options_json, []) ?? []).map((o) => o.label);
  if (!S.get().restarted) {
    if (!check('the task waits on the owner with a needs-decision report', t?.state === 'waiting-owner' && report?.status === 'needs-decision', t ? `${t.state}: ${t.state_reason}` : 'timed out')) return;
  }
  check("the report's options are 'Clients' and 'Customers'", OPTIONS.every((o) => options.includes(o)), `${runLine(run)}; question: ${oneLine(report?.question, 200)}; options ${options.join(' | ')}`);

  // 2. The restart.
  if (!S.get().restarted) {
    // The coordinator first reacts to the needs-decision wake line; wait for that turn to end and keep what it said.
    const offset = S.get().wakeOffset ?? 0;
    const idle = await co.waitIdle({ quietMs: 10_000, timeoutMs: 5 * 60_000 });
    const before = co.digest(co.recordsFrom(offset));
    const wakeUser = before.users.filter((u) => u.text.includes(id)).at(-1);
    const said = wakeUser ? before.texts.filter((x) => x.at >= wakeUser.at).map((x) => x.text).join('\n') : '';
    log(`old coordinator ${status.sessionId}: wake line ${wakeUser ? `"${oneLine(wakeUser.text, 200)}"` : 'not seen'}; said: ${oneLine(said, 600)}`);
    J.note(`before the restart, coordinator ${status.sessionId} ${wakeUser ? `got "${oneLine(wakeUser.text, 200)}" and said: ${oneLine(said, 500)}` : 'had no wake line for the task in its transcript'}`);
    if (!idle) J.deviation('the old coordinator was still busy after 5 minutes; the restart went ahead anyway');
    const handoff = jvJson(['handoff', '--project', SANDBOX_NAME], { timeoutMs: 60_000 });
    const handoffText = JSON.stringify(handoff.json ?? handoff.stdout);
    check('jv handoff names the task and both options', handoff.status === 0 && handoffText.includes(id) && OPTIONS.every((o) => handoffText.includes(o)), handoff.status ? err(handoff) : `${handoffText.length} characters`);
    J.start('restart');
    const r = jvJson(['coordinator', 'restart', '--project', SANDBOX_NAME], { timeoutMs: 5 * 60_000 });
    if (!check('jv coordinator restart exits 0 and types the handoff', r.status === 0 && r.json?.handoffTyped === true, r.status ? err(r) : `stop: ${r.json.stop?.reason}; new ${r.json.sessionId}, screen ${r.json.screen}, handoffTyped ${r.json.handoffTyped}${r.json.handoffReason ? ` (${r.json.handoffReason})` : ''}`)) return;
    S.set({ restarted: r.json.sessionId, old: status.sessionId, restartedAt: new Date().toISOString() });
  }
  const now = co.status();
  check('a new coordinator session runs after the restart', now?.running && now.sessionId === S.get().restarted && now.sessionId !== S.get().old, `${S.get().old} -> ${now?.sessionId} (${now?.nativeSessionId}), screen ${now?.screen}`);

  // The new session's first reply.
  let first;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const d = co.digest(co.recordsFrom(0));
    const handoffUser = d.users.find((u) => u.text.includes('Handoff from your previous session'));
    if (handoffUser && d.texts.some((x) => x.at >= handoffUser.at) && (await co.waitIdle({ quietMs: 8000, timeoutMs: 60_000 })) !== undefined) {
      const dd = co.digest(co.recordsFrom(0));
      const hu = dd.users.find((u) => u.text.includes('Handoff from your previous session'));
      const after = dd.texts.filter((x) => x.at >= hu.at);
      // The first reply is the text of the first turn after the handoff (up to the next user line from the owner).
      const nextOwner = dd.users.find((u) => u.at > hu.at && !u.text.startsWith('[jv]'));
      first = { handoffAt: hu.at, text: after.filter((x) => !nextOwner || x.at < nextOwner.at).map((x) => x.text).join('\n'), tools: dd.tools.filter((x) => x.at >= hu.at && (!nextOwner || x.at < nextOwner.at)).map((x) => oneLine(x.input, 120)) };
      break;
    }
    await sleep(3000);
  }
  J.stop('restart');
  if (!check('the new session replied to the handoff', !!first?.text, first ? `${first.text.length} characters; tool calls: ${first.tools.join(' ; ') || 'none'}` : 'no reply within 10 minutes')) return;
  const title = taskRow(id).title;
  const namesTask = first.text.includes(id) || first.text.toLowerCase().includes(title.toLowerCase()) || /clients or customers/i.test(first.text);
  check('its first reply names the waiting task', namesTask, `task ${id} "${title}": ${oneLine(first.text, 700)}`);
  check('its first reply names both options', OPTIONS.every((o) => new RegExp(`\\b${o}\\b`).test(first.text)), OPTIONS.map((o) => `${o}: ${new RegExp(`\\b${o}\\b`).test(first.text)}`).join(', '));
  S.set({ firstReply: first.text });

  // 3. The owner answers through the coordinator.
  t = taskRow(id);
  if (t.state === 'waiting-owner') {
    const answer = `${id}: Customers. Keep the page title as it is.`;
    J.start('answer');
    const said = await co.say(answer, { timeoutMs: 10 * 60_000 });
    log(`owner typed "${answer}"; coordinator ran: ${said.digest.tools.map((x) => oneLine(x.input, 160)).join(' ; ')}; said: ${oneLine(said.digest.reply, 500)}`);
    check('the coordinator took the answer (it ran jv task answer)', said.digest.tools.some((x) => /jv task answer/.test(x.input) && x.input.includes(id)), said.digest.tools.map((x) => oneLine(x.input, 160)).join(' ; ') || 'no tool calls');
    S.set({ answered: answer });
    J.note(`owner answer typed into the coordinator: "${answer}"; it replied: ${oneLine(said.digest.reply, 400)}`);
  }
  t = await settle(id, { timeoutMs: 15 * 60_000 });
  J.stop('answer');
  const msgs = query('SELECT direction, text, created_at FROM messages WHERE task_id = ? ORDER BY created_at', id);
  check('the answer is in the store as a message of the task', msgs.some((m) => /Customers/.test(m.text)), msgs.map((m) => `${m.direction}: ${oneLine(m.text, 80)}`).join('; ') || 'none');
  check('the task finishes', t?.state === 'done', t ? `${t.state}: ${t.state_reason}` : 'timed out');
  const last = runsOf(id).at(-1);
  const rep = reportOf(last.id);
  if (rep) J.note(`last report (${last.id}): ${rep.status}: ${oneLine(rep.summary, 400)}`);
  const end = co.status();
  check('the coordinator is left running', end?.running === true, `${end?.sessionId}, screen ${end?.screen}`);
}

try {
  await main();
} catch (error) {
  check('no exception', false, error instanceof Error ? error.stack : String(error));
}
J.finish();
