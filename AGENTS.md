# Working in jevellan-skills

This repository is an APM package of skills plus one small runtime, the `jv` command. What the system does and how it
is installed and configured is in `README.md`. Every choice made while building it is recorded in
`docs/decisions.md` (D-numbers, append-only: a later decision amends an earlier one by number, it never edits it),
and every verified fact about tool flags, APM and the SDKs in `docs/findings.md` (dated entries, append-only, each
saying how it was checked). Read both before changing behaviour they describe, and add to them when you decide or
verify something new.

## Rules that bind every file

- No AI attribution anywhere: no `Co-Authored-By`, no `Claude-Session`, no "Generated with", no model named as an
  author in commit messages, authored text or generated reports. Commits use the machine's git identity.
- No tracked `CLAUDE.md` and no tracked `.claude/` directory, here or in any project the system touches; both are
  gitignored. Agent instructions live in `AGENTS.md`.
- Never touch production, never deploy, never stop or delete the owner's processes or data. Archive, never delete.
- Secrets never appear in logs, events, reports, the store, test fixtures or command lines. Provider keys live only in
  the files `providers.json` points at (`~/.jv/secrets/*`, mode 600). Tests use made-up values.
- Plain dash "-", never the em dash, in every file.
- No skill body contains a secret, a path on someone's machine, or a model id that the providers.json template does
  not also list.
- Other software may run on the same machine, Jevellan in particular. Never stop its services or tmux sessions and
  never write into its folders (`~/.jevellan*`; jv only reads a login from them, through `seeds.json`). jv's tmux names
  are exactly `jv-R<6>` (runs), `jv-coord-<project>` (coordinators) and `jv-login-<provider>` (sign-ins), and jv only
  ever kills a tmux session it can prove is its own.

## Node

Node 22.13 or later is required (`node:sqlite`). Where the default `node` is older, put a Node 22 first on PATH at
the start of every shell command, for example `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`;
`bin/jv.mjs` refuses an older Node and names an installed nvm Node 22 when it finds one. The installed `~/.jv/bin/jv`
is a `sh` shim that execs the Node binary recorded at bootstrap with `--disable-warning=ExperimentalWarning`, so the
SQLite warning never reaches stderr.

## Layout

```
apm.yml                                 APM package (targets: [claude])
package.json                            root pointer: "bin": {"jv": ".apm/skills/jevellan-router/scripts/jv/bin/jv.mjs"}, no dependencies
README.md, AGENTS.md, CHANGELOG.md, LICENSE
docs/decisions.md, docs/findings.md
.apm/agents/jevellan-coordinator.agent.md   the coordinator body as an agent file (the launcher uses the skill, D-052)
.apm/hooks/jevellan.json                the Stop hook (report guard) for APM installs
.apm/skills/
  jevellan-router/                      placement policy SKILL.md, evals/ (cases.json, run.mjs, threshold.json, RESULTS.md)
    scripts/jv/                         the runtime (the only copy of its source)
  jevellan-landing/                     landing policy SKILL.md and evals/, same shape as the router's
  jevellan-coordinator/                 coordinator system prompt and its Skillio output cases
  jevellan-duty-{answer,converse,investigate,plan,implement,document,verify,automate}/   duty bodies, jv-needs in frontmatter
  jevellan-workflow-{feature,bug,automation}/   checklist SKILL.md, workflow.json, Skillio trigger cases
acceptance/                             acceptance scripts against a real sandbox project (see below)
```

The runtime, `.apm/skills/jevellan-router/scripts/jv/`:

