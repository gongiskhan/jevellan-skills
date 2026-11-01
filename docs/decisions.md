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
