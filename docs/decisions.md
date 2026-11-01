# Decisions

Choices the brief left open or that the machine forced, numbered, append-only. Each says what and why.

## D-001 Node 22 is pinned by the shim, not by PATH

dev-madrid's default `node` is 20.19.4, which has no `node:sqlite`; 22.23.2 is installed under nvm. `jv bootstrap`
must be run with Node 22.13 or later and records that binary's path in `~/.jv/bin/jv`, a `sh` shim that execs it
with `--disable-warning=ExperimentalWarning` (the SQLite experimental warning would otherwise print on stderr of
every call). Detached workers are spawned with the same binary and flag.

## D-002 Provider homes are HOME directories; Jevellan's flat homes are mapped into them

Section 17 says to copy each Jevellan home's `.claude` (and `.codex`) directory. Jevellan ran its sessions with
`HOME=<home>` and `CLAUDE_CONFIG_DIR=<home>` (or `CODEX_HOME=<home>`), so its homes are flat config folders with no
`.claude` subfolder. jv uses `HOME=<home>` only, so `<home>/.claude/` is the config dir and `<home>/.claude.json`
the global config, which keeps the paths of sections 6.2 and 6.4 exactly as written. The bootstrap copies only
login and onboarding state: `<jevellan home>/.claude.json` to `<home>/.claude.json`, `<jevellan
home>/.credentials.json` to `<home>/.claude/.credentials.json` when present, and for Codex `auth.json` to
`<home>/.codex/auth.json`. It never copies Jevellan's `settings.json` (it carries Jevellan's PreCompact and Stop
hooks that point at Jevellan's runtime), transcripts, plugins or skills. Codex sessions get `CODEX_HOME=<home>/.codex`.

## D-003 Claude subscription providers take a tokenFile

The Gmail Claude account has no on-disk login in its Jevellan home: Jevellan keeps both Claude accounts' logins as
"shared" OAuth tokens in its vault and injects them as `CLAUDE_CODE_OAUTH_TOKEN`. jv therefore lets a
`claude-subscription` provider name a `tokenFile` (`~/.jv/secrets/claude-main.token`, mode 600); its content is
passed to every Claude process of that provider (SDK, tmux, coordinator, attach, probes) as
`CLAUDE_CODE_OAUTH_TOKEN`, never on a command line. Without a `tokenFile` the home's own `.credentials.json` login
is used (what `jv providers login <name>` creates). These tokens are long-lived and do not rotate, so jv and
Jevellan can share them without signing each other out. Both tokens and the Jev key were read once, read-only,
with Jevellan's own `SecretVault` code over a read-only connection to its hub database.

## D-004 Worker environment additions

`minimalEnvironment` keeps the brief's list (PATH, HOME, USER, LANG, TERM, SHELL, TMPDIR, provider HOME, endpoint
keys, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `JV_SESSION`) and adds, with reasons: `ENABLE_CLAUDEAI_MCP_SERVERS=false`
(ported from Jevellan: without it a session inherits the account's claude.ai connectors); `CLAUDE_CODE_OAUTH_TOKEN`
(D-003); `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` read from the machine's
git config at launch (HOME is the provider home, where there is no `.gitconfig`; Jevellan passed the same four);
`PLAYWRIGHT_BROWSERS_PATH` pointing at the machine's `~/.cache/ms-playwright` when it exists (browser journeys
would otherwise look for browsers under the provider home).

## D-005 Bootstrap installs dev dependencies to build, then prunes

Section 3 says `npm ci --omit=dev` and then build TypeScript, but the compiler is a dev dependency. The bootstrap
runs `npm ci`, `tsc -p tsconfig.json`, then `npm prune --omit=dev`, so the installed runtime ends with production
dependencies only, as the brief intends.

## D-006 A session row is one run (one turn)

`reports.session_id` is unique and a worker reports exactly once per turn, so every turn is its own `sessions` row
("R" for run): a start, a "Continue." after a progress report, an owner answer, a resume after `lost`. Rows of the
same conversation share `native_session_id`, which is what J7 checks. Owner and coordinator messages for a task
are stored in `messages` and delivered at the next turn boundary of that task's session (the `claude-tmux`
runtime types them into the live window at once).

## D-007 Secrets never travel on command lines

tmux-launched processes (claude-tmux sessions, the coordinator, `jv attach`, `jv providers login`) run through an
internal `jv exec --session <id>` (or `--provider <name>`) that builds the minimal environment, reads the key files
and spawns the real command with inherited stdio, so no token appears in `ps`, tmux history or logs.

## D-008 The provider homes' Stop hook names the Node binary and the guard by absolute path

Section 6.4 writes the hook as `node ~/.jv/runtime/dist/report-guard.mjs`. In a provider home, `node` on PATH may be
the machine's Node 20 (no `node:sqlite`) and `~` is the provider home, not the owner's. The bootstrap therefore
merges `<bootstrap Node> --disable-warning=ExperimentalWarning $JV_HOME/runtime/dist/report-guard.mjs` into
`<home>/.claude/settings.json` of every Claude provider (the path goes through the `$JV_HOME/runtime` link of D-021,
so it stays valid across updates). Exactly one guard entry is kept: any other entry whose command contains
`report-guard.mjs` (an older path, the APM form) is folded into it; every other hook and key is kept as it was. The
APM hook file keeps the brief's literal command for the owner's own sessions; D-016 makes it resolve under provider
HOMEs too.

## D-009 Section 17 seeding is driven by `$JV_HOME/seeds.json`

The Jevellan account folders are machine facts, not code: `$JV_HOME/seeds.json` maps a provider name to the
Jevellan folder to seed it from, and the runtime contains no Jevellan path. "When the target is empty" is read as
"the home has no login file yet" (`.claude/.credentials.json` for Claude kinds, `.codex/auth.json` for Codex): a home
with its own login is never overwritten, and no existing file is replaced, except a `.claude.json` that is only the
`{"hasCompletedOnboarding": true}` jv writes itself (a jv call that ran before seeds.json existed). A provider is
recorded in `$JV_HOME/seeds-applied.json` (paths and byte sizes, never contents) only when a file was copied, so a
seed that copied nothing can still happen later. The source is only read.

## D-010 `~/.jv/skills/jevellan-router` has no `scripts/`

Section 3 says to copy every `jevellan-*` skill folder to `~/.jv/skills/`. The router's `scripts/jv/` is the runtime
itself, already installed at `~/.jv/runtime`; a second copy (with its `node_modules` after a build) would also be
copied into every provider home by D-015 and is never read. The runtime reads only `SKILL.md` and the `evals/` and
`workflow.json` files of the skills, so the router is copied without `scripts/`.

## D-011 providers.json: fields the brief did not list, and strict validation

Added, with defaults so the brief's shape validates as written: `enabled` (default true; a disabled provider stays in
the file and out of the menu), `paidUse` (`always`, `never`, `when-subscriptions-run-out`; Jevellan's rule for
metered accounts) and `metered` (default true for `claude-endpoint` and `openai-compatible`, false otherwise; Ollama
in the template sets it false because it is local). The per-model token cap of 6.5 is written `maxTokens`, in the
file's camelCase; it is sent as `max_tokens`. Unknown keys are refused (exit 2 naming the key), so a typo such as
`ceilingPCT` never silently falls back to a default. A `claude-endpoint` entry may omit `home` (the brief's glm entry
has none); it defaults to `~/.jv/homes/<name>`. Every provider home must resolve, with symlinks followed, to a folder
strictly inside `$JV_HOME/homes/`, and never to the user's home or into a `~/.jevellan*` folder: jv writes logins,
settings and skills into it, so a mix-up between seeds.json (a Jevellan source) and providers.json (a jv target) must
fail before anything is written. seed() checks again right before writing.

