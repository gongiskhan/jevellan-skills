// Shared by the viewer scripts (viewer-check.mjs, phase8-viewer.mjs): Playwright from outside the package, and a
// `jv ui` of the script's own on a free port. Plain ESM, no dependencies.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { JV, SANDBOX } from './lib.mjs';

/** Points Playwright at ~/.cache/ms-playwright when PLAYWRIGHT_BROWSERS_PATH is not set and that folder exists. */
export function defaultBrowsersPath() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(join(homedir(), '.cache', 'ms-playwright'))) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(homedir(), '.cache', 'ms-playwright');
  }
}

/** Folders that may hold the playwright package, in order. */
function playwrightCandidates() {
  const out = [];
  if (process.env.JV_PLAYWRIGHT_DIR) out.push(process.env.JV_PLAYWRIGHT_DIR);
  out.push(join(SANDBOX, 'node_modules', 'playwright'), join(SANDBOX, 'node_modules', '@playwright', 'test'));
  out.push(join(dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright'));
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvm)) for (const v of readdirSync(nvm).sort().reverse()) out.push(join(nvm, v, 'lib', 'node_modules', 'playwright'));
  out.push(join(homedir(), 'dev', 'jevellan', 'node_modules', 'playwright'));
  return out;
}

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const tried = [];
  for (const dir of playwrightCandidates()) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    try {
      const pw = require(dir);
      if (pw?.chromium) return { pw, dir };
    } catch (error) {
      tried.push(`${dir}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`Playwright not found (set JV_PLAYWRIGHT_DIR). Tried: ${playwrightCandidates().join(', ')}${tried.length ? `; errors: ${tried.join('; ')}` : ''}`);
}

/** Starts `jv ui --port 0 --json` and resolves with {url, child} once it printed its URL. */
export function startViewer(bind) {
  const args = ['ui', '--port', '0', '--json', ...(bind ? ['--bind', bind] : [])];
  const child = spawn(JV, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let out = '';
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`jv ui printed no URL within 20 s: ${err.trim() || out.trim()}`));
    }, 20_000);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      try {
        const info = JSON.parse(out);
        if (info.url) {
          clearTimeout(timer);
          resolve({ url: info.url, child });
        }
      } catch {
        // not the whole JSON yet
      }
    });
    child.stderr.on('data', (c) => (err += c.toString('utf8')));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`jv ui exited with ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

export async function stopViewer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

