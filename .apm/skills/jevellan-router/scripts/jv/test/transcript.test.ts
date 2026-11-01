// The ported native transcript parser (Claude and Codex branches), the incremental reader, turn end, usage per
// message id and the jv events of a turn. Fake transcript lines only.

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  claudeTranscriptPath,
  claudeTurnUsage,
  cwdSlug,
  findClaudeTranscript,
  nativeActivity,
  nativeRecords,
  parseNativeTranscript,
  readComplete,
  transcriptEvents,
  TurnTracker,
} from '../src/transcript.js';

const dir = mkdtempSync(join(tmpdir(), 'jv-transcript-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const line = (v: unknown) => `${JSON.stringify(v)}\n`;

const claudeLines = [
  line({ type: 'user', message: { role: 'user', content: 'Start the step now. <system-reminder>hidden</system-reminder>' }, timestamp: '2026-11-01T10:00:00.000Z' }),
  line({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Looking at the code.' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
  }),
  line({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/index.ts' } }], usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
  }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'export {}' }] }] } }),
  line({ type: 'assistant', isSidechain: true, message: { id: 'msg_side', content: [{ type: 'text', text: 'sidechain' }], usage: { input_tokens: 999 } } }),
  line({
    type: 'assistant',
    message: { id: 'msg_2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The app starts in src/index.ts.' }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 130, cache_creation_input_tokens: 0 } },
    timestamp: '2026-11-01T10:00:05.000Z',
  }),
];

test('the Claude branch projects text, thinking and tools; skips sidechains; cleans user text', () => {
  const turns = parseNativeTranscript(claudeLines.join(''), 'claude');
  assert.equal(turns.length, 4);
  assert.deepEqual(turns[0]!.blocks, [{ type: 'text', text: 'Start the step now.' }]);
  assert.equal(turns[0]!.role, 'user');
  assert.equal(turns[0]!.at, '2026-11-01T10:00:00.000Z');
  assert.deepEqual(turns[1]!.blocks, [{ type: 'thinking', text: 'Looking at the code.' }]);
  const tool = turns[2]!.blocks[0]!;
  assert.equal(tool.type, 'tool');
  // The result in a later record completes the call parsed in the same chunk.
  assert.deepEqual(tool, { type: 'tool', id: 'tu_1', name: 'Read', input: '{"file_path":"src/index.ts"}', output: 'export {}', state: 'completed' });
  assert.ok(!JSON.stringify(turns).includes('sidechain'));
});

test('jv events: assistant text and thinking, tool call and result; a result in a later chunk stands alone', () => {
  const all = transcriptEvents(parseNativeTranscript(claudeLines.join(''), 'claude'));
  assert.deepEqual(
    all.map((e) => e.kind),
    ['thinking', 'tool-call', 'tool-result', 'text'],
  );
  const first = transcriptEvents(parseNativeTranscript(claudeLines.slice(0, 3).join(''), 'claude'));
  assert.deepEqual(first.map((e) => e.kind), ['thinking', 'tool-call']);
  const later = transcriptEvents(parseNativeTranscript(claudeLines[3]!, 'claude', 999));
  assert.deepEqual(later, [{ kind: 'tool-result', payload: { id: 'tu_1', ok: true, output: 'export {}' } }]);
  const long = transcriptEvents(
    parseNativeTranscript(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: 'x'.repeat(5000) }] } }), 'claude'),
  );
  assert.equal(long[0]!.kind, 'tool-call');
  assert.equal((long[0]!.payload as { input: string }).input.length, 4000);
  assert.equal((long[0]!.payload as { inputTruncated?: boolean }).inputTruncated, true);
});

test('usage is counted once per message id, the larger output kept, sidechains left out', () => {
  const u = claudeTurnUsage(nativeRecords(claudeLines.join('')));
  assert.deepEqual(u, { inputTokens: 13, outputTokens: 16, cacheReadTokens: 230, cacheWriteTokens: 20, calls: 2 });
});

test('turn end: end_turn or turn_duration is idle; tool use and user records are working', () => {
  const t = new TurnTracker('claude');
  t.feed(nativeRecords(claudeLines.slice(0, 4).join('')), 1000);
  assert.equal(t.sawUser, true);
  assert.equal(t.ended(1000), false);
  t.feed(nativeRecords(claudeLines.slice(4).join('')), 2000);
  assert.equal(t.ended(2000), true);
  const s = new TurnTracker('claude');
  s.feed(nativeRecords(line({ type: 'system', subtype: 'turn_duration' })), 0);
  assert.equal(s.ended(0), true);
  const text = new TurnTracker('claude');
  text.feed(nativeRecords(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })), 0);
  assert.equal(text.ended(1000), false);
  assert.equal(text.ended(6000), true);
  assert.equal(nativeActivity(claudeLines.join(''), 'claude', Date.now()), 'idle');
});

test('the Codex branch: user events, messages, reasoning, function calls and outputs', () => {
  const raw = [
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Instructions for this session: do it' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate of the event' }] } }),
    line({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about it' }] } }),
    line({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' } }),
    line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a\nb' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'Done.' }] } }),
    line({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('');
  const turns = parseNativeTranscript(raw, 'codex');
  assert.deepEqual(
    turns.map((t) => [t.role, t.blocks[0]!.type]),
    [
      ['user', 'text'],
      ['assistant', 'thinking'],
      ['assistant', 'tool'],
      ['assistant', 'text'],
    ],
  );
  assert.ok(!JSON.stringify(turns).includes('duplicate of the event'));
  const tool = turns[2]!.blocks[0] as { output?: string; state: string };
  assert.equal(tool.output, 'a\nb');
  assert.equal(tool.state, 'completed');
  assert.equal(nativeActivity(raw, 'codex', Date.now()), 'idle');
});

test('readComplete keeps an incomplete last line for the next read and reads a shrunk file from the start', () => {
  const file = join(dir, 'chunks.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'user' })}\n{"type":"assis`);
  const a = readComplete(file, 0);
  assert.equal(a.text, '{"type":"user"}\n');
  assert.equal(a.next, 16);
  appendFileSync(file, 'tant"}\n');
  const b = readComplete(file, a.next);
  assert.equal(b.text, '{"type":"assistant"}\n');
  assert.equal(nativeRecords(b.text, b.start)[0]!.id, 'journal:16');
  writeFileSync(file, '{"type":"user"}\n');
  const c = readComplete(file, b.next);
  assert.equal(c.start, 0);
  assert.equal(readComplete(join(dir, 'missing.jsonl'), 5).next, 5);
});

test('the transcript path uses the resolved cwd with every non-alphanumeric character as "-"', () => {
  assert.equal(cwdSlug('/home/u/.jv/worktrees/sandbox/fix-a_b'), '-home-u--jv-worktrees-sandbox-fix-a-b');
  const real = join(dir, 'real.repo');
  mkdirSync(real);
  const link = join(dir, 'link');
  symlinkSync(real, link);
  const home = join(dir, 'home');
  const expected = claudeTranscriptPath(home, link, 'uuid-1');
  assert.equal(expected, join(home, '.claude', 'projects', cwdSlug(real), 'uuid-1.jsonl'));
  assert.equal(findClaudeTranscript(home, link, 'uuid-1'), undefined);
  const other = join(home, '.claude', 'projects', 'shortened-name');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'uuid-1.jsonl'), '');
  assert.equal(findClaudeTranscript(home, link, 'uuid-1'), join(other, 'uuid-1.jsonl'));
});
