// jv report S: prints a session's report (text, or the section 5 shape with --json).

import type { CommandIo, ParsedArgs } from '../command.js';
import { requirePositional } from '../command.js';
import { notFound } from '../errors.js';
import { normalizeId } from '../ids.js';
import { formatReport, reportView } from '../report.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const id = normalizeId(requirePositional(args, 0, 'the session id (jv report S)'));
  const store = openStore();
  try {
    const session = store.requireSession(id);
    const row = store.getReportBySession(session.id);
    if (!row) throw notFound(`session ${session.id} has no report (state ${session.state}: ${session.state_reason})`);
    const view = reportView(row);
    io.result(view, () => formatReport(view));
    return 0;
  } finally {
    store.close();
  }
}
