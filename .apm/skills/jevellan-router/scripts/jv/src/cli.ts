// The jv command line: argument parsing (no dependencies), the command table, output and exit codes.
//
// Exit codes: 0 ok, 2 refused with a reason, 3 not found, 4 conflict, 1 an unexpected error.
// Every command accepts --json: text output is for humans, JSON for the coordinator and scripts.
// Commands are modules imported lazily from the table below; see src/command.ts for the module contract.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CommandIo, CommandModule, FlagValue, ParsedArgs } from './command.js';
import { EXIT, JvError, refused } from './errors.js';

export interface CommandEntry {
  /** Module path relative to this file (compiled: dist/cli.js). */
  module: string;
  /** One line for jv --help. */
  usage: string;
  /** Flags of this command that take no value (beyond the global ones). */
  booleans?: readonly string[];
  /** Internal commands are left out of jv --help. */
  internal?: boolean;
}

/** Flags that never take a value, for every command. */
export const GLOBAL_BOOLEANS: readonly string[] = ['json', 'help', 'version'];

/**
 * Every command of section 3 plus the internal ones. A module exports
 * `run(args: ParsedArgs, io: CommandIo): Promise<number | void>`.
 */
export const COMMANDS: Readonly<Record<string, CommandEntry>> = {
  doctor: { module: './doctor.js', usage: 'jv doctor                                   preflights' },
  project: {
    module: './project.js',
    usage: 'jv project add <path> [--name N] | jv project list',
  },
  providers: {
    module: './commands/providers.js',
    usage: 'jv providers check | jv providers login <name>',
  },
  status: { module: './commands/status.js', usage: 'jv status [--project N]' },
  task: {
    module: './commands/task.js',
    booleans: ['visible', 'discard', 'undo', 'keep'],
    usage:
      'jv task create|show|message|answer|stop|resume|override ...  (create: --project N --kind K [--duty D] --title T (--text ... | --file F) [--parent T] [--after T] [--visible])',
  },
  land: { module: './commands/land.js', booleans: ['force'], usage: 'jv land T [--force]' },
  report: { module: './commands/report.js', usage: 'jv report S' },
  tail: { module: './commands/tail.js', booleans: ['follow'], usage: 'jv tail S [--follow]' },
  attach: { module: './commands/attach.js', usage: 'jv attach S' },
  ui: { module: './commands/ui.js', usage: 'jv ui [--port 7071] [--bind ADDRESS]' },
  coordinator: {
    module: './commands/coordinator.js',
    usage: 'jv coordinator start|stop|restart|status --project N',
  },
  handoff: { module: './commands/handoff.js', usage: 'jv handoff --project N' },
  notes: { module: './commands/notes.js', usage: 'jv notes write --project N < text' },
  evals: { module: './commands/evals.js', usage: 'jv evals route|landing [--since DATE]' },
  usage: { module: './commands/usage.js', usage: 'jv usage [--week W]' },
  gc: { module: './commands/gc.js', booleans: ['dry-run'], usage: 'jv gc [--project N] [--dry-run]' },
  version: { module: './commands/version.js', usage: 'jv --version', internal: true },

  bootstrap: { module: './commands/bootstrap.js', usage: 'jv bootstrap', internal: true },
  update: { module: './commands/bootstrap.js', usage: 'jv update', internal: true },
  run: { module: './commands/run.js', usage: 'jv run --session R', internal: true, booleans: ['detach'] },
  exec: {
    module: './commands/exec.js',
    usage: 'jv exec --session R | --provider P [--home-login] -- <command...>',
    internal: true,
    booleans: ['home-login'],
  },
};

/**
 * Parses argv (without node and the script). Flags may appear anywhere; `--` ends flag parsing.
 * `--name=value` and `--name value` both work; a flag in GLOBAL_BOOLEANS or the command's booleans takes no
 * value. A value flag given more than once collects every value.
 */