```
package.json, package-lock.json   deps: @anthropic-ai/claude-agent-sdk, @openai/codex-sdk, zod; dev: typescript, @types/node (22.x, D-020)
tsconfig.json                     src/ -> dist/ (NodeNext, ES2023, strict)
tsconfig.test.json                src/ + test/ -> dist-test/
bin/jv.mjs                        plain JS entry: Node version check, first-use bootstrap, then dist/cli.js
bin/bootstrap.mjs                 plain JS bootstrap and update (versioned runtimes and skill sets behind links, D-021)
templates/                        providers.json, project.json, landing.json, worker-rules.md
ui/                               the viewer page: index.html, app.js, app.css, format.js, markdown.js, favicon.svg (served as they are)
test/*.test.ts, test/fixtures/    node:test suites and their helpers (fake runtime, run, coordinator and viewer fixtures)
src/
  cli.ts                 argument parsing, the command table, output and exit codes
  command.ts             the contract between the CLI and command modules, and flag helpers
  commands/attach.ts     jv attach: attaches in a terminal, otherwise prints the command
  commands/bootstrap.ts  jv bootstrap and jv update when reached through the CLI
  commands/coordinator.ts  jv coordinator start|stop|restart|status
  commands/doctor.ts     jv doctor [--check NAME]
  commands/evals.ts      jv evals route|landing: export decisions into a policy's cases.json
  commands/exec.ts       jv exec (internal)
  commands/gc.ts         jv gc [--project N] [--dry-run]
  commands/handoff.ts    jv handoff
  commands/land.ts       jv land [--force] and its exit codes
  commands/notes.ts      jv notes write|show
  commands/project.ts    jv project add|list
  commands/providers.ts  jv providers check (probes, usage rows, model list fill) and jv providers login
  commands/report.ts     jv report
  commands/run.ts        jv run (internal): the detached process of one run
  commands/status.ts     jv status
  commands/tail.ts       jv tail [--follow]
  commands/task.ts       jv task create|show|message|answer|stop|resume|override
  commands/ui.ts         jv ui [--port] [--bind]
  commands/usage.ts      jv usage [--week]
  commands/version.ts    jv --version
  advance.ts             what happens when a run ends: next step, onFail retries, waiting-owner, automatic landing
  attach.ts              owner takeover: tmux attach, or a `claude --resume` / `codex resume` window
  claude-control.ts      supportedModels() probe of a Claude login
  codex-control.ts       `codex app-server` over stdio JSON-RPC: account, rate limits, model list
  coordinator.ts         the coordinator tmux session: start, stop, restart, status, Remote Control, first-run dialogs
  doctor.ts              the preflights; runChecks(names) for jv task create
  env.ts                 the minimal worker environment
  errors.ts              JvError and the exit codes
  evals.ts               eval case export and the policy replay behind evals/run.mjs
  events.ts              recordEvent, the one write path for events
  exec.ts                runs one command under a provider's environment, secrets in the environment only
  gc.ts                  archives worktrees of finished tasks
  git.ts                 task worktrees and the worktree setup command
  handoff.ts             the handoff from the store plus notes.md
  ids.ts                 ids: a letter plus 6 Crockford base32 characters
  jev/client.ts          the Jev HTTP client; the key is read at each call
  jev/contract.ts        Jev request and response schemas and error kinds
  land-git.ts            git of landing and gc: changed files, merge, fast-forward or ref update, push, worktree moves
  land.ts                jv land: refusals, landing state, the Jev decision, routes, checks, landings rows
  launcher.ts            run rows, detached `jv run` processes, alive or lost, stop
  notes.ts               notes.md writes: atomic, archived, redacted, capped
  paths.ts               every jv path, from JV_HOME
  policy.ts              parses and hashes policy skills (level-2 sections)
  project.ts             project add and list: default branch, .git/info/exclude, command detection
  prompt.ts              what a worker receives: worker rules, duty body, AGENTS.md, task block
  providers.ts           providers.json schema, key files, provider environments, eligibility and ranking
  redact.ts              the redactor of every known secret
  report-guard.mts       the Stop hook (compiled to dist/report-guard.mjs)
  report-mcp.ts          jv-report-mcp, the stdio MCP server of the report tool
  report.ts              the report contract, its validation and its one write path
  route.ts               the router: menu, state, Jev questions, resolution, owner rules, workflow questions, decision rows
  run.ts                 one run (one turn) from start to end, then advancing
  runtimes/index.ts      picks the runtime module by the session's runtime
  runtimes/types.ts      the runtime module contract: start, resume, stop, tail
  runtimes/claude-sdk.ts   Claude Code through the agent SDK's query()
  runtimes/claude-tmux.ts  interactive Claude Code in tmux, events from the native transcript
  runtimes/codex.ts      Codex through @openai/codex-sdk
  runtimes/llm.ts        one-answer calls: SDK with no tools, or chat/completions
  seeds.ts               seed(): providers.json, provider homes, seeds, hooks, skills, .jv links
  status.ts              jv status: what is not done, waiting-on-owner first, lost runs marked at read time
  store.ts               the SQLite store: schema, pragmas, transactions, request ids
  tasks.ts               task create, show, message, answer, stop, resume, override
  transcript.ts          native transcript parsers (Claude and Codex) and the turn tracker
  types.ts               store row interfaces (column names exactly)
  ui/db.ts               the viewer's read-only store connection
  ui/evidence.ts         report screenshots from .jv-evidence/ and nowhere else
  ui/server.ts           the viewer's HTTP server: pages, JSON endpoints, live updates, host guard, headers
  ui/views.ts            what each viewer page shows
  usage.ts               provider usage by ISO week
  wake.ts                [jv] wake lines into the coordinator's window
  workflows.ts           workflow resolution and validation
```

