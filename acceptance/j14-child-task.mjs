#!/usr/bin/env node
// J14 Child task (brief section 15, sections 7.1, 8 and 9.2; D-048), on the real sandbox, through the coordinator:
// an automation task whose plan step reports needs-decision proposing a child feature task; the coordinator runs
// jv task create --parent; the child lands into the parent's branch (not main); the parent continues and lands into
// main.
//
// quiet   Waits until no task is in flight (waitQuiet), so main does not move under the parent while J14 runs.
// type    The owner's message, pasted into the coordinator's window as one message. The sandbox's customers page
//         only lists customers (no form, no delete, no stable selectors), so the message says so and asks the plan
//         to propose a child feature that adds the form, the delete buttons and data-testid attributes, as a
//         needs-decision, before automating (a deviation from the example wording, recorded).
// parent  Within 15 minutes the coordinator creates one automation task. If Jev skipped its plan step, the task is
//         stopped with --discard, ~/.jv/projects/<project>/workflows/automation.json is written (the package
//         automation workflow with the plan step's "when" removed), the coordinator is told why and asked again
//         (a deviation); the override is moved out again at the end.
// poll    Every 10 s until the parent is done, failed or stopped (up to --timeout-min): jv status, the parent and
//         its children from the store. The owner's turns: a landing the coordinator asks about gets "Land now"; if
//         the coordinator asks the owner about the plan's proposal, the answer is to create the child with --parent
//         and answer the parent only after it landed; any other question goes to results/J14-question.txt and waits
//         for results/J14-answer.txt. The moment the child's landing is landed, the parent's branch and main are
//         checked (the child's commit is on the first and not on the second) and the result kept in the state.
// assert  The parent's plan ran and reported needs-decision proposing the child; the coordinator ran jv task create
//         --parent <P>; the child is a task with parent_task_id P, branched from the parent's branch, every step
//         done or skipped with reports, its landing row landed into the parent's branch; the parent's first answer
//         came after the child landed; the parent's automate and verify steps are done with reports and its
//         automation scripts are on main; the parent's landing row is landed and main holds the parent and the
//         child; every started step has a placement with probabilities; the checkout is clean; main holds the J4
//         changes plus this one (the brief's closing line names three: recorded).
//
// --tag T: the task ids and what the journey did are kept in results/J14-state-<T>.json; a rerun with the same tag
// types nothing again and goes on polling and asserting.
// Usage: node acceptance/j14-child-task.mjs --tag T [--timeout-min 180] [--note "..."]
// Writes acceptance/results/J14.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkoutState, git, JV_HOME, jvJson, log, onBranch, query, queryOne, SANDBOX, SANDBOX_NAME, sleep } from './lib.mjs';
import { arg, journey, RESULTS_DIR } from './journey.mjs';
import { coordinator, oneLine } from './coord.mjs';
import { err, landingsOf, parse, reportOf, runsOf, stateFile, stepsOf, taskRow, waitQuiet } from './task-lib.mjs';

const J = journey(14, 'Child task');
if (!J.tag) {
  process.stderr.write('J14 needs --tag (the task ids are kept under it)\n');
  process.exit(2);
}
const S = stateFile(14, J.tag);
const TIMEOUT_MS = Number(arg('--timeout-min', '180')) * 60_000;
const PROJECT = SANDBOX_NAME;
const QUESTION_FILE = join(RESULTS_DIR, 'J14-question.txt');
const ANSWER_FILE = join(RESULTS_DIR, 'J14-answer.txt');
const OVERRIDE_FILE = join(JV_HOME, 'projects', PROJECT, 'workflows', 'automation.json');
const PACKAGE_WORKFLOW = join(JV_HOME, 'skills', 'jevellan-workflow-automation', 'workflow.json');
const FINAL = ['done', 'failed', 'stopped'];

const MESSAGE =
  'Automation task: automate the customer flow on the sandbox web pages with Playwright: create a customer on the customers page, check it appears in the list, then delete it. ' +
  'Today the customers page only lists customers: it has no form to create one, no way to delete one, and the list has no stable selectors. ' +
  'So the plan should propose a child feature task that adds a create form and a delete button per row to the customers page, with data-testid attributes on the form, the list rows and the buttons, as a needs-decision, before automating.';
const CHILD_ANSWER = (p) => `1 A. Yes: create the child feature task the plan proposes, with --parent ${p}, and answer ${p} only after the child has landed into its branch.`;

