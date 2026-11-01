#!/usr/bin/env node
// J1 Install (brief section 15; sections 2 and 11): `apm install gongiskhan/jevellan-skills --target claude` in the
// real sandbox checkout (APM fetches GitHub main), then the two side effects APM has on a consumer undone
// (docs/findings.md): the tracked .gitignore restored, and apm.yml, apm.lock.yaml and apm_modules/ listed once in the
// repository's .git/info/exclude, so the main checkout stays clean.
//
// Checks: the 14 jevellan-* skills under <sandbox>/.claude/skills/<name>/SKILL.md byte-identical to the package (the
// copy APM fetched, and this repository's .apm/ at the same commit), the agent at .claude/agents/jevellan-coordinator.md
// byte-identical to .apm/agents/jevellan-coordinator.agent.md, the jv Stop hook merged into .claude/settings.json,
// `jv doctor` run from the checkout with no FAIL and WARN only for providers without key files, and an empty
// `git status --porcelain`.
//
// Usage: node acceptance/j01-install.mjs [--tag T] [--skip-install]
//   --skip-install  check an existing install without running apm again
// Writes acceptance/results/J01.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, git, jvJson, SANDBOX } from './lib.mjs';
import { flag, journey } from './journey.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'gongiskhan/jevellan-skills';
const J = journey(1, 'Install');
const oneLine = (s, max = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: SANDBOX, timeout: 600_000, ...options });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Every file under dir, relative to dir (no symlinks followed). */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

const cmp = (a, b) => existsSync(a) && existsSync(b) && sh('cmp', ['-s', a, b]).status === 0;

// ---- before
const head = git(SANDBOX, ['rev-parse', 'HEAD']);
const before = git(SANDBOX, ['status', '--porcelain']);
const gitignoreBefore = readFileSync(join(SANDBOX, '.gitignore'), 'utf8');
const repoHead = git(REPO, ['rev-parse', 'HEAD']);
const remoteMain = (sh('git', ['ls-remote', `https://github.com/${PKG}`, 'main']).stdout.split(/\s+/)[0] ?? '').trim();
check('the package on GitHub main is this repository HEAD (so "the package" is one thing)', remoteMain === repoHead, `remote main ${remoteMain || '(none)'}; local HEAD ${repoHead}`);
check('the sandbox main checkout is clean before the install', before === '', before ? oneLine(before) : `HEAD ${head}`);

// ---- install
if (!flag('--skip-install')) {
  J.start('apmInstall');
  const apm = sh('apm', ['install', PKG, '--target', 'claude']);
  J.stop('apmInstall');
  check('apm install gongiskhan/jevellan-skills --target claude exits 0', apm.status === 0, `exit ${apm.status}; ${oneLine(apm.stdout.split('\n').filter((l) => /install|skill|agent|hook|integrat|deployed|added/i.test(l)).join(' | '), 600)}${apm.status ? `; stderr ${oneLine(apm.stderr)}` : ''}`);
  J.note(`apm install output (filtered): ${oneLine(apm.stdout.split('\n').filter((l) => l.trim()).slice(-25).join(' | '), 1500)}`);
}

// ---- what APM changed in the checkout, then undo the side effects
const afterInstall = git(SANDBOX, ['status', '--porcelain', '--untracked-files=all']);
const gitignoreAfter = readFileSync(join(SANDBOX, '.gitignore'), 'utf8');
J.note(`git status right after apm install: ${oneLine(afterInstall, 600) || '(clean)'}`);
if (gitignoreAfter !== gitignoreBefore) {
  const added = gitignoreAfter.split('\n').filter((l) => !gitignoreBefore.split('\n').includes(l) && l.trim());
  J.note(`apm install edited the tracked .gitignore, adding: ${added.join(', ')}`);
}
sh('git', ['-C', SANDBOX, 'checkout', '--', '.gitignore']);
const commonDir = sh('git', ['-C', SANDBOX, 'rev-parse', '--git-common-dir']).stdout.trim();
const excludeFile = join(commonDir.startsWith('/') ? commonDir : join(SANDBOX, commonDir), 'info', 'exclude');
const excludeLines = readFileSync(excludeFile, 'utf8').split('\n').map((l) => l.trim());
const wanted = ['apm.yml', 'apm.lock.yaml', 'apm_modules/'];
const missing = wanted.filter((w) => !excludeLines.includes(w) && !excludeLines.includes(`/${w}`));
if (missing.length) {
  const text = readFileSync(excludeFile, 'utf8');
  appendFileSync(excludeFile, `${text.endsWith('\n') ? '' : '\n'}# APM install of jevellan-skills (acceptance J1)\n${missing.join('\n')}\n`);
}
J.deviation(
  'After apm install the journey restores the tracked .gitignore (git checkout -- .gitignore) and lists apm.yml, apm.lock.yaml and apm_modules/ in .git/info/exclude (once). Reason: APM 0.24.0 always writes apm.yml and apm.lock.yaml at the consumer root and appends apm_modules/ to the tracked .gitignore (docs/findings.md); the owner rule is that nothing edits the main checkout except landing, so its status must stay empty.',
);
check('.gitignore restored and the APM files excluded once', readFileSync(join(SANDBOX, '.gitignore'), 'utf8') === gitignoreBefore && wanted.every((w) => readFileSync(excludeFile, 'utf8').split('\n').filter((l) => l.trim() === w).length === 1), `${excludeFile}: ${missing.length ? `added ${missing.join(', ')}` : 'already listed'}`);