Root `package.json` is a thin pointer into the runtime: `npm install -g github:gongiskhan/jevellan-skills` and APM
both end in the same `bin/jv.mjs`, which bootstraps `~/.jv/runtime/` from the folder it lives in. `~/.jv/runtime` and
`~/.jv/skills` are symlinks to versioned folders under `~/.jv/runtimes/` and `~/.jv/skill-sets/`, switched atomically
by each bootstrap (D-021).

## Runtime conventions

- ESM, `import ... from './x.js'` with explicit `.js` extensions. No dependencies beyond the three allowed;
  everything else is Node built-ins (`node:sqlite`, `node:http`, `node:child_process`, `node:fs`, `node:crypto`).
- `JV_HOME` (default `~/.jv`) is resolved once in `src/paths.ts`; nothing else reads `os.homedir()` for jv paths.
- Store: `src/store.ts` owns the schema verbatim, the pragmas (WAL, `busy_timeout` 5000, `synchronous=NORMAL`,
  `foreign_keys=ON`), the schema version in `meta.schema_version`, short write transactions (`BEGIN IMMEDIATE`), and
  the `request_id` rule (same id and same input returns the row, different input exits 4). Nothing is ever deleted
  from the store.
- Ids: one letter prefix plus 6 characters of Crockford base32 upper case (`T` tasks, `S` steps, `R` runs, `D`
  decisions, `L` landings, `M` messages, `P` projects, `E` reports). The task short id in branch names is the 6
  characters lower case.
- Errors: throw `JvError(message, exitCode)`; the CLI prints the message (or `{"error": ...}` with `--json`) and exits
  2 refused, 3 not found, 4 conflict. Every command accepts `--json`.
- Times are ISO 8601 UTC strings (`new Date().toISOString()`).
- Every state change writes a short human `state_reason`.
- Placement has one code path, `src/route.ts`, and no fallback: no Jev answer, no placement, and no default model
  anywhere in the runtime.
- Provider homes: `~/.jv/homes/<provider>/` is the `HOME` of that provider's sessions; Claude's config dir is
  therefore `<home>/.claude/` (settings.json with the jv Stop hook, transcripts under `projects/`) and its global
  config `<home>/.claude.json`; Codex uses `CODEX_HOME=<home>/.codex`. `CLAUDE_CONFIG_DIR` is never set.
- Claude subscription logins come from `tokenFile` (`CLAUDE_CODE_OAUTH_TOKEN`) when providers.json names one, else
  from the home's own `.credentials.json`.
- Secrets are read from key files at the moment of use and passed only through child process environments, never
  through argv, never written to logs; the redactor masks every loaded secret in text that is stored.
- Worker processes are spawned detached (`setsid`) in their own process group, stdout and stderr to
  `~/.jv/logs/<session-id>.log`.
- Config files (providers.json, project files, workflows, rules.json, landing.json) are validated strictly: unknown
  keys are refused with exit 2 naming the key.
- Every module starts with a header comment saying what it does and which decisions shape it; keep it current.

## Skill conventions