export function parseArgs(argv: readonly string[], commands: Readonly<Record<string, CommandEntry>> = COMMANDS): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const words: string[] = [];
  let command = '';
  let booleans = new Set(GLOBAL_BOOLEANS);
  const setFlag = (name: string, value: string | boolean): void => {
    const prev = flags[name];
    if (prev === undefined || typeof value === 'boolean' || typeof prev === 'boolean') flags[name] = value;
    else flags[name] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-h') {
      setFlag('help', true);
      continue;
    }
    if (token === '-v' || token === '-V') {
      setFlag('version', true);
      continue;
    }
    if (token.startsWith('--') && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw refused(`unknown flag ${token}`);
      if (eq >= 0) {
        const value = body.slice(eq + 1);
        if (booleans.has(name)) setFlag(name, value !== 'false' && value !== '0');
        else setFlag(name, value);
        continue;
      }
      if (booleans.has(name)) {
        setFlag(name, true);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) throw refused(`--${name} needs a value`);
      setFlag(name, next);
      i++;
      continue;
    }
    if (command === '' && words.length === 0) {
      command = token;
      const entry = Object.hasOwn(commands, token) ? commands[token] : undefined;
      if (entry?.booleans) booleans = new Set([...GLOBAL_BOOLEANS, ...entry.booleans]);
      continue;
    }
    words.push(token);
  }
  return { command, positionals: words, flags, json: flags.json === true, raw: [...argv] };
}

/** Output to the process streams. */
export function processIo(json: boolean): CommandIo {
  return {
    json,
    result(data: unknown, text: string | (() => string)): void {
      if (json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      else {
        const t = typeof text === 'function' ? text() : text;
        if (t !== '') process.stdout.write(t.endsWith('\n') ? t : `${t}\n`);
      }
    },
    info(text: string): void {
      if (!json) process.stderr.write(`${text}\n`);
    },
    warn(text: string): void {
      process.stderr.write(`${text}\n`);
    },
    write(text: string): void {
      process.stdout.write(text);
    },
  };
}

export function helpText(): string {
  const lines = ['jv - the Jevellan runtime', '', 'Commands (every command accepts --json):'];
  for (const entry of Object.values(COMMANDS)) if (!entry.internal) lines.push(`  ${entry.usage}`);
  lines.push('  jv --version', '', 'Exit codes: 0 ok, 2 refused, 3 not found, 4 conflict.');
  return lines.join('\n');
}

/** The resolved file of a command module, or undefined when this build does not have it. */
export function commandModuleFile(entry: CommandEntry): string | undefined {
  const file = fileURLToPath(new URL(entry.module, import.meta.url));
  return existsSync(file) ? file : undefined;
}

async function redactText(text: string): Promise<string> {
  try {
    const { redact } = await import('./redact.js');
    return redact(text);
  } catch {
    return text;
  }
}

async function report(error: unknown, json: boolean): Promise<number> {
  if (error instanceof JvError) {
    const message = await redactText(error.message);
    if (json) process.stdout.write(`${JSON.stringify({ error: message, exitCode: error.exitCode }, null, 2)}\n`);
    else process.stderr.write(`jv: ${message}\n`);
    return error.exitCode;
  }
  const message = await redactText(error instanceof Error ? error.message : String(error));
  if (json) process.stdout.write(`${JSON.stringify({ error: message, exitCode: EXIT.failure }, null, 2)}\n`);
  else process.stderr.write(`jv: ${message}\n`);
  if (process.env.JV_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${await redactText(error.stack)}\n`);
  }
  return EXIT.failure;
}

/** Runs one jv invocation and returns its exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  try {
    const args = parseArgs(argv);
    if (args.command === '' && args.flags.version === true) return await runEntry('version', args, processIo(args.json));
    if (args.command === '' || args.command === 'help') {
      processIo(args.json).result({ commands: Object.keys(COMMANDS).filter((c) => !COMMANDS[c]!.internal) }, helpText());
      return EXIT.ok;
    }
    if (!Object.hasOwn(COMMANDS, args.command)) {
      throw refused(`unknown command "${args.command}". Run jv --help for the list.`);
    }
    if (args.flags.help === true) {
      processIo(args.json).result({ command: args.command, usage: COMMANDS[args.command]!.usage }, COMMANDS[args.command]!.usage);
      return EXIT.ok;
    }
    return await runEntry(args.command, args, processIo(args.json));
  } catch (error) {
    return report(error, json);
  }
}

async function runEntry(name: string, args: ParsedArgs, io: CommandIo): Promise<number> {
  const entry = COMMANDS[name]!;
  const file = commandModuleFile(entry);
  if (!file) throw refused(`jv ${name} is not available in this build`);
  const mod = (await import(new URL(entry.module, import.meta.url).href)) as Partial<CommandModule>;
  if (typeof mod.run !== 'function') throw refused(`jv ${name} is not available in this build`);
  const code = await mod.run(args, io);
  return typeof code === 'number' ? code : EXIT.ok;
}
