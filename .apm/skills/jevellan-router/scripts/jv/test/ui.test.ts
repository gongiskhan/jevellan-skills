// jv ui (section 10): every page and endpoint over a fixture store in a temporary JV_HOME, the evidence route's
// refusals, the read-only guarantees, the Host guard, the live stream, the Markdown renderer and the jv ui command.
// No network beyond loopback, no model calls, no browser (the visual check is acceptance/viewer-check.mjs).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-ui-test-');
process.env.JV_HOME = home;
const { openStore } = await import('../src/store.js');
const { recordEvent } = await import('../src/events.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
const { startUiServer, validateBind, hostAllowed } = await import('../src/ui/server.js');
const { ReadOnlyStore } = await import('../src/ui/db.js');
const { evidenceUrl, isoWeek, currentStep } = await import('../src/ui/views.js');
const { sniffImage, evidenceSegments } = await import('../src/ui/evidence.js');
const { buildUiFixture } = await import('./fixtures/ui-fixture.js');
const markdown = (await import(pathToFileURL(join(RUNTIME_ROOT, 'ui', 'markdown.js')).href)) as {
  renderMarkdown(text: string): string;
  renderInline(text: string): string;
};
const format = (await import(pathToFileURL(join(RUNTIME_ROOT, 'ui', 'format.js')).href)) as {
  dateFmt: Intl.DateTimeFormat;
  fullFmt: Intl.DateTimeFormat;
  clockFmt: Intl.DateTimeFormat;
  rateLimitParts(p: unknown, formatDate: (iso: string) => string): string[];
  toolResultView(p: unknown): { name: string; command?: string; body: string; detail: string; failed: boolean };
  hiddenNote(n: number): string;
  providerUsageNote(p: unknown): string;
};

const store = openStore();
const fx = buildUiFixture(store, home);
const aliveIds = new Set(fx.alive);
const ui = await startUiServer({ port: 0, pollMs: 100, alive: (s) => aliveIds.has(s.id) });
const base = ui.url;

after(async () => {
  await ui.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

async function json<T = any>(path: string, status = 200): Promise<T> {
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, status, `${path} answered ${r.status}`);
  assert.match(r.headers.get('content-type') ?? '', /application\/json/);
  return (await r.json()) as T;
}

function raw(path: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: options.method ?? 'GET', headers: options.host ? { Host: options.host } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('every page serves index.html with a strict content security policy', async () => {
  for (const path of ['/', `/task/${fx.tasks.asked}`, `/session/${fx.sessions.verify}`, '/decisions', '/usage', '/decisions?kind=placement']) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const body = await r.text();
    assert.match(body, /<script type="module" src="\/ui\/app\.js"><\/script>/);
  }
  for (const [file, type] of [['app.js', /javascript/], ['app.css', /text\/css/], ['markdown.js', /javascript/], ['format.js', /javascript/], ['favicon.svg', /svg/]] as const) {
    const r = await fetch(`${base}/ui/${file}`);
    assert.equal(r.status, 200, file);
    assert.match(r.headers.get('content-type') ?? '', type);
    assert.equal(await r.text(), readFileSync(join(RUNTIME_ROOT, 'ui', file), 'utf8'));
  }
  for (const path of ['/nope', '/ui/index.html.bak', '/ui/..%2Fpackage.json', '/ui/sub/app.js', '/task', '/api/nope']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('the first page groups tasks as section 10 lists them, with step, model, last event and the lost dot', async () => {
  const d = await json('/api/overview');
  assert.equal(d.projects.length, 1);
  const p = d.projects[0];
  assert.equal(p.name, 'jevellan-live-sandbox');
  assert.deepEqual(
    p.groups.map((g: any) => g.state),
    ['waiting-owner', 'running', 'queued', 'landing', 'done', 'failed'],
  );
  const ids = p.groups.flatMap((g: any) => g.tasks.map((t: any) => t.id));
  assert.ok(!ids.includes(fx.tasks.doneOld), 'a task done three days ago is not listed');
  assert.ok(p.hidden >= 1);
  const line = (id: string) => p.groups.flatMap((g: any) => g.tasks).find((t: any) => t.id === id);
  const running = line(fx.tasks.running);
  assert.equal(running.kind, 'feature');
  assert.equal(running.step.duty, 'implement');
  assert.equal(running.step.ordinal, 1);
  assert.equal(running.session.model, 'claude-sonnet-5-5');
  assert.equal(running.session.provider, 'claude-second');
  assert.ok(running.lastEventAt);
  assert.equal(running.lost, false);
  const lost = line(fx.tasks.lost);
  assert.equal(lost.lost, true, 'a running row whose process is gone shows the lost dot');
  assert.equal(lost.step.state, 'retrying');
  const asked = line(fx.tasks.asked);
  assert.match(asked.stateReason, /ask-owner/);
  assert.equal(asked.step.duty, 'verify', 'the step at the end of the workflow, the last one that ran');
});

test('the task page has the text, the steps with attempts, sessions, reports, decisions, landing and children', async () => {
  const d = await json(`/api/task/${fx.tasks.asked}`);
  assert.equal(d.task.id, fx.tasks.asked);
  assert.match(d.task.text, /No customers yet/);
  assert.deepEqual(d.steps.map((s: any) => [s.ordinal, s.duty, s.state]), [
    [1, 'plan', 'skipped'],
    [2, 'implement', 'done'],
    [3, 'verify', 'done'],
    [4, 'document', 'skipped'],
  ]);
  const impl = d.steps[1];
  assert.equal(impl.attempts, 1);
  assert.equal(impl.sessions.length, 1);
  const s = impl.sessions[0];
  assert.equal(s.runtime, 'claude-sdk');
  assert.equal(s.provider, 'claude-main');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'medium');
  assert.equal(s.nativeSessionId, '3c9e1f52-7a4b-4d0e-9b1a-6f2c8d7e5a10');
  assert.equal(s.tokens.input, 48210);
  assert.equal(s.costUsd, 0.84);
  assert.equal(s.report.status, 'done');
  assert.deepEqual(s.report.changedFiles.length, 3);
  assert.equal(s.report.testsRun.passed, true);
  const placement = impl.placements[0];
  assert.equal(placement.kind, 'placement');
  assert.match(placement.summary, /Opus medium via claude-main \(claude-sdk\)/);
  const model = placement.answers.find((a: any) => a.question === 'model');
  assert.equal(model.choice, 'Opus via claude-main (claude-sdk)');
  assert.equal(model.probabilities[0].p, 0.62);
  assert.ok(placement.answers.some((a: any) => a.question === 'provider' && a.source === 'only-option'));
  assert.deepEqual(placement.outcome, { status: 'done', attempts: 1, durationMs: 312000, costUsd: 0.84 });

  const verify = d.steps[2];
  assert.equal(verify.placements[0].overrideMode, 'keep');
  assert.equal(verify.placements[0].override.model, 'claude-fable-5-1');
  const shots = verify.sessions[0].report.screenshots;
  assert.equal(shots.length, 3);
  assert.equal(shots[0].url, `/evidence/${fx.tasks.asked}/customers-empty-desktop.png`);
  assert.equal(shots[1].url, `/evidence/${fx.tasks.asked}/customers-empty-phone.png`);
  assert.equal(shots[2].url, null, 'a path outside .jv-evidence gets no URL');

  assert.equal(d.workflowDecisions.length, 1);
  assert.match(d.workflowDecisions[0].summary, /needs_plan no \(0\.18\), needs_docs no \(0\.07\)/);
  assert.equal(d.landings.length, 1);
  assert.equal(d.landings[0].route, 'ask-owner');
  assert.equal(d.landings[0].state, 'asked');
  assert.equal(d.landings[0].checks[0].passed, true);
  assert.equal(d.landings[0].decision.summary, 'ask-owner');
  assert.equal(d.landings[0].decision.answers[0].probabilities[0].option, 'ask-owner');
  assert.deepEqual(d.landingDecisions, [], 'a decision a landing row points at is shown with that landing only');
  assert.deepEqual(d.children.map((c: any) => c.id), [fx.tasks.child]);
  assert.equal(d.messages.length, 1);

  const child = await json(`/api/task/${fx.tasks.child}`);
  assert.equal(child.parent.id, fx.tasks.asked);
  const queued = await json(`/api/task/${fx.tasks.queued}`);
  assert.equal(queued.after.id, fx.tasks.asked);
  assert.equal(queued.steps.length, 3);

  await json('/api/task/T000000', 404);
  const lowered = await json(`/api/task/${fx.tasks.asked.toLowerCase()}`);
  assert.equal(lowered.task.id, fx.tasks.asked, 'ids typed in lower case are normalized');
});

test('the session page streams events oldest first, pages with after, and links report screenshots', async () => {
  const d = await json(`/api/session/${fx.sessions.live}`);
  assert.equal(d.session.runtime, 'claude-tmux');
  assert.equal(d.session.tmuxTarget, `jv-${fx.sessions.live}`);
  assert.equal(d.task.id, fx.tasks.running);
  assert.equal(d.step.duty, 'implement');
  const seqs = d.events.map((e: any) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
  assert.deepEqual(
    [...new Set(d.events.map((e: any) => e.kind))].sort(),
    ['message', 'rate-limit', 'start', 'text', 'thinking', 'tool-call', 'tool-result'].sort(),
  );
  assert.equal(d.lastSeq, seqs.at(-1));
  assert.equal(d.more, false);
  const later = await json(`/api/session/${fx.sessions.live}?after=${seqs.at(-3)}`);
  assert.deepEqual(later.events.map((e: any) => e.seq), seqs.slice(-2));

  const verify = await json(`/api/session/${fx.sessions.verify}`);
  const report = verify.events.find((e: any) => e.kind === 'report');
  assert.equal(report.payload.screenshots[0].url, `/evidence/${fx.tasks.asked}/customers-empty-desktop.png`);
  assert.equal(report.payload.screenshots[2].url, null);
  const lost = await json(`/api/session/${fx.sessions.lost}`);
  assert.equal(lost.session.lost, true);
  await json('/api/session/R000000', 404);
});

test('decisions filter by kind and by date', async () => {
  const all = await json('/api/decisions');
  assert.equal(all.total, 4);
  assert.deepEqual([...new Set(all.decisions.map((d: any) => d.kind))].sort(), ['landing', 'placement', 'workflow']);
  const newestFirst = all.decisions.map((d: any) => d.createdAt);
  assert.deepEqual(newestFirst, [...newestFirst].sort().reverse());
  const placement = await json('/api/decisions?kind=placement');
  assert.equal(placement.total, 2);
  assert.ok(placement.decisions.every((d: any) => d.kind === 'placement' && d.task && d.step));
  assert.equal(placement.decisions.find((d: any) => d.id === fx.decisions.verify).task.title, 'Empty state on the customers page');
  const created = Date.parse(all.decisions.at(-1).createdAt);
  const today = new Date(created).toISOString().slice(0, 10);
  const tomorrow = new Date(created + 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(created - 86_400_000).toISOString().slice(0, 10);
  assert.equal((await json(`/api/decisions?from=${today}&to=${today}`)).total, 4);
  assert.equal((await json(`/api/decisions?from=${tomorrow}`)).total, 0);
  assert.equal((await json(`/api/decisions?to=${yesterday}`)).total, 0);
  assert.equal((await json(`/api/decisions?kind=landing&from=${today}`)).decisions[0].id, fx.decisions.landing);
  assert.equal((await json('/api/decisions?kind=bogus')).total, 4, 'an unknown kind is no filter');
  assert.equal((await json(`/api/decisions?task=${fx.tasks.asked}`)).total, 4);
  assert.equal((await json('/api/decisions?project=other')).total, 0);
});

test('usage rows are grouped by ISO week, newest week first, with session totals', async () => {
  const d = await json('/api/usage');
  assert.ok(d.weeks.length >= 2);
  assert.equal(d.weeks[0].week, isoWeek(Date.now()));
  const thisWeek = d.weeks[0];
  const main = thisWeek.providers.find((p: any) => p.provider === 'claude-main');
  assert.equal(main.weeklyPct, 48, 'the newest observation of the week (a stream rate limit) wins');
  assert.ok(main.sources.probe >= 1 && main.sources.stream >= 1);
  assert.ok(main.sessions.count >= 2);
  const deepseek = thisWeek.providers.find((p: any) => p.provider === 'deepseek');
  assert.equal(deepseek.localInputTokens, 120400);
  const older = d.weeks.find((w: any) => w.week === isoWeek(Date.now() - 8 * 86_400_000));
  assert.ok(older.providers.some((p: any) => p.provider === 'claude-second' && p.weeklyPct === 76));
  assert.equal(isoWeek('2026-01-01T12:00:00Z'), '2026-W01');
  assert.equal(isoWeek('2026-11-01T12:00:00Z'), '2026-W44');
  assert.equal(isoWeek('2027-01-01T00:00:00Z'), '2026-W53');
});

test('the evidence route serves only images under the task worktree .jv-evidence', async () => {
  const ok = await raw(`/evidence/${fx.tasks.asked}/customers-empty-desktop.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.deepEqual(ok.body, readFileSync(join(fx.worktree, '.jv-evidence', 'customers-empty-desktop.png')));
  const head = await raw(`/evidence/${fx.tasks.asked}/customers-empty-phone.png`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const refused = [
    `/evidence/${fx.tasks.asked}/notes.png`,
    `/evidence/${fx.tasks.asked}/link.png`,
    `/evidence/${fx.tasks.asked}/..%2Foutside.png`,
    `/evidence/${fx.tasks.asked}/%2e%2e/outside.png`,
    `/evidence/${fx.tasks.asked}/..%2Fsecret.txt`,
    `/evidence/${fx.tasks.asked}/missing.png`,
    `/evidence/${fx.tasks.asked}/%2Fetc%2Fpasswd`,
    `/evidence/${fx.tasks.asked}/customers-empty-desktop.png%00.txt`,
    `/evidence/${fx.tasks.running}/customers-empty-desktop.png`,
    '/evidence/T000000/customers-empty-desktop.png',
    `/evidence/${fx.tasks.asked}/`,
  ];
  for (const path of refused) {
    const r = await raw(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(r.body.toString('utf8'), /not for the viewer|jv-evidence|\/tmp\//, path);
  }
  // A raw ../ in the request line (fetch would normalize it) never leaves the folder either.
  assert.equal((await raw(`/evidence/${fx.tasks.asked}/../outside.png`)).status, 404);

  assert.equal(evidenceUrl('T1', '/w', '.jv-evidence/a/b.png'), '/evidence/T1/a/b.png');
  assert.equal(evidenceUrl('T1', '/w', './.jv-evidence/a b.png'), '/evidence/T1/a%20b.png');
  assert.equal(evidenceUrl('T1', '/w', '/w/.jv-evidence/x.webp'), '/evidence/T1/x.webp');
  assert.equal(evidenceUrl('T1', '/w', '/w/other/x.png'), null);
  assert.equal(evidenceUrl('T1', '/w', '.jv-evidence/../x.png'), null);
  assert.equal(evidenceUrl('T1', '/w', '.jv-evidence/out.txt'), null);
  assert.equal(evidenceUrl('T1', null, '.jv-evidence/x.png'), null);
  assert.equal(evidenceSegments('a/%2e%2e/b.png'), undefined);
  assert.equal(evidenceSegments('a%2Fb.png'), undefined);
  assert.deepEqual(evidenceSegments('a/b%20c.png'), ['a', 'b c.png']);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('hello world, not an image')), undefined);
});

test('read only: no method but GET and HEAD, no write on the connection, lost rows are not marked', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await raw(`/api/task/${fx.tasks.asked}`, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET, HEAD');
  }
  const reader = new ReadOnlyStore(store.file);
  assert.throws(() => reader.all("UPDATE tasks SET title = 'x'"), /readonly/);
  reader.close();
  await json('/api/overview');
  await json(`/api/session/${fx.sessions.lost}`);
  assert.equal(store.getSession(fx.sessions.lost)!.state, 'running', 'the viewer shows the dot but never writes lost');
  const missing = new ReadOnlyStore(join(home, 'no-store-here.sqlite'));
  assert.throws(() => missing.all('SELECT 1'), /no store yet/);
  assert.match(missing.dataVersion(), /^unavailable/);
});

test('the Host header must name this machine (DNS rebinding guard)', async () => {
  const port = new URL(base).port;
  assert.equal((await raw('/api/overview', { host: `evil.example:${port}` })).status, 403);
  assert.equal((await raw('/', { host: 'evil.example' })).status, 403);
  assert.equal((await raw('/api/overview', { host: `localhost:${port}` })).status, 200);
  assert.equal((await raw('/api/overview', { host: `127.0.0.1:${port}` })).status, 200);
  assert.equal(hostAllowed('dev-madrid.tail1234.ts.net:7071'), true);
  assert.equal(hostAllowed('100.101.102.103:7071'), true);
  assert.equal(hostAllowed('[::1]:7071'), true);
  assert.equal(hostAllowed(undefined), false);
  assert.equal(hostAllowed('attacker.example.com'), false);
});

test('--bind takes one IP address, never a wildcard', () => {
  assert.equal(validateBind('localhost'), '127.0.0.1');
  assert.equal(validateBind('100.101.102.103'), '100.101.102.103');
  assert.equal(validateBind('[::1]'), '::1');
  for (const bad of ['0.0.0.0', '::', 'example.com', '']) {
    assert.throws(() => validateBind(bad), (e: unknown) => e instanceof JvError && e.exitCode === 2, bad);
  }
});

test('the live stream says hello, then change after another connection writes', async () => {
  const controller = new AbortController();
  const r = await fetch(`${base}/api/live`, { signal: controller.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern: RegExp, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pattern.test(text)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${pattern} in ${JSON.stringify(text)}`);
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), left))]);
      if (chunk.done) throw new Error('stream ended');
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  await until(/event: hello/, 2000);
  assert.doesNotMatch(text, /event: change/);
  recordEvent(store, fx.sessions.live, 'text', { text: 'one more line' });
  await until(/event: change\ndata: \{"version":\d+,/, 3000);
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test('a secret that reached the store by mistake is masked in the JSON', async () => {
  // Writers redact; this writes around them on purpose to check the viewer's own redaction.
  store.appendEvent(fx.sessions.investigate, 'text', { text: `leaked ${FAKE_TOKEN} here` });
  const r = await fetch(`${base}/api/session/${fx.sessions.investigate}`);
  const body = await r.text();
  assert.ok(!body.includes(FAKE_TOKEN));
  assert.match(body, /leaked \[redacted\] here/);
});

test('the Markdown renderer escapes HTML and links only http(s), site paths and anchors', () => {
  const { renderMarkdown, renderInline } = markdown;
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderInline('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(renderInline('[x](javascript:alert(1))'), 'x');
  assert.equal(renderInline('[x](data:text/html,hi)'), 'x');
  assert.equal(renderInline('[t](/task/T1)'), '<a href="/task/T1">t</a>');
  assert.equal(renderInline('[t](https://a.example/?a=1&b="2")'), '<a href="https://a.example/?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener noreferrer">t</a>');
  assert.equal(renderInline('`<b>`'), '<code>&lt;b&gt;</code>');
  assert.equal(renderInline('**bold** and *it* and snake_case_name'), '<strong>bold</strong> and <em>it</em> and snake_case_name');
  assert.equal(renderMarkdown('```\n<x>&\n```'), '<pre><code>&lt;x&gt;&amp;</code></pre>');
  assert.equal(renderMarkdown('# Title\n\n- a\n- b\n  - c'), '<h3>Title</h3><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>');
  assert.equal(renderMarkdown('line one\nline two'), '<p>line one<br>line two</p>');
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| <i>1</i> | 2 |'), /<td>&lt;i&gt;1&lt;\/i&gt;<\/td>/);
  assert.equal(renderMarkdown('![alt](https://img.example/x.png)'), '<p><a href="https://img.example/x.png" target="_blank" rel="noopener noreferrer">alt</a></p>');
  // Whatever the input, the output holds only the renderer's own tags, and no tag carries an event handler.
  const allowed = /^<\/?(p|a|code|pre|strong|em|del|ul|ol|li|h[3-6]|blockquote|hr|br|table|thead|tbody|tr|th|td|div)(\s|>|\/)/i;
  const nasty = ['<a href="x" onclick="y">', '[a](https://x" onmouseover="y)', '<svg/onload=alert(1)>', '`` ` ``<iframe>', '> <script>', '**<b onmouseover=1>**', '[<img src=x>](https://a.example)'];
  for (const n of nasty) {
    for (const tag of renderMarkdown(n).match(/<[^>]*>/g) ?? []) {
      assert.match(tag, allowed, `${n} gave ${tag}`);
      assert.doesNotMatch(tag, /\son\w+\s*=/i, `${n} gave ${tag}`);
    }
  }
});

test('page text helpers: 24-hour clock everywhere, no dash for unknown rate limits, jv tool results, hidden note', () => {
  // Dates said "02:53 PM" while the event clocks said "14:53:05" on the same page.
  for (const f of [format.dateFmt, format.fullFmt, format.clockFmt]) assert.equal(f.resolvedOptions().hourCycle, 'h23');
  // A stream rate-limit event without a five-hour value read "five hours -, week 63%".
  const day = (iso: string) => `D(${iso})`;
  assert.deepEqual(format.rateLimitParts({ weeklyPct: 63, weeklyResetsAt: '2026-11-02T05:00:00.000Z' }, day), ['week 63%', 'week resets D(2026-11-02T05:00:00.000Z)']);
  assert.deepEqual(format.rateLimitParts({ fiveHourPct: 14.4, weeklyPct: 48 }, day), ['five hours 14%', 'week 48%']);
  assert.deepEqual(format.rateLimitParts({}, day), []);
  assert.equal(format.providerUsageNote({ weeklyPct: 63.2, ceilingPct: 90, fiveHourPct: null }), 'week 63% of 90%');
  assert.equal(format.providerUsageNote({ weeklyPct: 41, ceilingPct: 90, fiveHourPct: 12 }), 'week 41% of 90%, five hours 12%');
  assert.equal(format.providerUsageNote({ weeklyPct: null, ceilingPct: null }), 'week unknown');
  // The worktree setup result has no tool call; it showed as a bare "result" row with an empty body.
  const setup = format.toolResultView({ name: 'worktree-setup', command: 'npm ci', ok: true, exitCode: 0, timedOut: false, durationMs: 2046, text: 'Worktree setup: npm ci ok.' });
  assert.equal(setup.name, 'worktree-setup');
  assert.equal(setup.command, 'npm ci');
  assert.equal(setup.detail, '$ npm ci\nWorktree setup: npm ci ok.\nexit code 0, 2.0s');
  assert.equal(setup.failed, false);
  const failed = format.toolResultView({ name: 'worktree-setup', command: 'npm ci', ok: false, exitCode: 1, timedOut: true, text: 'Worktree setup: npm ci failed.' });
  assert.equal(failed.failed, true);
  assert.match(failed.detail, /exit code 1, timed out$/);
  // A result whose call is not in the stream keeps the old shape.
  assert.deepEqual(format.toolResultView({ id: 'x', ok: true, output: 'done' }), { name: 'result', command: undefined, body: 'done', detail: 'done', failed: false });
  // A task stopped a minute ago is hidden too, so the note does not call every hidden task "older".
  assert.equal(format.hiddenNote(0), '');
  assert.equal(format.hiddenNote(1), '1 task not shown (stopped, or ended more than a day ago)');
  assert.equal(format.hiddenNote(3), '3 tasks not shown (stopped, or ended more than a day ago)');
});

test('currentStep: running or retrying first, then tasks.current_step, then the first pending', () => {
  const s = (ordinal: number, state: string) => ({ id: `S${ordinal}`, ordinal, state }) as any;
  assert.equal(currentStep({ current_step: 1 }, [s(1, 'done'), s(2, 'retrying'), s(3, 'pending')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 3 }, [s(1, 'done'), s(2, 'done'), s(3, 'pending')])!.id, 'S3');
  assert.equal(currentStep({ current_step: 0 }, [s(1, 'done'), s(2, 'pending')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 0 }, [s(1, 'done'), s(2, 'done')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 3 }, [s(1, 'done'), s(2, 'done'), s(3, 'skipped')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 0 }, []), undefined);
});

test('a missing store is a 503 until it appears; a store of another schema is refused at start', async () => {
  const file = join(home, 'later.sqlite');
  const waiting = await startUiServer({ port: 0, storeFile: file });
  try {
    const r = await fetch(`${waiting.url}/api/overview`);
    assert.equal(r.status, 503);
    assert.match(((await r.json()) as { error: string }).error, /no store yet/);
    assert.equal((await fetch(`${waiting.url}/`)).status, 200, 'the page itself still loads and says so');
  } finally {
    await waiting.close();
  }
  const other = join(home, 'other-schema.sqlite');
  const db = new DatabaseSync(other);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '0')");
  db.close();
  await assert.rejects(startUiServer({ port: 0, storeFile: other }), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /schema version 0/.test(e.message));
});

const cliUrl = new URL('../src/cli.js', import.meta.url).href;

test('jv ui --port 0 --json prints the URL, serves, and stops on SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(['ui', '--port', '0', '--json']);`],
    { env: { ...process.env, JV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 15_000;
  while (!/\}\s*$/.test(out.trim()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const info = JSON.parse(out) as { url: string; port: number; bind: string; readOnly: boolean };
  assert.equal(info.bind, '127.0.0.1');
  assert.equal(info.readOnly, true);
  assert.ok(info.port > 0);
  assert.equal((await fetch(`${info.url}/api/overview`)).status, 200);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