## D-012 The login state of the last probe lives in `meta`, key `provider_auth:<name>`

Section 7.2 puts only providers that are "logged in (last probe `ready`)" in the menu, and section 4 has no column
for it, so each probe's result is stored as `meta` row `provider_auth:<provider>` = `{"auth": "ready" | "needs-login"
| "unknown", "observedAt": ..., "detail": ...}` (no secret, no raw probe output). `jv doctor` writes it for every
login it probes; `jv providers check` (phase 7) writes it too. `rankProviders` takes the map as a required input and
excludes, with reason `needs-login`, every provider whose recorded state is not `ready`, including providers never
probed, as Jevellan's `rankAccounts` does. Doctor probes no `openai-compatible` provider today (it checks key files
only), so those stay out of the menu until `jv providers check` records their state in phase 7.

## D-013 jv doctor: exit 2 on FAIL, `--check`, and what each probe asks

`jv doctor` exits 0 when every line is OK or WARN and 2 (refused) when any line is FAIL, so `jv task create` and
scripts can gate on it; `--check NAME` (repeatable, or positional names) runs one group (`jev`, `logins`, `models`) or
one line (`login:claude-main`). The Claude login probe is a one-turn `claude -p --max-turns 1` on the provider's
cheapest model, as section 11 says. The `models:<provider>` lines port Jevellan's `listClaudeModels`: the agent SDK's
`supportedModels()` through an open, empty input stream (no model turn), under the provider's own environment;
a providers.json model id the login does not offer is WARN, a probe that cannot run is FAIL. `claude-endpoint`
providers are not probed (Claude Code lists Anthropic's aliases there, not the endpoint's models; Jevellan returned
the configured list too). The Codex login is `codex app-server` with `account/read` (`refreshToken: false`) and
`account/rateLimits/read`: a 401 or 403 on the latter means the stored login was revoked or rotated away
(needs-login); `codex login status` is not used because it only reads the local file. The refresh is never forced,
for the reason in D-022.

## D-014 What the redactor masks

Every value in a file under `~/.jv/secrets/` and every `keyFile`/`tokenFile` providers.json names, whole and per line
(and the value of `NAME=value` lines), when it is at least 6 characters long: shorter values would mangle ordinary
text and are not real keys. The OAuth logins jv keeps in provider homes (`<home>/.claude/.credentials.json`,
`<home>/.codex/auth.json`) and the copies archived under `~/.jv/archive/credentials/` are JSON, where a line holds the
key name and the quotes too, so each of their string values of at least 20 characters is masked on its own (the
tokens; not plan names or scopes). The redactor reloads when any of those files change.

## D-015 Skills reach provider homes by a plain copy, not by APM

Section 2 says that when APM has a user-level install, `jv project add` installs there instead. On dev-madrid it has
one (`apm install -g` writes `~/.claude/{skills,agents,settings.json,apm-hooks.json}`; docs/findings.md). jv does not
use it: `jv project add` and the bootstrap copy the `jevellan-*` skills from `~/.jv/skills/` into
`<provider home>/.claude/skills/` and the coordinator agent into `<provider home>/.claude/agents/<name>.md` of every
Claude provider. The reasons, written from the code: (1) the coordinator and every worker run with `HOME` set to a
provider home, so the owner's `~/.claude` is not the user scope they load, and an install there reaches none of
them; (2) `apm install -g` writes into the owner's own `~/.claude` (their data, which jv must not change) and merges
its hook into the owner's settings; (3) APM is optional: `npm install -g github:gongiskhan/jevellan-skills` must work
without it, and the runtime must not depend on another CLI being installed; (4) the copies come from `~/.jv/skills/`,
the folder the runtime reads, so their hashes match by construction and `jv doctor` can compare them; (5) the copy is
idempotent, writes only files whose content differs, and archives (never deletes) a `jevellan-*` skill the package
no longer has; (6) only `jevellan-*` names are touched, so skills and agents the owner put in a provider home stay.
The project install the owner runs with APM (`apm install ... --target claude` in the project) stays as section 2
says; `jv doctor` warns when it differs from `~/.jv/skills/`.

## D-016 Each Claude provider home links `.jv` to `$JV_HOME`

The coordinator (9.1) runs in the project checkout with `HOME` = the claude-main home, so it loads the project's
APM-merged hook `node ~/.jv/runtime/dist/report-guard.mjs`, where `~` is the provider home. The bootstrap therefore
creates the symlink `<claude provider home>/.jv -> $JV_HOME` (a link, no copy; anything already at that path is left
alone and reported), so the brief's `~/.jv/...` paths resolve under every provider HOME exactly as under the
owner's. Codex homes get none (Codex loads no Claude hooks). Requirements this puts on the phase 2 report guard: it
exits 0 unless `JV_SESSION` names a session row of kind `step` (the coordinator has `JV_SESSION` set too, and must
never be blocked), and it reads `JV_SESSION` before any dynamic `import('node:sqlite')`, so the APM form of the hook
still exits 0 in an owner session on the machine's Node 20.

## D-017 provider_usage key clashes move the observation 1 ms later

`provider_usage` has `PRIMARY KEY (provider, observed_at)`. Two observations of one provider in the same
millisecond (a probe and a stream event) would otherwise make one of them fail; the store moves the later insert
forward by 1 ms until the key is free (at most 50 times). The row keeps its values; only its time moves, by a few
milliseconds, which nothing that reads usage can tell apart.

## D-018 Timestamps

Every time is an ISO 8601 UTC string from `new Date().toISOString()`. A state change sets the timestamps the state
implies: entering a start state (`running` for tasks; `running`, `retrying` for steps; `starting`, `running` for
sessions) sets `started_at` once and never overwrites it; entering an end state (`done`, `failed`, `stopped` for
tasks; `done`, `failed`, `skipped` for steps; `done`, `failed`, `lost`, `stopped` for sessions; `landed`, `asked`,
`failed` for landings) sets `ended_at`; entering any other state clears `ended_at`, because the row is live again (a
resumed session, a retried step).

## D-019 What "the same input" means for request ids and the other natural keys

A repeat returns the existing row when every input column is equal, and exits 4 naming the differing columns
otherwise. Compared columns: tasks (key `request_id`): project, parent, after, kind, title, text, workflow JSON,
visible; the initial state is not input. Sessions (key `request_id`): project, task, step, kind, runtime, provider,
model, effort, cwd, and `native_session_id` only when the caller gives one. Steps (key task and ordinal): duty,
instructions, `when` rule, `on_fail` JSON. Reports (key session): status, summary and every content field. Projects
are not request-id rows; they are keyed on the name: the same name with another path exits 4; the same name and path
with another default branch updates `default_branch` (the repository renamed its branch, and nothing else could
correct the row) and says so; a path already registered under another name exits 4 naming that project, because two
projects on one checkout would land into it independently.

## D-020 @types/node is pinned to 22

The runtime targets Node 22.13 or later and dev-madrid runs 22.23.2. `@types/node` is pinned to a 22.x version so the
compiler offers only APIs that exist on Node 22 (newer type packages describe `node:sqlite` and other modules as they
are in later Node versions).

## D-021 The runtime and the skills are versioned folders behind links; one bootstrap at a time

Section 3 copies the package over `~/.jv/runtime/` and builds there. Building in place leaves a window with no
`dist/` (every other jv call, and every worker's Stop hook, fails or starts a bootstrap of its own), a failed build
leaves no runtime at all, and files deleted from the package stay and are compiled again. So each build goes into a
fresh `$JV_HOME/runtimes/<version>-<fingerprint>-<time>.partial/` (copy, `npm ci`, `tsc`, `npm prune --omit=dev`),
the skills into `$JV_HOME/skill-sets/<same id>.partial/`, and only when both are complete do `$JV_HOME/runtime` and
`$JV_HOME/skills` (symlinks) switch to them with one `rename(2)` each, which readers see as either the old folder or
the new one. `~/.jv/runtime/...` and `~/.jv/skills/...` keep the paths sections 1, 3 and 6.4 name. On any failure the
installed runtime is untouched and the command exits non-zero. The current and the previous version stay in place
(a running jv process imports its command modules lazily from the folder it started in); older ones move to
`$JV_HOME/archive/runtimes/` and `archive/skill-sets/`, an archived runtime without its `node_modules` (npm ci
recreates it from the archived lock file). A folder installed before this decision is moved aside once, as
`runtimes/legacy-<time>`. The package fingerprint (the runtime files, the `jevellan-*` skills and agents, the Node
binary and a bootstrap format number) is recorded in `install.json`; a bootstrap or update whose fingerprint
matches rebuilds nothing and still rewrites the shim and runs seed(). `$JV_HOME/bootstrap.lock` (created with
O_EXCL, holding the pid) lets one bootstrap run at a time; a lock whose pid is gone is taken over; a first-use call
(`jv` with no runtime built yet) that finds the lock held waits for it (up to 120 s) and then uses what the other
bootstrap installed. `jv update` run from an installed runtime whose `bootstrap.mjs` differs from the source's runs
the source's, so a change to the bootstrap applies on the update that brings it.

## D-022 The Codex login is shared with the running Jevellan, by design

Section 17 seeds `~/.jv/homes/codex/.codex/auth.json` from Jevellan's Codex account folder, so jv and Jevellan hold
one ChatGPT OAuth login with one refresh token. When either side refreshes it, the server may rotate the refresh
token and the other side's copy stops working. jv never forces a refresh to check the login (D-013), but a Codex
worker that runs long enough refreshes it like any Codex session. When jv's copy stops working, `jv doctor` and `jv
providers check` report `login:codex` as "needs login" with `jv providers login codex`; when Jevellan's does,
Jevellan reports it. The way out of the sharing is one `jv providers login codex` by the owner, which gives jv its own
login; the run's status file carries a NEEDS-OWNER line for it.

## D-023 A Claude subscription with a tokenFile keeps no `.credentials.json`

A `claude-subscription` provider that names a `tokenFile` logs in with that token (D-003); a `.credentials.json` in its
home is never used by jv, and a second live copy of the refresh token of the Jevellan home it was seeded from could be
refreshed by any `claude` started there without the token (by hand, or a future `jv providers login`) and sign
Jevellan out. Seeding therefore copies no `.credentials.json` for such a provider, and a copy an earlier bootstrap made
(listed in seeds-applied.json) is moved to `~/.jv/archive/credentials/<provider>-<time>.credentials.json` (folder mode
700, file mode 600, masked by the redactor, D-014), never deleted; the move is recorded under `archived` in
seeds-applied.json.

## D-024 The shim keeps a JV_HOME the caller set

`~/.jv/bin/jv` sets `JV_HOME` to the home it was installed in only when the caller has not set one, so section 1's
"`JV_HOME` overrides it" holds through the shim as well. The shim always runs its own home's runtime entry; with
another `JV_HOME` that runtime serves the other home's store, and installs a runtime there first when the other home
has none, from the package recorded in the shim's own home.

## D-025 JV_HOME is part of the worker environment

D-004's list gains `JV_HOME`. The stdio report server and the Stop hook run inside the worker's environment and
must open the same store as the launcher; without it a non-default home (tests, a second install) is invisible to
them, and Codex homes have no `.jv` link (D-016) to fall back on.

## D-026 Read-only duties: dontAsk with an explicit allow list

Section 6.1 gives read-only duties `permissionMode: 'dontAsk'` and the tool list `Read, Glob, Grep, WebSearch,
WebFetch, ToolSearch`. In dontAsk mode a tool that is not pre-approved is denied, so `allowedTools` names
`mcp__jv__jv_report`, `WebSearch`, `WebFetch`, `Write` for `plan` (its one allowed file, by instruction), and
`mcp__<name>` for each MCP server in project.json. The `tools` list stays exactly section 6.1's (plus `Write` for
plan).

## D-027 claude-sdk events and usage

Text and thinking events are recorded once per complete assistant block, not per stream delta, so a turn is a few
dozen rows; tool inputs and outputs are trimmed to 4000 characters. The SDK's result totals are cumulative over a
resumed conversation, and every turn is its own row (D-006), so each `usage` event carries the delta: the totals
minus what the earlier rows with the same `native_session_id` already counted (costs compared with a 1e-5
tolerance, since they are floats). Without this every resume would count the whole conversation again.

## D-028 The no-report backstop runs in the same process and row

When a claude-sdk turn ends without `jv_report`, the adapter resumes it once with section 5's message in the same
`jv run` process and the same session row; if there is still no report it writes a `blocked` report with
limitations `synthesized: no report`. The runtime module's `resume(session, message, input?)` takes the turn input
as an optional third argument (section 6's signature has two), so a resume does not rebuild what `jv run` already
built.

## D-029 Meta keys and test hooks of the run machinery

`meta` holds `run_message:<R>` (the message a run delivers besides the task's undelivered messages, such as
"Continue.") and `report_guard:<R>` (the Stop hook's block count for the turn). Two environment variables exist for
tests only and are named so in their modules' headers: `JV_TEST_RUNTIME_MODULE` (a fake runtime for the detached
`jv run`) and `JV_TEST_WORKER_RULES` (another worker rules template).

## D-030 The placement menu and the provider question

The model question has one option per model id, named "<label> via <provider> (<runtime>)" after its best-ranked
eligible provider; when other eligible providers serve the same id, the second call's provider question chooses
among them. A provider criterion with no usage observation prints "unknown" ("week unknown of 90%, five hours
unknown"). A question with a single option is not asked (a choice needs two) and is recorded as `only-option`; when
nothing is left to ask, the row is written without a Jev call. `state.step.failure` appears only on retries. A
`noul` answer counts as true at probability 0.5 or above.

## D-031 Which provider kinds run which runtime

The agent runtimes (`claude-sdk`, `claude-tmux`, `codex`) run on `claude-subscription`, `claude-endpoint` and
`codex-subscription` providers; `llm` runs on `claude-subscription` (section 6.5's one-turn SDK path),
`claude-endpoint` and `openai-compatible` providers.

## D-032 Owner placement rules: `~/.jv/projects/<name>/rules.json`

Shape: `{"rules":[{"id":"R<n>","when":{"kind"?,"duty"?,"keywords"?},"set":{"minEffort"?,"maxEffort"?,
"landingRoute"?},"note"?,"enabled"?}]}`. Every rule in the file has project scope; ties between matching rules are
broken by rule number; an invalid file is exit 2. Rules apply after Jev answers (ported from Jevellan's
jev-rules.ts), then the effort is mapped onto the chosen model's efforts.

## D-033 Decision rows: who answered

`jev_model` holds the model Jev reports as having answered (for example `jev-1.14.0` for `jev-latest`), not the
alias asked for. A placement the owner made (`jv task override --undo`) is written with `jev_model: "none"` and
`chosen_json.source: "owner"`; the evals export skips such rows because there is no Jev answer to replay.

## D-034 The task block names the project's commands

Section 7.4's task block gains one part, after the step instructions: "Project settings (project.json):" with the
`testCommand`, `devCommand` and `automationDir` that project.json sets (non-empty strings only; the part is left out
when none is set). The verify and automate duty bodies read the test command, the dev server command and the
automation folder from it, and nothing else would tell a worker the values the owner configured.

## D-035 Acceptance scripts for phases 2 and 3 create tasks through the runtime's modules

Task creation is phase 4's, so `acceptance/phase2-investigate.mjs` creates the task, its one step and the run row
through the installed runtime's `dist/store.js` and `dist/launcher.js` with an explicit owner placement, sets the
step and task running (what the launcher of phase 4 will do), and starts the run with `spawnRun`.
`acceptance/phase3-placement.mjs` calls `placeStep` of `dist/route.js` on that step against the real Jev, then runs
the no-key half in a child process whose `JV_HOME` is a temporary folder (paths resolve `JV_HOME` once): an empty
secrets folder, `jev.keyFile` pointing at a missing file, one provider with an empty home and a `ready` login record
so the menu is not what refuses. No secret is copied anywhere. Both scripts are kept for the acceptance suite; the
`jv task create` forms of these checks come with phase 4.

## D-036 A placement with nothing to ask still reaches Jev

D-030 does not ask a question with a single option, and with a one-model, one-effort menu and one eligible provider
nothing was left to ask, so the row was written without any Jev call: a missing key or a revoked one went unnoticed
and the step ran, against section 7.2's "No Jev, no placement". The question cannot be sent anyway, because Jev's
contract refuses a choice with fewer than two options (2 to 255, ported as it is), and padding it with a made-up
option would put a fake answer in the decision row. So when no question is left, `placeStep` calls `GET /v1/models`
first: a missing key, an authentication error, a timeout or an invalid response is exit 2 with the JevError message,
and so is a configured `jev.model` that the list does not name (what `jv doctor --check jev` checks); nothing is
written then. When it answers, the row is written as D-030 says (sources `only-option`, empty questions and
answers), with `latency_ms` of that call and one entry in `usage_json.calls` with `questions: []` and `check: "GET
/v1/models"`. This amends D-030.

