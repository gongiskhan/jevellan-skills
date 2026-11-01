// A child process of the concurrent writers test in store.test.ts. It does nothing unless JV_TEST_WORKER=1, so
// the test runner, which also loads every file under dist-test/test/, sees an empty passing file.

import { Store } from '../../src/store.js';

interface WorkerArgs {
  file: string;
  worker: number;
  count: number;
  projectId: string;
  sharedSessionId: string;
}

function main(): void {
  const args = JSON.parse(process.env.JV_TEST_WORKER_ARGS ?? '{}') as WorkerArgs;
  const store = Store.open({ file: args.file });
  let sharedCreated = 0;
  try {
    for (let j = 0; j < args.count; j++) {
      const task = store.createTask({
        project_id: args.projectId,
        request_id: `w${args.worker}-t${j}`,
        kind: 'single',
        title: `worker ${args.worker} task ${j}`,
        task_text: 'concurrency',
        workflow_json: '{"steps":[]}',
      }).row;
      const session = store.createSession({
        project_id: args.projectId,
        task_id: task.id,
        request_id: `w${args.worker}-s${j}`,
        kind: 'step',
        runtime: 'claude-sdk',
        provider: 'claude-main',
        model: 'm',
        effort: 'high',
        cwd: '/tmp',
      }).row;
      store.appendEvent(session.id, 'start', { worker: args.worker, j });
      store.appendEvent(args.sharedSessionId, 'text', { worker: args.worker, j });
      // Every worker also creates the same task with the same request id: exactly one of them creates it.
      const shared = store.createTask({
        project_id: args.projectId,
        request_id: 'shared-task',
        kind: 'single',
        title: 'shared',
        task_text: 'same input from every worker',
        workflow_json: '{"steps":[]}',
      });
      if (shared.created) sharedCreated++;
    }
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify({ worker: args.worker, sharedCreated })}\n`);
}

if (process.env.JV_TEST_WORKER === '1') main();