// ---- skills
const fetched = join(SANDBOX, 'apm_modules', 'gongiskhan', 'jevellan-skills');
const fetchedSkills = join(fetched, '.apm', 'skills');
const repoSkills = join(REPO, '.apm', 'skills');
const pkgNames = readdirSync(repoSkills).filter((n) => n.startsWith('jevellan-')).sort();
const installedDir = join(SANDBOX, '.claude', 'skills');
const installedNames = existsSync(installedDir) ? readdirSync(installedDir).filter((n) => n.startsWith('jevellan-')).sort() : [];
check('14 jevellan-* skills in the package and 14 installed under .claude/skills', pkgNames.length === 14 && JSON.stringify(installedNames) === JSON.stringify(pkgNames), `package ${pkgNames.length}, installed ${installedNames.length}: ${installedNames.join(' ')}`);
const skillDiff = pkgNames.filter((n) => !cmp(join(installedDir, n, 'SKILL.md'), join(repoSkills, n, 'SKILL.md')) || !cmp(join(installedDir, n, 'SKILL.md'), join(fetchedSkills, n, 'SKILL.md')));
check('every installed SKILL.md is byte-identical to the package (cmp against the APM-fetched copy and this repository)', skillDiff.length === 0 && existsSync(fetchedSkills), skillDiff.length ? `differ: ${skillDiff.join(', ')}` : `14/14 identical; fetched copy ${fetched}`);
// Whole skill folders, not only SKILL.md: the router carries the runtime source.
const folderDiff = [];
let fileCount = 0;
for (const n of pkgNames) {
  // Tracked files only: a checkout also holds build output and node_modules that are not part of the package.
  const files = git(REPO, ['ls-files', '--', `.apm/skills/${n}`]).split('\n').filter(Boolean).map((f) => relative(join('.apm', 'skills', n), f));
  for (const f of files) {
    fileCount++;
    if (!cmp(join(installedDir, n, f), join(repoSkills, n, f))) folderDiff.push(`${n}/${f}`);
  }
}
check('every file of every skill folder is installed byte-identical (the router with its scripts/jv runtime source)', folderDiff.length === 0, folderDiff.length ? `${folderDiff.length} differ: ${folderDiff.slice(0, 10).join(', ')}` : `${fileCount} files identical`);

// ---- agent
const agent = join(SANDBOX, '.claude', 'agents', 'jevellan-coordinator.md');
check('the agent at .claude/agents/jevellan-coordinator.md, byte-identical to .apm/agents/jevellan-coordinator.agent.md', cmp(agent, join(REPO, '.apm', 'agents', 'jevellan-coordinator.agent.md')), existsSync(agent) ? `${agent} (${statSync(agent).size} bytes)` : `${agent} missing`);

// ---- hook
const settingsFile = join(SANDBOX, '.claude', 'settings.json');
let stopHooks = [];
try {
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  stopHooks = (settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []);
} catch (e) {
  stopHooks = [];
}
const pkgHook = JSON.parse(readFileSync(join(REPO, '.apm', 'hooks', 'jevellan.json'), 'utf8'));
const pkgCommands = (pkgHook.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
check('the jv Stop hook is merged into .claude/settings.json', stopHooks.some((h) => h.type === 'command' && /report-guard\.mjs/.test(h.command ?? '') && pkgCommands.includes(h.command)), stopHooks.map((h) => h.command).join(' ; ') || `no Stop hook in ${settingsFile}`);

// ---- doctor
J.start('doctor');
const doc = jvJson(['doctor'], { cwd: SANDBOX, timeoutMs: 300_000 });
J.stop('doctor');
const lines = doc.json?.checks ?? [];
const fails = lines.filter((l) => l.status === 'FAIL');
const warns = lines.filter((l) => l.status === 'WARN');
const badWarns = warns.filter((l) => !(/^(key|login):/.test(l.name) && /key file missing/.test(l.detail)));
check('jv doctor (run from the checkout) has no FAIL', doc.json && fails.length === 0, `${lines.length} lines: ${lines.filter((l) => l.status === 'OK').length} OK, ${warns.length} WARN, ${fails.length} FAIL${fails.length ? `: ${fails.map((l) => `${l.name} ${oneLine(l.detail, 160)}`).join('; ')}` : ''}; exit ${doc.status}`);
check('jv doctor WARNs only for providers without key files', badWarns.length === 0, warns.map((l) => `${l.name}: ${oneLine(l.detail, 90)}`).join('; ') || 'no WARN');
const hookLine = lines.find((l) => l.name === 'hook');
check('doctor: the hook line is OK for the checkout', hookLine?.status === 'OK', `${hookLine?.status} ${oneLine(hookLine?.detail, 200)}`);
const copies = lines.find((l) => l.name === 'skill-copies:project');
check("doctor: the project's installed skill copies match ~/.jv/skills", copies?.status === 'OK', `${copies?.status} ${oneLine(copies?.detail, 200)}`);

// ---- clean checkout
const after = git(SANDBOX, ['status', '--porcelain']);
check('git status --porcelain of the sandbox is empty', after === '' && git(SANDBOX, ['rev-parse', 'HEAD']) === head, after ? oneLine(after) : `clean; HEAD ${head} unchanged`);

// ---- what APM wrote (for docs/findings.md)
const written = [
  ...walk(join(SANDBOX, '.claude')).map((f) => `.claude/${f}`),
  ...['apm.yml', 'apm.lock.yaml'].filter((f) => existsSync(join(SANDBOX, f))),
  ...(existsSync(fetched) ? ['apm_modules/gongiskhan/jevellan-skills/'] : []),
];
const top = [...new Set(written.map((f) => f.split('/').slice(0, f.startsWith('.claude/skills/') ? 3 : 4).join('/')))];
J.set('pathsWritten', top.join(', '));
J.set('filesUnderClaude', written.filter((f) => f.startsWith('.claude/')).length);
J.note(`APM wrote under ${SANDBOX}: ${top.join(', ')}`);
J.finish();
