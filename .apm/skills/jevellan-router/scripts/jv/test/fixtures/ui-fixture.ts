// Fixture of the viewer tests (and of the visual check): a store with one project and tasks in every state the
// first page groups, steps with retries, sessions on several runtimes with every event kind, reports with real PNG
// screenshots under a worktree's .jv-evidence/, placement, workflow and landing decisions (one overridden), a
// landing with checks, a child task, messages and provider usage rows over two weeks. Plus the files the evidence
// route must refuse: a text file named .png, a symlink out of .jv-evidence, a file outside it. Every value is made up.
// Callers set process.env.JV_HOME before importing anything from src/ (paths.ts resolves it at load).

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { recordEvent } from '../../src/events.js';
import { writeReport } from '../../src/report.js';
import type { Store } from '../../src/store.js';

// ---- a tiny PNG encoder (solid rectangles), so the fixture needs no image library ----------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  rgb: [number, number, number];
}

/** A PNG of `width` x `height` on `bg`, with rectangles drawn in order. */
export function png(width: number, height: number, bg: [number, number, number], rects: Rect[] = []): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      let c = bg;
      for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) c = r.rgb;
      const o = y * row + 1 + x * 3;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A made-up page screenshot: a header bar, a title, a card with an empty-state message. */
function pageShot(width: number, height: number): Buffer {
  const pad = Math.round(width * 0.06);
  return png(width, height, [246, 246, 243], [
    { x: 0, y: 0, w: width, h: 56, rgb: [33, 37, 41] },
    { x: pad, y: 20, w: 90, h: 16, rgb: [240, 240, 240] },
    { x: pad, y: 92, w: Math.round(width * 0.4), h: 22, rgb: [60, 60, 60] },
    { x: pad, y: 140, w: width - 2 * pad, h: Math.round(height * 0.45), rgb: [255, 255, 255] },
    { x: pad + 24, y: 180, w: Math.round((width - 2 * pad) * 0.5), h: 14, rgb: [120, 120, 120] },
    { x: pad + 24, y: 206, w: Math.round((width - 2 * pad) * 0.35), h: 12, rgb: [170, 170, 170] },
    { x: pad + 24, y: 240, w: 120, h: 34, rgb: [43, 89, 195] },
  ]);
}

// ---- the fixture ----------------------------------------------------------------------------------------------

export interface UiFixture {
  projectId: string;
  repo: string;
  worktree: string;
  /** Task ids by role. */
  tasks: {
    asked: string;
    running: string;
    lost: string;
    queued: string;
    doneRecent: string;
    failed: string;
    child: string;
    doneOld: string;
  };
  sessions: { implement: string; verify: string; live: string; lost: string; investigate: string };
  decisions: { workflow: string; implement: string; verify: string; landing: string };
  landingId: string;
  /** Session ids whose process the tests treat as alive. */
  alive: string[];
}

