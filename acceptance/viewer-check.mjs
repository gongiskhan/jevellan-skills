#!/usr/bin/env node
// Viewer check (J5, J16): loads /task/<T> of jv ui at phone width (390 px) in headless Chromium and asserts that the
// page renders the task, that every report screenshot the task has under .jv-evidence/ is shown and loaded, and that
// nothing scrolls sideways.
//
//   node acceptance/viewer-check.mjs <task id> [--url http://ADDRESS:PORT] [--bind ADDRESS] [--shots DIR]
//
// Without --url it starts `$JV_HOME/bin/jv ui --port 0 --json` itself (with --bind when given, for the tailnet
// address of J16), reads the URL it prints, and stops that process at the end; it stops nothing else. Playwright is
// not a dependency of the package: it is loaded from JV_PLAYWRIGHT_DIR, the sandbox's node_modules, or a global npm
// folder, and the browsers from PLAYWRIGHT_BROWSERS_PATH (default ~/.cache/ms-playwright). The screenshot of the
// page goes to --shots (default: the system temporary folder) and its path is printed.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, stamp, summary } from './lib.mjs';
import { defaultBrowsersPath, loadPlaywright, startViewer, stopViewer } from './viewer-lib.mjs';

function parseArgs(argv) {
  const out = { task: undefined, url: undefined, bind: undefined, shots: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--bind') out.bind = argv[++i];
    else if (a === '--shots') out.shots = argv[++i];
    else if (!a.startsWith('--') && !out.task) out.task = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.task) throw new Error('usage: node acceptance/viewer-check.mjs <task id> [--url URL] [--bind ADDRESS] [--shots DIR]');
  return out;
}

function reportScreenshots(task) {
  const sessions = [...task.steps.flatMap((s) => s.sessions), ...task.otherSessions];
  return sessions.flatMap((s) => s.report?.screenshots ?? []);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  defaultBrowsersPath();
  let viewer;
  let browser;
  try {
    let url = args.url?.replace(/\/+$/, '');
    if (!url) {
      viewer = await startViewer(args.bind);
      url = viewer.url;
    }
    process.stdout.write(`viewer ${url}\n`);
    const r = await fetch(`${url}/api/task/${encodeURIComponent(args.task)}`);
    if (!check('the task exists in the viewer', r.status === 200, `GET /api/task/${args.task} answered ${r.status}`)) return summary();
    const task = await r.json();
    const shots = reportScreenshots(task);
    const served = shots.filter((s) => s.url);
    check('the task has screenshots under .jv-evidence/', served.length > 0, `${served.length} of ${shots.length} report screenshots are served`);
    for (const s of served) {
      const img = await fetch(`${url}${s.url}`);
      check(`image ${s.path} is served`, img.status === 200 && /^image\//.test(img.headers.get('content-type') ?? ''), `${img.status} ${img.headers.get('content-type')}`);
    }

    const { pw, dir } = loadPlaywright();
    process.stdout.write(`playwright ${dir}\n`);
    browser = await pw.chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    // Not networkidle: the page keeps its live stream (/api/live) open for as long as it is shown.
    await page.goto(`${url}/task/${encodeURIComponent(task.task.id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main .page-head h1', { timeout: 15_000 }).catch(() => undefined);
    await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r))))));
    const seen = await page.evaluate(() => ({
      h1: document.querySelector('main h1')?.textContent ?? '',
      steps: document.querySelectorAll('.timeline > li').length,
      images: [...document.querySelectorAll('.shot img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth })),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    check('the task page renders the task', seen.h1.includes(task.task.title), `heading "${seen.h1.trim()}"`);
    check('every step is on the timeline', seen.steps === task.steps.length, `${seen.steps} of ${task.steps.length}`);
    check('every served screenshot is on the page', seen.images.length === served.length, `${seen.images.length} images, ${served.length} expected`);
    check('every screenshot loaded', seen.images.length > 0 && seen.images.every((i) => i.w > 0), JSON.stringify(seen.images.map((i) => i.w)));
    check('no horizontal scroll at 390 px', seen.scrollWidth <= seen.innerWidth, `scrollWidth ${seen.scrollWidth}, width ${seen.innerWidth}`);
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    const shotsDir = args.shots ?? tmpdir();
    mkdirSync(shotsDir, { recursive: true });
    const file = join(shotsDir, `viewer-check-${task.task.id}-390-${stamp()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    process.stdout.write(`screenshot ${file}\n`);
  } catch (error) {
    check('the viewer check ran', false, error.message);
  } finally {
    await browser?.close().catch(() => undefined);
    await stopViewer(viewer?.child);
  }
  return summary();
}

process.exitCode = await main();
