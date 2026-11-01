// Ids: one letter prefix plus 6 characters of Crockford base32, upper case, from crypto random bytes.
// Uniqueness is the store's job: it retries with a fresh id when an insert collides.

import { randomInt } from 'node:crypto';

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIXES = {
  task: 'T',
  step: 'S',
  session: 'R',
  decision: 'D',
  landing: 'L',
  message: 'M',
  project: 'P',
  report: 'E',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ID_BODY_LENGTH = 6;
const ID_PATTERN = /^[TSRDLMPE][0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

/** A new random id for `kind`, for example newId('task') -> "T7K2M9Q". */
export function newId(kind: IdKind): string {
  let body = '';
  for (let i = 0; i < ID_BODY_LENGTH; i++) body += CROCKFORD[randomInt(32)];
  return ID_PREFIXES[kind] + body;
}

/** True when `value` is a well formed id, optionally of one kind. */
export function isId(value: string, kind?: IdKind): boolean {
  if (!ID_PATTERN.test(value)) return false;
  return kind === undefined || value[0] === ID_PREFIXES[kind];
}

/**
 * Normalizes an id typed by a person: upper case, Crockford's lookalikes mapped (I and L to 1, O to 0).
 * Returns the input unchanged when it does not look like an id at all.
 */
export function normalizeId(value: string): string {
  const v = value.trim().toUpperCase();
  if (v.length !== ID_BODY_LENGTH + 1) return value.trim();
  const body = v.slice(1).replace(/[IL]/g, '1').replace(/O/g, '0');
  return v[0] + body;
}