const MIN = 60_000;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export function buildUiFixture(store: Store, home: string): UiFixture {
  const repo = join(home, 'repos', 'jevellan-live-sandbox');
  mkdirSync(repo, { recursive: true });
  const project = store.createProject({ name: 'jevellan-live-sandbox', path: repo, default_branch: 'main' }).row;
  const worktree = join(home, 'worktrees', 'jevellan-live-sandbox', 'customers-empty-state-k7m2q9');
  const evidence = join(worktree, '.jv-evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'customers-empty-desktop.png'), pageShot(960, 600));
  writeFileSync(join(evidence, 'customers-empty-phone.png'), pageShot(390, 780));
  writeFileSync(join(evidence, 'notes.png'), 'not an image, only text\n');
  writeFileSync(join(worktree, 'outside.png'), png(8, 8, [200, 0, 0]));
  writeFileSync(join(worktree, 'secret.txt'), 'not for the viewer\n');
  symlinkSync(join(worktree, 'outside.png'), join(evidence, 'link.png'));

  const backdate = (table: 'tasks' | 'steps' | 'sessions' | 'decisions' | 'landings' | 'reports' | 'messages', id: string, cols: Record<string, string | null>): void => {
    const keys = Object.keys(cols);
    store.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]!), id);
  };
  let req = 0;
  const task = (kind: 'feature' | 'bug' | 'automation' | 'single', title: string, text: string, extra: { parent?: string; after?: string; visible?: boolean } = {}) =>
    store.createTask({
      project_id: project.id,
      request_id: `ui-fixture-task-${++req}`,
      kind,
      title,
      task_text: text,
      workflow_json: JSON.stringify({ name: kind, steps: [] }),
      parent_task_id: extra.parent ?? null,
      after_task_id: extra.after ?? null,
      visible: extra.visible ?? false,
    }).row;
  const step = (taskId: string, ordinal: number, duty: string, instructions: string, when = 'always', onFail: object | null = null) =>
    store.createStep({ task_id: taskId, ordinal, duty, instructions, when_rule: when, on_fail_json: onFail ? JSON.stringify(onFail) : null }).row;
  const session = (taskId: string, stepId: string, runtime: 'claude-sdk' | 'claude-tmux' | 'codex' | 'llm', provider: string, model: string, effort: string, cwd: string) =>
    store.createSession({
      project_id: project.id,
      task_id: taskId,
      step_id: stepId,
      request_id: `ui-fixture-session-${++req}`,
      kind: 'step',
      runtime,
      provider,
      model,
      effort,
      cwd,
    }).row;
  const placement = (taskId: string, stepId: string, label: string, model: string, provider: string, runtime: string, effort: string, probs: Record<string, number>, effortProbs: Record<string, number>) =>
    store.createDecision({
      kind: 'placement',
      project_id: project.id,
      task_id: taskId,
      step_id: stepId,
      skill_name: 'jevellan-router',
      skill_hash: 'a3f9c2e17b4d5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7',
      jev_model: 'jev-1.14.0',
      state_json: '{"menu":{}}',
      questions_json: JSON.stringify({ model: { type: 'choice' }, effort: { type: 'choice' } }),
      answers_json: JSON.stringify({
        model: { type: 'choice', choice: Object.entries(probs).sort((a, b) => b[1] - a[1])[0]![0], probabilities: probs, confidence: 0.74 },
        effort: { type: 'choice', choice: Object.entries(effortProbs).sort((a, b) => b[1] - a[1])[0]![0], probabilities: effortProbs, confidence: 0.61 },
      }),
      chosen_json: JSON.stringify({
        source: 'jev',
        duty: 'implement',
        visible: false,
        runtime,
        provider,
        model,
        label,
        effort,
        effortRequested: effort,
        effortAfterRules: effort,
        choices: {
          model: { source: 'jev', option: `${label} via ${provider} (${runtime})`, probabilities: probs },
          effort: { source: 'jev', option: effort, probabilities: effortProbs },
          provider: { source: 'only-option', option: provider },
        },
        candidates: [
          { name: 'claude-main', kind: 'claude-subscription', eligible: true, reason: 'eligible', ceilingPct: 90, weeklyPct: 48, fiveHourPct: 12 },
          { name: 'claude-second', kind: 'claude-subscription', eligible: true, reason: 'eligible', ceilingPct: 90, weeklyPct: 31, fiveHourPct: 4 },
          { name: 'codex', kind: 'codex-subscription', eligible: true, reason: 'eligible', ceilingPct: 90, weeklyPct: 22, fiveHourPct: 0 },
          { name: 'glm', kind: 'claude-endpoint', eligible: false, reason: 'no-key', ceilingPct: 100, weeklyPct: null, fiveHourPct: null },
        ],
        rules: { applied: [], ignored: [], minimum: 'low', maximum: 'max', reason: '' },
      }),
      latency_ms: 812,
      usage_json: JSON.stringify({ input_tokens: 5120, output_tokens: 96, calls: [{ questions: ['model', 'effort'] }] }),
    });
  const ev = (sessionId: string, kind: Parameters<typeof recordEvent>[2], payload: unknown, at: string) => recordEvent(store, sessionId, kind, payload, { at });

  // ---- T asked: the customers empty state, landing asked the owner ------------------------------------------
  const asked = task(
    'feature',
    'Empty state on the customers page',
    [
      'When there are no customers, the customers page shows a blank table. Show a short message instead:',
      '',
      '- **Title**: "No customers yet"',
      '- **Body**: one line on how to add the first customer, with a link to `/customers/new`',
      '',
      'Add a test that renders the page with no customers. The owner will check it on the phone too.',
    ].join('\n'),
  );
  store.updateTask(asked.id, { worktree_path: worktree, branch: 'jv/customers-empty-state-k7m2q9', base_commit: '4f1c2a9e0b7d36c85e2f1a0b9c8d7e6f5a4b3c2d' });
  const sPlan = step(asked.id, 1, 'plan', 'Write plan.md at the worktree root.', 'jev:needs_plan');
  const sImpl = step(asked.id, 2, 'implement', 'Follow plan.md when it exists. Commit on the task branch.');
  const sVerify = step(asked.id, 3, 'verify', 'Run the test command, then the browser journeys at desktop and phone widths.', 'always', { goto: 'implement', maxLoops: 2 });
  const sDocs = step(asked.id, 4, 'document', 'Update the docs the project keeps.', 'jev:needs_docs');
  const workflow = store.createDecision({
    kind: 'workflow',
    project_id: project.id,
    task_id: asked.id,
    skill_name: 'jevellan-router',
    skill_hash: 'a3f9c2e17b4d5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7',
    jev_model: 'jev-1.14.0',
    state_json: '{}',
    questions_json: JSON.stringify({ needs_plan: { type: 'noul' }, needs_docs: { type: 'noul' } }),
    answers_json: JSON.stringify({ needs_plan: { type: 'noul', noul: 0.18 }, needs_docs: { type: 'noul', noul: 0.07 } }),
    chosen_json: JSON.stringify({
      answers: { needs_plan: { value: false, probability: 0.18 }, needs_docs: { value: false, probability: 0.07 } },
      skip: [
        { stepId: sPlan.id, ordinal: 1, duty: 'plan', question: 'needs_plan' },
        { stepId: sDocs.id, ordinal: 4, duty: 'document', question: 'needs_docs' },
      ],
    }),
    latency_ms: 640,
    usage_json: JSON.stringify({ input_tokens: 2210, output_tokens: 40, calls: [{ questions: ['needs_plan', 'needs_docs'] }] }),
  });
  store.setStepState(sPlan.id, 'skipped', 'Jev: not needed');
  store.setStepState(sDocs.id, 'skipped', 'Jev: not needed');
  store.setTaskState(asked.id, 'running', 'step implement started');

  const dImpl = placement(asked.id, sImpl.id, 'Opus', 'claude-opus-5-5', 'claude-main', 'claude-sdk', 'medium',
    { 'Opus via claude-main (claude-sdk)': 0.62, 'GPT via codex (codex)': 0.27, 'Sonnet via claude-main (claude-sdk)': 0.08, 'Haiku via claude-main (claude-sdk)': 0.03 },
    { low: 0.1, medium: 0.58, high: 0.29, max: 0.03 });
  store.setStepState(sImpl.id, 'running', 'placed on claude-opus-5-5 medium');
  store.incrementStepAttempts(sImpl.id);
  const rImpl = session(asked.id, sImpl.id, 'claude-sdk', 'claude-main', 'claude-opus-5-5', 'medium', worktree);
  store.updateDecision(dImpl.id, { session_id: rImpl.id });
  store.setSessionState(rImpl.id, 'running', 'claude-sdk turn running', { native_session_id: '3c9e1f52-7a4b-4d0e-9b1a-6f2c8d7e5a10', pid: 4242, pgid: 4242 });
  ev(rImpl.id, 'start', { runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'medium', cwd: worktree, resume: false }, ago(42 * MIN));
  // What run.ts writes for the worktree setup command: a tool-result with no tool call before it.
  ev(rImpl.id, 'tool-result', { name: 'worktree-setup', command: 'npm ci', ok: true, exitCode: 0, timedOut: false, durationMs: 2046, text: 'Worktree setup: npm ci ok.' }, ago(42 * MIN));
  ev(rImpl.id, 'text', { text: 'I will look at the customers page and its test first.' }, ago(41 * MIN));
  ev(rImpl.id, 'tool-call', { id: 'tool_1', name: 'Read', input: JSON.stringify({ file_path: `${worktree}/src/web/pages/customers.tsx` }) }, ago(41 * MIN));
  ev(rImpl.id, 'tool-result', { id: 'tool_1', ok: true, output: 'export function CustomersPage({ customers }) {\n  return <table>...</table>;\n}' }, ago(41 * MIN));
  ev(rImpl.id, 'tool-call', { id: 'tool_2', name: 'Edit', input: JSON.stringify({ file_path: `${worktree}/src/web/pages/customers.tsx`, old_string: '<table>', new_string: 'customers.length === 0 ? <EmptyState /> : <table>' }) }, ago(39 * MIN));
  ev(rImpl.id, 'tool-result', { id: 'tool_2', ok: true, output: 'The file was updated.' }, ago(39 * MIN));
  ev(rImpl.id, 'tool-call', { id: 'tool_3', name: 'Bash', input: JSON.stringify({ command: 'npx vitest run test/customers.test.ts', description: 'Run the customers test' }) }, ago(37 * MIN));
  ev(rImpl.id, 'tool-result', { id: 'tool_3', ok: true, output: ' RUN  v4.1.11\n PASS test/customers.test.ts (3 tests) 41ms\n Test Files  1 passed (1)\n      Tests  3 passed (3)' }, ago(37 * MIN));
  writeReport(store, rImpl.id, {
    status: 'done',
    summary: 'The customers page now shows **No customers yet** with a link to add the first customer when the list is empty.\n\n- `EmptyState` component in `src/web/components/empty-state.tsx`\n- The page renders it when `customers.length === 0`\n- New test: `renders the empty state with no customers`',
    testsRun: { command: 'npx vitest run test/customers.test.ts', passed: true, summary: '3 tests passed' },
    changedFiles: ['src/web/components/empty-state.tsx', 'src/web/pages/customers.tsx', 'test/customers.test.ts'],
  });
  ev(rImpl.id, 'usage', { inputTokens: 48210, outputTokens: 3120, cacheReadTokens: 210400, cacheWriteTokens: 18200, costUsd: 0.84, numTurns: 9, durationMs: 312000 }, ago(36 * MIN));
  ev(rImpl.id, 'rate-limit', { fiveHourPct: 14, weeklyPct: 48, weeklyResetsAt: new Date(Date.now() + 3 * 24 * 60 * MIN).toISOString() }, ago(36 * MIN));
  ev(rImpl.id, 'end', { status: 'done', reason: 'report done', report: 'done' }, ago(36 * MIN));
  store.setSessionState(rImpl.id, 'done', 'report done');
  store.setStepState(sImpl.id, 'done', `report done (${rImpl.id})`);
  store.updateDecision(dImpl.id, { outcome_json: JSON.stringify({ status: 'done', attempts: 1, durationMs: 312000, costUsd: 0.84 }) });

  const dVerify = placement(asked.id, sVerify.id, 'GPT', 'gpt-6.1-sol', 'codex', 'codex', 'high',
    { 'GPT via codex (codex)': 0.55, 'Opus via claude-main (claude-sdk)': 0.38, 'Sonnet via claude-main (claude-sdk)': 0.07 },
    { medium: 0.31, high: 0.52, xhigh: 0.17 });
  store.updateDecision(dVerify.id, {
    override_json: JSON.stringify({ source: 'owner', runtime: 'claude-sdk', provider: 'claude-second', model: 'claude-fable-5-1', effort: 'high', at: ago(30 * MIN) }),
    override_mode: 'keep',
  });
  store.setStepState(sVerify.id, 'running', 'placed on gpt-6.1-sol high');
  store.incrementStepAttempts(sVerify.id);
  const rVerify = session(asked.id, sVerify.id, 'codex', 'codex', 'gpt-6.1-sol', 'high', worktree);
  store.setSessionState(rVerify.id, 'running', 'codex turn running', { native_session_id: '019a2f4c-5e6d-7f80-9a1b-2c3d4e5f6a7b', pid: 4343, pgid: 4343 });
  ev(rVerify.id, 'start', { runtime: 'codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', cwd: worktree }, ago(34 * MIN));
  ev(rVerify.id, 'tool-call', { id: 'c1', name: 'shell', input: JSON.stringify({ command: 'npm test' }) }, ago(33 * MIN));
  ev(rVerify.id, 'tool-result', { id: 'c1', ok: true, output: 'Test Files  12 passed (12)\n     Tests  58 passed (58)' }, ago(32 * MIN));
  ev(rVerify.id, 'tool-call', { id: 'c2', name: 'shell', input: JSON.stringify({ command: 'npm run test:browser -- customers' }) }, ago(31 * MIN));
  ev(rVerify.id, 'tool-result', { id: 'c2', ok: true, output: '2 passed (8.1s)' }, ago(30 * MIN));
  writeReport(store, rVerify.id, {
    status: 'done',
    summary: 'All 58 unit tests and the two customers browser journeys pass. The empty state reads well at desktop and phone widths; screenshots below.',
    testsRun: { command: 'npm test && npm run test:browser -- customers', passed: true, summary: '58 unit tests, 2 browser journeys' },
    screenshots: [
      { path: '.jv-evidence/customers-empty-desktop.png', caption: 'Customers page, no customers, desktop' },
      { path: '.jv-evidence/customers-empty-phone.png', caption: 'Customers page, no customers, phone' },
      { path: 'docs/outside.png', caption: 'A path outside the evidence folder' },
    ],
    changedFiles: [],
  });
  ev(rVerify.id, 'usage', { inputTokens: 22100, outputTokens: 1480, cacheReadTokens: 64000, cacheWriteTokens: 0, durationMs: 241000 }, ago(29 * MIN));
  ev(rVerify.id, 'end', { status: 'done', reason: 'report done', report: 'done' }, ago(29 * MIN));
  store.setSessionState(rVerify.id, 'done', 'report done');
  store.setStepState(sVerify.id, 'done', `report done (${rVerify.id})`);
  store.updateDecision(dVerify.id, { outcome_json: JSON.stringify({ status: 'done', attempts: 1, durationMs: 241000, costUsd: 0 }) });

  store.setTaskState(asked.id, 'landing', 'last step done');
  const dLanding = store.createDecision({
    kind: 'landing',
    project_id: project.id,
    task_id: asked.id,
    skill_name: 'jevellan-landing',
    skill_hash: '7e2d9b04c1a35f68e0d4b2a19c8f7e6d5c4b3a29180f7e6d5c4b3a2918070605',
    jev_model: 'jev-1.14.0',
    state_json: '{}',
    questions_json: JSON.stringify({ landing_route: { type: 'choice' } }),
    answers_json: JSON.stringify({ landing_route: { type: 'choice', choice: 'ask-owner', probabilities: { land: 0.21, 'verify-then-land': 0.18, 'ask-owner': 0.61 }, confidence: 0.58 } }),
    chosen_json: JSON.stringify({ route: 'ask-owner', reason: 'Touches src/web/pages, which landing.json lists as a risky area.' }),
    latency_ms: 702,
    usage_json: JSON.stringify({ input_tokens: 3010, output_tokens: 22, calls: [{ questions: ['landing_route'] }] }),
  });
  const landing = store.createLanding({
    task_id: asked.id,
    decision_id: dLanding.id,
    route: 'ask-owner',
    checks_json: JSON.stringify([
      { name: 'test', command: 'npm test', passed: true, durationMs: 18400, outputTail: 'Test Files  12 passed (12)\n     Tests  58 passed (58)' },
    ]),
  });
  store.setLandingState(landing.id, 'asked', 'Touches a risky area (src/web/pages); asking the owner: Land now or Leave it.');
  store.setTaskState(asked.id, 'waiting-owner', 'landing: ask-owner, touches a risky area (src/web/pages)');
  store.createMessage({ task_id: asked.id, direction: 'owner', text: 'Keep the wording short, it is read on the phone.' });

  // ---- T running: README, a live claude-tmux session ---------------------------------------------------------
  const running = task('feature', 'README: How to run section', 'Add a How to run section to the README that lists the commands in package.json, one line each.', { visible: true });
  const sReadme = step(running.id, 1, 'implement', 'Commit on the task branch.');
  store.setTaskState(running.id, 'running', 'step implement started');
  store.setStepState(sReadme.id, 'running', 'placed on claude-sonnet-5-5 low');
  store.incrementStepAttempts(sReadme.id);
  const rLive = session(running.id, sReadme.id, 'claude-tmux', 'claude-second', 'claude-sonnet-5-5', 'low', join(home, 'worktrees', 'jevellan-live-sandbox', 'readme-how-to-run-p3x8d2'));
  store.setSessionState(rLive.id, 'running', 'claude-tmux turn running', { native_session_id: '8d0f3b6a-1c2e-4f5a-9b7c-0e1d2f3a4b5c', pid: process.pid, pgid: process.pid, tmux_target: `jv-${rLive.id}` });
  ev(rLive.id, 'start', { runtime: 'claude-tmux', provider: 'claude-second', model: 'claude-sonnet-5-5', effort: 'low', cwd: rLive.cwd }, ago(6 * MIN));
  ev(rLive.id, 'message', { from: 'jv', text: 'Start the step now. End with jv_report.' }, ago(6 * MIN));
  ev(rLive.id, 'thinking', { text: 'The README has no run section. package.json has start, test, test:browser, lint and check:changelog.\nI will add one line per script.' }, ago(5 * MIN));
  ev(rLive.id, 'tool-call', { id: 'toolu_a', name: 'Read', input: JSON.stringify({ file_path: 'package.json' }) }, ago(5 * MIN));
  ev(rLive.id, 'tool-result', { id: 'toolu_a', ok: true, output: '{\n  "scripts": {\n    "start": "tsx src/web/server.ts",\n    "test": "vitest run"\n  }\n}' }, ago(5 * MIN));
  ev(rLive.id, 'tool-call', { id: 'toolu_b', name: 'Bash', input: JSON.stringify({ command: 'grep -n "## " README.md', description: 'List README sections' }) }, ago(4 * MIN));
  ev(rLive.id, 'tool-result', { id: 'toolu_b', ok: false, output: 'grep: README.md: No such file or directory' }, ago(4 * MIN));
  ev(rLive.id, 'text', { text: 'There is no `README.md` at the root yet; I will create it with a **How to run** section:\n\n```sh\nnpm start\nnpm test\n```\n\n<script>alert("not run")</script>' }, ago(3 * MIN));
  ev(rLive.id, 'tool-call', { id: 'toolu_c', name: 'Write', input: JSON.stringify({ file_path: 'README.md', content: '# Sandbox\n\n## How to run\n\n- `npm start`: the web server\n' }) }, ago(2 * MIN));
  ev(rLive.id, 'rate-limit', { fiveHourPct: 9, weeklyPct: 31 }, ago(2 * MIN));

  // ---- T lost: a unit test, the run's process is gone ---------------------------------------------------------
  const lost = task('bug', 'Unit test for formatCurrency', 'src/format.ts has formatCurrency with no test. Add one for negative amounts and zero.');
  const sLost = step(lost.id, 1, 'implement', 'Reproduce first with a failing test when the bug is testable, then fix.', 'always', null);
  step(lost.id, 2, 'verify', 'Run the project test command.', 'always', { goto: 'implement', maxLoops: 2 });
  store.setTaskState(lost.id, 'running', 'step implement started');
  store.setStepState(sLost.id, 'retrying', 'verify failed: 1 test failed; back to implement');
  store.incrementStepAttempts(sLost.id);
  store.incrementStepAttempts(sLost.id);
  const rLost = session(lost.id, sLost.id, 'codex', 'codex', 'gpt-6.1-sol', 'medium', join(home, 'worktrees', 'jevellan-live-sandbox', 'format-currency-test-q1w2e3'));
  store.setSessionState(rLost.id, 'running', 'codex turn running', { native_session_id: '019a3b5d-6e7f-8091-a2b3-c4d5e6f7a8b9', pid: 999_999, pgid: 999_999 });
  ev(rLost.id, 'start', { runtime: 'codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', cwd: rLost.cwd }, ago(19 * MIN));
  ev(rLost.id, 'error', { message: 'stream disconnected before completion' }, ago(17 * MIN));

  // ---- T queued, after the asked one ------------------------------------------------------------------------
  const queued = task('automation', 'Export invoices to CSV every night', 'Automate the invoice export from the admin page and save the CSV.', { after: asked.id });
  step(queued.id, 1, 'plan', 'Write plan.md: the flow to automate step by step.', 'jev:needs_plan');
  step(queued.id, 2, 'automate', 'Build the Playwright automation.');
  step(queued.id, 3, 'verify', 'Run the automation end to end.', 'always', { goto: 'automate', maxLoops: 2 });
  store.setTaskState(queued.id, 'queued', `waiting for ${asked.id} to finish`);

  // ---- T done today: a single investigate -------------------------------------------------------------------
  const done = task('single', 'Where does the app start?', 'Name the file and the line where the web server starts.');
  const sInv = step(done.id, 1, 'investigate', 'Answer with paths.');
  store.setTaskState(done.id, 'running', 'step investigate started');
  store.setStepState(sInv.id, 'running', 'placed on claude-haiku-5-5 low');
  store.incrementStepAttempts(sInv.id);
  const rInv = session(done.id, sInv.id, 'claude-sdk', 'claude-main', 'claude-haiku-5-5', 'low', repo);
  store.setSessionState(rInv.id, 'running', 'claude-sdk turn running', { native_session_id: '5b2c9d1e-0f3a-4b6c-8d7e-1f2a3b4c5d6e', pid: 4545, pgid: 4545 });
  ev(rInv.id, 'start', { runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-haiku-5-5', effort: 'low', cwd: repo }, ago(80 * MIN));
  writeReport(store, rInv.id, { status: 'done', summary: 'The server starts in `src/web/server.ts` line 42 (`app.listen(port)`), run by `npm start` through tsx.' });
  ev(rInv.id, 'usage', { inputTokens: 9100, outputTokens: 210, costUsd: 0.01 }, ago(79 * MIN));
  ev(rInv.id, 'end', { status: 'done', reason: 'report done', report: 'done' }, ago(79 * MIN));
  store.setSessionState(rInv.id, 'done', 'report done');
  store.setStepState(sInv.id, 'done', `report done (${rInv.id})`);
  store.setTaskState(done.id, 'done', 'step investigate done');

  // ---- T failed ---------------------------------------------------------------------------------------------
  const failed = task('feature', 'Dark mode toggle in settings', 'Add a dark mode toggle to the settings page.');
  const sF1 = step(failed.id, 1, 'implement', 'Commit on the task branch.');
  const sF2 = step(failed.id, 2, 'verify', 'Run the tests.', 'always', { goto: 'implement', maxLoops: 2 });
  store.setTaskState(failed.id, 'running', 'started');
  store.setStepState(sF1.id, 'done', 'report done');
  store.setStepState(sF2.id, 'failed', 'verify failed after 2 loops: settings.spec.ts toggles twice');
  store.setTaskState(failed.id, 'failed', 'verify failed after 2 loops: settings.spec.ts toggles twice');

  // ---- T child of the asked task, landing --------------------------------------------------------------------
  const child = task('feature', 'Empty state illustration', 'Add a small illustration to the empty state.', { parent: asked.id });
  const sC = step(child.id, 1, 'implement', 'Commit on the task branch.');
  store.setTaskState(child.id, 'running', 'started');
  store.setStepState(sC.id, 'done', 'report done');
  store.setTaskState(child.id, 'landing', 'last step done; landing into the parent branch');

  // ---- T done three days ago (not on the first page) --------------------------------------------------------
  const old = task('single', 'Old answer', 'An old question.');
  store.setTaskState(old.id, 'done', 'answered');
  backdate('tasks', old.id, { created_at: ago(3 * 24 * 60 * MIN), ended_at: ago(3 * 24 * 60 * MIN + 5 * MIN) });

  // ---- provider usage ------------------------------------------------------------------------------------------
  store.recordProviderUsage({ provider: 'claude-main', source: 'probe', observed_at: ago(50 * MIN), weekly_pct: 47, five_hour_pct: 11, weekly_resets_at: new Date(Date.now() + 3 * 24 * 60 * MIN).toISOString() });
  store.recordProviderUsage({ provider: 'codex', source: 'probe', observed_at: ago(50 * MIN), weekly_pct: 22, five_hour_pct: 0 });
  store.recordProviderUsage({ provider: 'deepseek', source: 'local', observed_at: ago(45 * MIN), local_week: null, local_input_tokens: 120400, local_output_tokens: 8800, local_cost_usd: 0.06 });
  store.recordProviderUsage({ provider: 'claude-main', source: 'probe', observed_at: ago(8 * 24 * 60 * MIN), weekly_pct: 92, five_hour_pct: 40 });
  store.recordProviderUsage({ provider: 'claude-second', source: 'probe', observed_at: ago(8 * 24 * 60 * MIN), weekly_pct: 76, five_hour_pct: 18 });

  return {
    projectId: project.id,
    repo,
    worktree,
    tasks: { asked: asked.id, running: running.id, lost: lost.id, queued: queued.id, doneRecent: done.id, failed: failed.id, child: child.id, doneOld: old.id },
    sessions: { implement: rImpl.id, verify: rVerify.id, live: rLive.id, lost: rLost.id, investigate: rInv.id },
    decisions: { workflow: workflow.id, implement: dImpl.id, verify: dVerify.id, landing: dLanding.id },
    landingId: landing.id,
    alive: [rLive.id],
  };
}
