// jv ui page script: routes, rendering and the live stream. Vanilla ES modules, no build step, no framework.
//
// Read only: the page fetches JSON from /api/ and renders it; nothing here sends anything but GET requests. Every
// value from the store goes through html`` (escaped) or renderMarkdown (escaped, then formatted). Re-renders patch
// the DOM in place (morph), so open disclosures, images and the scroll position survive the live updates.

import { clockFmt, dateFmt, fullFmt, hiddenNote, providerUsageNote, rateLimitParts, toolResultView } from './format.js';
import { renderMarkdown } from './markdown.js';

// ---- safe HTML ----------------------------------------------------------------------------------------------------

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
function fmt(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += fmt(values[i]) + strings[i + 1];
  return new Raw(out);
}
const md = (text) => html`<div class="md">${raw(renderMarkdown(text ?? ''))}</div>`;

// ---- formatting ---------------------------------------------------------------------------------------------------

const TONE = {
  'waiting-owner': 'wait', running: 'run', queued: 'queue', landing: 'land', done: 'done', failed: 'fail', stopped: 'stop',
  pending: 'queue', retrying: 'wait', skipped: 'stop',
  starting: 'run', waiting: 'wait', lost: 'fail',
  progress: 'run', blocked: 'fail', 'needs-decision': 'wait',
  checking: 'run', landed: 'done', asked: 'wait',
  land: 'done', 'verify-then-land': 'run', 'ask-owner': 'wait',
};
const LABEL = { 'waiting-owner': 'waiting on owner', 'needs-decision': 'needs decision', 'verify-then-land': 'verify then land', 'ask-owner': 'ask owner' };
const tone = (state) => TONE[state] ?? 'queue';
const label = (state) => LABEL[state] ?? String(state ?? '');
const pill = (state, big = false) => html`<span class="pill t-${tone(state)}${big ? ' lg' : ''}">${label(state)}</span>`;
const passPill = (passed) => html`<span class="pill t-${passed ? 'done' : 'fail'}">${passed ? 'passed' : 'failed'}</span>`;
const lostMark = (lost) => (lost ? html`<span class="lost" title="The process ended without an end event">lost</span>` : '');
const dash = '-';

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function validDate(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t);
}
function ago(iso) {
  const d = validDate(iso);
  if (!d) return dash;
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function when(iso) {
  const d = validDate(iso);
  return d ? dateFmt.format(d) : dash;
}
const timeAgo = (iso) => (iso ? html`<time datetime="${iso}" data-rel="ago" title="${fullFmt.format(validDate(iso) ?? new Date(0))}">${ago(iso)}</time>` : dash);
const timeAt = (iso) => (iso ? html`<time datetime="${iso}" title="${fullFmt.format(validDate(iso) ?? new Date(0))}">${when(iso)}</time>` : dash);
function clock(iso) {
  const d = validDate(iso);
  return d ? clockFmt.format(d) : '';
}
function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return dash;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
function span(start, end) {
  const a = validDate(start);
  if (!a) return undefined;
  const b = validDate(end) ?? new Date();
  return b.getTime() - a.getTime();
}
function count(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return dash;
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dash;
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  return `$${v.toFixed(v < 10 ? 2 : 1)}`;
}
function pct(p, digits = 0) {
  return typeof p === 'number' && Number.isFinite(p) ? `${(p * 100).toFixed(digits)}%` : dash;
}
function pct100(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : dash;
}
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
const short = (hash, n = 10) => (hash ? String(hash).slice(0, n) : dash);
const fact = (name, value, mono = false, wide = false) =>
  html`<div${wide ? raw(' class="span2"') : ''}><dt>${name}</dt><dd${mono ? raw(' class="mono"') : ''}>${value === null || value === undefined || value === '' ? dash : value}</dd></div>`;
/** Items separated by middle dots; a line that wraps never starts with a dot. */
const dots = (items) => html`<div class="dotline"><div>${items.filter((i) => i !== '' && i !== null && i !== undefined && i !== false).map((i) => html`<span>${i}</span>`)}</div></div>`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- data ---------------------------------------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function getJson(url) {
  let r;
  try {
    r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new HttpError(0, 'The viewer is not reachable.');
  }
  let body;
  try {
    body = await r.json();
  } catch {
    body = undefined;
  }
  if (!r.ok) throw new HttpError(r.status, body?.error ?? `HTTP ${r.status}`);
  return body;
}

// ---- shared blocks ----------------------------------------------------------------------------------------------

function stepChip(step) {
  if (!step) return '';
  const extra = step.state !== 'running' && step.state !== 'pending' ? ` (${label(step.state)})` : '';
  return html`<span class="step-chip">step ${step.ordinal} of ${step.of} <span class="duty">${step.duty}</span>${extra}</span>`;
}

function taskRow(t) {
  const meta = [html`<span class="mono">${t.id}</span>`, t.kind];
  if (t.step) meta.push(stepChip(t.step));
  if (t.session) meta.push(`${t.session.model} ${t.session.effort} via ${t.session.provider}`);
  if (t.visible) meta.push('visible');
  const showReason = ['waiting-owner', 'failed', 'queued', 'landing'].includes(t.state) && t.stateReason;
  return html`<li data-key="t-${t.id}"><a class="row b-${tone(t.state)}" href="/task/${t.id}">
    <div class="row-title"><span class="title">${t.title}</span>${lostMark(t.lost)}</div>
    <div class="row-side">${t.lastEventAt ? timeAgo(t.lastEventAt) : html`<span title="No events yet">${timeAgo(t.createdAt)}</span>`}</div>
    <div class="row-meta">${dots(meta)}</div>
    ${showReason ? html`<div class="row-reason">${t.stateReason}</div>` : ''}
  </a></li>`;
}

function shot(s) {
  if (!s.url) {
    return html`<figure class="shot"><div class="panel missing">Not shown: <span class="mono">${s.path}</span> is not an image under .jv-evidence/</div><figcaption>${s.caption}</figcaption></figure>`;
  }
  return html`<figure class="shot"><a href="${s.url}" target="_blank" rel="noopener"><img src="${s.url}" alt="${s.caption}" decoding="async"></a><figcaption>${s.caption}</figcaption></figure>`;
}

function reportBlock(r) {
  if (!r) return '';
  const files = r.changedFiles ?? [];
  const shots = r.screenshots ?? [];
  const fileList = html`<ul class="files">${files.map((f) => html`<li>${f}</li>`)}</ul>`;
  return html`<div class="report r-${r.status}">
    <div class="report-head"><span class="label">Report</span>${pill(r.status)}${r.createdAt ? html`<span class="faint">${timeAt(r.createdAt)}</span>` : ''}</div>
    ${md(r.summary)}
    ${r.question
      ? html`<div class="question"><div class="q">${r.question}</div>${r.options?.length
          ? html`<ol>${r.options.map((o) => html`<li><b>${o.label}</b>${o.description ? html` <span class="muted">${o.description}</span>` : ''}</li>`)}</ol>`
          : ''}</div>`
      : ''}
    ${r.testsRun
      ? html`<div><div class="label">Tests</div><div class="tests">${passPill(r.testsRun.passed)}<code class="mono">${r.testsRun.command}</code></div>${r.testsRun.summary ? html`<div class="small muted">${r.testsRun.summary}</div>` : ''}</div>`
      : ''}
    ${shots.length ? html`<div><div class="label">Screenshots</div><div class="shots">${shots.map(shot)}</div></div>` : ''}
    ${files.length
      ? files.length > 12
        ? html`<details class="disclose" data-key="files-${r.id}"><summary><span class="chev"></span>${plural(files.length, 'changed file')}</summary>${fileList}</details>`
        : html`<div><div class="label">Changed files</div>${fileList}</div>`
      : ''}
    ${r.limitations ? html`<div><div class="label">Limitations</div><div class="small">${r.limitations}</div></div>` : ''}
    ${r.ownerCommands?.length
      ? html`<div><div class="label">For the owner to run</div>${r.ownerCommands.map((c) => html`<pre>${c.command}</pre><div class="small muted">In ${c.cwd}: ${c.why}</div>`)}</div>`
      : ''}
  </div>`;
}

function placementText(c) {
  if (!isObj(c)) return '';
  const name = c.label ?? c.model ?? '?';
  return `${name}${c.model && c.label ? ` (${c.model})` : ''} ${c.effort ?? ''} via ${c.provider ?? '?'}${c.runtime ? `, ${c.runtime}` : ''}`.replace(/\s+/g, ' ');
}

function answerBlock(a) {
  const probs = a.probabilities ?? [];
  const top = probs.slice(0, 6);
  const head = html`<div class="qname">${a.question}${
    a.source === 'only-option'
      ? html`<span class="faint">only option, not asked</span>`
      : typeof a.confidence === 'number'
        ? html`<span class="faint">confidence ${pct(a.confidence)}</span>`
        : ''
  }</div>`;
  if (!top.length) return html`<div class="prob-q">${head}<div class="prob chosen"><span class="opt">${a.choice ?? dash}</span><span></span><span></span></div></div>`;
  return html`<div class="prob-q">${head}${top.map(
    (p) => html`<div class="prob${p.option === a.choice ? ' chosen' : ''}"><span class="opt">${p.option}</span><span class="bar"><span data-w="${(p.p * 100).toFixed(1)}"></span></span><span class="pv">${pct(p.p)}</span></div>`,
  )}${probs.length > top.length ? html`<div class="tiny faint">and ${probs.length - top.length} more</div>` : ''}</div>`;
}

function overrideNote(d) {
  if (!d.override) return '';
  const o = d.override;
  const mode = d.overrideMode === 'keep' ? 'override only, the running session continued' : 'override and undo, the step started again';
  return html`<div class="note override"><b>Owner override</b> (${mode}): ${placementText(o) || JSON.stringify(o)}${o.at ? html`, ${timeAt(o.at)}` : ''}</div>`;
}

function outcomeNote(d) {
  const o = d.outcome;
  if (!isObj(o)) return '';
  const ok = o.status === 'done';
  const parts = [o.status ?? 'ended'];
  if (typeof o.attempts === 'number') parts.push(plural(o.attempts, 'attempt'));
  if (typeof o.durationMs === 'number') parts.push(duration(o.durationMs));
  if (typeof o.costUsd === 'number') parts.push(money(o.costUsd));
  return html`<div class="note ${ok ? 'outcome-done' : 'outcome-fail'}"><b>Outcome</b>: ${parts.join(', ')}</div>`;
}

function candidatesBlock(d) {
  const c = isObj(d.chosen) && Array.isArray(d.chosen.candidates) ? d.chosen.candidates : [];
  if (!c.length) return '';
  return html`<details class="disclose" data-key="cand-${d.id}"><summary><span class="chev"></span>Providers considered (${c.length})</summary>
    <ul class="checks">${c.map(
      (p) => html`<li class="check-head"><span class="pill t-${p.eligible ? 'done' : 'stop'}">${p.eligible ? 'in the menu' : 'left out'}</span><b>${p.name}</b><span class="muted small">${p.kind}${p.eligible ? '' : `, ${p.reason}`}</span><span class="faint small">${providerUsageNote(p)}</span></li>`,
    )}</ul></details>`;
}

const KIND_NAME = { placement: 'Placement', landing: 'Landing', workflow: 'Workflow questions' };

function decisionCard(d, opts = {}) {
  const source =
    d.source === 'owner' ? html`<span class="tag">by the owner</span>` : d.source === 'only-option' ? html`<span class="tag">nothing to ask</span>` : '';
  const meta = [timeAt(d.createdAt)];
  if (opts.showTask && d.task) meta.push(html`<a href="/task/${d.task.id}">${d.task.id}</a> ${d.task.title}`);
  if (opts.showTask && d.step) meta.push(`step ${d.step.ordinal} ${d.step.duty}`);
  meta.push(d.jevModel === 'none' ? 'no Jev call' : html`Jev <span class="mono">${d.jevModel}</span>`);
  if (d.latencyMs) meta.push(duration(d.latencyMs));
  if (d.usage?.calls) meta.push(`${plural(d.usage.calls, 'call')}, ${count(d.usage.inputTokens)} in, ${count(d.usage.outputTokens)} out`);
  meta.push(html`<span title="${d.skillName} ${d.skillHash}">${d.skillName} <span class="mono">${short(d.skillHash, 8)}</span></span>`);
  const skips = d.kind === 'workflow' && isObj(d.chosen) && Array.isArray(d.chosen.skip) ? d.chosen.skip : [];
  return html`<div class="${opts.bare ? '' : 'card card-body '}decision" data-key="d-${d.id}">
    <div class="decision-head">${opts.showKind !== false ? html`<span class="tag">${KIND_NAME[d.kind] ?? d.kind}</span>` : ''}<span class="what">${d.summary}</span>${source}${d.override ? html`<span class="pill t-land">overridden</span>` : ''}</div>
    <div class="decision-meta">${dots(meta)}</div>
    ${d.answers?.length ? html`<div class="probs">${d.answers.map(answerBlock)}</div>` : ''}
    ${skips.length ? html`<div class="small muted">Skipped: ${skips.map((s) => `step ${s.ordinal} ${s.duty} (${s.question})`).join(', ')}</div>` : ''}
    ${overrideNote(d)}
    ${outcomeNote(d)}
    ${d.kind === 'placement' ? candidatesBlock(d) : ''}
    ${d.kind === 'landing' && isObj(d.chosen) && d.chosen.reason ? html`<div class="small">${d.chosen.reason}</div>` : ''}
  </div>`;
}

function sessionCard(s) {
  const timing = s.startedAt ? html`${timeAt(s.startedAt)}<span class="sep">${duration(span(s.startedAt, s.endedAt))}</span>` : html`not started`;
  return html`<div class="card" data-key="r-${s.id}">
    <div class="card-head"><a class="mono" href="/session/${s.id}">${s.id}</a>${pill(s.state)}${lostMark(s.lost)}<span class="grow"></span><span class="tiny faint">${timing}</span></div>
    <div class="card-body">
      <dl class="facts">
        ${fact('Runtime', s.runtime)}${fact('Provider', s.provider)}${fact('Model', s.model)}${fact('Effort', s.effort)}
        ${fact('Native id', s.nativeSessionId, true)}${fact('tmux', s.tmuxTarget, true)}
        ${fact('Tokens', `${count(s.tokens.input)} in, ${count(s.tokens.output)} out`)}${fact('Cache', `${count(s.tokens.cacheRead)} read, ${count(s.tokens.cacheWrite)} write`)}
        ${fact('Cost', money(s.costUsd))}${fact('Events', html`<a href="/session/${s.id}">${s.eventCount}</a>`)}
      </dl>
      ${s.stateReason ? html`<div class="small muted">${s.stateReason}</div>` : ''}
      ${reportBlock(s.report)}
    </div>
  </div>`;
}

// ---- pages ----------------------------------------------------------------------------------------------------

const overviewPage = {
  nav: 'tasks',
  title: () => 'Tasks',
  load: () => getJson('/api/overview'),
  render(d) {
    const head = html`<div class="page-head"><h1>Tasks</h1></div>`;
    if (!d.projects.length) {
      return html`${head}<div class="notice">No projects yet. Register one with <code class="mono">jv project add &lt;path&gt;</code>.</div>`;
    }
    return html`${head}${d.projects.map((p) => {
      const parts = p.groups.map((g) => `${g.tasks.length} ${g.label.toLowerCase().replace(' in the last 24 hours', ' today')}`);
      return html`<section class="project" data-key="p-${p.id}">
        <div class="project-head"><h2>${p.name}</h2><span class="path mono">${p.path}</span><div class="project-summary">${parts.length ? parts.join(', ') : 'Nothing open'}${p.hidden ? `. ${hiddenNote(p.hidden)}` : ''}</div></div>
        ${p.groups.map(
          (g) => html`<div class="group" data-key="g-${p.id}-${g.state}"><div class="group-head">${g.label}<span class="count">${g.tasks.length}</span></div><ul class="rows panel">${g.tasks.map(taskRow)}</ul></div>`,
        )}
        ${p.groups.length ? '' : html`<div class="panel empty">No open tasks, and nothing finished in the last 24 hours.</div>`}
      </section>`;
    })}`;
  },
};

function stepItem(s) {
  const meta = [];
  if (s.attempts > 0) meta.push(`attempt ${s.attempts}`);
  if (s.whenRule && s.whenRule !== 'always') meta.push(`when ${s.whenRule}`);
  if (isObj(s.onFail) && s.onFail.goto) meta.push(`on failure back to ${s.onFail.goto}${s.onFail.maxLoops ? `, up to ${plural(s.onFail.maxLoops, 'loop')}` : ''}`);
  if (s.startedAt) meta.push(`${when(s.startedAt)}, ${duration(span(s.startedAt, s.endedAt))}`);
  const body = [...s.placements.map((d) => decisionCard(d, { showKind: true })), ...s.sessions.map(sessionCard)];
  return html`<li class="${s.current ? 'current' : ''}" data-key="s-${s.id}"><span class="node t-${tone(s.state)}" aria-hidden="true">${s.ordinal}</span>
    <div class="step-head"><span class="duty">${s.duty}</span>${pill(s.state)}${s.current ? html`<span class="tag">current</span>` : ''}</div>
    ${meta.length ? html`<div class="step-meta">${meta.join(', ')}</div>` : ''}
    ${s.stateReason ? html`<div class="step-meta">${s.stateReason}</div>` : ''}
    ${s.instructions ? html`<details class="disclose" data-key="ins-${s.id}"><summary><span class="chev"></span>Step instructions</summary>${md(s.instructions)}</details>` : ''}
    ${body.length ? html`<div class="step-body">${body}</div>` : ''}
  </li>`;
}

function landingBlock(l) {
  const checks = Array.isArray(l.checks) ? l.checks : [];
  return html`<div class="card" data-key="l-${l.id}">
    <div class="card-head"><span class="mono">${l.id}</span>${pill(l.route)}${pill(l.state)}<span class="grow"></span><span class="tiny faint">${timeAt(l.createdAt)}</span></div>
    <div class="card-body">
      ${l.reason ? html`<div>${l.reason}</div>` : ''}
      ${l.commitSha ? html`<div class="small">Landed as <span class="mono">${short(l.commitSha, 12)}</span></div>` : ''}
      ${checks.length
        ? html`<div><div class="label">Checks</div><ul class="checks">${checks.map((c, i) => {
            const ok = c.passed ?? c.ok ?? (typeof c.exitCode === 'number' ? c.exitCode === 0 : undefined);
            const out = c.outputTail ?? c.output ?? c.tail;
            return html`<li class="check" data-key="c-${l.id}-${i}"><div class="check-head">${ok === undefined ? html`<span class="pill">${c.state ?? 'ran'}</span>` : passPill(ok)}<b>${c.name ?? `check ${i + 1}`}</b>${c.command ? html`<code class="mono small">${c.command}</code>` : ''}${typeof c.durationMs === 'number' ? html`<span class="faint small">${duration(c.durationMs)}</span>` : ''}</div>${out ? html`<details class="disclose" data-key="co-${l.id}-${i}"><summary><span class="chev"></span>Output</summary><pre>${out}</pre></details>` : ''}</li>`;
          })}</ul></div>`
        : ''}
      ${l.decision ? decisionCard(l.decision, { bare: true }) : ''}
    </div>
  </div>`;
}

const taskPage = {
  nav: 'tasks',
  title: (d) => `${d.task.id} ${d.task.title}`,
  load: ([id]) => getJson(`/api/task/${encodeURIComponent(id)}`),
  render(d) {
    const t = d.task;
    const crumbs = html`<nav class="crumbs" aria-label="Breadcrumb">${dots([html`<a href="/">Tasks</a>`, d.project?.name, html`<span class="mono">${t.id}</span>`])}</nav>`;
    const facts = html`<dl class="facts panel panel-pad">
      ${fact('Kind', t.kind)}${t.workflow && t.workflow !== t.kind ? fact('Workflow', t.workflow) : ''}${fact('Branch', t.branch, true, true)}${fact('Worktree', t.worktreePath, true, true)}
      ${fact('Base', short(t.baseCommit, 12), true)}${fact('Landed', t.landedCommit ? short(t.landedCommit, 12) : null, true)}
      ${fact('Created', timeAt(t.createdAt))}${fact('Last event', t.lastEventAt ? timeAgo(t.lastEventAt) : null)}
      ${fact('Duration', t.startedAt ? duration(span(t.startedAt, t.endedAt)) : null)}${fact('Visible', t.visible ? 'yes, in tmux' : 'no')}
      ${d.parent ? fact('Parent', html`<a href="/task/${d.parent.id}">${d.parent.id}</a> ${d.parent.title}`) : ''}
      ${d.after ? fact('After', html`<a href="/task/${d.after.id}">${d.after.id}</a> ${d.after.title} (${label(d.after.state)})`) : ''}
    </dl>`;
    const landingCount = d.landings.length + d.landingDecisions.length;
    return html`<div class="page-head">${crumbs}<h1><span>${t.title}</span>${pill(t.state, true)}${lostMark(t.lost)}</h1>${t.stateReason ? html`<p class="lede">${t.stateReason}</p>` : ''}</div>
      ${facts}
      <section class="section" data-key="text"><div class="section-title"><h2>Task</h2></div><div class="panel task-text">${md(t.text)}</div></section>
      ${d.workflowDecisions.length ? html`<section class="section" data-key="wf"><div class="section-title"><h2>Workflow questions</h2></div><div class="list">${d.workflowDecisions.map((x) => decisionCard(x, { showKind: false }))}</div></section>` : ''}
      <section class="section" data-key="steps"><div class="section-title"><h2>Steps</h2><span class="count">${d.steps.length}</span></div>
        ${d.steps.length ? html`<ol class="timeline">${d.steps.map(stepItem)}</ol>` : html`<div class="panel empty">No steps.</div>`}
      </section>
      ${d.otherSessions.length ? html`<section class="section" data-key="other"><div class="section-title"><h2>Other sessions</h2></div><div class="list">${d.otherSessions.map(sessionCard)}</div></section>` : ''}
      ${landingCount ? html`<section class="section" data-key="landing"><div class="section-title"><h2>Landing</h2></div><div class="list">${d.landings.map(landingBlock)}${d.landingDecisions.map((x) => decisionCard(x))}</div></section>` : ''}
      ${d.children.length ? html`<section class="section" data-key="children"><div class="section-title"><h2>Child tasks</h2><span class="count">${d.children.length}</span></div><ul class="rows panel">${d.children.map(taskRow)}</ul></section>` : ''}
      ${d.messages.length ? html`<section class="section" data-key="messages"><details class="disclose" data-key="msgs"><summary><span class="chev"></span>Messages to the task (${d.messages.length})</summary><div class="list">${d.messages.map(
        (m) => html`<div class="card card-body" data-key="m-${m.id}"><div class="small muted">From the ${m.direction === 'answer' ? 'owner (answer)' : m.direction}, ${timeAt(m.createdAt)}${m.deliveredAt ? html`, delivered ${timeAt(m.deliveredAt)}` : ', not delivered yet'}</div>${md(m.text)}</div>`,
      )}</div></details></section>` : ''}`;
  },
};

// ---- session page -------------------------------------------------------------------------------------------

const FIRST_LINE_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'name'];