## D-037 The shared worker rules depend on the duty

Section 7.9's rules tell every worker to commit on its branch, to save screenshots under `.jv-evidence/` and to end
with `jv_report`, but `investigate` changes nothing, `plan` writes only plan.md and does not commit, and `answer` and
`converse` have no tools and report with a fenced block (6.5). `templates/worker-rules.md` therefore has three more
placeholders, filled by `src/prompt.ts` from the duty: `{{isolation}}` (write duties: the brief's paragraph;
`plan`: the worktree sentence plus "writes only plan.md ... and no commit"; other read-only duties: "changes nothing
... does not commit"; llm duties: no repository at all), `{{report}}` (the brief's jv_report rule, or the fenced
block for llm duties) and `{{work}}` (the evidence and surgical tests bullets, for write duties only). Every other
line is the brief's.

## D-038 Task request ids, the creation preflight and the placement row

Without `--request-id`, a task's request id is `auto:` plus the sha256 of the JSON array `[project id, kind, duty,
title (whitespace collapsed), text (CRLF to LF, trailing whitespace trimmed), parent, after, visible]`, so the same
command typed twice is one task (D-019). Before any row is written, `jv task create` checks the providers only: a
recorded login state (D-012) counts as fresh for 12 hours, a missing or stale one of a Claude or Codex provider is
probed with the doctor's `login:<name>` check, `openai-compatible` providers are never probed, and a refusal is exit 2
with the doctor lines. Jev is not checked before creating, so a missing key (J9) leaves a queued task whose step is
pending with the Jev message; `jv task resume` places it once the key is there. `task.md` holds the stored task text
exactly. Each run's placement has request id `run:<decision id>`, and the run id is written to the decision's
`session_id`.

## D-039 Task worktrees and the setup command

A workflow whose every duty is `answer` or `converse` gets no worktree: it runs in the project checkout and never
lands. Every other task's worktree is based on the local default branch, or `origin/<default>` when the local branch
is missing; a failed `git fetch` is only a warning. A reused worktree reports its fork point (`merge-base`); an
existing branch is exit 4 and an unknown folder at the path is exit 2. Nothing is pruned, removed or deleted. The
project's setup command runs once per worktree (meta `worktree_setup:<T>`), right before `runtime.start` on the first
turn of a run and never on a resume; its output goes to the session log and one `tool-result` event carries the
result. A failure fails the run with exit 2 ("worktree setup failed: ...") and is retried on the next run. Until the
end-to-end check wired it into `run.ts`, the setup command never ran.

## D-040 Step failures, retries, the progress budget and lost runs

A step that fails with no `on_fail` fails and puts the task in waiting-owner; the extra verify step that
verify-then-land adds goes back to landing instead (D-046). With `on_fail` goto, the loops used are the goto target's
`attempts - 1`; steps after the target return to pending and skipped steps stay skipped. A placement of a step gets 20
continues (`MAX_PROGRESS`); the 21st progress report blocks. Lost runs are never advanced automatically: `jv status`
marks them at read time and `jv task resume` continues them (J7).

## D-041 The run process finishes advancing before it exits, and a stopped row stays stopped

`run.ts` awaits `afterRun` and starts the exit timer of `commands/run.ts` only after it returns. Without the await its
`finally` closed the store and the process exited 2 s later, so every path that places a step through Jev (the next
step after done, an `on_fail` goto, the automatic landing) hit a closed store or was killed. A stopped session row is
never moved back to starting or running: an override right after creating a step had the run process write `running`
over `stopped`, so the reason read "stopped (SIGTERM)" instead of "overridden by the owner".

## D-042 Owner commands on a task and `jv status`

`jv task stop` without `--discard` keeps the task state and only updates the reason. With `--discard`, running or
retrying steps become `failed` with "discarded by the owner" and no placement outcome is recorded, and open landings
close (D-050). A message or answer from a coordinator caller (`JV_SESSION` names a coordinator session) is stored with
direction `coordinator`; otherwise an answer is `answer` and a message is `owner`. Answers resume through the normal
delivery of undelivered messages; `jv task message` types into the live window of a claude-tmux conversation with
`typeIntoConversation` (D-006), not `runtime.resume`, which waits for the whole turn. `answer` and `message` refuse
when every step is done ("only landing is left: jv land T"). `jv status` leaves done tasks out and lists them as
`recent` for 24 hours; failed and stopped tasks stay listed for 24 hours.

## D-043 Landing refusals, Jev failures and `--force`

With `auto` (the landing `afterRun` starts), a refusal puts the task in waiting-owner and wakes the coordinator;
nothing is thrown. Without `auto`, a refusal is exit 2 and changes nothing. A Jev failure puts the task in
waiting-owner, sends the coordinator a "Jev refused (...)" line and exits 2, with no landing row and no decision row;
Jevellan fell back to ask-owner instead, which would hide a broken Jev behind an ordinary question. `--force` writes
no decision row (the landing has `decision_id` null), skips a landing verify step that is not running, and marks an
open verify-then-land landing `failed` with "replaced: forced by the owner"; the uncommitted-changes check still
applies. A landing outside the auto path (`jv land`, `--force`, "Land now") calls `advance.releaseDependents`, as the
auto path does, so tasks waiting `--after` it start. `jv land` exits 0 for landed, checking or asked, 2 for failed or
refused, and 3 for an unknown task.

## D-044 One landing at a time per project

A landing holds meta `landing_lock:<project id>`; a lock whose holder pid is gone is taken over, and a waiting landing
gives up after 60 minutes. If the default branch moves during a landing, the merge, the checks and the fast-forward
repeat, up to 3 rounds.

## D-045 How a task branch lands, and the landing checks

The default branch is merged into the task branch with `--no-ff`; a branch with nothing of its own fast-forwards
instead, so an empty merge commit never lands, and a task with zero changed files lands as a no-op. The default branch
then moves by `merge --ff-only` when it is checked out and clean in the touched files; checked out and dirty in those
files fails the landing and puts the task in waiting-owner with a reason naming the files; another branch or a
detached HEAD gets `push . <branch>:<default>` (the ref only). Checks run with `sh -c` in their own process group,
with a default timeout of 30 minutes, and get the base environment keys, the owner's own HOME, the git identity and
the Playwright browsers path, nothing from providers or Jev. A check that moves HEAD fails. The last 4000 characters
of output are kept, redacted.

## D-046 verify-then-land continues without a second Jev call

Meta `landing_step:<L>` names the extra verify step. `afterRun` hands that step back to `landTask(store, id, {auto:
true})` whether it passed or failed (`isLandingVerifyStep`), and that call lands or fails from the step's result
without asking Jev again.

## D-047 landing.json, the landing state and the landing decision row

landing.json is validated strictly: `riskyPaths` and `checks[{name, command, timeoutMs?}]`. The landing state adds to
Jevellan's schema the project name and guidance, per-step summaries, totals, a `risky` flag per file and the policy's
`rules`; above 60,000 characters the file list is cut first (risky files are always kept), then the summaries, then
the task text. The decision row has `kind` `landing`, one `landing_route` question whose criteria come from the
policy's `## routes`, and `chosen_json` `{route, jevRoute, probabilities, rulesApplied, ruleReason?, source: 'jev'}`.
When a rules.json rule (D-032) changes the route, the landing reason starts "Jev chose <route> (<its criterion>)."
followed by the rule's reason; it used to quote the criterion of the route the rule chose, which Jev had not judged.

