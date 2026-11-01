#!/usr/bin/env node
// Phase 8 viewer pass (section 10): loads every page of jv ui that one task touches (/, /task/T, /session/R for each
// of its sessions, /decisions, /usage) in headless Chromium at 1280 and 390 px, light and dark, saves a full-page
// screenshot of each as e2e-<page>-<width>-<scheme>.png and asserts, per page, width and scheme:
//   - the page rendered (a heading in main) with no page error, console error, failed request or HTTP error;
//   - nothing scrolls sideways;
//   - every image on the page loaded;
//   - the colour scheme took effect (dark page background under dark, light under light);
//   - on session pages, every collapsed tool row has a name and a first line.
//
//   node acceptance/phase8-viewer.mjs <task id> [--url http://127.0.0.1:7071] [--shots DIR] [--widths 1280,390]
//                                     [--schemes light,dark]
//
// Without --url it starts `$JV_HOME/bin/jv ui --port 0 --json` itself and stops that process at the end; it stops
// nothing else. The screenshots are for a person to read; the assertions only catch what a script can see.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, summary } from './lib.mjs';
import { defaultBrowsersPath, loadPlaywright, startViewer, stopViewer } from './viewer-lib.mjs';

function parseArgs(argv) {
  const out = { task: undefined, url: undefined, shots: undefined, widths: [1280, 390], schemes: ['light', 'dark'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--shots') out.shots = argv[++i];
    else if (a === '--widths') out.widths = argv[++i].split(',').map(Number);
    else if (a === '--schemes') out.schemes = argv[++i].split(',');
    else if (!a.startsWith('--') && !out.task) out.task = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.task) throw new Error('usage: node acceptance/phase8-viewer.mjs <task id> [--url URL] [--shots DIR] [--widths 1280,390] [--schemes light,dark]');
  return out;
}

/** Relative luminance of a CSS rgb() colour, 0 (black) to 1 (white). */
function luminance(rgb) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(rgb);
  if (!m) return NaN;
  const [r, g, b] = m.slice(1, 4).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function visit(context, url, file, isSession) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    // The live stream is cut when the page closes; that is not a failure of the page.
    if (!r.url().endsWith('/api/live')) errors.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  // Not networkidle: the page keeps its live stream (/api/live) open for as long as it is shown.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main h1', { timeout: 15_000 }).catch(() => errors.push('no heading in main within 15 s'));
  await page.waitForTimeout(500);
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r))))));
  const seen = await page.evaluate(() => ({
    h1: document.querySelector('main h1')?.textContent?.trim() ?? '',
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    images: [...document.images].map((i) => i.naturalWidth),
    background: getComputedStyle(document.body).backgroundColor,
    blankTools: [...document.querySelectorAll('details.tool > summary')].filter(
      (s) => !s.querySelector('.tname')?.textContent?.trim() || !s.querySelector('.first')?.textContent?.trim(),
    ).length,
  }));
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return { ...seen, errors, isSession };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  defaultBrowsersPath();
  let viewer;
  let browser;
  try {
    let url = args.url?.replace(/\/+$/, '');
    if (!url) {
      viewer = await startViewer();
      url = viewer.url;
    }
    process.stdout.write(`viewer ${url}\n`);
    const r = await fetch(`${url}/api/task/${encodeURIComponent(args.task)}`);
    if (!check('the task exists in the viewer', r.status === 200, `GET /api/task/${args.task} answered ${r.status}`)) return summary();
    const task = await r.json();
    const sessions = [...task.steps.flatMap((s) => s.sessions), ...task.otherSessions].map((s) => s.id);
    const pages = [
      ['overview', '/'],
      ['task', `/task/${task.task.id}`],
      ...sessions.map((id) => [`session-${id}`, `/session/${id}`]),
      ['decisions', '/decisions'],
      ['usage', '/usage'],
    ];
    const shotsDir = args.shots ?? join(tmpdir(), 'jv-viewer-shots');
    mkdirSync(shotsDir, { recursive: true });
    const { pw, dir } = loadPlaywright();
    process.stdout.write(`playwright ${dir}\nscreenshots ${shotsDir}\n`);
    browser = await pw.chromium.launch();
    for (const scheme of args.schemes) {
      for (const width of args.widths) {
        const phone = width < 600;
        const context = await browser.newContext({
          viewport: { width, height: phone ? 844 : 900 },
          deviceScaleFactor: phone ? 2 : 1,
          isMobile: phone,
          hasTouch: phone,
          colorScheme: scheme,
        });
        for (const [name, path] of pages) {
          const file = join(shotsDir, `e2e-${name}-${width}-${scheme}.png`);
          const v = await visit(context, `${url}${path}`, file, name.startsWith('session-'));
          const at = `${path} ${width} px ${scheme}`;
          check(`${at}: renders`, v.h1 !== '' && v.errors.length === 0, v.errors.length ? v.errors.slice(0, 3).join(' | ') : `heading "${v.h1.slice(0, 60)}"`);
          check(`${at}: no horizontal scroll`, v.scrollWidth <= v.innerWidth, `scrollWidth ${v.scrollWidth}, width ${v.innerWidth}`);
          check(`${at}: images load`, v.images.every((w) => w > 0), `${v.images.filter((w) => w > 0).length} of ${v.images.length} loaded`);
          const lum = luminance(v.background);
          check(`${at}: ${scheme} scheme applied`, scheme === 'dark' ? lum < 0.1 : lum > 0.6, `body background ${v.background}`);
          if (v.isSession) check(`${at}: every tool row has a name and a first line`, v.blankTools === 0, `${v.blankTools} blank`);
        }
        await context.close();
      }
    }
  } catch (error) {
    check('the viewer pass ran', false, error.message);
  } finally {
    await browser?.close().catch(() => undefined);
    await stopViewer(viewer?.child);
  }
  return summary();
}

process.exitCode = await main();