- Every `jevellan-duty-*`, `jevellan-router`, `jevellan-landing` and `jevellan-coordinator` skill has
  `disable-model-invocation: true` and a description that begins "Jevellan internal. Not for direct use."
  `jevellan-workflow-*` descriptions read "Jevellan workflow <name>: used by the Jevellan coordinator session only."
- Every `SKILL.md` carries `jv-version` equal to the package version; `jv doctor` warns on a mismatch.
- Policy skills are parsed by their level-2 sections (`src/policy.ts`); text outside the parsed sections is for people.
  Every model in the providers.json template needs a line in the router's `## model descriptions`.
- The policy skills' `evals/run.mjs` are thin wrappers over `src/evals.ts`; the replay logic lives and is tested there.

## Tests

```sh
cd .apm/skills/jevellan-router/scripts/jv
npm ci
npm test                              # tsc -p tsconfig.test.json, then node --test over dist-test/test/**/*.test.js
JV_TEST_SKIP_BOOTSTRAP=1 npm test     # skips test/bootstrap.test.ts, which builds the package for real (about a minute)
npm run build                         # tsc -p tsconfig.json: src/ -> dist/
```

One suite after `tsc -p tsconfig.test.json`:
`node --disable-warning=ExperimentalWarning --test dist-test/test/store.test.js`.

- Every test file creates its own temporary `JV_HOME` with `mkdtempSync` and sets `process.env.JV_HOME` before it
  imports any runtime module (imports are dynamic, after that line), because paths resolve `JV_HOME` once. No test
  reads or writes the real `~/.jv`.
- No test reaches a model, Jev, a provider or a real tmux session of the owner: effects go through injected
  dependencies (`DoctorDeps`, `CoordinatorDeps`, tmux runners, Jev clients, `fetch`) and the fixtures under
  `test/fixtures/`.
- Test-only environment hooks, named as such in their modules: `JV_TEST_RUNTIME_MODULE` (a fake runtime for the
  detached `jv run`), `JV_TEST_WORKER_RULES` (another worker rules template), `JV_TEST_WORKER` and
  `JV_TEST_WORKER_ARGS` (the concurrent writer child), `JV_TEST_SKIP_BOOTSTRAP`.
- Lint is the compiler: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. A failing or flaky test is fixed,
  not skipped.

## Acceptance scripts

`acceptance/` holds plain ESM scripts that drive the installed `jv` (`$JV_HOME/bin/jv`) against a real sandbox project
and assert on the store with `jv ... --json` and a read-only `node:sqlite` connection. They use real providers and
Jev, so they cost quota; run them deliberately, never from `npm test`. Each prints its checks and exits 0 when all
pass, 1 otherwise; run results are recorded in `acceptance/RESULTS.md`.

- `lib.mjs`, `viewer-lib.mjs`: shared helpers (the leak check feeds key file lines to `grep -F -f -` on stdin and
  prints only file names).
- `phase2-investigate.mjs` and `phase3-placement.mjs`: a single investigate run end to end, and placement with and
  without a Jev key (`JV_SANDBOX` overrides the sandbox path).
- `phase4-feature.mjs`, `phase5-landing.mjs`, `phase7-runtimes.mjs`: workflows, overrides, landing routes and the four
  runtimes, against a disposable clone of the sandbox named by `JV_ACCEPT_CLONE` (project `JV_ACCEPT_PROJECT`,
  default `sandbox-clone`); `--only`, `--tag` (request id suffix, so a rerun picks up the same tasks) and
  `--timeout-min`.
