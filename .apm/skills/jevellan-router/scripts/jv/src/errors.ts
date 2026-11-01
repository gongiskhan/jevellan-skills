// The one error type commands throw. The CLI prints the message (or {"error": ...} with --json) and exits with
// the code: 2 refused with a reason, 3 not found, 4 conflict (a request id reused with different input).

export const EXIT = {
  ok: 0,
  failure: 1,
  refused: 2,
  notFound: 3,
  conflict: 4,
} as const;

export type JvExitCode = typeof EXIT.refused | typeof EXIT.notFound | typeof EXIT.conflict;

export class JvError extends Error {
  readonly exitCode: JvExitCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, exitCode: JvExitCode = EXIT.refused, details?: Record<string, unknown>) {
    super(message);
    this.name = 'JvError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function refused(message: string, details?: Record<string, unknown>): JvError {
  return new JvError(message, EXIT.refused, details);
}

export function notFound(message: string, details?: Record<string, unknown>): JvError {
  return new JvError(message, EXIT.notFound, details);
}

export function conflict(message: string, details?: Record<string, unknown>): JvError {
  return new JvError(message, EXIT.conflict, details);
}

export function isJvError(error: unknown): error is JvError {
  return error instanceof JvError;
}
