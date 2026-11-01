#!/usr/bin/env node
// J17 No leaks (brief section 15; the secrets rule of AGENTS.md and D-014): the contents of every key file under
// $JV_HOME/secrets, and every token value of 20 or more characters in the provider homes' .credentials.json and
// auth.json, appear nowhere in the store (store.sqlite and its -wal and -shm), $JV_HOME/logs, any .jv-evidence folder
// under $JV_HOME/worktrees and $JV_HOME/archive, $JV_HOME/projects and providers.json, this repository, and the
// acceptance outputs (acceptance/results, acceptance/RESULTS.md and every --extra PATH, such as the journeys' run
// logs). The Anthropic auth token variable name appears nowhere in those places either, except in this
// repository's code that sets it for endpoint providers (named below; a repository whose code names the variable
// cannot be free of it, so those files are allowed by exact path and any other file is a failure).
//
// The values are fed to `grep -r -a -l -F -f -` on stdin and never printed, written or put on a command line; the
// journey records only the file names that matched and, for credentials, the JSON key path a value came from.
// `grep -r` does not follow symbolic links below the folders it is given, so the homes' .jv links are not walked.
//
// --final first stops the coordinator (`jv coordinator stop --project jevellan-live-sandbox`) and checks the state
// the run leaves: no jv ui, jv run or jv exec process and no jv-R<6>, jv-coord-* or jv-login-* tmux session; the
// tmux sessions jv does not own still there; `jv status --json` with no running work; the sandbox's main checkout
// clean on main and holding every change landed into it. The leak search then runs over the final store and logs.
//
// It creates no task, so --tag is recorded only.
//
// Usage: node acceptance/j17-no-leaks.mjs [--tag T] [--final] [--extra PATH]...
// Writes acceptance/results/J17.json and rebuilds acceptance/RESULTS.md. Exit 0 pass, 1 fail.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, checkoutState, JV_HOME, jvJson, onBranch, query, SANDBOX, SANDBOX_MAIN, SANDBOX_NAME, secretFiles, sleep } from './lib.mjs';
import { flag, journey } from './journey.mjs';

