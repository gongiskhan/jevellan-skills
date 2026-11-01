# jevellan-skills

A package of Claude Code skills plus one small runtime, the `jv` command, that turn an ordinary interactive Claude
Code session into the coordinator of one software project.

- **The coordinator** is a Claude Code session in tmux, one per project. You talk to it; it does not write code. It
  turns each piece of work into a task, answers what it can from the repository, keeps notes, and asks you only what
  is yours to decide.
- **Duties.** A task runs as a sequence of steps from a workflow (feature, bug, automation, or a single step), and
  each step is one duty - plan, implement, verify, document, investigate, automate, answer or converse - run as its own
  session. A task that works on the repository gets its own git worktree and branch.
- **Jev placement.** Jev is a decision service that answers multiple-choice questions with probabilities. For every
  step, the router asks Jev, with the placement policy in the `jevellan-router` skill, which model, effort and provider
  account to use; the runtime follows from that choice: `claude-sdk` (the Claude Agent SDK, the default),
  `claude-tmux` (interactive Claude Code in tmux, for steps you want to watch), `codex` (the Codex SDK) or `llm` (one
  plain call, for answers and conversation). When the last step is done, Jev reads the landing policy and the branch
  lands, gets one more verification first, or waits for you. There is no fallback table: no Jev, no placement.
- **One SQLite store.** Every session on every runtime is one row in `~/.jv/store.sqlite`, with its events, its
  report and the id to resume it. The store is the only state and the only history.
- **The viewer.** `jv ui` is a read-only web page over the store: tasks, steps, sessions, decisions and usage.

## Requirements

- Linux (the runtime is developed and tested there) with git and tmux.
- Node 22.13 or later (the store uses the built-in `node:sqlite`).
- Claude Code (`claude` on PATH) and at least one Claude account, or an Anthropic-compatible endpoint.
- Optional: Codex, for a ChatGPT account as a provider (the runtime uses the Codex binary bundled with its SDK).
- A Jev API key.
- APM, to install the skills into a project, or npm.
- Optional: Tailscale, to read the viewer on a phone. Browser journeys in verify and automate steps use the
  project's own Playwright.

## Install

With APM, in the project the coordinator will work on:

```sh
apm install gongiskhan/jevellan-skills --target claude
```

This writes the 14 `jevellan-*` skills to `.claude/skills/` (the router skill carries the runtime source under
`scripts/jv/`), the coordinator agent to `.claude/agents/jevellan-coordinator.md`, and merges the Stop hook into
`.claude/settings.json`. Keep `.claude/` untracked (gitignore it).

Without APM:

```sh
npm install -g github:gongiskhan/jevellan-skills
```

Both end in the same `bin/jv.mjs`, which installs the runtime into `~/.jv/` on first use.

## First run

1. Bootstrap, with a Node 22.13 or later first on PATH:

   ```sh
   node .claude/skills/jevellan-router/scripts/jv/bin/jv.mjs bootstrap   # after APM, in the project
   jv bootstrap                                                          # after npm
   ```

   The bootstrap builds the runtime into `~/.jv/runtimes/`, copies the skills to `~/.jv/skill-sets/`, switches the
   `~/.jv/runtime` and `~/.jv/skills` links to them, writes the shim `~/.jv/bin/jv` (it runs the runtime with the Node
   binary the bootstrap ran with), writes `~/.jv/providers.json` from the template when it is missing, prepares one
   home per provider and installs the Stop hook, the skills and the coordinator agent into every Claude provider home.

2. Put the shim on PATH (the bootstrap prints the exact line), ahead of npm's global bin, in `~/.profile` or your
   shell's rc file:

   ```sh
   export PATH="$HOME/.jv/bin:$PATH"
   ```

3. Run `jv doctor` inside the project checkout. Each line is OK, WARN or FAIL with the fix; the command exits 2
   while anything fails. On a fresh install expect FAIL for `jev` (no key yet) and WARN for providers without key
   files. `jv doctor --check jev` runs one group.

4. Edit `~/.jv/providers.json` (mode 600). Keep the providers you have and set `"enabled": false` on the others.
   It never holds a secret: keys live in files under `~/.jv/secrets/` (folder mode 700, files mode 600). Write each
   one without putting it on a command line or in shell history:

   ```sh
   (umask 077 && cat > ~/.jv/secrets/jev.key)   # paste the key, Enter, Ctrl-D
   ```

   `jev.keyFile` names that file and `jev.model` the Jev model (`jev-latest`). A Claude account signs in either
   with `jv providers login <name>` (a full claude.ai login kept in its home) or with a long-lived token from
   `claude setup-token`, written the same way to `~/.jv/secrets/<name>.token` and named by
   `"tokenFile": "~/.jv/secrets/<name>.token"` in its entry. A token login cannot use Remote Control (see below).