- `phase6-coordinator.mjs`: the coordinator on the real sandbox (talked to only; it creates no tasks).
- `jNN-<slug>.mjs`: the acceptance journeys of brief section 15 (J1 `j01-install.mjs`, J2 `j02-providers.mjs`, J3
  `j03-coordinator.mjs`, ...), each on the real sandbox, through `journey.mjs`: `--tag` (request id suffix, so a rerun
  reuses its tasks), `--note`, and a `results/JNN.json` per run (id, title, status, checks with evidence, elapsed,
  deviations, notes). `results.mjs` rebuilds `RESULTS.md` from those, in journey order; each journey runs it at the
  end. J3 leaves the coordinator running; `--fresh` restarts only a coordinator an earlier J3 run started.
  A journey's optional `tables` ([{title, columns, rows}]) are rendered after its checks. J4 (`j04-three-tasks.mjs`)
  types into the coordinator through `coord.mjs` (its window, transcript, idle detection, typing as the owner); the
  tasks the coordinator creates are kept in `results/J04-state-<tag>.json`, so a rerun with the tag reuses them, and
  an owner question it cannot answer itself ("Land now" it can) waits for `results/J04-answer.txt`. `j05-live.mjs
  --run R` records what only a live claude-tmux run shows (jv attach, the window, jv tail against the transcript); J4
  and J5 `--ask` start it for every visible run. J5 leaves its loopback viewer running and J16 stops it.
  J6, J7, J8, J11 and J13 create their tasks directly with `jv task create` through `task-lib.mjs` (create by
  request id, settle, answering an asked landing "Land now", and `results/JNN-state-<tag>.json` of what a journey did
  by hand, so a rerun with the tag does not attach, kill or override twice). J6 stops the coordinator and starts it
  again; J8 restarts it. J9 (`j09-jev-refused.mjs`), J10 (`j10-ceiling.mjs`) and J12 (`j12-codex.mjs`) change
  global config for one task each: they wait for `task-lib.mjs` `waitQuiet()` (no task in flight, no live step run),
  then move `jev.key` aside in the same folder, lower `claude-main.ceilingPct` in `providers.json` (`--backup FILE`),
  or edit the installed router policy's model descriptions (`--backup FILE`). Each restores in a `finally` block and
  on SIGINT/SIGTERM, records the restore as checks (mode 600, `cmp`, sha256 equal to the repository policy), and
  leaves a `results/JNN-state-<tag>.json.*` marker with the manual restore command while the change is in place.
  They make their placement once per tag: a rerun with the same tag refuses to run (use a new tag).
  J14 (`j14-child-task.mjs --tag T`) waits for `waitQuiet()`, types one automation request into the coordinator and
  plays the owner from the store and the transcript: "Land now" on an asked landing, approval of the plan's child
  proposal when the coordinator asks (a reply ending in "?" or in numbered open questions), anything else through
  `results/J14-question.txt` and `results/J14-answer.txt`. It snapshots the parent's branch and main the moment the
  child's landing is landed (kept in `results/J14-state-<tag>.json`, main's reflog stands in on a rerun that missed
  it). If Jev skips the parent's plan step it discards the task, writes a project `workflows/automation.json` that
  always plans, asks again, and moves the override out after the run. A rerun with the tag reuses the parent.
  J15 (`j15-evals.mjs`) runs `jv evals route|landing --since 2026-11-01` into the package's cases files and both
  policies' `evals/run.mjs` (real Jev calls; exit 1 on a low held-out score counts as a run), backs both files up to
  `JV_ACCEPT_BACKUP_DIR` (default the system temporary folder) first, and searches what it wrote for machine paths
  and the owner's name and e-mail. J17 (`j17-no-leaks.mjs [--final] [--extra PATH]...`) searches the store, logs,
  evidence folders, jv config, this repository and the acceptance outputs for every key file line and every
  credential token value (patterns on stdin, file names only), with positive controls; `--final` first stops the
  coordinator and checks the state the run leaves. Both create no task and can be rerun.
- `phase8-viewer.mjs <T>` and `viewer-check.mjs <T> [--bind ADDRESS]`: the viewer in headless Chromium at desktop and
  phone widths. Playwright is not a dependency: it comes from `JV_PLAYWRIGHT_DIR`, the sandbox's `node_modules` or a
  global npm folder.

Usage lines and options are in each script's header comment.

## Commits

One commit per coherent change at least, with a message that says what and why, the machine's git identity, and no
trailers of any kind. Never commit build output (`dist/`, `dist-test/`, `node_modules/`),
`.jv-evidence/`, `CLAUDE.md` or `.claude/`.

## Releasing

A version lives in `apm.yml`, the root `package.json`, the runtime's `package.json` and every `SKILL.md`'s
`jv-version`; change them together, add a `CHANGELOG.md` section, and tag `v<version>`.
