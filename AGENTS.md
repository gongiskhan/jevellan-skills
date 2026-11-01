# Working in jevellan-skills

This repository is an APM package of skills plus one small runtime, the `jv` command. The specification is the
brief at `~/.jevellan-build/manager/BRIEF-jevellan-skills.md`; section numbers below refer to it. Every choice the
brief left open is recorded in `docs/decisions.md` (D-numbers, append-only) and every verified fact about flags,
APM and SDKs in `docs/findings.md` (append-only).

## Rules that bind every file

- No AI attribution anywhere: no `Co-Authored-By`, no `Claude-Session`, no "Generated with", no model names in
  commit messages, authored text or generated reports. Commits use the machine's git identity.
- No tracked `CLAUDE.md` and no tracked `.claude/` directory, here or in any project the system touches.
  Agent instructions live in `AGENTS.md`.
- Never touch production, never deploy, never stop or delete the owner's processes or data. Archive, never delete.
- Secrets never appear in logs, events, reports, the store, test fixtures or command lines. Provider keys live only
  in the files `providers.json` points at (`~/.jv/secrets/*`, mode 600).
- Plain dash "-", never the em dash, in every file.
- Never touch anything under `~/.jevellan*` except appending status lines to
  `~/.jevellan-build/manager/jevellan-skills-status.txt`. Jevellan keeps running (systemd `jevellan.service`,
  tmux sessions `jv-bridge-*`, `jv-build`, `rc`, `codex-*`): never stop them, never reuse their tmux names.
  Our tmux names are exactly `jv-R<6>` (sessions) and `jv-coord-<project>` (coordinators).

## Node

Node 22.13 or later is required (`node:sqlite`). On dev-madrid the default `node` is 20; use
`export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` at the start of every shell command. The installed
`~/.jv/bin/jv` is a `sh` shim that execs the Node binary recorded at bootstrap with
`--disable-warning=ExperimentalWarning`, so the SQLite warning never reaches stderr.

## Layout

```
apm.yml, package.json (root; "bin": {"jv": ".apm/skills/jevellan-router/scripts/jv/bin/jv.mjs"}, no dependencies)
.apm/skills/jevellan-*/SKILL.md        skills (section 2)
.apm/skills/jevellan-router/scripts/jv/ the runtime (the only copy of its source)
  package.json, package-lock.json      deps: @anthropic-ai/claude-agent-sdk, @openai/codex-sdk, zod. Dev: typescript, @types/node
  tsconfig.json                        src/ -> dist/ (NodeNext, ES2023, strict)
  tsconfig.test.json                   src/ + test/ -> dist-test/
  bin/jv.mjs                           plain JS entry: Node version check, first-use bootstrap, then import dist/cli.js
  bin/bootstrap.mjs                    plain JS bootstrap (runs before anything is built)
  src/                                 TypeScript; report guard is src/report-guard.mts -> dist/report-guard.mjs
  test/*.test.ts                       node:test; `npm test` = tsc -p tsconfig.test.json && node --disable-warning=ExperimentalWarning --test "dist-test/test/**/*.test.js"
                                       (test/bootstrap.test.ts builds the package for real, about a minute; JV_TEST_SKIP_BOOTSTRAP=1 skips it)
  templates/                           providers.json, project.json, landing.json templates
.apm/agents/jevellan-coordinator.agent.md, .apm/hooks/jevellan.json
acceptance/                            journey scripts J1..J17 and RESULTS.md
docs/decisions.md, docs/findings.md
```

Root `package.json` is a thin pointer into the runtime: `npm install -g github:gongiskhan/jevellan-skills` and APM
both end in the same `bin/jv.mjs`, which bootstraps `~/.jv/runtime/` from the folder it lives in. `~/.jv/runtime` and
`~/.jv/skills` are symlinks to versioned folders under `~/.jv/runtimes/` and `~/.jv/skill-sets/`, switched atomically
by each bootstrap (D-021).

## Runtime conventions

- ESM, `import ... from './x.js'` with explicit `.js` extensions. No dependencies beyond the three allowed;
  everything else is Node built-ins (`node:sqlite`, `node:http`, `node:child_process`, `node:fs`, `node:crypto`).
- `JV_HOME` (default `~/.jv`) is resolved once in `src/paths.ts`; nothing else reads `os.homedir()` for jv paths.
- Store: `src/store.ts` owns the schema of section 4 verbatim, the pragmas (WAL, `busy_timeout` 5000,
  `synchronous=NORMAL`, `foreign_keys=ON`), schema version in `meta.schema_version`, short write transactions
  (`BEGIN IMMEDIATE`), and the `request_id` rule (same id + same input returns the row, different input exits 4).
  Nothing is ever deleted from the store.
- Ids: one letter prefix plus 6 characters of Crockford base32 upper case (`T`, `S`, `R`, `D` decisions, `L`
  landings, `M` messages, `P` projects, `E` reports). Task short id in branch names is the 6 characters lower case.
- Errors: throw `JvError(message, exitCode)`; the CLI prints the message (or `{"error": ...}` with `--json`) and
  exits 2 refused, 3 not found, 4 conflict. Every command accepts `--json`.
- Times are ISO 8601 UTC strings (`new Date().toISOString()`).
- Every state change writes a short human `state_reason`.
- Provider homes: `~/.jv/homes/<provider>/` is the `HOME` of that provider's sessions; Claude's config dir is
  therefore `<home>/.claude/` (settings.json with the jv Stop hook, transcripts under `projects/`) and its global
  config `<home>/.claude.json`; Codex uses `CODEX_HOME=<home>/.codex`. `CLAUDE_CONFIG_DIR` is never set.
- Claude subscription logins come from `tokenFile` (`CLAUDE_CODE_OAUTH_TOKEN`) when providers.json names one,
  else from the home's own `.credentials.json`.
- Secrets are read from key files at the moment of use and passed only through child process environments,
  never through argv, never written to logs; a redactor masks every loaded secret in text that is stored.
- Worker processes are spawned detached (`setsid`) in their own process group, stdout/stderr to
  `~/.jv/logs/<session-id>.log`.

## Commits

One commit per phase at least, message says what and why, machine git identity, no trailers of any kind.