5. Check the providers:

   ```sh
   jv providers check
   jv providers login <name>      # for each provider the check shows as "needs login"
   ```

   The check probes each enabled provider's login and usage, fills its model list from what the login offers
   (keeping the labels and efforts of providers.json), and checks that Jev answers and lists its model.
   `jv providers login` opens the tmux session `jv-login-<name>` under that provider's home for you to sign in once.

6. Register the project:

   ```sh
   jv project add <path> [--name N]
   ```

   It writes `~/.jv/projects/<name>/` (`project.json` with `testCommand` and `devCommand` guessed from
   package.json, `landing.json`, `notes.md`, `workflows/`) and adds `/.jv-evidence/` and `/plan.md` (and `.claude/` and
   `CLAUDE.md` when the repository does not ignore them already) to the repository's `.git/info/exclude`. It never
   edits the checkout. Check `testCommand` in project.json.

7. Start the coordinator and talk to it:

   ```sh
   jv coordinator start --project <name>
   jv coordinator status --project <name>     # prints the attach command
   tmux attach -t '=jv-coord-<name>'
   ```

   It runs in the tmux session `jv-coord-<name>` in the project checkout, on `claude-main` with `claude-opus-5-5`
   at high effort (providers.json must list both). Its prompt is the coordinator skill, the project's `AGENTS.md` and
   the handoff. Ask it for "status", or give it work.

8. Open the viewer: `jv ui`, then http://127.0.0.1:7071.

## Commands

Every command accepts `--json`. Exit codes: 0 ok, 2 refused with a reason, 3 not found, 4 conflict (a request id
reused with different input).

```
jv doctor [--check NAME]                    preflights
jv project add <path> [--name N] | jv project list
jv providers check | jv providers login <name>
jv status [--project N]                     what is not done, waiting-on-owner first
jv task create --project N --kind feature|bug|automation|single [--duty D] --title T (--text "..." | --file F)
               [--parent T] [--after T] [--visible] [--request-id ID]
jv task show|resume T
jv task message T "text"                    to the running or next session of the task
jv task answer T "<option or text>"         answers a needs-decision; the task continues
jv task stop T [--discard]                  --discard also stops the task; the worktree stays
jv task override T --model M [--effort E] [--provider P] --undo|--keep
jv land T [--force]
jv report R | jv tail R [--follow] | jv attach R
jv ui [--port 7071] [--bind ADDRESS]
jv coordinator start|stop|restart|status --project N
jv handoff --project N
jv notes write --project N < text | jv notes show --project N
jv evals route|landing [--since DATE] [--out FILE]
jv usage [--week W]
jv gc [--project N] [--dry-run]
jv update | jv --version
```

`--undo` stops the running step and restarts it on your placement; `--keep` only records the override on the
decision row. `jv attach` opens a session in tmux (for a `claude-sdk` or `codex` session, the same conversation in the
interactive CLI); `jv task resume T` continues after you leave it.

## Nightly restart

The coordinator restarts from a handoff built from the store and its notes: `jv coordinator restart` types `/exit`,
starts a new session and pastes the handoff as its first message. jv schedules nothing itself; add one cron line
(`crontab -e`):

```
PATH=<dir of claude>:<dir of tmux>:/usr/bin:/bin
0 4 * * * $HOME/.jv/bin/jv coordinator restart --project <name>
```

cron runs with `PATH=/usr/bin:/bin`, which usually lacks `claude`, and the restart stops the old session before it
looks for `claude`, so without the `PATH=` line the coordinator stays down. cron does not expand variables in that
line: write the directories out (`command -v claude tmux` prints them).

## Adding a provider

1. Add an entry to `providers` in `~/.jv/providers.json`. Unknown keys are refused, so a typo fails loudly. Fields
   every kind takes: `name`, `kind`, `models` (a list of `{"id", "label", "efforts", "maxTokens"?}` or
   `"same as <provider>"`), `enabled` (default true), `ceilingPct` (default 90: a subscription at or over this share
   of its five-hour or weekly limit leaves the menu) and `paidUse` (`always`, `never` or
   `when-subscriptions-run-out`, for metered providers). Efforts are `low`, `medium`, `high`, `xhigh` and `max`. A
   `home` must be a folder inside `~/.jv/homes/`.
