// afterRun: what happens to the task when a run ends. MINIMAL phase 2 version; phase 4 replaces this file with the
// advancing, retries and wake lines of section 7.6.
//
// - A stopped run is left alone (whoever stopped it owns the task's state).
// - A `done` report marks the step done; the task is done when it is a `single` task or that was its last step,
//   else it waits on the owner (advancing to the next step arrives in phase 4).
// - Anything else (progress, blocked, needs-decision, or no report from a failed or lost run) marks the task
//   waiting-owner with the report status, or the run's state, as the reason.

import type { Store } from './store.js';

export function afterRun(store: Store, sessionId: string): void {
  const session = store.getSession(sessionId);
  if (!session || session.kind !== 'step' || !session.task_id || !session.step_id) return;
  if (session.state === 'stopped') return;
  const task = store.getTask(session.task_id);
  const step = store.getStep(session.step_id);
  if (!task || !step) return;
  if (['done', 'failed', 'stopped'].includes(task.state)) return;
  const report = store.getReportBySession(sessionId);
  store.tx(() => {
    if (report?.status === 'done') {
      store.setStepState(step.id, 'done', `report done (${sessionId})`);
      const steps = store.listSteps(task.id);
      const last = steps.every((s) => s.id === step.id || s.state === 'done' || s.state === 'skipped');
      if (task.kind === 'single' || last) store.setTaskState(task.id, 'done', `step ${step.duty} done`);
      else store.setTaskState(task.id, 'waiting-owner', `step ${step.duty} done; the next step is not started yet`);
      return;
    }
    const why = report ? report.status : `session ${session.state}: ${session.state_reason}`;
    store.setTaskState(task.id, 'waiting-owner', why);
  });
}
