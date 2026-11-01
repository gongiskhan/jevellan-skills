#!/usr/bin/env node
// jv entry point (plain JS, runs before anything is built).
//
// 1. Refuses Node older than 22.13 (node:sqlite), naming an installed Node 22 when there is one.
// 2. "jv bootstrap" and "jv update" run bin/bootstrap.mjs.
// 3. Otherwise runs $JV_HOME/runtime/dist/cli.js; on first use (no build yet) bootstraps first. That first-use
//    bootstrap takes $JV_HOME/bootstrap.lock: when another bootstrap holds it, it waits (bounded, 120 s) and then
//    uses what the other one installed instead of building a second time. An update never removes dist/: it
//    switches the $JV_HOME/runtime link atomically (D-021).

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_MAJOR = 22;
const MIN_MINOR = 13;

function nodeIsRecentEnough() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
}

function installedNode22() {
  const root = join(homedir(), '.nvm', 'versions', 'node');
  try {
    const found = readdirSync(root)
      .filter((v) => /^v22\.(\d+)\.\d+$/.test(v) && Number(v.split('.')[1]) >= MIN_MINOR)
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number);
        const pb = b.slice(1).split('.').map(Number);
        return pb[1] - pa[1] || pb[2] - pa[2];
      });
    return found.length ? join(root, found[0], 'bin') : undefined;
  } catch {
    return undefined;
  }
}

if (!nodeIsRecentEnough()) {
  const bin = installedNode22();
  const hint = bin
    ? `Node 22 is installed at ${bin}: run export PATH=${bin}:$PATH and try again.`
    : 'Install Node 22.13 or later (for example with nvm: nvm install 22) and try again.';
  process.stderr.write(`jv: Node ${process.versions.node} is too old; jv needs Node 22.13 or later (node:sqlite). ${hint}\n`);
  process.exit(2);
}

// node:sqlite prints an ExperimentalWarning on first use. The installed shim passes
// --disable-warning=ExperimentalWarning; when jv runs without it, drop that one warning and keep the others.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const here = dirname(fileURLToPath(import.meta.url));
function resolveJvHome() {
  // Same rule as src/paths.ts: JV_HOME (with a leading ~ expanded), else ~/.jv.
  const v = process.env.JV_HOME?.trim();
  if (!v) return join(homedir(), '.jv');
  if (v === '~') return homedir();
  return resolve(v.startsWith('~/') ? join(homedir(), v.slice(2)) : v);
}

const jvHome = resolveJvHome();
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-'));

async function runBootstrap(argv) {
  const { bootstrap } = await import(pathToFileURL(join(here, 'bootstrap.mjs')).href);
  return bootstrap(argv);
}

async function main() {
  if (command === 'bootstrap' || command === 'update') {
    return runBootstrap(args);
  }
  const cli = join(jvHome, 'runtime', 'dist', 'cli.js');
  if (!existsSync(cli)) {
    process.stderr.write(`jv: no runtime built in ${jvHome} yet; installing it\n`);
    const code = await runBootstrap(['bootstrap', '--first-use']);
    if (code !== 0) return code;
    if (!existsSync(cli)) {
      process.stderr.write(`jv: the bootstrap finished but ${cli} is missing\n`);
      return 1;
    }
  }
  const { main: cliMain } = await import(pathToFileURL(cli).href);
  return cliMain(args);
}

main().then(
  (code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  },
  (error) => {
    process.stderr.write(`jv: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