2. Write its key file (mode 600) or sign it in.
3. Give every model id a line in the router policy's `## model descriptions` section (`<model id>: <when to use
   it>`): Jev chooses from those lines, and placement refuses a menu model that has none. The runtime reads its copy
   at `~/.jv/skills/jevellan-router/SKILL.md`; edit the package's `SKILL.md` (in a checkout of this repository, see
   "The eval loop") and run `jv update`.
4. Run `jv providers check`, then `jv doctor`.

The four kinds:

**claude-subscription** - a claude.ai account. Its home holds the login; it runs `claude-sdk`, `claude-tmux` and
`llm`.

```json
{ "name": "claude-third", "kind": "claude-subscription", "home": "~/.jv/homes/claude-third", "ceilingPct": 90,
  "models": "same as claude-main" }
```

Sign in with `jv providers login claude-third`, or put a `claude setup-token` token in
`~/.jv/secrets/claude-third.token` and add `"tokenFile": "~/.jv/secrets/claude-third.token"`.

**claude-endpoint** - Claude Code against an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`, the key as
`ANTHROPIC_AUTH_TOKEN`, the model ids as the default models). `home` is optional (default `~/.jv/homes/<name>`);
metered by default.

```json
{ "name": "glm", "kind": "claude-endpoint", "baseUrl": "https://api.z.ai/api/anthropic",
  "keyFile": "~/.jv/secrets/glm.key",
  "models": [ { "id": "glm-5.3", "label": "GLM", "efforts": ["low", "medium", "high"] } ] }
```

Key file: `~/.jv/secrets/glm.key`, the endpoint's API key.

**codex-subscription** - a ChatGPT account through Codex. No key file.

```json
{ "name": "codex-second", "kind": "codex-subscription", "home": "~/.jv/homes/codex-second", "ceilingPct": 90,
  "models": "same as codex" }
```

Sign in with `jv providers login codex-second`.

**openai-compatible** - any `POST <baseUrl>/chat/completions` API. It runs only the `llm` runtime, so it serves the
answer and converse duties. `keyFile` is optional and `maxTokens` is sent as `max_tokens`.

```json
{ "name": "deepseek", "kind": "openai-compatible", "baseUrl": "https://api.deepseek.com",
  "keyFile": "~/.jv/secrets/deepseek.key",
  "models": [ { "id": "deepseek-chat", "label": "DeepSeek", "efforts": ["low", "medium", "high"], "maxTokens": 8192 } ] }
```

Key file: `~/.jv/secrets/deepseek.key`. A local Ollama needs none: `"baseUrl": "http://127.0.0.1:11434/v1"`,
`"metered": false`.

## Project settings

`~/.jv/projects/<name>/project.json`:

| key | meaning |
| --- | --- |
| `testCommand` | the project's test command; the default landing check |
| `devCommand` | the dev server command verify and automate steps use |
| `automationDir` | where automate steps put scripts (default `automations/`) |
| `setupCommand` | runs once per worktree before its first turn; absent means `npm ci` when package-lock.json exists, `null` runs nothing |
| `pushAfterLanding` | push the default branch to origin after a landing (default false) |
| `retentionDays` | how long `jv gc` keeps worktrees of finished tasks (default 3) |
| `guidance` | text Jev reads with every placement and landing of the project |
| `mcpServers` | the project's MCP servers for workers (`jv` is reserved) |

`commitPlan` is in the template but not read in 0.1.0: `plan.md` stays excluded and is never committed.

### landing.json

```json
{ "riskyPaths": ["migrations/", "src/billing"],
  "checks": [ { "name": "tests", "command": "npm test", "timeoutMs": 1200000 },
              { "name": "browser", "command": "npm run test:browser" } ] }
```

A changed file at or under a risky path is marked risky in the landing state; the landing policy sends such changes
to you. The checks run in the task worktree after the default branch is merged in and before the default branch moves;
with no checks, `testCommand` is the check. The default timeout is 30 minutes.

### rules.json

Your standing rules, applied after Jev answers and recorded on the decision row:

```json
{ "rules": [
  { "id": "R1", "when": { "kind": "feature", "keywords": ["payment", "checkout"] },
    "set": { "minEffort": "high", "landingRoute": "ask-owner" }, "note": "Payments always wait for me." },
  { "id": "R2", "when": { "duty": "document" }, "set": { "maxEffort": "medium" } }
] }
```

