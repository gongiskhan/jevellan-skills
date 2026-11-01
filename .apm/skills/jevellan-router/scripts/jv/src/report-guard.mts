// The report guard: the Stop hook of section 6.4 (compiled to dist/report-guard.mjs).
//
// - Reads JV_SESSION before importing anything else: when it is unset (an ordinary session, including the owner's
//   own sessions where the APM hook runs it, possibly on a Node without node:sqlite) it exits 0 at once (D-016).
// - Exits 0 unless JV_SESSION names a session row of kind `step` (the coordinator has JV_SESSION too and is never
//   blocked).
// - Resolves the current run like the report MCP server (newest row of the conversation without a report, D-006).
//   When that run has no report it prints {"decision":"block","reason":"End the turn with jv_report (status
//   progress, done, blocked or needs-decision)."} and exits 0; it blocks at most twice per run (counted in meta
//   `report_guard:<R>`), then lets the turn end and the adapter synthesizes `blocked`.
// - Never throws: any error exits 0 with nothing on stdout. It does not read stdin.

const sessionId = process.env.JV_SESSION?.trim();

export const BLOCK_REASON = 'End the turn with jv_report (status progress, done, blocked or needs-decision).';
export const MAX_BLOCKS = 2;
export const GUARD_META_PREFIX = 'report_guard:';

async function decide(id: string): Promise<string | undefined> {
  // The APM form of the hook runs without --disable-warning: keep node:sqlite's ExperimentalWarning off stderr.
  process.removeAllListeners('warning');
  process.on('warning', () => {});
  const { existsSync } = await import('node:fs');
  const { paths } = await import('./paths.js');
  if (!existsSync(paths.store)) return undefined; // never create a store from a hook
  const { openStore } = await import('./store.js');
  const { resolveReportSession } = await import('./report.js');
  const store = openStore();
  try {
    const named = store.getSession(id);
    if (!named || named.kind !== 'step') return undefined;
    const run = resolveReportSession(store, id);
    if (store.getReportBySession(run.id)) return undefined;
    const key = `${GUARD_META_PREFIX}${run.id}`;
    const blocked = store.tx(() => {
      const count = Number(store.getMeta(key) ?? '0');
      const n = Number.isFinite(count) ? count : 0;
      if (n >= MAX_BLOCKS) return false;
      store.setMeta(key, String(n + 1));
      return true;
    });
    return blocked ? JSON.stringify({ decision: 'block', reason: BLOCK_REASON }) : undefined;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  if (!sessionId) return;
  const out = await decide(sessionId);
  if (out !== undefined) await new Promise<void>((resolve) => process.stdout.write(`${out}\n`, () => resolve()));
}

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
if (!sessionId) process.exit(0);
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