const project = queryOne('SELECT * FROM projects WHERE name = ?', PROJECT);
const MAIN = project.default_branch;
const co = coordinator(PROJECT, project.path);
const projectTasks = () => query('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, rowid', project.id);
const childrenOf = (id) => query('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at, rowid', id);
const messagesOf = (id) => query('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid', id);
const mainHead = () => git(SANDBOX, ['rev-parse', `refs/heads/${MAIN}`]);
const isAncestor = (commit, ref) => !!commit && onBranch(SANDBOX, commit, ref);

J.deviation(
  'The owner message adapts the example to the sandbox: its customers page only lists customers (no create form, no delete, no stable selectors), so the message says so and asks the plan to propose a child feature that adds the form, a delete button per row and data-testid attributes, instead of saying the form and list exist without selectors.',
);

function topProbs(probs, n = 3) {
  return Object.entries(probs ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k.replace(/ via .*$/, '')} ${v}`)
    .join(', ');
}

/** The placement a run ran under: its own decision, or for a continuation the decision of its conversation. */
function placementOf(run) {
  const own = queryOne("SELECT * FROM decisions WHERE kind = 'placement' AND session_id = ? ORDER BY created_at DESC", run.id);
  if (own || !run.native_session_id) return own ?? undefined;
  return (
    queryOne(
      `SELECT d.* FROM decisions d JOIN sessions s ON s.id = d.session_id
       WHERE d.kind = 'placement' AND d.step_id = ? AND s.native_session_id = ? AND s.started_at <= ? ORDER BY d.created_at DESC`,
      run.step_id,
      run.native_session_id,
      run.started_at,
    ) ?? undefined
  );
}

function line(id) {
  const t = taskRow(id);
  const st = stepsOf(id)
    .map((s) => `${s.ordinal}.${s.duty}:${s.state}${s.attempts > 1 ? `x${s.attempts}` : ''}`)
    .join(' ');
  const live = runsOf(id)
    .filter((r) => ['queued', 'starting', 'running', 'waiting'].includes(r.state))
    .map((r) => `${r.id} ${r.runtime} ${r.model} ${r.effort} ${r.state}`)
    .join(', ');
  const l = landingsOf(id).at(-1);
  return `${id} ${t.state} [${st}]${live ? ` live ${live}` : ''}${l ? ` landing ${l.route}/${l.state}` : ''}`;
}

// ---- owner turns -------------------------------------------------------------------------------------------------

function recordAnswer(kind, question, answer, tasks) {
  const s = S.get();
  S.set({ answers: [...(s.answers ?? []), { at: new Date().toISOString(), kind, question: oneLine(question, 1500), answer, tasks }] });
  log(`owner answered (${kind}): ${answer}`);
}

/** Says `text` to the coordinator as the owner and records it. */
async function ownerSays(kind, question, text, tasks) {
  const r = await co.say(text);
  recordAnswer(kind, question, text, tasks);
  log(`coordinator after the owner (${kind}): ${oneLine(r.digest.reply, 800)}`);
  S.set({ processedOffset: co.size() });
  return r;
}

/** The owner's question file: written once, answered by whoever runs the journey through the answer file. */
async function askRunner(question, tasks) {
  const s = S.get();
  if (!s.pendingQuestion) {
    writeFileSync(QUESTION_FILE, `${new Date().toISOString()}\n${question}\n`);
    S.set({ pendingQuestion: { question, tasks } });
    log(`OWNER-QUESTION (answer in ${ANSWER_FILE}): ${oneLine(question, 1500)}`);
    return;
  }
  if (!existsSync(ANSWER_FILE)) return;
  const answer = readFileSync(ANSWER_FILE, 'utf8').trim();
  renameSync(ANSWER_FILE, `${ANSWER_FILE}.${Date.now()}.used`);
  S.set({ pendingQuestion: undefined });
  if (answer) await ownerSays('other', s.pendingQuestion.question, answer, s.pendingQuestion.tasks);
}

async function ownerTurn(parentId) {
  if (co.busy()) return;
  const s = S.get();
  const offset = s.processedOffset ?? co.size();
  const ids = [parentId, ...childrenOf(parentId).map((c) => c.id)];
  // A landing the coordinator asks about: "Land now", once per asked landing row, after it asked.
  const asked = ids.flatMap((id) => {
    const last = landingsOf(id).at(-1);
    return last?.state === 'asked' && !(s.handledLandings ?? []).includes(last.id) ? [{ id, landing: last }] : [];
  });
  if (asked.length) {
    if ((await co.waitIdle({ quietMs: 8000, timeoutMs: 60_000 })) === undefined) return;
    const said = co.digest(co.recordsFrom(offset)).reply;
    if (!/land now/i.test(said)) return;
    S.set({ handledLandings: [...(s.handledLandings ?? []), ...asked.map((a) => a.landing.id)] });
    const q = `${asked.map((a) => `${a.id}: ${a.landing.route} ${a.landing.state}: ${a.landing.reason}`).join(' | ')} || coordinator: ${said.slice(-1500)}`;
    await ownerSays('landing', q, asked.length === 1 ? 'Land now' : `Land now, all ${asked.length}: ${asked.map((a) => a.id).join(', ')}`, asked.map((a) => a.id));
    return;
  }
  if (s.pendingQuestion) return askRunner();
  const fresh = co.digest(co.recordsFrom(offset));
  const reply = fresh.reply.trim();
  // A question: the reply ends with "?", or ends with the numbered open questions the coordinator's prompt asks for.
  const asksIn = (text) => !!text && (/\?\s*$/.test(text.slice(-400)) || /(^|\n)\s*1[.)]\s/.test(text.slice(-1500)));
  const asks = asksIn(reply);
  const parent = taskRow(parentId);
  const children = childrenOf(parentId);
  // The plan's proposal, asked of the owner before any child exists: the owner's message already decided it. Read
  // from the coordinator's last text since the owner's message, so a question already marked processed still counts.
  if (parent.state === 'waiting-owner' && !children.length && !s.childAnswerGiven && !landingsOf(parentId).some((l) => l.state === 'asked')) {
    const since = co.digest(co.recordsFrom(Math.min(...(s.typed ?? []).map((t) => t.offset), offset)));
    const lastText = since.texts.at(-1)?.text ?? '';
    const nd = reportOf(runsOf(parentId).at(-1)?.id ?? '');
    if (nd?.status === 'needs-decision' && since.lastAt && since.lastAt > nd.created_at && asksIn(lastText) && lastText.includes(parentId)) {
      if ((await co.waitIdle({ quietMs: 15_000, timeoutMs: 60_000 })) === undefined) return;
      if (childrenOf(parentId).length) return;
      S.set({ childAnswerGiven: true });
      await ownerSays('child', lastText.slice(-2000), CHILD_ANSWER(parentId), [parentId]);
      return;
    }
  }
  // The child landed and the parent still waits with no answer, long after the coordinator went quiet: nudge once.
  const childLanded = children.map((c) => landingsOf(c.id).find((l) => l.state === 'landed')).find(Boolean);
  if (childLanded && parent.state === 'waiting-owner' && !landingsOf(parentId).some((l) => l.state === 'asked') && !s.nudged) {
    const answeredAfter = messagesOf(parentId).some((m) => m.created_at > childLanded.ended_at);
    if (!answeredAfter && Date.now() - Date.parse(childLanded.ended_at) > 5 * 60_000 && (await co.waitIdle({ quietMs: 30_000, timeoutMs: 90_000 })) !== undefined) {
      S.set({ nudged: true });
      J.deviation(`The coordinator had not answered ${parentId} 5 minutes after its child landed; the owner reminded it.`);
      await ownerSays('nudge', 'parent still waiting after the child landed', `The child task landed into ${parentId}'s branch. Answer ${parentId} now so it continues.`, [parentId]);
      return;
    }
  }
  if (asks) {
    if ((await co.waitIdle({ quietMs: 8000, timeoutMs: 60_000 })) === undefined) return;
    const said = co.digest(co.recordsFrom(offset)).reply;
    const waiting = ids.map(taskRow).filter((t) => t.state === 'waiting-owner');
    await askRunner(`${waiting.map((t) => `${t.id} waiting-owner: ${t.state_reason}`).join('\n')}\n--- coordinator ---\n${said.slice(-3000)}`, waiting.map((t) => t.id));
    return;
  }
  S.set({ processedOffset: co.size() });
}