## D-048 A child task lands into its parent's branch

A task created with `--parent` was branched from the parent's branch, so landing it onto the default branch would have
moved main onto the parent's unfinished commits without the parent's own landing decision or checks (against J14).
`landingTarget()` makes the parent's branch the target: `refs/heads/<parent branch>` is merged into the child branch
and the checks run, then the parent branch moves in the parent's worktree by `merge --ff-only` after the touched files
are found clean there, otherwise the landing is refused. The default branch never moves for a child and nothing is
pushed. A child landing is refused (exit 2) when the parent is gone, discarded or already landed, or has no branch or
registered worktree. gc counts a landed child as landed when its branch is contained in the parent's branch.

## D-049 Answered and replaced ask-owner rows close as failed

An ask-owner landing row stayed `asked` after the owner decided, so the handoff, the coordinator and `jv task message`
kept offering an answered question, and "Land now" after a later failure refused. The schema has no answered state, so
such rows close as `failed` with a fixed reason: `landTask` closes them inside the lock, only after its preconditions
pass (a refused "Land now" leaves the question open), with "answered: Land now (jv land --force)" when forced and
"replaced by a new landing of the task" otherwise. Only the last landing row of a task can be an open question:
`askedLanding` returns it only when it is `asked`, and the handoff, `messageTask` and `answerTask` read only that row.
The evals export marks a row closed with one of these reasons as `stopped`, so it is skipped rather than becoming an
unlabelled failure. Asked rows written before this were left as they were.