`when` matches on task kind, step duty and keywords (any of them in the title or text, ignoring case); an empty `when`
matches everything. `minEffort` and `maxEffort` bound the effort, `landingRoute` replaces Jev's route. The most
specific matching rule wins; `"enabled": false` turns a rule off. An invalid file refuses placement with exit 2.

## Overriding a workflow

The package workflows are in `~/.jv/skills/jevellan-workflow-<kind>/workflow.json`. To change one for a project,
copy it to `~/.jv/projects/<name>/workflows/<kind>.json` and edit it:

```json
{ "name": "bug", "steps": [
  { "duty": "implement", "instructions": "Reproduce first with a failing test, then fix. Commit on the task branch." },
  { "duty": "verify", "visible": true,
    "instructions": "Run the project's test command and the browser journey for the affected screen. Save evidence to .jv-evidence/.",
    "onFail": { "goto": "implement", "maxLoops": 3 } },
  { "duty": "document", "when": "jev:needs_docs", "instructions": "Update the README for what changed. Nothing else." }
] }
```

- `duty`: one of the eight duty skills.
- `when`: `always` (the default) or `jev:<id>`, a yes-or-no question Jev answers at task creation; the id needs a
  line in the router policy's `## questions` (`needs_plan` and `needs_docs` ship). A no skips the step.
- `onFail`: when the step fails (for verify, also when its tests did not pass), go back to the named step, at most
  `maxLoops` times (0 to 10, default 2), then the task fails.
- `visible`: run this step on `claude-tmux`, so you can watch it and attach.

Unknown keys are refused. The workflow is read once, at task creation; `jv task create` prints the file it used.

## Remote Control

The coordinator asks for Remote Control (`--remote-control jv-<name>`) only when it runs on a full claude.ai login
of `claude-main`: Claude Code refuses Remote Control for a long-lived token. To give it one:

1. `jv providers login claude-main` and sign in, in the tmux session `jv-login-claude-main`. When `claude-main` has a
   `tokenFile`, this login (`claude auth login`, with no token in its environment) is the coordinator's own, and
   `claude-main`'s workers keep signing in with the token.
2. `jv coordinator restart --project <name>`.
3. `jv coordinator status --project <name>` shows the Remote Control state; if it is not on, attach and type
   `/remote-control`. In the Claude app the session is named `jv-<name>`.

## The viewer on the phone

`jv ui` binds to 127.0.0.1:7071. To read it over Tailscale, bind it to this machine's tailnet address
(`tailscale ip -4`) and open `http://<tailnet ip>:7071` on the phone:

```sh
jv ui --bind <tailnet ip>
```

`--bind` takes exactly one address of this machine; `0.0.0.0` and `::` are refused. The page is read-only - it has no
buttons and no forms - but anyone who can reach the address can read it.

## The eval loop

The router and landing policies are plain text that Jev reads, so they are measured by replaying stored decisions
against the current text. Work in a checkout of this repository and bootstrap from it (`node
.apm/skills/jevellan-router/scripts/jv/bin/jv.mjs bootstrap`): `jv evals` writes cases into the package copy that
`~/.jv/install.json` names, `jv update` installs from it, and `evals/run.mjs` replays the `SKILL.md` next to it.

1. `jv evals route --since 2026-11-01` exports decisions into `evals/cases.json`. The expected answer is your
   override when there is one, else Jev's answer when the step was done on its first attempt; a failed step gives a
   case with `expected: null` for you to label. Every fifth case is held out. Cases written by hand and your labels
   are kept on later exports; `--out FILE` writes elsewhere.
2. `node .apm/skills/jevellan-router/evals/run.mjs` replays the policy as it is in the checkout through Jev (real
   calls), prints agreement per question for the dev and held-out splits and every disagreement with Jev's
   probabilities, and writes `evals/RESULTS.md` with the policy hash and the date. It exits 1 when held-out agreement
   is below `evals/threshold.json` and 2 when it cannot run. Flags: `--split held-out|dev|all`, `--cases FILE`,
   `--results FILE`, `--json`, `--runtime DIST`. This is the baseline.
3. Read the disagreements.
4. Edit the policy, `.apm/skills/jevellan-router/SKILL.md`, changing one thing. The script reads the sections
   `## model`, `## model descriptions`, `## effort`, `## effort guide`, `## questions` and `## rules`; the rest is for
   people.
