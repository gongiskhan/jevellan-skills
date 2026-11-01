// jv coordinator start|stop|restart|status --project N (section 9.1, 9.5). See src/coordinator.ts.

import type { CommandIo, ParsedArgs } from '../command.js';
import { requireFlag } from '../command.js';
import {
  coordinatorStatus,
  formatStatus,
  restartCoordinator,
  startCoordinator,
  stopCoordinator,
} from '../coordinator.js';
import { refused } from '../errors.js';
import { openStore } from '../store.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  const project = requireFlag(args, 'project');
  const store = openStore();
  try {
    switch (sub) {
      case 'start': {
        io.info(`Starting the coordinator of ${project} (waits up to 60 s for its prompt).`);
        const r = await startCoordinator(store, project);
        io.result(r, () => `${r.started ? 'Started.' : 'Already running.'}\n${formatStatus(r)}`);
        return 0;
      }
      case 'stop': {
        const r = await stopCoordinator(store, project);
        io.result(r, r.stopped ? `Coordinator of ${r.project} ${r.reason}.` : `Coordinator of ${r.project}: ${r.reason}.`);
        return 0;
      }
      case 'restart': {
        io.info(`Restarting the coordinator of ${project}.`);
        const r = await restartCoordinator(store, project);
        io.result(r, () =>
          [
            `Restarted (${r.stop.reason}).`,
            formatStatus(r),
            r.handoffTyped ? 'Handoff typed as the first message.' : `Handoff not typed: ${r.handoffReason}.`,
          ].join('\n'),
        );
        return 0;
      }
      case 'status':
      case undefined: {
        const r = coordinatorStatus(store, project);
        io.result(r, () => formatStatus(r));
        return 0;
      }
      default:
        throw refused(`unknown subcommand "jv coordinator ${sub}" (start, stop, restart or status)`);
    }
  } finally {
    store.close();
  }
}
