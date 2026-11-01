// A fake runtime module for the launcher tests (loaded through JV_TEST_RUNTIME_MODULE in the detached `jv run`).
// FAKE_RUNTIME_MODE picks the behaviour: done (reports done), progress, sleep (waits for SIGTERM), crash (exits
// without an end event), fail (throws). FAKE_RUNTIME_DUMP names a file where the input it received is written
// (environment keys only, never values, except HOME and JV_SESSION).

import { writeFileSync } from 'node:fs';
import { recordEvent, tailEvents } from '../../src/events.js';
import { stopRun } from '../../src/launcher.js';
import { writeReport } from '../../src/report.js';
import { RunStopped, type StartInput, type TurnInput } from '../../src/runtimes/types.js';
import { openStore } from '../../src/store.js';
import type { SessionRow } from '../../src/types.js';

function dump(session: SessionRow, prompt: string, input: TurnInput): void {
  const file = process.env.FAKE_RUNTIME_DUMP;
  if (!file) return;
  writeFileSync(
    file,
    JSON.stringify({
      session: session.id,
      native: session.native_session_id,
      prompt,
      systemAppend: input.systemAppend,
      tools: input.tools,
      mcp: input.mcp,
      envKeys: Object.keys(input.env).sort(),
      home: input.env.HOME,
      jvSession: input.env.JV_SESSION,
    }),
  );
}

async function turn(session: SessionRow, prompt: string, input: TurnInput): Promise<void> {
  dump(session, prompt, input);
  const mode = process.env.FAKE_RUNTIME_MODE ?? 'done';
  const store = openStore();
  try {
    if (!session.native_session_id) store.updateSession(session.id, { native_session_id: `fake-native-${session.id}` });
    recordEvent(store, session.id, 'text', { text: `fake ${mode}: ${prompt}` });
    if (mode === 'crash') process.exit(9);
    if (mode === 'fail') throw new Error('the fake model refused');
    if (mode === 'sleep') {
      // A real turn keeps the event loop busy with its CLI child; the fake keeps it with a timer.
      const keepAlive = setInterval(() => {}, 1000);
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      clearInterval(keepAlive);
      throw new RunStopped();
    }
    recordEvent(store, session.id, 'usage', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    writeReport(store, session.id, { status: mode === 'progress' ? 'progress' : 'done', summary: `Fake ${mode} report.` });
  } finally {
    store.close();
  }
}

export async function start(session: SessionRow, input: StartInput) {
  const { prompt, ...rest } = input;
  await turn(session, prompt, rest);
  return { nativeSessionId: `fake-native-${session.id}`, pid: process.pid, pgid: process.pid };
}

export async function resume(session: SessionRow, message: string, input?: TurnInput) {
  await turn(session, message, input!);
}

export async function stop(session: SessionRow, reason: string) {
  const store = openStore();
  try {
    await stopRun(store, session.id, reason);
  } finally {
    store.close();
  }
}

export async function* tail(session: SessionRow, sinceSeq: number) {
  const store = openStore();
  try {
    yield* tailEvents(store, session.id, sinceSeq);
  } finally {
    store.close();
  }
}