// ---- the parent ----------------------------------------------------------------------------------------------------

async function typeAndFindParent(text, kind) {
  const before = projectTasks().map((t) => t.id);
  if ((await co.waitIdle({ quietMs: 3000, timeoutMs: 10 * 60_000 })) === undefined) return undefined;
  const offset = co.size();
  const typedAt = new Date().toISOString();
  const ok = co.type(text);
  check(`the owner's ${kind} message is pasted into the coordinator as one message`, ok, `${co.target}: ${oneLine(text, 900)}`);
  if (!ok) return undefined;
  S.set({ typed: [...(S.get().typed ?? []), { at: typedAt, kind, text, offset }], processedOffset: offset });
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const fresh = projectTasks().filter((t) => !before.includes(t.id));
    const auto = fresh.find((t) => t.kind === 'automation');
    if (auto) {
      await co.waitIdle({ quietMs: 8000, timeoutMs: 10 * 60_000 });
      const d = co.digest(co.recordsFrom(offset));
      const others = projectTasks().filter((t) => !before.includes(t.id) && t.id !== auto.id);
      S.set({ parent: auto.id, parentCreatedReply: d.reply, parentCreatedTools: d.tools.map((t) => oneLine(t.input, 600)), otherNewTasks: others.map((t) => `${t.id} ${t.kind} ${t.title}`), processedOffset: co.size() });
      return auto.id;
    }
    if (Date.now() > deadline) return undefined;
    if (!co.busy() && co.size() > offset && fresh.length === 0) await ownerTurnBeforeParent(offset);
    await sleep(2000);
  }
}

