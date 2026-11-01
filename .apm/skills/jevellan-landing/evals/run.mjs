#!/usr/bin/env node
// The eval runner of this policy skill (frontmatter jv-eval-runner: evals/run.mjs, section 12).
//
//   node evals/run.mjs [--cases FILE] [--split held-out|dev|all] [--results FILE] [--json] [--runtime DIST]
//
// Replays the policy in the SKILL.md next to this folder, as it is now, against evals/cases.json through Jev (real
// calls, with the key providers.json names), prints the agreement per question and every disagreement with Jev's
// probabilities, writes evals/RESULTS.md and exits 1 when held-out agreement is below evals/threshold.json
// ({"heldOut": 0..1}); 2 when the run cannot be made (no Jev key, a Jev failure, an invalid cases file).
//
// The replay itself is the installed runtime's dist/evals.js ($JV_HOME/runtime/dist, JV_HOME default ~/.jv), so
// this file needs no build and both policy skills run the same code. --runtime DIST (or JV_EVALS_RUNTIME) points at
// another built dist folder, such as a development checkout's.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

function runtimeDist() {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime' && argv[i + 1]) return resolve(argv[i + 1]);
    if (argv[i].startsWith('--runtime=')) return resolve(argv[i].slice('--runtime='.length));
  }
  if (process.env.JV_EVALS_RUNTIME?.trim()) return resolve(process.env.JV_EVALS_RUNTIME.trim());
  const home = process.env.JV_HOME?.trim() ? resolve(process.env.JV_HOME.trim()) : join(homedir(), '.jv');
  return join(home, 'runtime', 'dist');
}

const module = join(runtimeDist(), 'evals.js');
if (!existsSync(module)) {
  process.stderr.write(`evals: no ${module}; the installed runtime has no evals module. Run jv update, or pass --runtime <dist folder>.\n`);
  process.exit(2);
}
const { runEvalsMain } = await import(pathToFileURL(module).href);
process.exitCode = await runEvalsMain(skillDir, argv);