5. Run `run.mjs` again, and repeat from 3.
6. Commit when held-out agreement improves, then `jv update`: placement reads `~/.jv/skills/`, not the checkout.

The replay runs the installed runtime's `dist/evals.js`, so after a change to the runtime itself, `jv update` before
replaying.

The landing policy is the same loop: `.apm/skills/jevellan-landing/SKILL.md` (sections `## landing_route`,
`## routes`, `## rules`), `jv evals landing --since DATE` and `node .apm/skills/jevellan-landing/evals/run.mjs`.

Skillio: both policy skills declare `jv-eval-runner: evals/run.mjs` and `disable-model-invocation: true`, so
Skillio's `checking-skills` and `improving-skills` skip trigger evals for them and run `node evals/run.mjs --split
all|tuning|held-out` from the skill folder as the outcome runner (`tuning` is the dev split). A change is kept only
when held-out agreement beats the baseline by more than the noise and the runner still exits 0. Skillio's side of this
is pull request 2 on gongiskhan/skillio (open at this release). The coordinator and workflow skills have ordinary
Skillio cases under their `evals/` folders.

## Where things live

```
~/.jv/                       JV_HOME overrides it
  store.sqlite               the store (WAL)
  providers.json             providers and Jev, no secrets (mode 600)
  secrets/                   key and token files (folder 700, files 600)
  bin/jv                     the shim on PATH
  runtime -> runtimes/<id>   the built runtime; each bootstrap switches the link atomically
  skills -> skill-sets/<id>  the jevellan-* skills the runtime reads
  install.json               what was installed, from where
  homes/<provider>/          HOME of that provider's sessions (.claude/ or .codex/ inside)
  projects/<name>/           project.json, landing.json, rules.json, notes.md, workflows/, coordinator-prompt.md,
                             tasks/<T>/task.md
  worktrees/<project>/<slug>/  task worktrees, on branches jv/<slug>-<task id>
  logs/<session id>.log      raw runtime output, never shown in the viewer
  archive/                   whatever jv moves aside instead of deleting
  seeds.json                 optional: provider name -> a folder to copy an existing login from, once
```

Workers save screenshots and test output to `<worktree>/.jv-evidence/`, which is never committed.

The store has the tables `projects`, `tasks`, `steps`, `sessions` (one row per run, that is one turn), `events`,
`reports`, `decisions` (every placement, workflow question and landing decision, with Jev's probabilities, the policy
hash and any override), `landings`, `messages`, `provider_usage` and `meta`. Ids are a letter and six characters: `T`
task, `S` step, `R` run, `D` decision, `L` landing, `M` message, `P` project, `E` report. Nothing is ever deleted
from it. Read it with `jv status --json`, `jv task show T --json`, `jv report R`, `jv tail R` or the viewer.

## Owner rules

These hold in this repository and in every project jv touches:

- No attribution: workers commit with the machine's git identity and no trailers, "generated with" lines or other
  attribution of any kind.
- Agent instructions live in `AGENTS.md`, never `CLAUDE.md`: workers read the project's `AGENTS.md` (first 32 KiB)
  and are told never to edit, commit or mention `CLAUDE.md` or `.claude`. Neither is ever tracked: the APM install's
  `.claude/` stays gitignored, and `jv project add` lists both in `.git/info/exclude` when the repository does not
  ignore them already.
- Never deploy and never touch production. The coordinator runs only `jv`, `git log`, `git show` and read-only
  inspection.
- Archive, never delete. All task work happens in worktrees and only landing moves the default branch. `jv gc` takes
  finished tasks older than `retentionDays`: it removes a worktree only when it is clean and its branch has landed,
  after moving its evidence to `~/.jv/archive/`, and moves every other one to `~/.jv/archive/worktrees/`. Notes are
  archived before each write; a discarded task keeps its worktree.
- Secrets stay in `~/.jv/secrets/`: never in argv, logs, events, reports or the store, and a redactor masks every
  known key in stored text.

## Updating

`jv update` rebuilds from the package source recorded in `~/.jv/install.json` (after `apm install` or
`npm install -g` brought a new version); when the package is unchanged it rebuilds nothing and only refreshes the
shim, the provider homes and their hooks and skills. `jv --version` prints the package and store schema versions.

## Working on this repository

See [AGENTS.md](AGENTS.md) for the layout, conventions and tests, and [docs/decisions.md](docs/decisions.md) for every
choice made along the way.

## License

MIT.