/** Before the parent exists, a quiet coordinator with a question is a question for whoever runs the journey. */
async function ownerTurnBeforeParent(offset) {
  if ((await co.waitIdle({ quietMs: 15_000, timeoutMs: 60_000 })) === undefined) return;
  if (projectTasks().some((t) => t.kind === 'automation' && t.created_at > (S.get().typed?.at(-1)?.at ?? ''))) return;
  const said = co.digest(co.recordsFrom(offset)).reply;
  if (!said.trim()) return;
  await askRunner(`no task yet\n--- coordinator ---\n${said.slice(-3000)}`, []);
}

/** If Jev skipped the parent's plan step: discard it, write the workflow override, ask again. */
async function planSkippedFallback(parentId) {
  const plan = stepsOf(parentId).find((s) => s.duty === 'plan');
  if (!plan || plan.state !== 'skipped') return parentId;
  log(`${parentId}: Jev skipped the plan step (${plan.state_reason}); discarding and writing the workflow override`);
  const stop = jvJson(['task', 'stop', parentId, '--discard']);
  check(`the parent ${parentId} whose plan Jev skipped is stopped with --discard`, stop.status === 0, stop.status ? err(stop) : `${plan.state_reason}`);
  const wf = JSON.parse(readFileSync(PACKAGE_WORKFLOW, 'utf8'));
  wf.steps = wf.steps.map((s) => {
    if (s.duty !== 'plan') return s;
    const { when, ...rest } = s;
    return rest;
  });
  mkdirSync(join(JV_HOME, 'projects', PROJECT, 'workflows'), { recursive: true });
  writeFileSync(OVERRIDE_FILE, `${JSON.stringify(wf, null, 2)}\n`);
  S.set({ discarded: [...(S.get().discarded ?? []), parentId], overrideWritten: true, parent: undefined });
  J.deviation(
    `Jev skipped the plan step of the first automation task ${parentId} (${plan.state_reason}); it was discarded, ${OVERRIDE_FILE} was written (the package automation workflow with the plan step's "when" removed) and the coordinator was asked again.`,
  );
  const again = `I discarded ${parentId} on purpose: Jev skipped its plan step, and this automation needs the plan that proposes the child task first. I added a project workflow override (workflows/automation.json) that always runs the plan step. Create the automation task again with the same brief.`;
  return typeAndFindParent(again, 'ask-again');
}

// ---- the poll ------------------------------------------------------------------------------------------------------

function snapshotChildLanding(parentId) {
  if (S.get().childLandedSnapshot) return;
  const parent = taskRow(parentId);
  for (const c of childrenOf(parentId)) {
    const l = landingsOf(c.id).find((x) => x.state === 'landed');
    if (!l) continue;
    const commit = l.commit_sha ?? c.landed_commit;
    const snap = {
      at: new Date().toISOString(),
      child: c.id,
      landing: l.id,
      landingEndedAt: l.ended_at,
      commit,
      parentBranch: parent.branch,
      parentBranchHead: git(SANDBOX, ['rev-parse', `refs/heads/${parent.branch}`]),
      onParentBranch: isAncestor(commit, `refs/heads/${parent.branch}`),
      main: mainHead(),
      onMain: isAncestor(commit, `refs/heads/${MAIN}`),
      parentAnswersBefore: messagesOf(parentId).map((m) => `${m.id} ${m.direction} ${m.created_at}`),
    };
    S.set({ childLandedSnapshot: snap });
    log(`child ${c.id} landed (${l.id} ${commit}): on ${parent.branch} ${snap.onParentBranch}, on ${MAIN} ${snap.onMain}`);
    return;
  }
}

