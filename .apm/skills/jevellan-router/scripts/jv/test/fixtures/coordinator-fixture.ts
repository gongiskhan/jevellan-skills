// Shared fixture of the coordinator and wake tests: a fake tmux (no real tmux is ever touched), a providers.json
// whose claude-main lists the coordinator's model, and an installed coordinator skill. Every value is made up.
// Callers set process.env.JV_HOME before importing anything from src/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TmuxResult, TmuxRunner } from '../../src/coordinator.js';

/** A Claude Code screen with the input prompt, as captured on dev-madrid. */
export const READY_SCREEN = [
  ' ▐▛███▛█   Claude Code v2.1.316',
  '▝▜██████▀  Opus 5.5 with high effort · Claude API',
  '────────────────────────────────────────',
  '❯ Try "how do I log an error?"',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

/** The folder trust dialog, as captured on dev-madrid. */
export const TRUST_SCREEN = [
  ' Accessing workspace:',
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** The bypass-permissions warning, as captured on dev-madrid. */
export const BYPASS_SCREEN = [
  '  WARNING: Claude Code running in Bypass Permissions mode',
  '  ❯ No, exit',
  '    Yes, I accept',
  '  Enter to confirm · Esc to cancel',
].join('\n');

export interface FakeSession {
  name: string;
  pid: number;
  cwd: string;
  command: string[];
  env: string[];
  screen: string;
  /** Text typed since the last Enter. */
  input: string;
  /** Every submitted message (text typed or pasted, then Enter). */
  submitted: string[];
}

export class FakeTmux {
  readonly sessions = new Map<string, FakeSession>();
  readonly calls: string[][] = [];
  readonly buffers = new Map<string, string>();
  /** Every session ever created, kept after it ends. */
  readonly history: FakeSession[] = [];
  /** Whether a typed /exit ends the session. */
  exitOnSlashExit = true;
  /** The screen a new session shows. */
  startScreen = READY_SCREEN;
  /** A new session ends at once (claude failed to start). */
  dieOnStart = false;
  private nextPid = 40_000;

  readonly run: TmuxRunner = (args, input) => this.handle([...args], input);

  /** A session that is not ours (someone else's tmux session with our name). */
  addForeign(name: string): FakeSession {
    const s = this.makeSession(name, '/', ['bash'], []);
    return s;
  }

  private makeSession(name: string, cwd: string, command: string[], env: string[]): FakeSession {
    const s: FakeSession = { name, pid: this.nextPid++, cwd, command, env, screen: this.startScreen, input: '', submitted: [] };
    this.sessions.set(name, s);
    this.history.push(s);
    return s;
  }

  private target(args: string[]): FakeSession | undefined {
    const i = args.indexOf('-t');
    if (i < 0) return undefined;
    const name = args[i + 1]!.replace(/^=/, '').replace(/:.*$/, '');
    return this.sessions.get(name);
  }

  private ok(stdout = ''): TmuxResult {
    return { code: 0, stdout, stderr: '' };
  }

  private fail(stderr: string): TmuxResult {
    return { code: 1, stdout: '', stderr };
  }

  private handle(args: string[], input?: string): TmuxResult {
    this.calls.push(args);
    const [cmd] = args;
    switch (cmd) {
      case 'has-session':
        return this.target(args) ? this.ok() : this.fail("can't find session");
      case 'new-session': {
        const name = args[args.indexOf('-s') + 1]!;
        if (this.sessions.has(name)) return this.fail(`duplicate session: ${name}`);
        const cwd = args[args.indexOf('-c') + 1]!;
        const env: string[] = [];
        args.forEach((a, i) => {
          if (a === '-e') env.push(args[i + 1]!);
        });
        const fmt = args.indexOf('-F');
        const command = args.slice(fmt + 2);
        const s = this.makeSession(name, cwd, command, env);
        if (this.dieOnStart) this.sessions.delete(name);
        return this.ok(`${s.pid}\n`);
      }
      case 'capture-pane': {
        const s = this.target(args);
        return s ? this.ok(s.screen) : this.fail("can't find pane");
      }
      case 'display-message': {
        const s = this.target(args);
        return s ? this.ok(`${s.pid}\n`) : this.fail("can't find pane");
      }
      case 'send-keys': {
        const s = this.target(args);
        if (!s) return this.fail("can't find pane");
        if (args.includes('-l')) {
          const dash = args.indexOf('--');
          s.input += args[dash >= 0 ? dash + 1 : args.length - 1]!;
          return this.ok();
        }
        if (args.at(-1) === 'Enter') {
          const text = s.input;
          s.input = '';
          s.submitted.push(text);
          if (text === '/exit' && this.exitOnSlashExit) this.sessions.delete(s.name);
        }
        return this.ok();
      }
      case 'load-buffer': {
        const b = args[args.indexOf('-b') + 1]!;
        this.buffers.set(b, input ?? '');
        return this.ok();
      }
      case 'paste-buffer': {
        const b = args[args.indexOf('-b') + 1]!;
        const s = this.target(args);
        if (!s || !this.buffers.has(b)) return this.fail('no buffer or pane');
        s.input += this.buffers.get(b)!;
        if (args.includes('-d')) this.buffers.delete(b);
        return this.ok();
      }
      case 'kill-session': {
        const s = this.target(args);
        if (!s) return this.fail("can't find session");
        this.sessions.delete(s.name);
        return this.ok();
      }
      default:
        return this.fail(`fake tmux: ${cmd} not supported`);
    }
  }

  /** The command line /proc would show for a pane's pid: jv exec --session <R> for ours. */
  cmdline(pid: number): string[] | undefined {
    const s = [...this.sessions.values()].find((x) => x.pid === pid);
    return s ? ['sh', ...s.command] : undefined;
  }
}

/** Writes providers.json (claude-main with the coordinator's model, tokenFile) and the coordinator skill. */
export function writeCoordinatorHome(home: string): void {
  mkdirSync(join(home, 'homes', 'claude-main', '.claude'), { recursive: true });
  writeFileSync(
    join(home, 'providers.json'),
    JSON.stringify(
      {
        jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-test' },
        providers: [
          {
            name: 'claude-main',
            kind: 'claude-subscription',
            home: '~/.jv/homes/claude-main',
            tokenFile: '~/.jv/secrets/claude-main.token',
            models: [
              { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'max'] },
              { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low'] },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  const skill = join(home, 'skills', 'jevellan-coordinator');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: jevellan-coordinator',
      'description: "Jevellan internal. Not for direct use."',
      'disable-model-invocation: true',
      '---',
      '',
      'You are the coordinator of the project "{{project}}" at {{path}}.',
      '',
      'This project: "{{project}}", default branch {{default_branch}}. The jv is {{jv}}.',
      '',
      '```sh',
      '{{jv}} status --json',
      '```',
      '',
    ].join('\n'),
  );
}