const J = journey(17, 'No leaks');
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VAR = ['ANTHROPIC', 'AUTH', 'TOKEN'].join('_'); // built here so this file does not name it
const oneLine = (s, max = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};
const extras = process.argv.flatMap((a, i) => (a === '--extra' && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const tmuxSessions = () => {
  const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
};
const OURS = (name) => /^jv-R[0-9A-HJKMNP-TV-Z]{6}$/.test(name) || name.startsWith('jv-coord-') || name.startsWith('jv-login-');

// ---- final state (--final) ----------------------------------------------------------------------------------------

if (flag('--final')) {
  const before = tmuxSessions();
  const notOurs = before.filter((n) => !OURS(n));
  const stop = jvJson(['coordinator', 'stop', '--project', SANDBOX_NAME], { timeoutMs: 120_000 });
  check('final state: jv coordinator stop --project jevellan-live-sandbox', stop.status === 0, `exit ${stop.status}; ${oneLine(stop.json ? `stopped ${stop.json.stopped}: ${stop.json.reason}` : stop.stderr)}`);
  let after = tmuxSessions();
  for (let i = 0; i < 20 && after.some(OURS); i++) {
    await sleep(500);
    after = tmuxSessions();
  }
  check('final state: no jv-R<6>, jv-coord-* or jv-login-* tmux session is left', !after.some(OURS), `before: ${before.join(', ') || 'none'}; after: ${after.join(', ') || 'none'}`);
  const missing = notOurs.filter((n) => !after.includes(n));
  check('final state: the tmux sessions jv does not own are untouched', missing.length === 0, `still there: ${notOurs.join(', ') || 'none'}${missing.length ? `; gone: ${missing.join(', ')}` : ''}`);
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  const procs = ps
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /(\/bin\/jv|jv\.mjs|dist\/cli\.js)\s+(ui|run|exec)\b/.test(l) && !l.startsWith(`${process.pid} `));
  check('final state: no jv ui, jv run or jv exec process is left', procs.length === 0, procs.length ? procs.map((l) => oneLine(l, 120)).join(' / ') : 'none in ps');

  const st = jvJson(['status']);
  const tasks = st.json?.tasks ?? [];
  const sessions = st.json?.sessions ?? [];
  const runningTasks = tasks.filter((t) => ['queued', 'running', 'waiting-owner', 'landing'].includes(t.state));
  const liveRows = query("SELECT id, kind, state FROM sessions WHERE state IN ('queued', 'starting', 'running', 'waiting')");
  check(
    'final state: jv status --json shows no running work (and the store has no live session)',
    st.status === 0 && runningTasks.length === 0 && liveRows.length === 0,
    `${tasks.length} tasks not done: ${tasks.map((t) => `${t.id} ${t.state}`).join(', ') || 'none'}; ${sessions.length} sessions listed; live session rows: ${liveRows.map((s) => `${s.id} ${s.kind} ${s.state}`).join(', ') || 'none'}`,
  );
  const stopped = tasks.filter((t) => t.state === 'stopped');
  if (stopped.length) J.note(`jv status --json still lists ${stopped.length} stopped task(s) (${stopped.map((t) => t.id).join(', ')}) among the tasks not done; they run nothing (docs/findings.md, 2026-11-01 J4/J5/J16 section).`);

  const co = checkoutState(SANDBOX);
  check('final state: the sandbox main checkout is clean on main', co.branch === 'main' && co.status === '', `branch ${co.branch}, HEAD ${co.head.slice(0, 7)}, git status --porcelain ${co.status === '' ? 'empty' : oneLine(co.status, 200)}`);
  const landed = query(
    "SELECT l.task_id, l.commit_sha, l.reason, t.title FROM landings l JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id WHERE l.state = 'landed' AND p.name = ? ORDER BY l.created_at",
    SANDBOX_NAME,
  );
  const onMain = landed.filter((l) => l.commit_sha && onBranch(SANDBOX, l.commit_sha, 'main'));
  const j4 = existsSync(join(REPO, 'acceptance', 'results', 'J04-state-j4c.json')) ? JSON.parse(readFileSync(join(REPO, 'acceptance', 'results', 'J04-state-j4c.json'), 'utf8')).tasks ?? [] : [];
  const j4Landed = j4.filter((id) => onMain.some((l) => l.task_id === id));
  check(
    'final state: main holds every change landed into the sandbox, the three J4 changes among them',
    landed.length > 0 && onMain.length === landed.length && j4.length === 3 && j4Landed.length === 3 && onBranch(SANDBOX, SANDBOX_MAIN, 'main'),
    `${onMain.length}/${landed.length} landed commits are on main (${landed.map((l) => `${l.task_id} ${l.commit_sha?.slice(0, 7)}`).join(', ')}); J4: ${j4Landed.join(', ')}; main descends from ${SANDBOX_MAIN.slice(0, 7)}`,
  );
  const log = spawnSync('git', ['-C', SANDBOX, 'log', '--first-parent', '--format=%h %s', `${SANDBOX_MAIN}..main`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  J.set('sandboxMainFirstParent', `${log.length} commits since ${SANDBOX_MAIN.slice(0, 7)}: ${log.join(' / ')}`);
}

// ---- what is searched ---------------------------------------------------------------------------------------------

/** Folders named .jv-evidence under root, without walking node_modules or .git. */
function evidenceFolders(root) {
  if (!existsSync(root)) return [];
  const r = spawnSync('find', [root, '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o', '-type', 'd', '-name', '.jv-evidence', '-print'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '').split('\n').filter(Boolean);
}

const store = ['store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm'].map((n) => join(JV_HOME, n)).filter((f) => existsSync(f));
const evidence = [...evidenceFolders(join(JV_HOME, 'worktrees')), ...evidenceFolders(join(JV_HOME, 'archive'))];
const TARGETS = [
  { name: 'store', paths: store },
  { name: 'logs', paths: [join(JV_HOME, 'logs')] },
  { name: 'evidence', paths: evidence },
  { name: 'jv config', paths: [join(JV_HOME, 'projects'), join(JV_HOME, 'providers.json')] },
  { name: 'repository', paths: [REPO] },
  { name: 'acceptance outputs', paths: [join(REPO, 'acceptance', 'results'), join(REPO, 'acceptance', 'RESULTS.md'), ...extras] },
].map((t) => ({ ...t, paths: t.paths.filter((p) => existsSync(p)) }));

function fileCount(paths) {
  let n = 0;
  for (const p of paths) {
    if (statSync(p).isFile()) n++;
    else n += Number(spawnSync('sh', ['-c', 'find "$1" -type f | wc -l', 'sh', p], { encoding: 'utf8' }).stdout.trim() || 0);
  }
  return n;
}

/** grep -r -a -l -F -f - over paths; patterns on stdin. Returns {files, errors}. */
function grepFiles(patterns, paths) {
  if (!patterns.length || !paths.length) return { files: [], errors: [] };
  const r = spawnSync('grep', ['-r', '-a', '-l', '-F', '-f', '-', '--', ...paths], { input: `${patterns.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = (r.stdout ?? '').split('\n').filter(Boolean);
  const errors = r.status === 0 || r.status === 1 ? [] : (r.stderr ?? '').split('\n').filter(Boolean).map((l) => oneLine(l, 200));
  return { files, errors };
}

// ---- the secret values --------------------------------------------------------------------------------------------

/** A key file's patterns: lines of 6 or more characters and the value of NAME=value lines (lib.mjs, D-014). */
function keyFilePatterns(file) {
  const out = new Set();
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length >= 6) out.add(line);
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(line);
    if (m && m[1].trim().length >= 6) out.add(m[1].trim());
  }
  return [...out];
}

/** The credential files of the provider homes (two levels down, links not followed). */
function credentialFiles() {
  const homes = join(JV_HOME, 'homes');
  if (!existsSync(homes)) return [];
  const r = spawnSync('find', [homes, '-maxdepth', '3', '-type', 'f', '(', '-name', '.credentials.json', '-o', '-name', 'auth.json', ')'], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').filter(Boolean).sort();
}

/** String values of 20 or more characters (not timestamps, not URLs) with their key paths. */
function tokenValues(file) {
  const values = [];
  const keys = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      if (v.length >= 20 && !/^\d{4}-\d{2}-\d{2}T/.test(v) && !/^https?:\/\//.test(v)) {
        values.push(v);
        keys.push(path);
      }
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  try {
    walk(JSON.parse(readFileSync(file, 'utf8')), '$');
  } catch {
    return { values: [], keys: [], unreadable: true };
  }
  return { values, keys };
}

const groups = [];
for (const f of secretFiles()) groups.push({ label: `secrets/${relative(join(JV_HOME, 'secrets'), f)}`, patterns: keyFilePatterns(f) });
for (const f of credentialFiles()) {
  const t = tokenValues(f);
  groups.push({ label: `${relative(JV_HOME, f)} (${t.keys.join(', ') || 'no values'})`, patterns: t.values, unreadable: t.unreadable });
}
check(
  'the secret values to search for were read (every key file and every credentials file of the provider homes)',
  groups.length >= 1 && groups.every((g) => g.patterns.length > 0 && !g.unreadable),
  groups.map((g) => `${g.label}: ${g.patterns.length} value${g.patterns.length === 1 ? '' : 's'}`).join('; '),
);

// ---- the search ---------------------------------------------------------------------------------------------------

// Positive controls: the same search finds a task id in the binary store and a line of this script in the
// repository, so "no match" below means the values are absent, not that the search read nothing.
const someTask = query('SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1')[0]?.id;
const inStore = someTask ? grepFiles([someTask], store) : { files: [] };
const inRepo = grepFiles(['// J17 No leaks (brief section 15'], [REPO]);
check(
  'the search finds what is there (a task id in the store, a line of this script in the repository)',
  inStore.files.length > 0 && inRepo.files.some((f) => f.endsWith('acceptance/j17-no-leaks.mjs')),
  `task ${someTask} in ${inStore.files.map((f) => relative(JV_HOME, f)).join(', ') || 'nothing'}; the script line in ${inRepo.files.map((f) => relative(REPO, f)).join(', ') || 'nothing'}`,
);

const searched = TARGETS.map((t) => `${t.name} ${fileCount(t.paths)} files`).join(', ');
J.set('searched', searched);
J.set('storeFiles', store.map((f) => relative(JV_HOME, f)).join(', '));
J.set('evidenceFolders', String(evidence.length));
J.start('grep');
for (const t of TARGETS) {
  const hits = [];
  const errors = [];
  for (const g of groups) {
    const r = grepFiles(g.patterns, t.paths);
    for (const f of r.files) hits.push(`${g.label} in ${f}`);
    errors.push(...r.errors);
  }
  const named = (p) => (p === REPO || p.startsWith(`${REPO}/`) ? relative(REPO, p) || 'the repository' : p.startsWith(`${JV_HOME}/`) ? `$JV_HOME/${relative(JV_HOME, p)}` : undefined);
  const shown =
    t.name === 'evidence'
      ? `${t.paths.length} .jv-evidence folders`
      : [...t.paths.map(named).filter(Boolean), ...(t.paths.some((p) => !named(p)) ? [`${t.paths.filter((p) => !named(p)).length} --extra paths`] : [])].join(', ');
  check(`no key file or credential value in the ${t.name}`, t.paths.length > 0 && hits.length === 0 && errors.length === 0, `${hits.length ? `MATCHED (file names only): ${hits.join('; ')}` : 'no match'}; ${fileCount(t.paths)} files under ${shown}${errors.length ? `; grep errors: ${errors.slice(0, 5).join(' / ')}` : ''}`);
}

// The variable name: none outside the repository's code that sets it.
const ALLOWED = [
  /^README\.md$/,
  /^\.apm\/skills\/jevellan-router\/scripts\/jv\/(src|test)\/[a-z-]+(\.test)?\.ts$/,
  /^\.apm\/skills\/jevellan-router\/scripts\/jv\/(dist|dist-test)\/.+\.js$/,
  /^\.apm\/skills\/jevellan-router\/scripts\/jv\/node_modules\/@anthropic-ai\//,
  /^\.codegraph\//,
];
for (const t of TARGETS) {
  const r = grepFiles([VAR], t.paths);
  if (t.name === 'repository') {
    const rel = r.files.map((f) => relative(REPO, f));
    const allowed = rel.filter((f) => ALLOWED.some((re) => re.test(f)));
    const other = rel.filter((f) => !ALLOWED.some((re) => re.test(f)));
    check(
      'the Anthropic auth token variable name appears in the repository only in the code that sets it',
      other.length === 0 && r.errors.length === 0,
      `${other.length ? `ELSEWHERE: ${other.join(', ')}; ` : ''}${allowed.length} allowed files: ${allowed.filter((f) => !/node_modules|dist|\.codegraph/.test(f)).join(', ')}, plus their compiled copies in dist/ and dist-test/, the agent SDK in node_modules/@anthropic-ai and the CodeGraph index`,
    );
  } else {
    check(`the Anthropic auth token variable name appears nowhere in the ${t.name}`, t.paths.length > 0 && r.files.length === 0 && r.errors.length === 0, `${r.files.length ? `MATCHED: ${r.files.join(', ')}` : 'no match'}${r.errors.length ? `; grep errors: ${r.errors.slice(0, 5).join(' / ')}` : ''}`);
  }
}
J.stop('grep');

J.deviation(
  'The repository necessarily names the Anthropic auth token variable: src/providers.ts sets it for endpoint providers, src/env.ts documents it, three test files assert on it, README.md documents it, and the build, the agent SDK in node_modules and the CodeGraph index repeat it. Those files are allowed by exact path; any other file in the repository, and any match in the store, logs, evidence, jv config or acceptance outputs, fails the journey.',
);
J.finish();