async function poll(parentId) {
  const started = Date.now();
  let lastLine = '';
  for (;;) {
    const st = jvJson(['status', '--project', PROJECT]);
    const ids = [parentId, ...childrenOf(parentId).map((c) => c.id)];
    const l = ids.map(line).join(' | ');
    if (l !== lastLine) log(`poll: ${l}; status ${st.status === 0 ? `${st.json.tasks.length} open` : err(st)}`);
    lastLine = l;
    snapshotChildLanding(parentId);
    await ownerTurn(parentId);
    if (FINAL.includes(taskRow(parentId).state) && childrenOf(parentId).every((c) => FINAL.includes(taskRow(c.id).state))) break;
    if (Date.now() - started > TIMEOUT_MS) {
      log('poll: timed out');
      break;
    }
    await sleep(10_000);
  }
  await co.waitIdle({ quietMs: 8000, timeoutMs: 5 * 60_000 });
}

// ---- main ----------------------------------------------------------------------------------------------------------

async function main() {
  const status = co.status();
  if (!check('the coordinator is running before the journey', status?.running === true && co.alive(), `${status?.sessionId} ${status?.model} ${status?.effort} on ${status?.provider}; screen ${status?.screen}`)) return;

  let parentId = S.get().parent;
  if (!parentId) {
    const quiet = await waitQuiet({ timeoutMs: 30 * 60_000 });
    check('no task is in flight before the message (main does not move under the parent)', quiet.quiet, quiet.evidence);
    if (!quiet.quiet) return;
    S.set({ mainBefore: mainHead(), startedAt: new Date().toISOString() });
    J.start('parent');
    parentId = await typeAndFindParent(MESSAGE, 'automation');
  } else {
    log(`reusing the parent ${parentId} of tag ${J.tag}`);
  }
  if (!check('the coordinator creates one automation task for the message', !!parentId, parentId ? `${parentId}: ${taskRow(parentId).title}` : 'no automation task after 15 min')) return;
  parentId = await planSkippedFallback(parentId);
  if (!check('an automation task whose plan step Jev did not skip', !!parentId && stepsOf(parentId).find((s) => s.duty === 'plan')?.state !== 'skipped', parentId ? line(parentId) : 'none')) return;
  J.stop('parent');
  await poll(parentId);
  assertAll(parentId);
}

