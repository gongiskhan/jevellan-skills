#!/usr/bin/env node
// J16 Viewer on the phone (brief section 15): the viewer over Tailscale at phone width.
//
// 1. Stops the loopback viewer J5 left running (jv ui --port 7071 on 127.0.0.1, its pid in results/J05.json
//    elapsed.viewerPid; only that pid, and only when it is a jv ui process), and checks 127.0.0.1:7071 is free.
// 2. Starts `jv ui --bind <tailnet ip> --port 7071` in the background and waits for it to answer on that address.
// 3. Runs acceptance/viewer-check.mjs <customers task> --url http://<tailnet ip>:7071 (Playwright headless, 390 px):
//    the task page renders with its screenshots loaded and no horizontal scroll; its page screenshot goes to --shots.
// 4. Stops that viewer and checks the port is free again.
//
// Usage: node acceptance/j16-viewer-phone.mjs [--tag T] [--j4-tag j4c] [--bind 100.88.165.46] [--shots DIR]
// Writes acceptance/results/J16.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, JV, queryOne, sleep } from './lib.mjs';
import { arg, journey, RESULTS_DIR } from './journey.mjs';
import { oneLine } from './coord.mjs';

const J = journey(16, 'Viewer on the phone');
const HERE = dirname(fileURLToPath(import.meta.url));
const J4_TAG = arg('--j4-tag', 'j4c');
const BIND = arg('--bind', '100.88.165.46');
const SHOTS = arg('--shots', '/tmp/claude-1001/-home-ggomes-dev-jevellan-skills/286eb47c-c709-4c16-8549-52f13f67d750/scratchpad/journey-shots');
const URL = `http://${BIND}:7071`;
const parse = (s, f = null) => {
  try {
    return s == null ? f : JSON.parse(s);
  } catch {
    return f;
  }
};

async function answers(url) {
  try {
    const r = await fetch(`${url}/api/overview`, { signal: AbortSignal.timeout(3000) });
    return r.status;
  } catch {
    return 0;
  }
}

const cmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
  } catch {
    return '';
  }
};

async function main() {
  const state = parse(existsSync(join(RESULTS_DIR, `J04-state-${J4_TAG}.json`)) ? readFileSync(join(RESULTS_DIR, `J04-state-${J4_TAG}.json`), 'utf8') : null);
  const tasks = (state?.tasks ?? []).map((id) => queryOne('SELECT * FROM tasks WHERE id = ?', id));
  const cust = tasks.find((t) => /customer/i.test(`${t.title} ${t.task_text}`) && /empty/i.test(`${t.title} ${t.task_text}`));
  if (!check('the customers task of J4', !!cust, cust ? `${cust.id} "${cust.title}" ${cust.state}` : 'none')) return;

  // 1. the loopback viewer
  const j5 = parse(existsSync(join(RESULTS_DIR, 'J05.json')) ? readFileSync(join(RESULTS_DIR, 'J05.json'), 'utf8') : null);
  const pid = j5?.elapsed?.viewerPid;
  const line = pid ? cmdline(pid) : '';
  let stopped = 'J5 left no loopback viewer';
  if (pid && /\bui\b/.test(line) && /jv/.test(line)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20 && cmdline(pid); i++) await sleep(250);
    stopped = `stopped J5's loopback viewer pid ${pid} (${oneLine(line, 160)})`;
  } else if (pid) stopped = `J5's viewer pid ${pid} is gone already`;
  const loopback = await answers('http://127.0.0.1:7071');
  check('the loopback viewer is stopped (127.0.0.1:7071 free)', loopback === 0, `${stopped}; 127.0.0.1:7071 answers ${loopback || 'nothing'}`);

  // 2. the tailnet viewer
  const ip = spawnSync('ip', ['-o', 'addr', 'show'], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.includes(` ${BIND}/`));
  check(`${BIND} is an address of this machine (the tailnet interface)`, !!ip, ip ? oneLine(ip, 160) : 'not found in ip addr');
  const child = spawn(JV, ['ui', '--bind', BIND, '--port', '7071'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  let status = 0;
  for (let i = 0; i < 40 && !status; i++) {
    await sleep(500);
    status = await answers(URL);
  }
  if (!check(`jv ui --bind ${BIND} --port 7071 serves ${URL}`, status === 200, `pid ${child.pid}; /api/overview ${status || 'no answer'}; ${oneLine(out, 300)}`)) {
    child.kill('SIGTERM');
    return;
  }
  check('the tailnet viewer is not on loopback', (await answers('http://127.0.0.1:7071')) === 0, '127.0.0.1:7071 does not answer');

  // 3. the phone check
  const v = spawnSync(process.execPath, ['--no-warnings', join(HERE, 'viewer-check.mjs'), cust.id, '--url', URL, '--shots', SHOTS], {
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME, '.cache', 'ms-playwright') },
    timeout: 180_000,
  });
  const lines = (v.stdout ?? '').split('\n').filter(Boolean);
  for (const l of lines) {
    const m = /^(PASS|FAIL) ([^:]+)(?:: (.*))?$/.exec(l);
    if (m) check(`viewer-check at 390 px: ${m[2]}`, m[1] === 'PASS', m[3] ?? '');
  }
  const shot = lines.find((l) => l.startsWith('screenshot '));
  check('viewer-check.mjs ran to the end', v.status === 0 && !!shot, `exit ${v.status}; ${shot ?? oneLine(v.stderr, 300)}`);
  if (shot) J.note(`page screenshot at 390 px: ${shot.slice('screenshot '.length)}`);

  // 4. stop it
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
  if (child.exitCode === null) child.kill('SIGKILL');
  check('the tailnet viewer is stopped afterwards', (await answers(URL)) === 0, `exit ${child.exitCode ?? child.signalCode}; ${URL} answers nothing`);
}

await main();
J.finish();