## D-050 Discarding a task closes its open landings

`jv task stop --discard` closes an open verify-then-land landing (`failed`, "discarded by the owner") and an asked
landing (`failed`, "discarded by the owner (Leave it)"); otherwise the viewer showed the first as checking forever and
the handoff kept the second as a question.

## D-051 `jv gc`

gc handles done tasks with a `landed_commit` and stopped tasks, by `ended_at` against `retentionDays`. It removes a
worktree only when it is clean and its branch is contained in the default branch (or the parent's branch, D-048),
after moving `.jv-evidence/` and an untracked `plan.md` to the archive folder; everything else is moved with `git
worktree move` to `~/.jv/archive/worktrees/<project>/<name>-<date>`. `worktree_path` follows to the archive folder, or
becomes null when nothing was archived. Meta `gc:<T>` makes it handle each task once. It never prunes and never
touches a branch. The command has `--json`, `--dry-run` and `--project`.

## D-052 The coordinator's launch: fixed placement and the prompt file

The coordinator always runs on claude-main, `claude-opus-5-5`, effort high (fixed in code); start refuses (exit 2)
when providers.json does not list that model or effort. Its prompt goes through `--append-system-prompt-file`, not
`--agent`: `--agent jevellan-coordinator` loads the agent file, but the file cannot carry filled placeholders and
`{{project}}`, `{{path}}`, `{{default_branch}}` and `{{jv}}` reached the model unfilled.

## D-053 First-run dialogs are pre-accepted, by two helpers

Both first-run dialogs default to "No, exit", and a wake or a typed message would answer one. `jv coordinator start`
(`preacceptDialogs`) writes, before claude starts, `hasCompletedOnboarding`,
`projects["<cwd>"].hasTrustDialogAccepted` in `<home>/.claude.json` for both the stored checkout path and its
realpath, and `skipDangerousModePermissionPrompt` in `<home>/.claude/settings.json`. Workers use
`prepareClaudeInteractiveHome`, which sets `hasCompletedOnboarding`, `fullscreenUpsellSeenCount: 100` and trust for
both the main checkout of a worktree and the worktree itself, passes the bypass setting with `--settings` instead of
writing it, and refuses homes outside `$JV_HOME/homes`. Both are idempotent, keep every other key and write
atomically. They were left as two helpers.

## D-054 Remote Control only for a full login

Claude Code refuses Remote Control for a long-lived token login (findings 2026-11-01), which every Claude provider
with a tokenFile is (D-003, D-023). `--remote-control jv-coord-<project>` is therefore passed only for a
claude-subscription provider without a tokenFile; otherwise `jv coordinator status` reports Remote Control
"unavailable", quotes the refusal and names the command that would turn it on. Using Remote Control needs a full
claude.ai login in the claude-main home, which is the owner's call.

## D-055 The coordinator's session row and what counts as ours

The coordinator row has kind `coordinator`, runtime `claude-tmux`, `native_session_id` the uuid passed to
`--session-id`, request id `coordinator:<projectId>:<uuid>`, tmux target `=jv-coord-<project>:`, and pid and pgid of
the pane, so `markLost` covers it. Meta `coordinator:<projectId>` holds `{sessionId, projectId, projectName,
tmuxSession, promptFile, startedAt, stoppedAt?, remoteControl}`. A coordinator is ours when that record is live, the
row is starting or running, the tmux session exists and the pane's command line contains the R id; a tmux session with
our name that fails this is refused and left alone.

## D-056 Waking the coordinator

`notifyCoordinator` never throws. Meta `wake:<projectId>` holds `{lastSentAt, pending[], flusher{pid, dueAt}}` and is
read and written only in transactions; a flusher whose pid is gone, or which is 30 s past its due time, is taken over
by the next event. Wake lines are made into one line, cut to 500 characters and passed through the redactor.

## D-057 Restart, handoff and notes

Restart stops the session with `/exit`, then types "Handoff from your previous session: " literally and pastes the
handoff body (a tmux buffer pasted with `-p`, then Enter, so it arrives as one message). The handoff lists failed
tasks of the last 7 days; Jev refusals are pending steps whose `state_reason` starts with "Jev: ". `jv notes write`
refuses empty stdin or stdin that is a terminal, archives the previous notes to
`~/.jv/archive/<project>/notes/notes-<time>.md`, writes atomically with mode 600 through the redactor, and caps notes
at 256 KiB. `jv notes show --project N` prints them.

## D-058 The claude-tmux runtime

A claude-tmux row's pid and pgid are the pane process when jv starts a window; when a resume types into a live window
the pid stays the watcher's, because `isRunAlive` looks for the row id in the process command line. `--effort` is
passed when the session's effort is low, medium, high, xhigh or max, and left out otherwise. Read-only duties run with
`dontAsk` and D-026's tools and allowedTools, not bypassPermissions. If a launch fails before the prompt appears, the
generated native id is cleared from the row. A turn that ends with no report gets `NO_REPORT_PROMPT` once after an
8-second grace and, with still none, a synthesized `blocked` (D-028's backstop for this runtime); multi-line prompts
are sent as a bracketed paste rather than with `send-keys -l`. A window closes when its step is done or its task ends;
a step waiting on the owner keeps it, and only `jv-R<6>` names are ever killed (a finished task's window stayed open
before). claude-tmux workers and the claude-sdk takeover window of `jv attach` pass `--setting-sources user`, as the
SDK runtime does: Claude Code loads CLAUDE.md and `.claude/rules` from the ancestor folders of the cwd, and every
worktree is under the owner's home, so without it the owner's own `~/.claude/CLAUDE.md` and rules reached workers as
project instructions.

## D-059 The Codex runtime

It uses the Codex binary bundled with the SDK (0.166.0) everywhere, for the runtime, attach and login; `codex` on PATH
is 0.153.4. `project_doc_max_bytes` is 256 KiB and MCP servers are pre-approved (`default_tools_approval_mode:
approve`). The plan duty runs workspace-write without network and without the git directories, so it can write plan.md
but cannot commit; write duties also get the worktree's git directories. A provider whose environment has no
`CODEX_HOME` is refused (exit 2). `turn.completed` usage is treated as running thread totals and recorded as deltas,
as D-027 does for claude-sdk. "Instructions for this session:" is sent only with the first message of a thread;
resumes send the message alone. Codex is left out of the placement menu of a `--visible` step, which needs a tmux
window to watch; an owner override onto Codex is still allowed.

## D-060 The llm runtime

The Claude path uses the `claude_code` preset plus the append (section 6.1's form), with `tools: []`, `maxTurns: 1`,
no MCP, `dontAsk` and `settingSources: []`, so the Stop hook never blocks a tool-less turn. An openai-compatible
conversation gets a made-up native id `llm-<uuid>` so its resume rows can find each other, and its history is the
earlier rows' `message` events that carry a role. A provider that refuses `reasoning_effort` gets the effort as a line
of the system message instead, and meta `llm_effort:<provider>=refused` remembers that. An invalid report block is
synthesized the same way as a missing one.

## D-061 `jv providers check`, usage rows and `jv providers login`

Each configured model is matched to an offered one by id, else by the first word of its label (for example "Opus"); a
match keeps its label, efforts and maxTokens. Unmatched models are dropped unless nothing matched at all. Offered
models nobody configured are listed, never added, because they would have no policy description. "same as" lists are
kept, and providers.json is written only on change, mode 600. The fix text depends on the case: an unreachable
endpoint gets "make sure <url> is reachable or set enabled false", a provider with no key file named gets "name a
keyFile", and a missing key gets "write the key" (an unreachable ollama was told to write its key). `local` usage rows
are written only for openai-compatible providers, because a subscription's probe would be hidden by them. A Claude
subscription without a tokenFile is probed with the access token of the home's `.credentials.json`; when that token
expired, the provider counts as ready with no usage. `jv providers login` refuses providers that log in with a
tokenFile or key file and names the file to write; its tmux name `jv-login-<name>` is a third tmux name pattern.

## D-062 `jv attach`

`jv attach` marks the newest run of the conversation `waiting` ("attached by owner"), for codex as for claude-sdk. It
refuses while a turn is running and refuses llm sessions. Inside tmux it uses `switch-client`.

## D-063 The viewer reads the store on its own read-only connection

The viewer never calls `Store.open`: it has its own `DatabaseSync(file, {readOnly: true})` connection and checks the
schema version (another schema is exit 2 at start; a missing store gives 503 until it appears). Lost is computed at
read time the way `markLost` decides it (`isRunAlive` plus no `end` event) and never written. The live stream polls
each second: `PRAGMA data_version` plus the set of starting or running sessions whose process is gone; on `change` the
page fetches its endpoint again and patches the DOM in place. The current step is the running or retrying step, else
the step at the `tasks.current_step` ordinal (unless skipped), else the first pending step, else the last step that
was not skipped. `state_json` is never served and all JSON goes through `defaultRedactor().redactValue`.

## D-064 Viewer binding, host guard, evidence and headers

`--bind` takes exactly one IP address of this machine (`localhost` maps to 127.0.0.1); `0.0.0.0`, `::` and hostnames
are refused with exit 2. Against DNS rebinding, the Host header must be an IP literal, localhost, `os.hostname()` (or
a name starting with it) or a `*.ts.net` name; anything else gets 403. Evidence is served only from the task's
`worktree_path`: every path segment a plain name, the folder's realpath inside the worktree and the file's inside the
folder, an image extension plus a matching byte signature (png, jpeg, gif, webp, avif), served as the sniffed type, at
most 32 MB; every refusal is a 404 that names no path. A report screenshot gets a `url` only when it is an image under
`.jv-evidence/`. Headers: CSP `default-src 'none'; script-src 'self'; style-src 'self'` with no inline styles (bar
widths are set by script from `data-w`), nosniff, no-referrer and DENY framing.

## D-065 Viewer text

The Markdown renderer escapes everything first, allows links to http(s), site paths and anchors only, turns images
into links and renders headings two levels smaller. Every date and clock uses the 24-hour clock. The page's text
helpers live in `ui/format.js` (pure functions) so the unit tests can import them. An event with a result but no tool
call shows its own name, its command and ok or error (the worktree-setup event was a blank "result" row). Unknown
usage values are left out of sentences ("five hours -" read as a value); the usage meter still shows "-" in its
column. The note for hidden tasks names both reasons: "stopped, or ended more than a day ago".

## D-066 Acceptance scripts for phases 4 to 8

`acceptance/phase4-feature.mjs`, `phase5-landing.mjs`, `phase6-coordinator.mjs`, `phase7-runtimes.mjs` and
`phase8-viewer.mjs` are kept and rerunnable (phases 4 to 7 take `--only`, `--tag` and `--timeout-min`, and phases 4,
5 and 7 run against a clone named by `JV_ACCEPT_CLONE`; phase 8 is `phase8-viewer.mjs <T> [--url] [--shots] [--widths]
[--schemes]`). Request ids are `acceptance-phase<N>-<check>-<tag>`, so a rerun with the same tag picks
up the same tasks. Phase 4 answers a step's needs-decision with its first option, at most three times. Phase 7 moves
the lost-check task to claude-sdk with an owner override (Sonnet low) when Jev places it elsewhere, because J7 is
about the default runtime. The coordinator script refuses to start while a coordinator session exists. The clone
(`sandbox-clone`, push URL `/nonexistent/no-push`) has `testCommand` `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test`,
because the sandbox's bare `npm test` fails by design in a clean environment; the real sandbox needs the same setting
before J4.

## D-067 The evals replay and its exit codes

The replay is `src/evals.ts` in the runtime; each policy skill's `evals/run.mjs` is a thin plain-JS wrapper that loads
it from the installed runtime's dist (`--runtime DIST` or `JV_EVALS_RUNTIME` points at another build), so both skills
run the same code with no build. Exit 0 is pass, 1 is held-out agreement below `evals/threshold.json` (`{"heldOut":
0.6}` for both skills), and 2 is a run that cannot be made (no key, a Jev failure, an invalid file). The replay also
refreshes `state.menu.models[].description` from the current policy and asks the provider question again in a second
call with the stored criteria; a case the current policy cannot express is listed as stale and not scored.

## D-068 Which decision rows become eval cases

A placement is a success when its outcome is done on the attempt it was placed for; failed, blocked, or done only
after more attempts gives source failed with expected null. Pending and stopped rows are skipped, and so are rows that
asked nothing (`only-option`), owner placements (D-033) and answered or replaced asks (D-049). Workflow rows are
labelled by how the task ended, because nothing writes `outcome_json` for them; landing rows by their landings row
(landed is a success, failed a failure), linked through `decision_id`. Every fifth eligible row by creation order is
held-out, the rest dev, and the position counts every eligible row, not only those after `--since`, so a decision
keeps its split across exports. Merging keeps hand cases and older exports, replaces by decision id, and keeps a
person's label when a failed case is exported again unlabelled.

## D-069 The Skillio runner contract

Skillio runs a skill's own evals when its frontmatter has `jv-eval-runner: evals/run.mjs` (a relative path inside the
skill folder that exists); trigger evals are skipped only when `disable-model-invocation: true` is also set. It calls
`<node> evals/run.mjs --split all|tuning|held-out` from the skill folder, with Claude Code session variables removed
and HOME and PATH kept; `tuning` is our `dev` split, which `run.mjs` maps. Its tags map to splits: `held-out` or
`<skill>:held-out` to held-out, `tuning` or `<skill>:tuning` to tuning, anything else to all, and trigger-only tags
exit 0 without running. The runner prints `<split> agreement: <n>%` lines (`held-out`, `tuning`, `all`) and a bare
`agreement:` line for the split it ran, and exits 0 at or above its threshold and 1 below it; any other exit is a
runner failure. A change is kept only if held-out agreement beats the baseline run by more than the noise and the
runner still exits 0. Skillio's side is https://github.com/gongiskhan/skillio/pull/2 (not merged).

## D-070 The coordinator loads the provider home's settings only, and its prompt carries AGENTS.md

The coordinator runs in the project checkout, which is under the owner's home, and Claude Code loads CLAUDE.md and
`.claude/rules` from every ancestor folder of its cwd, so the owner's own `~/.claude/CLAUDE.md` and rules reached it
as project instructions (findings: its voice was overridden). It is now started with `--setting-sources user`, as
the workers are (D-058). With project instructions no longer loaded, `coordinator-prompt.md` gets the project's
`AGENTS.md` after the skill body and before the handoff, under "# This project's AGENTS.md": the first 32 KiB, a
longer file cut with the same note `prompt.projectInstructions` uses for workers, through the redactor. User scope is
`<claude-main home>/.claude/`, where seed() installs the fourteen `jevellan-*` skills, the coordinator agent and the
Stop hook (D-015, D-008), so all of them still load (checked on dev-madrid after jv update: the home's skill copies
match `~/.jv/skills`); only the project's APM-merged `.claude/settings.json` hook is dropped, which exits 0 for the
coordinator anyway (D-016).

## D-071 The coordinator's own login and Remote Control (amends D-023, D-054 and D-061)

A `.credentials.json` in a Claude home is "seeded" only while seeds-applied.json lists it under `files`, it still has
the recorded byte size, and no `archived` entry has moved it away since; any other file there is a login of the
home's own (`claudeLoginOrigin`). When in doubt it counts as the owner's, because jv must never archive a login it did
not copy.
When claude-main has a tokenFile and its home holds its own login, the coordinator runs on that login: `jv exec
--home-login` builds its environment without `CLAUDE_CODE_OAUTH_TOKEN`, and claude gets `--remote-control
jv-<project>` (the task's name for it; D-054 named it `jv-coord-<project>`, which stays the tmux name). Otherwise it
runs as before: no tokenFile means the home's login and Remote Control; a tokenFile alone means the token and no
Remote Control, and `jv coordinator status` prints exactly `jv providers login claude-main` as the command that
turns it on (recomputed at each status, and `jv coordinator restart --project N` once that login exists). `jv
providers login claude-main` is no longer refused for its tokenFile: it runs `claude auth login` under `--home-login`
in `jv-login-claude-main`; every other provider with a tokenFile is still refused with the file to write. Workers never
get `--home-login`, so the token wins for them (D-003). D-023's concern was a second live copy of Jevellan's refresh
token; a login made in the home is its own grant. The archive step of D-023 now moves only a seeded copy: once
archived, a file at that path is never archived or moved again, which fixes `jv update` archiving a login the owner
made after an earlier archive (claude-second's record on dev-madrid had exactly that shape).

## D-072 What "production behaviour" means in the landing policy

Jev sent the invoice-count change of 1 November (DKW70WF: five small files, unit and browser checks passed, no risky
paths) to ask-owner at 0.88. The three route criteria stay verbatim; `landing_route` and the Production rule now say
that landing only puts a change on the default branch for the owner to release later, that production behaviour
means deployed systems, live data, credentials, billing, infrastructure and deploy configuration, and not ordinary
feature, UI, test or documentation changes, that such a change, small, outside the risky areas and covered by the
passing checks, lands, and that a behaviour change the checks do not exercise is verify-then-land. Measured with the
11 cases (4 new hand cases, all dev, so held-out stays the same 2): before 9/11, held-out 2/2; with the production
wording alone still 9/11 (the invoice case fell to ask-owner 0.69, the deploy case moved further to
verify-then-land, 0.69). Two more sentences were needed and kept: a change to production behaviour goes to the owner
however small, because no pre-landing check exercises a deployed system (deploy case back to ask-owner, 0.59); and a
change that only displays something about a risky area (money here) without changing how it is computed, stored,
charged or sent does not touch it, since "invoices" in the money list was what kept the real case at ask-owner. Final
run 11/11, held-out 2/2; migration 0.94 and session expiry 0.92 stay ask-owner.

## D-073 jv doctor checks the Stop hook of registered projects only

The hook line looks up the registered project whose checkout holds the current directory (symlinks resolved, the
longest match); anywhere else it is OK with "not inside a registered project; skipped" and no fix. Telling the owner
to run `apm install` in an arbitrary repository would write a `.claude/` folder there, this package's checkout
included. Task worktrees under `~/.jv/worktrees` are not checkouts of a project and are skipped too.

## D-074 jv exec installs its signal handlers before it spawns the child

`exec.test.ts` "SIGTERM to jv exec reaches the child" failed 6 times in 30 runs under CPU load (exit code null: jv
exec itself died of SIGTERM). The handlers were installed right after `spawn()` returned, but the child runs as soon
as it is forked: it printed "ready", the test sent SIGTERM, and the default action killed jv exec in that window,
leaving the child running on its own. The same window exists for tmux and the owner. runExec now installs the
forwarding and ignoring handlers first and delivers a signal that arrived before the child existed right after the
spawn; 0 failures in 30 runs under the same load.

## D-075 A takeover is imported before the run resumes (amends D-062)

`jv attach` on a claude-sdk run records meta `takeover:<R>` = `{file, offset, at}`: the conversation's transcript
(`<provider home>/.claude/projects/<cwd slug>/<native id>.jsonl`) and its size then. `jv task resume` on that waiting
run first imports what was appended after that offset as events of the attached run, every payload with `source:
"takeover"`: what the owner typed as `message` (from owner, role user; slash-command markup and meta records left
out), assistant text and thinking, tool calls and results (trimmed as D-027), each at its transcript timestamp; then
the run is done with "the owner ended the takeover; N transcript entries imported (M typed by the owner)" and the new
turn continues the same native session. While the takeover window (`jv-<R>`) is still open the run stays waiting,
its reason names the window, and the resume exits 4: two writers on one conversation would interleave, as attach
refuses while a turn runs. An import is recorded in the meta row and happens once. A run attached before this has no
offset; then the entries later than its last event are taken. No usage is imported (the SDK's cumulative totals of the
next turn are counted as D-027 says). Codex takeovers are only marked done, as before. Not yet seen on dev-madrid:
that `claude --resume <id>` in the takeover window appends to the same file (findings list it as not exercised); if
it wrote elsewhere, nothing would be imported and the reason would say nothing was typed.

## D-076 "Land now" on a merge conflict resolves it in an appended step

Section 8 routes a merge conflict on the land route to ask-owner, and the owner's "Land now" runs `jv land --force`,
which merges again and hit the same conflict, so the owner was asked the same question forever and a conflicting
task could never land. Three parallel tasks that each add a CHANGELOG line (the sandbox's guidance asks for one per
change) conflict on the second and third landings, so J4 would have stopped there. A forced landing (meta
`landing_forced:<L>`) whose merge conflicts now appends one implement step, placed by Jev like any step, whose
instructions (`land.resolveConflictInstructions`) say to merge the target branch, resolve the conflicts keeping both
sides' intent, run the tests of the conflicted files and commit; the landing row waits in checking with the step in
meta `landing_step:<L>`, the same mechanism as verify-then-land's verify step, and landing (merge, checks,
fast-forward) continues when the step is done. A second conflict on the same landing row asks the owner again, so
nothing loops without the owner. The first conflict still asks the owner, as section 8 says.

## D-077 The user's home is read from the user database, never from HOME

paths.ts resolved `~`, the default JV_HOME, the `~/.jevellan*` folders and "the user's home folder" of the provider
home check from `os.homedir()`, which is HOME. Every jv command the coordinator runs has HOME set to the claude-main
provider home, so `providerHomeProblem` saw `$JV_HOME/homes/claude-main` as the user's home and every `jv task create`
from the coordinator exited 2 with "providers.claude-main.home ... is the user's home folder" (J4, the first command
the coordinator ran that loads providers.json). `paths.userHome()` now reads the home from the user database
(`os.userInfo().homedir`, falling back to HOME only without a passwd entry), and `env.ownerHome()` uses it.

## D-078 A single task whose step committed lands (amends the section 4 state rule)

Section 4 makes a `single` task `done` when its step reports done, and the coordinator's prompt (section 9.2)
recommends `single --duty document` for documentation. The two together stranded documentation on its task branch:
in J4 the coordinator made the README "How to run" request a single document task, the worker committed the section
on `jv/...`, the task was done, and nothing ever reached main. `advance.finishSteps` now sends a single task to
landing (the same automatic `jv land`, Jev's route and the checks) when its branch names a commit other than its base
(`advance.singleHasCommits`); a single task that committed nothing (investigate, answer, plan, or a document step
that found nothing to change) is done when its step is, as before.

## D-079 git fetch at task creation runs with the owner's HOME

The fetch before `git worktree add` (section 7.1) inherited HOME from the caller; from the coordinator that is the
claude-main provider home, which has no `.gitconfig` and so no credential helper, and every fetch failed with
"could not read Username" (the worktree still started from the local default branch, with a warning the
coordinator passed on to the owner as a credentials problem). `git.fetchEnv()` sets HOME to the owner's home
(D-077) for the fetch only; worktree, merge and fast-forward commands keep their environment so the owner's commit
settings do not reach landing commits.

## D-080 The viewer sends Cross-Origin-Opener-Policy on loopback only

Browsers honour COOP only on a trustworthy origin (HTTPS or loopback). On `jv ui --bind <tailnet ip>`, plain HTTP to
the phone, Chrome ignored the header and logged a console error on every page (J16). `ui/server.securityHeaderSet`
leaves COOP out unless the viewer is bound to loopback; nosniff, no-referrer, frame DENY and CORP same-origin stay on
every address. The session page's end event also stops repeating the report state its reason already names.

## D-081 jv bootstrap and jv update answer --help and refuse unknown arguments

`bin/bootstrap.mjs` ignored every argument it did not know, so `jv update --help` ran a full update (seen in J4:
it rebuilt and reinstalled the runtime). `--help` and `-h` now print the usage line
(`jv update [--rebuild] [--source DIR] [--json]`) and exit 0, and any other unknown argument, or `--source` without
a folder, exits 2 naming it, before the lock, the build or the delegation to the source's bootstrap. The usage
lines in the CLI's command table say the same.

## D-082 A closed landing question keeps why it was asked

Closing an asked landing row replaced its reason with the answer ("answered: Land now (jv land --force)"), so the
reason Jev's route asked (in J4 "merge conflict: ... conflicts in CHANGELOG.md") survived only in the wake line and
the coordinator's transcript. `land.closeAskedLandings` now writes `<answer>; asked: <reason>`, so the viewer and
`jv evals landing` still read it. `land.isClosedAsk` recognises both that form and the bare answers of rows closed
before this change; `evals.decisionVerdict` uses it, so an answered ask is still skipped as stopped.

## D-083 jv status leaves out tasks the owner discarded

A task reaches `stopped` only through `jv task stop --discard` ("Leave it"), the owner's own decision; nothing
waits on it. `jv status` listed such tasks among the open ones for 24 hours (TQ9JMCZ in J4 to J17), while the
viewer's first page and the handoff already left them out. `status.statusView` now leaves them out like done
tasks; failed tasks are still listed for 24 hours, since the owner may resume them. The store keeps everything, and
`jv task show` still shows a discarded task.