function assertAll(parentId) {
  const s = S.get();
  const parent = taskRow(parentId);
  const steps = stepsOf(parentId);
  const plan = steps.find((x) => x.duty === 'plan');
  const wfDecision = queryOne("SELECT * FROM decisions WHERE kind = 'workflow' AND task_id = ? ORDER BY created_at DESC", parentId);
  const wfChosen = parse(wfDecision?.chosen_json, {});
  check(
    "the parent's workflow is automation (plan, automate, verify) and its plan step ran",
    parent.kind === 'automation' && ['plan', 'automate', 'verify'].every((d) => steps.some((x) => x.duty === d)) && plan?.state !== 'skipped',
    `${parentId} ${parent.kind} "${parent.title}"; steps ${steps.map((x) => `${x.ordinal}.${x.duty}:${x.state}`).join(' ')}; workflow decision ${wfDecision?.id ?? 'none'} ${oneLine(JSON.stringify(wfChosen), 300)}${s.overrideWritten ? '; under the workflow override' : ''}`,
  );
  J.note(`The coordinator's brief for ${parentId}: ${oneLine(parent.task_text, 1500)}`);

  // The plan's needs-decision.
  const planRuns = runsOf(parentId).filter((r) => r.step_id === plan?.id);
  const planReports = planRuns.map((r) => reportOf(r.id)).filter(Boolean);
  const nd = planReports.find((r) => r.status === 'needs-decision');
  const ndText = nd ? `${nd.question ?? ''} ${(parse(nd.options_json, []) ?? []).map((o) => `${o.label}: ${o.description ?? ''}`).join(' | ')} ${nd.summary}` : '';
  check(
    'the plan step reports needs-decision proposing a child feature task',
    !!nd && /child|feature|separate task/i.test(ndText) && /data-testid|selector/i.test(ndText),
    nd ? `${nd.id} (${nd.session_id}) at ${nd.created_at}: question ${oneLine(nd.question, 400)}; options ${(parse(nd.options_json, []) ?? []).map((o) => o.label).join(' | ')}` : `plan reports: ${planReports.map((r) => r.status).join(',') || 'none'}`,
  );

  // The child.
  const children = childrenOf(parentId);
  const child = children[0];
  check('exactly one child task with parent_task_id set to the parent', children.length === 1, children.map((c) => `${c.id} ${c.kind} "${c.title}" ${c.state}`).join('; ') || 'none');
  if (!child) return;
  const tools = (() => {
    const offsets = (s.typed ?? []).map((t) => t.offset);
    return offsets.length ? co.digest(co.recordsFrom(Math.min(...offsets))).tools : [];
  })();
  const createCall = tools.find((t) => /task create/.test(t.input) && new RegExp(`--parent[ =]+["']?${parentId}`).test(t.input));
  check(`the coordinator ran jv task create --parent ${parentId}`, !!createCall, createCall ? `${createCall.at}: ${oneLine(createCall.input, 700)}` : `tool calls: ${tools.map((t) => oneLine(t.input, 120)).join(' || ').slice(0, 1500)}`);
  check('the child is a feature task created after the plan asked', child.kind === 'feature' && !!nd && child.created_at > nd.created_at, `${child.id} kind ${child.kind}, created ${child.created_at}; needs-decision ${nd?.created_at}`);
  // The parent's branch at the child's creation: its base plus any commit made before the child existed.
  const parentAtChild = git(SANDBOX, ['rev-parse', `refs/heads/${parent.branch}@{${child.created_at}}`]) || parent.base_commit;
  check(
    "the child's base commit is the parent's branch head when the child was created",
    !!child.base_commit && child.base_commit === parentAtChild && isAncestor(child.base_commit, `refs/heads/${parent.branch}`),
    `child ${child.branch} base ${child.base_commit}; parent ${parent.branch} at ${child.created_at}: ${parentAtChild}; parent base ${parent.base_commit}`,
  );
  if (parentAtChild === parent.base_commit) {
    J.deviation(
      `The parent's branch had no commit of its own when the child was created (plan.md is not committed), so its head was main's ${parent.base_commit.slice(0, 7)} and the child's base commit cannot tell the parent's branch from main here; that the child starts from the parent's branch is covered by the unit test "create --parent" in test/tasks.test.ts, and its landing into the parent's branch is checked below.`,
    );
  }
  const childSteps = stepsOf(child.id);
  check(
    "the child's steps are all done or skipped, each run with a report",
    childSteps.every((x) => ['done', 'skipped'].includes(x.state)) && runsOf(child.id).every((r) => reportOf(r.id) || r.state === 'stopped'),
    childSteps.map((x) => `${x.ordinal}.${x.duty}:${x.state}${x.attempts > 1 ? `x${x.attempts}` : ''}`).join(' '),
  );
  const childLanding = landingsOf(child.id).find((l) => l.state === 'landed');
  check(
    "the child's landing row is landed, into the parent's branch",
    !!childLanding && child.state === 'done' && new RegExp(parent.branch.replace(/[/.]/g, '\\$&')).test(`${childLanding.reason} ${child.state_reason}`),
    landingsOf(child.id).map((l) => `${l.id} ${l.route} ${l.state} ${l.commit_sha ?? ''}: ${oneLine(l.reason, 300)}`).join(' | ') + `; task: ${oneLine(child.state_reason, 300)}`,
  );
  const snap = s.childLandedSnapshot;
  const childCommit = childLanding?.commit_sha ?? child.landed_commit;
  // For a run that was not watching at that moment, main's reflog at the landing time stands in for the snapshot.
  const mainAtLanding = snap?.main ?? (childLanding ? git(SANDBOX, ['rev-parse', `${MAIN}@{${childLanding.ended_at}}`]) : '');
  check(
    "when the child landed, the parent's branch held its commit",
    snap ? snap.onParentBranch : isAncestor(childCommit, `refs/heads/${parent.branch}`),
    snap ? `${snap.at}: ${snap.commit} on ${snap.parentBranch} (head ${snap.parentBranchHead})` : `no snapshot; now: ${childCommit} on ${parent.branch}`,
  );
  check(
    'when the child landed, main did not hold its commit',
    !!childCommit && (snap ? snap.onMain === false : !!mainAtLanding && !isAncestor(childCommit, mainAtLanding)),
    snap ? `${snap.at}: main ${snap.main}, child commit on main: ${snap.onMain}` : `no snapshot; main at ${childLanding?.ended_at} (reflog) ${mainAtLanding}`,
  );

  // The parent's answer, after the child landed.
  const msgs = messagesOf(parentId);
  const firstAnswer = msgs[0];
  check(
    'the coordinator answered the parent only after the child landed',
    !!firstAnswer && !!childLanding && firstAnswer.created_at > childLanding.ended_at && firstAnswer.direction === 'coordinator',
    `${msgs.map((m) => `${m.id} ${m.direction} ${m.created_at}: ${oneLine(m.text, 300)}`).join(' | ') || 'no messages'}; child landed ${childLanding?.ended_at}`,
  );

  // The parent continues and lands.
  const automate = steps.filter((x) => x.duty === 'automate');
  const verify = steps.filter((x) => x.duty === 'verify');
  const doneWithReport = (x) => x.state === 'done' && query('SELECT status FROM reports WHERE step_id = ?', x.id).some((r) => r.status === 'done');
  check("the parent's plan, automate and verify steps are done with done reports", [plan, ...automate, ...verify].every((x) => x && (doneWithReport(x) || x.state === 'skipped')) && automate.length > 0 && verify.length > 0, steps.map((x) => `${x.ordinal}.${x.duty}:${x.state}${x.attempts > 1 ? `x${x.attempts}` : ''}`).join(' '));
  const parentLanding = landingsOf(parentId).find((l) => l.state === 'landed');
  const head = mainHead();
  check(
    "the parent's landing row is landed and main is at the parent's landed commit",
    !!parentLanding && parent.state === 'done' && !!parent.landed_commit && isAncestor(parent.landed_commit, `refs/heads/${MAIN}`),
    `${landingsOf(parentId).map((l) => `${l.id} ${l.route} ${l.state} ${l.commit_sha ?? ''}: ${oneLine(l.reason, 300)}`).join(' | ')}; main ${head}`,
  );
  check("main now holds the child's commit through the parent", isAncestor(childCommit, `refs/heads/${MAIN}`), `${childCommit} on ${MAIN} ${head}`);
  const base = s.mainBefore ?? parent.base_commit;
  const files = git(SANDBOX, ['diff', '--name-only', `${base}..${head}`]).split('\n').filter(Boolean);
  const automationFiles = files.filter((f) => f.startsWith('automations/'));
  const testids = git(SANDBOX, ['grep', '-c', 'data-testid', head, '--', 'src']);
  check("the automation scripts and the child's data-testid attributes are on main", automationFiles.length > 0 && testids !== '', `automations: ${automationFiles.join(', ') || 'none'}; data-testid in src: ${oneLine(testids, 300) || 'none'}; changed since ${base.slice(0, 8)}: ${files.join(', ')}`);

  // Placements and reports for every started step of both tasks.
  const missing = [];
  for (const t of [parentId, child.id]) {
    for (const x of stepsOf(t).filter((y) => y.state !== 'skipped' && y.state !== 'pending')) {
      const ds = query("SELECT * FROM decisions WHERE kind = 'placement' AND step_id = ?", x.id);
      const ok = ds.some((d) => {
        const c = parse(d.chosen_json, {});
        return c.source === 'owner' || (Object.keys(c.choices?.model?.probabilities ?? {}).length > 0 && Object.keys(c.choices?.effort?.probabilities ?? {}).length > 0);
      });
      if (!ok) missing.push(`${t} ${x.ordinal}.${x.duty}`);
    }
    for (const r of runsOf(t)) if (!placementOf(r)) missing.push(`run ${r.id}`);
  }
  check('every started step (parent and child) has a placement decision with probabilities, every run a placement', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${[parentId, child.id].flatMap((t) => runsOf(t)).length} runs placed`);

  const co2 = checkoutState(SANDBOX);
  check('the sandbox checkout is clean on main', co2.branch === MAIN && co2.status === '', `${co2.branch} ${co2.head}; status ${co2.status || 'clean'}`);

  // The brief's closing line: main holds the three J4 changes (plus this one).
  const j4 = parse(existsSync(join(RESULTS_DIR, 'J04-state-j4c.json')) ? readFileSync(join(RESULTS_DIR, 'J04-state-j4c.json'), 'utf8') : null, {});
  const j4Commits = (j4?.tasks ?? []).map((id) => taskRow(id)).filter(Boolean).map((t) => `${t.id} ${t.landed_commit}`);
  const j4On = (j4?.tasks ?? []).map((id) => taskRow(id)).filter(Boolean).every((t) => isAncestor(t.landed_commit, `refs/heads/${MAIN}`));
  check("main holds the three J4 changes plus J14's", j4Commits.length === 3 && j4On && isAncestor(parent.landed_commit, `refs/heads/${MAIN}`), `J4 ${j4Commits.join(', ')}; J14 ${parentId} ${parent.landed_commit}`);
  const all = git(SANDBOX, ['log', '--oneline', '--first-parent', `61fc71a..${head}`]).split('\n').filter(Boolean);
  J.deviation(
    `The brief's closing line says main holds "the three landed changes"; after J14 it holds the three J4 changes, J14's parent (with its child) and the other journeys' landings: ${all.length} first-parent commits since 61fc71a.`,
  );
  J.note(`main since 61fc71a (first parent): ${all.join(' | ')}`);

  // Elapsed.
  const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : undefined);
  J.set('parentCreatedToNeedsDecisionMs', ms(parent.created_at, nd?.created_at));
  J.set('needsDecisionToChildCreatedMs', ms(nd?.created_at, child.created_at));
  J.set('childCreatedToLandedMs', ms(child.created_at, childLanding?.ended_at));
  J.set('childLandedToParentAnswerMs', ms(childLanding?.ended_at, firstAnswer?.created_at));
  J.set('parentCreatedToLandedMs', ms(parent.created_at, parentLanding?.ended_at));
  J.note(`Parent ${parentId} "${parent.title}" (${parent.branch}); child ${child.id} "${child.title}" (${child.branch}).`);
  if (s.answers?.length) J.note(`Owner answers typed into the coordinator: ${s.answers.map((a) => `${a.at} ${a.kind}: "${a.answer}"`).join('; ')}.`);
  if (s.discarded?.length) J.note(`Discarded parents: ${s.discarded.join(', ')}.`);
  if (s.otherNewTasks?.length) J.note(`Other tasks the coordinator created with the parent: ${s.otherNewTasks.join('; ')}.`);
}

