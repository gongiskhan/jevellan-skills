// Picks the runtime module by the session row's `runtime` (section 6): claude-sdk, claude-tmux, codex and llm.
//
// Test hook: JV_TEST_RUNTIME_MODULE names a module file that replaces every runtime. It exists only so the launcher
// tests can run a detached `jv run` against a fake runtime with no model; nothing else sets it.

import { pathToFileURL } from 'node:url';
import { refused } from '../errors.js';
import type { Runtime } from '../types.js';
import type { RuntimeModule } from './types.js';

const BUILT: Partial<Record<Runtime, string>> = {
  'claude-sdk': './claude-sdk.js',
  'claude-tmux': './claude-tmux.js',
  codex: './codex.js',
  llm: './llm.js',
};

function asModule(mod: Partial<RuntimeModule>, name: string): RuntimeModule {
  for (const f of ['start', 'resume', 'stop', 'tail'] as const) {
    if (typeof mod[f] !== 'function') throw refused(`runtime module ${name} has no ${f}()`);
  }
  return mod as RuntimeModule;
}

export async function loadRuntime(runtime: Runtime): Promise<RuntimeModule> {
  const override = process.env.JV_TEST_RUNTIME_MODULE;
  if (override !== undefined && override.trim() !== '') {
    return asModule((await import(pathToFileURL(override).href)) as Partial<RuntimeModule>, override);
  }
  const file = BUILT[runtime];
  if (!file) throw refused(`the ${runtime} runtime is not available in this build yet`);
  return asModule((await import(file)) as Partial<RuntimeModule>, runtime);
}