function firstLine(text) {
  const t = String(text ?? '');
  try {
    const v = JSON.parse(t);
    if (isObj(v)) {
      for (const k of FIRST_LINE_KEYS) if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim().split('\n')[0];
      const first = Object.entries(v).find(([, x]) => typeof x === 'string' && x.trim());
      if (first) return `${first[0]}: ${first[1].trim().split('\n')[0]}`;
    }
  } catch {
    // not JSON
  }
  return t.split('\n').find((l) => l.trim()) ?? '';
}
function pretty(text) {
  const t = String(text ?? '');
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

function evItem(e, body, cls = '') {
  return html`<li class="ev ${cls}" data-key="e-${e.seq}"><span class="ev-time" title="${e.at}">${clock(e.at)}</span><div class="ev-body">${body}</div></li>`;
}

function eventItem(e, results) {
  const p = isObj(e.payload) ? e.payload : {};
  switch (e.kind) {
    case 'start':
      return evItem(e, html`Started ${p.resume ? '(resume) ' : ''}<b>${p.runtime ?? ''}</b>, ${p.provider ?? ''}, ${p.model ?? ''} ${p.effort ?? ''}${p.cwd ? html` in <span class="mono">${p.cwd}</span>` : ''}`, 'small');
    case 'text':
      return evItem(e, md(p.text), 'text');
    case 'thinking':
      return evItem(e, html`<details class="disclose" data-key="th-${e.seq}"><summary><span class="chev"></span>Thinking: ${firstLine(p.text).slice(0, 140)}</summary>${md(p.text)}</details>`, 'think');
    case 'message': {
      const from = p.from === 'owner' ? 'From the owner' : p.from === 'coordinator' ? 'From the coordinator' : 'Message from jv';
      return evItem(e, html`<div class="ev-kind">${from}</div>${md(p.text ?? p.message ?? '')}`, 'msg');
    }
    case 'tool-call': {
      const r = p.id ? results.get(p.id) : undefined;
      const rp = r && isObj(r.payload) ? r.payload : undefined;
      const status = !rp ? html`<span class="res wait">running</span>` : rp.ok === false ? html`<span class="res bad">error</span>` : html`<span class="res ok">ok</span>`;
      return evItem(
        e,
        html`<details class="tool" data-key="tc-${e.seq}"><summary><span class="chev"></span><span class="tname">${p.name ?? 'tool'}</span><span class="first">${firstLine(p.input)}</span>${status}</summary>
          <div class="tool-detail"><div><div class="label">Input${p.inputTruncated ? ' (cut)' : ''}</div><pre>${pretty(p.input)}</pre></div>
          ${rp ? html`<div><div class="label">Result${rp.ok === false ? ', error' : ''}${rp.outputTruncated ? ' (cut)' : ''}</div><pre>${rp.output ?? ''}</pre></div>` : ''}</div></details>`,
        'tool-ev',
      );
    }
    case 'tool-result': {
      const r = toolResultView(p);
      const status = r.failed ? html`<span class="res bad">error</span>` : p.ok === true ? html`<span class="res ok">ok</span>` : '';
      return evItem(e, html`<details class="tool" data-key="tr-${e.seq}"><summary><span class="chev"></span><span class="tname">${r.name}</span><span class="first">${r.command ?? firstLine(r.body)}</span>${status}</summary><div class="tool-detail"><pre>${r.detail}</pre></div></details>`, 'tool-ev');
    }
    case 'report':
      return evItem(e, reportBlock(p), 'report-ev');
    case 'error':
      return evItem(e, html`<div class="ev-kind">Error</div>${p.message ?? JSON.stringify(p)}`, 'err');
    case 'usage': {
      const parts = [`${count(p.inputTokens)} in`, `${count(p.outputTokens)} out`, `cache ${count(p.cacheReadTokens)} read, ${count(p.cacheWriteTokens)} write`];
      if (typeof p.costUsd === 'number') parts.push(money(p.costUsd));
      if (typeof p.numTurns === 'number') parts.push(plural(p.numTurns, 'turn'));
      if (typeof p.durationMs === 'number') parts.push(duration(p.durationMs));
      return evItem(e, html`Usage: ${parts.join(', ')}`, 'small');
    }
    case 'rate-limit': {
      const parts = rateLimitParts(p, when);
      return evItem(e, html`Rate limit: ${parts.length ? parts.join(', ') : 'no values reported'}`, 'small');
    }
    case 'end':
      // The reason often names the report already ("turn ended: report done"); say it once.
      const reportSaid = p.report && String(p.reason ?? '').includes(`report ${p.report}`);
      return evItem(e, html`Ended: <b>${label(p.status ?? 'end')}</b>${p.reason ? html`, ${p.reason}` : ''}${p.report && !reportSaid ? html`, report ${label(p.report)}` : ''}`, 'small');
    default:
      return evItem(e, html`<div class="ev-kind">${e.kind}</div><pre>${JSON.stringify(e.payload, null, 2)}</pre>`);
  }
}

let sessionCache = { id: '', events: [], lastSeq: 0 };

const sessionPage = {
  nav: 'tasks',
  stick: true,
  title: (d) => `${d.session.id} session`,
  async load([id]) {
    if (sessionCache.id !== id) sessionCache = { id, events: [], lastSeq: 0 };
    const before = sessionCache.events.length;
    let page;
    do {
      page = await getJson(`/api/session/${encodeURIComponent(id)}?after=${sessionCache.lastSeq}`);
      if (sessionCache.id !== id) break;
      sessionCache.events.push(...page.events.filter((e) => e.seq > sessionCache.lastSeq));
      sessionCache.lastSeq = Math.max(sessionCache.lastSeq, page.lastSeq);
    } while (page.more);
    return { ...page, events: sessionCache.events, grew: sessionCache.events.length > before && before > 0 };
  },
  render(d) {
    const s = d.session;
    const results = new Map();
    const calls = new Set();
    for (const e of d.events) {
      if (e.kind === 'tool-call' && isObj(e.payload) && e.payload.id) calls.add(e.payload.id);
      if (e.kind === 'tool-result' && isObj(e.payload) && e.payload.id) results.set(e.payload.id, e);
    }
    const shown = d.events.filter((e) => !(e.kind === 'tool-result' && isObj(e.payload) && calls.has(e.payload.id)));
    const crumbs = html`<nav class="crumbs" aria-label="Breadcrumb">${dots([
      html`<a href="/">Tasks</a>`,
      d.project?.name,
      d.task ? html`<a class="mono" href="/task/${d.task.id}">${d.task.id}</a>` : '',
      d.step ? `step ${d.step.ordinal} of ${d.step.of}, ${d.step.duty}` : '',
    ])}</nav>`;
    return html`<div class="page-head">${crumbs}<h1><span class="mono">${s.id}</span>${pill(s.state, true)}${lostMark(s.lost)}</h1>${d.task ? html`<p class="lede">${d.task.title}</p>` : ''}</div>
      <dl class="facts panel panel-pad">
        ${fact('Runtime', s.runtime)}${fact('Provider', s.provider)}${fact('Model', s.model)}${fact('Effort', s.effort)}
        ${fact('Native id', s.nativeSessionId, true)}${fact('tmux', s.tmuxTarget, true)}
        ${fact('Started', timeAt(s.startedAt))}${fact('Duration', s.startedAt ? duration(span(s.startedAt, s.endedAt)) : null)}
        ${fact('Tokens', `${count(s.tokens.input)} in, ${count(s.tokens.output)} out`)}${fact('Cache', `${count(s.tokens.cacheRead)} read, ${count(s.tokens.cacheWrite)} write`)}
        ${fact('Cost', money(s.costUsd))}${fact('Last event', s.lastEventAt ? timeAgo(s.lastEventAt) : null)}
        ${fact('Working folder', s.cwd, true, true)}
      </dl>
      ${s.stateReason ? html`<p class="small muted">${s.stateReason}</p>` : ''}
      <section class="section" data-key="events"><div class="section-title"><h2>Events</h2><span class="count">${d.events.length}</span></div>
        ${shown.length ? html`<div class="panel panel-pad"><ol class="stream">${shown.map((e) => eventItem(e, results))}</ol></div>` : html`<div class="panel empty">No events yet.</div>`}
        ${['starting', 'running', 'queued'].includes(s.state) && !s.lost ? html`<p class="stream-foot">Live: new events appear here as they arrive.</p>` : ''}
      </section>`;
  },
};

// ---- decisions page ---------------------------------------------------------------------------------------------

const decisionsPage = {
  nav: 'decisions',
  title: () => 'Decisions',
  load: (_params, query) => {
    const q = new URLSearchParams();
    for (const k of ['kind', 'from', 'to', 'project', 'task']) if (query.get(k)) q.set(k, query.get(k));
    return getJson(`/api/decisions?${q}`);
  },
  render(d) {
    const f = d.filter;
    const option = (value, text) => html`<option value="${value}"${(f.kind ?? '') === value ? raw(' selected') : ''}>${text}</option>`;
    const filtered = f.kind || f.from || f.to || f.project || f.task;
    return html`<div class="page-head"><h1>Decisions</h1><p class="lede">Every Jev decision: where each step ran, which workflow steps were needed, and how each task landed.</p></div>
      <div class="filters" role="search">
        <label>Kind<select data-filter="kind">${option('', 'All kinds')}${d.kinds.map((k) => option(k, KIND_NAME[k] ?? k))}</select></label>
        <label>From<input type="date" data-filter="from" value="${f.from ?? ''}"></label>
        <label>To<input type="date" data-filter="to" value="${f.to ?? ''}"></label>
        ${filtered ? html`<a class="clear" href="/decisions">Clear filters</a>` : ''}
        <span class="result">${d.shown < d.total ? `Newest ${d.shown} of ${d.total}` : plural(d.total, 'decision')}${f.task ? ` for ${f.task}` : ''}${f.project ? ` in ${f.project}` : ''}</span>
      </div>
      ${d.decisions.length ? html`<div class="list">${d.decisions.map((x) => decisionCard(x, { showTask: true }))}</div>` : html`<div class="panel empty">No decisions${filtered ? ' match these filters' : ' yet'}.</div>`}`;
  },
};

// ---- usage page --------------------------------------------------------------------------------------------------

function weekRange(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return '';
  const year = Number(m[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000 + (Number(m[2]) - 1) * 7 * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return `${dayFmt.format(monday)} to ${dayFmt.format(sunday)}`;
}

function meter(name, value) {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const cls = v === null ? '' : v >= 90 ? ' over' : v >= 70 ? ' hot' : '';
  return html`<div class="meter${cls}"><span class="muted">${name}</span><span class="bar"><span data-w="${v === null ? 0 : Math.min(100, v).toFixed(1)}"></span></span><span class="pv">${pct100(v)}</span></div>`;
}

const usagePage = {
  nav: 'usage',
  title: () => 'Usage',
  load: () => getJson('/api/usage'),
  render(d) {
    const head = html`<div class="page-head"><h1>Usage</h1><p class="lede">Provider usage by week: probes, rate limits seen in streams, and local token sums, with the sessions that ran.</p></div>`;
    if (!d.weeks.length) return html`${head}<div class="notice">No usage observed yet. <code class="mono">jv providers check</code> records it, and every session adds to it.</div>`;
    return html`${head}${d.weeks.map(
      (w) => html`<section class="week" data-key="w-${w.week}"><div class="week-head"><h2>${w.week}</h2><span class="muted small">${weekRange(w.week)}</span></div>
        <div class="providers">${w.providers.map(
          (p) => html`<div class="card provider" data-key="pv-${w.week}-${p.provider}">
            <div class="provider-name">${p.provider}${p.observedAt ? html`<span class="faint tiny">seen ${timeAgo(p.observedAt)}</span>` : ''}</div>
            ${p.weeklyPct !== null || p.fiveHourPct !== null ? html`${meter('Week', p.weeklyPct)}${meter('Five hours', p.fiveHourPct)}` : ''}
            <div class="kv">
              ${Object.keys(p.sources).length ? html`<div>${Object.entries(p.sources).map(([k, n]) => `${n} ${k}`).join(', ')} ${Object.values(p.sources).reduce((a, b) => a + b, 0) === 1 ? 'observation' : 'observations'}</div>` : ''}
              ${p.sessions.count ? html`<div><span><b>${p.sessions.count}</b> ${p.sessions.count === 1 ? 'session' : 'sessions'}</span><span><b>${count(p.sessions.inputTokens)}</b> in, <b>${count(p.sessions.outputTokens)}</b> out</span><span><b>${money(p.sessions.costUsd)}</b></span></div>` : ''}
              ${p.localInputTokens || p.localOutputTokens ? html`<div>local <b>${count(p.localInputTokens)}</b> in, <b>${count(p.localOutputTokens)}</b> out, <b>${money(p.localCostUsd)}</b></div>` : ''}
              ${!p.sessions.count && !p.localInputTokens && !p.localOutputTokens && p.weeklyPct === null && p.fiveHourPct === null ? html`<div>Nothing used this week</div>` : ''}
              ${p.weeklyResetsAt ? html`<div>week resets ${when(p.weeklyResetsAt)}</div>` : ''}
            </div>
          </div>`,
        )}</div>
        ${w.rows.length ? html`<details class="disclose" data-key="obs-${w.week}"><summary><span class="chev"></span>${plural(w.rows.length, 'observation')}</summary>
          <div class="panel"><table class="obs"><thead><tr><th>Time</th><th>Provider</th><th>Source</th><th>Week</th><th>Five hours</th><th>Local tokens</th></tr></thead><tbody>${w.rows.map(
            (r) => html`<tr><td data-l="">${timeAt(r.observedAt)}</td><td data-l="Provider">${r.provider}</td><td data-l="Source">${r.source}</td><td data-l="Week">${pct100(r.weeklyPct)}</td><td data-l="Five hours">${pct100(r.fiveHourPct)}</td><td data-l="Local">${r.localInputTokens !== null || r.localOutputTokens !== null ? `${count(r.localInputTokens ?? 0)} in, ${count(r.localOutputTokens ?? 0)} out` : dash}</td></tr>`,
          )}</tbody></table></div></details>` : ''}
      </section>`,
    )}`;
  },
};

const notFoundPage = {
  nav: '',
  title: () => 'Not found',
  load: async () => ({}),
  render: () => html`<div class="page-head"><h1>Not found</h1></div><div class="notice">This page does not exist. <a href="/">Back to the tasks</a>.</div>`,
};

// ---- DOM patching (keeps open disclosures, images and focus across live updates) --------------------------------

function keyOf(n) {
  return n.nodeType === 1 ? n.getAttribute('data-key') : null;
}
function patchAttributes(a, b) {
  const keepOpen = a.tagName === 'DETAILS';
  for (const { name } of [...a.attributes]) {
    if (name === 'style' || (keepOpen && name === 'open')) continue;
    if (!b.hasAttribute(name)) a.removeAttribute(name);
  }
  for (const { name, value } of [...b.attributes]) {
    if (keepOpen && name === 'open') continue;
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  if (a.tagName === 'INPUT' && document.activeElement !== a) {
    const v = b.getAttribute('value') ?? '';
    if (a.value !== v) a.value = v;
  }
}
function patchNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  patchAttributes(a, b);
  patchChildren(a, b);
  if (a.tagName === 'SELECT') {
    const sel = [...b.options].find((o) => o.hasAttribute('selected'));
    if (sel && a.value !== sel.value && document.activeElement !== a) a.value = sel.value;
  }
}
function compatible(a, b) {
  if (!a || a.nodeType !== b.nodeType) return false;
  if (a.nodeType === 1 && (a.tagName !== b.tagName || keyOf(a) !== null)) return false;
  return true;
}
function patchChildren(parent, next) {
  const keyed = new Map();
  for (const c of parent.childNodes) {
    const k = keyOf(c);
    if (k !== null) keyed.set(k, c);
  }
  let i = 0;
  for (const n of [...next.childNodes]) {
    const cur = parent.childNodes[i] ?? null;
    const k = keyOf(n);
    if (k !== null && keyed.has(k) && keyed.get(k).tagName === n.tagName) {
      const match = keyed.get(k);
      keyed.delete(k);
      if (match !== cur) parent.insertBefore(match, cur);
      patchNode(match, n);
    } else if (k === null && compatible(cur, n)) {
      patchNode(cur, n);
    } else {
      parent.insertBefore(n, cur);
    }
    i++;
  }
  while (parent.childNodes.length > i) parent.removeChild(parent.lastChild);
}
function morph(target, markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  patchChildren(target, tpl.content);
}
function applyWidths(root) {
  for (const el of root.querySelectorAll('[data-w]')) {
    const w = `${Math.max(0, Math.min(100, Number(el.getAttribute('data-w')) || 0))}%`;
    if (el.style.width !== w) el.style.width = w;
  }
}
function tick() {
  for (const el of document.querySelectorAll('time[data-rel="ago"]')) {
    const t = ago(el.getAttribute('datetime'));
    if (el.textContent !== t) el.textContent = t;
  }
}

// ---- routing and refresh ----------------------------------------------------------------------------------------

const ROUTES = [
  [/^\/$/, overviewPage],
  [/^\/task\/([^/]+)\/?$/, taskPage],
  [/^\/session\/([^/]+)\/?$/, sessionPage],
  [/^\/decisions\/?$/, decisionsPage],
  [/^\/usage\/?$/, usagePage],
];

const main = document.getElementById('main');
const live = document.getElementById('live');
const foot = document.getElementById('foot');
let current;
let inflight = false;
let again = false;

function setLive(state) {
  const text = { live: 'Live', connecting: 'Connecting', offline: 'Offline', unavailable: 'Store unavailable' }[state] ?? state;
  if (live.getAttribute('data-state') !== state) live.setAttribute('data-state', state);
  if (live.textContent !== text) live.textContent = text;
}

function resolve() {
  const path = location.pathname;
  for (const [re, page] of ROUTES) {
    const m = re.exec(path);
    if (m) {
      let params;
      try {
        params = m.slice(1).map((x) => decodeURIComponent(x));
      } catch {
        params = m.slice(1);
      }
      return { page, params };
    }
  }
  return { page: notFoundPage, params: [] };
}

function route(fresh) {
  const { page, params } = resolve();
  const key = `${location.pathname}`;
  const changed = !current || current.key !== key;
  current = { page, params, key, query: new URLSearchParams(location.search), rendered: !changed && current?.rendered };
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.getAttribute('data-nav') === page.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (changed) {
    main.replaceChildren();
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Loading';
    main.append(p);
    if (fresh) window.scrollTo(0, 0);
  }
  refresh();
}

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
}

async function render() {
  const view = current;
  try {
    const data = await view.page.load(view.params, view.query);
    if (view !== current) return;
    const stick = view.page.stick && data.grew && nearBottom();
    morph(main, String(view.page.render(data, view.params)));
    applyWidths(main);
    view.rendered = true;
    document.title = `${view.page.title(data)} - jv`;
    foot.textContent = `Read-only view of the jv store. Updated ${clockFmt.format(new Date())}.`;
    if (live.getAttribute('data-state') === 'unavailable') setLive(source && source.readyState === 1 ? 'live' : 'connecting');
    if (stick) window.scrollTo(0, document.documentElement.scrollHeight);
  } catch (error) {
    if (view !== current) return;
    const status = error instanceof HttpError ? error.status : -1;
    if (status === 404) {
      morph(main, String(html`<div class="page-head"><h1>Not found</h1></div><div class="notice">${error.message}. <a href="/">Back to the tasks</a>.</div>`));
      document.title = 'Not found - jv';
    } else if (status === 503) {
      setLive('unavailable');
      morph(main, String(html`<div class="page-head"><h1>Store unavailable</h1></div><div class="notice error">${error.message}</div>`));
    } else if (!view.rendered) {
      morph(main, String(html`<div class="notice error">Could not load this page: ${error.message}</div>`));
    } else {
      foot.textContent = `Could not refresh: ${error.message}`;
    }
  }
}

async function refresh() {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    do {
      again = false;
      await render();
    } while (again);
  } finally {
    inflight = false;
  }
}

// Links inside the page navigate without a reload; evidence images and anything with a target open normally.
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(evidence|api|ui)\//.test(url.pathname)) return;
  e.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) history.pushState(null, '', url.pathname + url.search + url.hash);
  route(true);
});
window.addEventListener('popstate', () => route(false));

// Decision filters: they change the address (no form, nothing is sent but the GET of the list).
document.addEventListener('change', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-filter]') : null;
  if (!el) return;
  const q = new URLSearchParams(location.search);
  const v = el.value.trim();
  if (v) q.set(el.getAttribute('data-filter'), v);
  else q.delete(el.getAttribute('data-filter'));
  const s = q.toString();
  history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}`);
  current.query = new URLSearchParams(location.search);
  refresh();
});

// An image that cannot be loaded says so instead of showing a broken icon.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const fig = img.closest('.shot');
    if (!fig || fig.querySelector('.missing')) return;
    const note = document.createElement('div');
    note.className = 'panel missing';
    note.textContent = 'The image is no longer in the worktree.';
    img.closest('a')?.replaceWith(note);
  },
  true,
);

let source;
let hellos = 0;
function connect() {
  source = new EventSource('/api/live');
  source.addEventListener('hello', () => {
    setLive('live');
    // A reconnect may have missed changes; the first hello comes right after the first load.
    if (hellos++ > 0) refresh();
  });
  source.addEventListener('change', () => refresh());
  source.addEventListener('error', () => setLive(source.readyState === 2 ? 'offline' : 'connecting'));
}

setInterval(tick, 10_000);
route(false);
connect();