function tables(parentId) {
  if (!parentId) return [];
  const ids = [parentId, ...childrenOf(parentId).map((c) => c.id)];
  return ids.flatMap((id) => {
    const t = taskRow(id);
    const rows = runsOf(id).map((r) => {
      const step = stepsOf(id).find((x) => x.id === r.step_id);
      const d = placementOf(r);
      const c = parse(d?.chosen_json, {});
      return [
        `${step?.ordinal}.${step?.duty}`,
        r.id,
        r.runtime,
        r.provider,
        r.model,
        r.effort,
        c.source === 'owner' ? 'owner placement' : `model: ${topProbs(c.choices?.model?.probabilities)}; effort: ${topProbs(c.choices?.effort?.probabilities)}`,
        reportOf(r.id)?.status ?? '',
      ];
    });
    const lrows = landingsOf(id).map((l) => {
      const c = parse(l.decision_id ? queryOne('SELECT chosen_json FROM decisions WHERE id = ?', l.decision_id)?.chosen_json : null, {});
      return [l.id, l.route, l.state, c.probabilities ? topProbs(c.probabilities) : '', l.commit_sha ?? '', oneLine(l.reason, 300)];
    });
    return [
      { title: `${id} ${t.parent_task_id ? `child of ${t.parent_task_id}` : 'parent'}: ${t.title} (${t.kind}) runs`, columns: ['Step', 'Run', 'Runtime', 'Provider', 'Model', 'Effort', 'Top probabilities', 'Report'], rows },
      { title: `${id} landings`, columns: ['Landing', 'Route', 'State', 'Route probabilities', 'Commit', 'Reason'], rows: lrows },
    ];
  });
}

try {
  await main();
} catch (e) {
  check('the journey ran without an exception', false, String(e?.stack ?? e).slice(0, 1500));
}
// The workflow override, when the journey wrote one, is moved out again (archived next to the state file).
if (S.get().overrideWritten && existsSync(OVERRIDE_FILE)) {
  const to = join(RESULTS_DIR, `J14-automation-override-${J.tag}.json`);
  renameSync(OVERRIDE_FILE, to);
  J.note(`The workflow override was moved out of ${OVERRIDE_FILE} to ${to} after the run.`);
}
J.finish({ tables: tables(S.get().parent) });
