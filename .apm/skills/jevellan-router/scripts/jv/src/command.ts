// The contract between the CLI and its command modules.
//
// A command module (src/commands/<name>.ts, or src/doctor.ts and src/project.ts) exports:
//
//   export async function run(args: ParsedArgs, io: CommandIo): Promise<number | void>
//
// It returns the exit code (undefined means 0) or throws JvError(message, 2 | 3 | 4). It prints its result once
// with io.result(data, text): JSON of `data` with --json, `text` otherwise. Progress for humans goes through
// io.info (stderr, silent with --json). args.positionals starts after the command name, so for
// `jv task show T1` the module of `task` sees positionals ['show', 'T1'].

import { refused } from './errors.js';

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  /** The command name ('' when none was given). */
  command: string;
  /** Words after the command: subcommand first when the command has subcommands. */
  positionals: string[];
  /** --name value, --name=value, or --name for boolean flags. A value flag given twice holds every value. */
  flags: Record<string, FlagValue>;
  /** --json was given: print JSON for machines. */
  json: boolean;
  /** The argv this was parsed from. */
  raw: string[];
}

export interface CommandIo {
  readonly json: boolean;
  /** Prints the command's result: `data` as JSON with --json, else `text`. */
  result(data: unknown, text: string | (() => string)): void;
  /** A line for humans on stderr; silent with --json. */
  info(text: string): void;
  /** A warning on stderr, also with --json. */
  warn(text: string): void;
  /** Raw output, for commands that stream (jv tail --follow). */
  write(text: string): void;
}

/** A string flag, or undefined. Throws when the flag was given as a bare boolean. */
export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') throw refused(`--${name} needs a value`);
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

/** Every value of a repeatable string flag. */
export function flagStrings(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (v === undefined || typeof v === 'boolean') return [];
  return Array.isArray(v) ? v : [v];
}

/** A required string flag; refuses (exit 2) when missing. */
export function requireFlag(args: ParsedArgs, name: string): string {
  const v = flagString(args, name);
  if (v === undefined || v === '') throw refused(`--${name} is required`);
  return v;
}

/** A boolean flag. */
export function flagBool(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === 'true';
}

/** An integer flag, or undefined; refuses on anything else. */
export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw refused(`--${name} needs a whole number`);
  return Number(v);
}

/** A required positional; refuses (exit 2) with `what` named when missing. */
export function requirePositional(args: ParsedArgs, index: number, what: string): string {
  const v = args.positionals[index];
  if (v === undefined || v === '') throw refused(`${what} is required`);
  return v;
}

/** What a command module exports. */
export interface CommandModule {
  run(args: ParsedArgs, io: CommandIo): Promise<number | void>;
}
