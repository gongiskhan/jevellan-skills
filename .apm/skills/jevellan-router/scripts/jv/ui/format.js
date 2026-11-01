// Pure text helpers of the jv ui page script (section 10). They touch no DOM, so node tests import them directly
// (app.js cannot be imported outside a browser).

/** Dates and clocks use the 24-hour clock everywhere, so an event's clock and a card's date read the same way. */
export const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const fullFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

const known = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v) => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * The parts of a rate-limit event line. A value the event does not carry is left out rather than shown as a dash
 * ("five hours -" read as a broken value). `formatDate` formats the reset time.
 */
export function rateLimitParts(p, formatDate) {
  const parts = [];
  if (known(p?.fiveHourPct)) parts.push(`five hours ${Math.round(p.fiveHourPct)}%`);
  if (known(p?.weeklyPct)) parts.push(`week ${Math.round(p.weeklyPct)}%`);
  if (text(p?.weeklyResetsAt)) parts.push(`week resets ${formatDate(p.weeklyResetsAt)}`);
  return parts;
}

/**
 * The usage note of a provider in a placement's "Providers considered" list: the weekly use against the ceiling, and
 * the five-hour use only when it is known (it read "five hours -" for every provider whose probe has no such value).
 */
export function providerUsageNote(p) {
  const week = known(p?.weeklyPct) ? `week ${Math.round(p.weeklyPct)}%` : 'week unknown';
  const ceiling = known(p?.ceilingPct) ? ` of ${Math.round(p.ceilingPct)}%` : '';
  const five = known(p?.fiveHourPct) ? `, five hours ${Math.round(p.fiveHourPct)}%` : '';
  return `${week}${ceiling}${five}`;
}

/**
 * A tool-result event with no tool call before it: jv's own steps (the worktree setup writes
 * `{name, command, ok, exitCode, timedOut, durationMs, text}`) or a result whose call is not in the stream. Gives the
 * row its name, the command when there is one, the body to show and whether it failed.
 */
export function toolResultView(p) {
  const name = text(p?.name)?.trim() ?? 'result';
  const command = text(p?.command)?.trim();
  const body = text(p?.output) ?? text(p?.text) ?? '';
  const facts = [];
  if (known(p?.exitCode)) facts.push(`exit code ${p.exitCode}`);
  if (p?.timedOut === true) facts.push('timed out');
  if (known(p?.durationMs)) facts.push(`${(p.durationMs / 1000).toFixed(1)}s`);
  const detail = [command ? `$ ${command}` : '', body, facts.join(', ')].filter(Boolean).join('\n');
  return { name, command, body, detail, failed: p?.ok === false };
}

/**
 * The note under a project for the tasks the first page leaves out: stopped tasks, and done or failed ones that ended
 * more than a day ago. A task stopped a minute ago is not "older", so the note names both reasons.
 */
export function hiddenNote(n) {
  if (!known(n) || n <= 0) return '';
  return `${n} ${n === 1 ? 'task' : 'tasks'} not shown (stopped, or ended more than a day ago)`;
}
