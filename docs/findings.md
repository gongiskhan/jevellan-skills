# Findings

What the run verified on dev-madrid about the installed tools, flags, APM and SDKs. Append-only; each entry is
dated and says how it was checked.

## 2026-11-01 Machine and tool versions

- Default `node` is v20.19.4 (no `node:sqlite`); v22.23.2 is installed at `~/.nvm/versions/node/v22.23.2/bin/node`
  and is what Jevellan's service runs. `node:sqlite` on 22.23.2 prints an ExperimentalWarning on first use.
- git 2.43.0, tmux 3.4, gh logged in as gongiskhan.
- Claude Code 2.1.316 (`claude --version`). Codex CLI 0.153.4 (`codex --version`). APM 0.24.0 (`apm --version`;
  0.35.0 is available and was not installed: the CLI is the owner's).
- npm registry on this date: `@anthropic-ai/claude-agent-sdk` 0.3.316, `@openai/codex-sdk` 0.166.0, `zod` 4.6.7.
  Jevellan at 8e2788ec uses agent SDK 0.3.281 and codex SDK 0.156.1.
- Tailscale address of dev-madrid: 100.88.165.46.

## 2026-11-01 Claude Code flags (from `claude --help`, 2.1.316)

- `--effort <level>` exists: the claude-tmux runtime passes the session's effort (the fallback of 6.2 is not needed).
- `--append-system-prompt <prompt>` exists; `--append-system-prompt-file` is named in the help text
  (verified with a real file in phase 6/7, recorded below then).
- `--session-id <uuid>`, `--mcp-config <configs...>`, `--strict-mcp-config`, `--setting-sources <sources>`,
  `--settings <file-or-json>`, `--permission-mode <mode>`, `--model <model>`, `-r/--resume [value]`,
  `--agent <agent>` exist.
- Remote control: `--remote-control [name]` is a flag of the main interactive command ("Start an interactive
  session with Remote Control"). The `claude remote-control` subcommand only takes `--name`, `--continue`,
  `--session-id`, `--permission-mode`, `--chrome` and debug flags: no `--model`, no `--append-system-prompt`.

## 2026-11-01 Codex flags (0.153.4)

- `codex resume [SESSION_ID] [PROMPT]` exists (also `--last`, `--all`), so attach is `codex resume <thread id>`.
- `codex login status` prints "Logged in using ChatGPT" for the Jevellan Ekoa Codex home's `auth.json`.
- A `CODEX_HOME` under `/tmp` makes Codex refuse to create its PATH helper binaries; jv homes live under `~/.jv`.

## 2026-11-01 Seeds

- Jevellan's homes are flat config folders (`HOME` = `CLAUDE_CONFIG_DIR` = the home), not HOMEs with a `.claude`
  subfolder (D-002). The Gmail home (`acc_01M4Z8H24SFH071Y65FP3XZKX6`) has no `.credentials.json`; the Ekoa home
  (`acc_01M4Z8H5MZDEZPADRKEJ3Y75Q1`) has one. Jevellan's account records mark both Claude accounts' credential as
  "shared" (a vault OAuth token injected as `CLAUDE_CODE_OAUTH_TOKEN`) and the Codex account as "per-device"
  (`auth.json` in the home).
- Jev key, and both Claude account tokens, read with Jevellan's own `SecretVault` (packages/core/dist/vault.js)
  over a read-only SQLite connection; written to `~/.jv/secrets/jev.key`, `claude-main.token`,
  `claude-second.token` (mode 600). Nothing under `~/.jevellan*` was written.
- `GET https://api.typesafe.ai/v1/models` with the key lists `jev-latest` and `jev-preview`.
- A one-turn `claude -p --max-turns 1 --model claude-haiku-5-5` with only `CLAUDE_CODE_OAUTH_TOKEN` and a fresh
  HOME answered for both tokens.
- The Codex login is a ChatGPT OAuth login with a refresh token. jv's copy and Jevellan's copy of the same login
  can sign each other out when one of them refreshes; when that happens jv reports "needs login" with
  `jv providers login codex`.

## 2026-11-01 APM install for the Claude target (APM 0.24.0)

Checked by installing a copy of this package (without build output) as a local dependency into a fresh git
repository with `.claude/` gitignored (`apm install ../pkg --target claude`), and at user scope with a temporary HOME
(`HOME=<tmp> apm install -g <absolute path> --target claude`).

- Project install writes: `.claude/skills/<name>/` for all 14 `jevellan-*` skills (the router with its whole
  `scripts/jv/` runtime source), `.claude/agents/jevellan-coordinator.md` (the package's
  `jevellan-coordinator.agent.md` with the `.agent` infix dropped), the Stop hook merged into `.claude/settings.json`
  as `{"type": "command", "command": "node ~/.jv/runtime/dist/report-guard.mjs"}`, and a side file
  `.claude/apm-hooks.json` holding the same hook group tagged `"_apm_source": "pkg"` (APM's record of what it merged).
  It also adds `apm_modules/` to `.gitignore` and the dependency to the project's `apm.yml`.
- User scope exists for the Claude target: `apm install -g` writes the same set under `~/.claude/`
  (`skills/`, `agents/jevellan-coordinator.md`, `settings.json`, `apm-hooks.json`) and keeps its manifest in
  `~/.apm/apm.yml`. It refuses a relative local path at user scope ("relative local paths are not supported at user
  scope"); an absolute path or `owner/repo` works. jv does not use the user-level install (D-015).
- Frontmatter survives the install unchanged: `disable-model-invocation: true`, the "Jevellan internal. Not for direct
  use." descriptions, `jv-needs` and `jv-version` survive: every installed `SKILL.md` and the installed agent file are
  byte-identical to the package's (checked with `cmp`).
- Claude Code 2.1.316 honours `disable-model-invocation: true` (earlier probe in this run, a skill `demo-skill` with
  the flag and a skill `demo-open` without it, both installed through APM): `demo-skill` is listed among the
  session's slash commands and runs when invoked as `/demo-skill`, but the model does not see it (asked whether a skill
  named demo-skill exists, it answered that none does and named only `demo-open`). The fallback of section 2 (the
  description alone plus a doctor warning) is therefore not needed.
- Because APM drops the `.agent` infix, a bootstrap run from an APM-installed package finds the agent as
  `.claude/agents/jevellan-coordinator.md`; seed() accepts both names (only `jevellan-*` files) and stages it as
  `$JV_HOME/agents/jevellan-coordinator.agent.md`.

## 2026-11-01 Probes behind jv doctor

- `supportedModels()` of agent SDK 0.3.316, through an empty open input stream under each Claude provider's HOME and
  token, answers in under a second with no model turn. Rows carry `value` (an alias such as `opus`, or a full id) and
  `resolvedModel` (the canonical id): both accounts offer `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`
  and `claude-haiku-5-5`; the Ekoa account also lists older ids (Opus 4.6 to 5, Sonnet 4.6 and 5, Haiku 4.5, Fable 5).
  The current models list efforts `low` to `max` with `xhigh`; Opus 4.6 and Sonnet 4.6 list no `xhigh`, and Haiku 4.5
  lists none.
- `codex app-server` (Codex 0.153.4) answers `initialize`, `account/read` and `account/rateLimits/read` over stdio
  JSON-RPC. `account/read` with `refreshToken: false` only reads the stored file: with a made-up `auth.json` (expired
  JWT, fake refresh token) it still reports `{"type": "chatgpt", "planType": "pro"}`, exactly like `codex login
  status`, which printed "Logged in using ChatGPT" for it. `account/rateLimits/read` goes to the server and answers
  that fake login with error -32603 "... 401 Unauthorized ... Please try signing in again". For jv's real Codex home
  it answers the `codex` limit with one weekly window (10080 minutes) and no five-hour window.

## 2026-11-01 First real claude-sdk turn and placement (acceptance phases 2 and 3)

- A `single` investigate step on the sandbox, run by `jv run` through agent SDK 0.3.316 on `claude-main`,
  `claude-sonnet-5-5` effort `low`, read-only (`dontAsk`, D-026), ended in about 20 seconds with one `jv_report`
  call through the in-process MCP server (`mcp__jv__jv_report`), status done. The tools it called were Glob, Grep,
  Read and the report tool only. The `system/init` session id was on the row before the first text event, and the
  native transcript is `<provider home>/.claude/projects/<cwd with every non-alphanumeric character as "-">/<id>.jsonl`.
  The result's `modelUsage` carried input, output, cache read and cache write tokens and a cost.
- No key file value appeared in the store, its WAL or the run log (`grep -F -f` per key file, patterns on stdin).
- `placeStep` for the same step against the real Jev (`jev-latest`, answered as `jev-1.14.0`) took two calls
  (model and effort, then provider between claude-main and claude-second) in about 350 ms and 2937 input tokens. With
  `jev.keyFile` pointing at a missing file it exits 2 with "Jev: no key configured" and writes no decisions row.

## 2026-11-01 Runtimes, coordinator and flags, verified in phases 6 and 7

Claude Code 2.1.316, Codex 0.153.4 on PATH and 0.166.0 bundled with the SDK, tmux 3.4. Checked by the phase 6
coordinator probes (interactive `claude` in tmux under the claude-main home) and by the acceptance runs of
`acceptance/phase6-coordinator.mjs` (real sandbox) and `acceptance/phase7-runtimes.mjs` (sandbox-clone).

- `--effort` low and high are accepted by the interactive `claude` (a claude-tmux worker on opus low, the coordinator
  on high; the coordinator's header read "Opus 5.5 with high effort").
- `--append-system-prompt-file F` is not in `claude --help` but works: with it, "what are your rules?" recited the
  jv command list and the project name, and the phase 6 coordinator opened its reply "I coordinate
  jevellan-live-sandbox...". It is accepted together with `--remote-control <name>`, `--model`, `--effort`,
  `--permission-mode bypassPermissions` and `--session-id`.
- `--permission-mode dontAsk` with `--tools` and `--allowedTools`, and `--settings <json>`, were accepted by the
  claude-tmux workers, which reported through `mcp__jv__jv_report`.
- `--setting-sources user` drops the CLAUDE.md files of ancestor folders: a `claude -p` probe under the owner's home listed
  the owner's `~/.claude/CLAUDE.md` and `~/.claude/rules/caveman.md` as project instructions without the flag and
  answered NONE with it; a worker transcript had "Contents of /home/ggomes/.claude/rules/caveman.md" before the flag
  and 0 matches after. The coordinator (run without it) still loads both, plus the checkout's `CLAUDE.md ->
  AGENTS.md`, and the caveman rule overrode its voice.
- `--agent jevellan-coordinator` loads `<home>/.claude/agents/jevellan-coordinator.md` (the header showed
  `@jevellan-coordinator`), but its `{{...}}` placeholders reach the model unfilled.
- `--session-id <uuid>` names the transcript file. The transcript path is `<provider home>/.claude/projects/<cwd
  with every non-alphanumeric character as "-">/<uuid>.jsonl` (seen for run RVNRDCM under the claude-second home).
- No first-run dialog appeared once `hasCompletedOnboarding`, `projects["<cwd>"].hasTrustDialogAccepted` (in
  `<home>/.claude.json`) and `skipDangerousModePermissionPrompt` (in `<home>/.claude/settings.json`) were set; Claude
  Code writes the same keys itself when a dialog is accepted, and both dialogs default to "No, exit". The theme
  dialog never appeared once onboarding was set.
- `/exit` ends an interactive session in about 1 s. `tmux load-buffer` plus `paste-buffer -p -d` plus Enter
  delivered a 44-line handoff as one message; the `=name:` target syntax works for `send-keys` and `capture-pane`.
  A coordinator restart reached a ready prompt in under 2 s, and the restarted coordinator answered the handoff 9 s
  later.
- Remote Control is refused for a long-lived token login: after 20 s there was no status line or URL, and
  `/remote-control` answered exactly "Remote Control requires a full-scope login token. Long-lived tokens (from claude
  setup-token or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons. Run claude auth login
  to use Remote Control." (D-054)
- With `ENABLE_CLAUDEAI_MCP_SERVERS=false` set, a coordinator transcript still showed an `mcp_instructions_delta`
  adding `claude-artifacts`.
- Codex `model/list` (app-server) lists `gpt-6-astra` (the default), `gpt-5.6-sol`, `gpt-5.6-terra` and
  `gpt-5.6-luna`; their efforts include `ultra`, which `mapEffort` refuses with exit 2. `gpt-6.1-sol` is not offered.
  `jv providers check` lists the three `gpt-5.6-*` ids as offered and not configured.
- Codex reports through the `jv.jv_report` tool, an MCP server in the thread's config (run RMDJBXZ, thread
  `01a197b7-...`); it needed no login. Codex reported usage once per turn.
- Five-hour usage is not returned by either probe: `jv providers check` gave weekly percentages (claude-main 63%,
  claude-second 42%, codex 1%) and "five hours unknown" for all three.
- claude-tmux events reached the store within 253 ms of the transcript (wall clock, three tool calls: Grep 252,
  ToolSearch 252, `mcp__jv__jv_report` 253).
- A claude-sdk run whose process group got SIGKILL showed as lost in `jv status` after 126 ms, and `jv task resume`
  continued it natively with the same native session id.
- Not yet exercised: Codex resume and attach; whether Codex `turn.completed` counts are thread totals or per turn (one
  turn only); whether `claude --resume <uuid>` in a fresh window appends to the same transcript file; how Stop-hook
  feedback appears in a transcript, and whether the Stop hook still blocks under `--setting-sources user` (every tmux
  run reported, so no block was seen); a coordinator restart while a task waits on the owner (J8 proper); Remote
  Control with a full claude.ai login.

## 2026-11-01 APM install from GitHub into the sandbox (acceptance J1)

Checked by `acceptance/j01-install.mjs`: `apm install gongiskhan/jevellan-skills --target claude` (APM 0.24.0) run in
`/home/ggomes/jevellan-projects/jevellan-live-sandbox`, which APM resolved to GitHub `main` at `bcf93d2e` (the same
commit as this repository's HEAD), then `cmp` of every installed file against the package and `git status`.

- Paths APM wrote, relative to the checkout:
  - `.claude/skills/<name>/` for the 14 `jevellan-*` skills, every tracked file of each skill folder (269 files,
    the router with its `scripts/jv/` runtime source), each byte-identical to `.apm/skills/<name>/`;
  - `.claude/agents/jevellan-coordinator.md`, byte-identical to `.apm/agents/jevellan-coordinator.agent.md`;
  - `.claude/settings.json`, created with the Stop hook group
    `{"hooks": [{"type": "command", "command": "node ~/.jv/runtime/dist/report-guard.mjs"}]}`;
  - `.claude/apm-hooks.json`, the same group tagged `"_apm_source": "jevellan-skills"` (the package name; the
    earlier local-path install tagged it `pkg`, the folder name);
  - `apm.yml` at the root (created: name, version, `targets: [claude]`, `dependencies.apm: [gongiskhan/jevellan-skills]`),
    `apm.lock.yaml` at the root (`resolved_commit`, `version: 0.1.0`, and the full `deployed_files` list), and
    `apm_modules/gongiskhan/jevellan-skills/` (the fetched package, `.apm/` included);
  - the tracked `.gitignore`, with `# APM dependencies` and `apm_modules/` appended.
- APM appends `apm_modules/` to `.gitignore` on every run, also on a second run when `apm_modules/` is already ignored
  through `.git/info/exclude` (it reports "Added apm_modules/ to .gitignore" again). A second run reports the agent as
  "adopted" and the package as "(cached)", and leaves every other file as it was.
- So a consumer whose main checkout must stay clean has to undo two side effects after each install: `git checkout
  -- .gitignore`, and list `apm.yml`, `apm.lock.yaml` and `apm_modules/` once in `.git/info/exclude`. With that done
  (and `.claude/` already excluded by `jv project add`), `git status --porcelain` of the sandbox stayed empty.
- APM printed "1 dependency unpinned ... add #tag or #sha to prevent drift": without `#v0.1.0` a reinstall follows
  `main`.
- `jv doctor` from the checkout after the install: 26 OK, 4 WARN, 0 FAIL; the WARNs are the three providers without
  key files (`glm`, `deepseek`, `kimi`) and the glm login that is not probed for the same reason. The `hook` line
  turned from WARN to OK, and `skill-copies:project` reports the 14 installed copies matching `~/.jv/skills`.

## 2026-11-01 J4, J5 and J16 on dev-madrid: open findings (not fixed)

- `jv update --help` runs the update instead of printing help (seen at 17:13Z; it rebuilt and reinstalled the runtime).
- When the owner answers an ask-owner landing, the asked row's `reason` is replaced by "answered: Land now (jv land
  --force)", so the reason Jev's route was asked (for J4: "merge conflict: merging main into ... conflicts in
  CHANGELOG.md") survives only in the wake line and the coordinator's transcript; the viewer and `jv evals landing`
  never see it.
- `jv status --json` keeps listing a task stopped with `--discard` (TQ9JMCZ) among the open tasks, so it is in every
  handoff; whether stopped tasks belong there is the owner's call.
- Claude Code stamps an assistant transcript entry when the message starts and writes the line when it is complete;
  in J5 two lines reached the file 6.2 s and 15.4 s after their own timestamps. jv stored every event within 0.9 s of
  its line being written.

## 2026-11-01 J6, J7, J8, J11 and J13 on dev-madrid

Checked by `acceptance/j06-takeover.mjs`, `j07-lost.mjs`, `j08-restart.mjs`, `j11-override.mjs` and `j13-llm.mjs`
against the real sandbox, asserting on the store read-only and on the native transcripts.

- Takeover (J6): `jv attach R` from a script inside tmux created the detached session `jv-R` (claude `--resume` of the
  run's native id under `~/.jv/homes/claude-second/`) and printed `tmux switch-client -t =jv-R`, because `$TMUX` was
  set. Claude Code was at its prompt within 4 s with no dialog. The typed line and the reply were appended to the same
  transcript after the offset recorded in meta `takeover:R`; `/exit` closed the tmux session; `jv task resume`
  imported 2 entries as events with `source: "takeover"` (a `message` from the owner and the `text` reply) and
  continued with a new run row on the same `native_session_id`.
- Lost (J7): after `kill -KILL -<pgid>` of a running claude-sdk implement run, the first `jv status --json` (124 ms
  later) showed the run lost; `jv task resume` continued natively and the step finished done.
- Jev routed the landing of a one-line comment in `src/invoices/index.ts` (J7) to the owner as "touches a risky area";
  the comment landings of `src/customers/index.ts` and `src/web/html.ts` (J11) went straight to `land`.
- Restart (J8): `jv coordinator restart` typed the handoff into the new session at a ready screen; the new session's
  first turn ran `jv status --json` and named the waiting task with both options.
- Override (J11): an owner override without `--provider` placed Fable on claude-second (jv's ranking, not named by the owner);
  `--keep` wrote `override_mode keep` on the running run's decision row and left the run alone.
- llm (J13): Jev placed the answer on Haiku low via claude-second (probability 0.9); the placement menu listed
  claude-second and claude-main, with the model entries on the higher-ranked claude-second only, and no glm (no key
  file). An `--undo` override issued right after `jv task create` still caught the llm run before it finished.
- None of the three comment commits J7 and J11 landed (`ff57fd0`, `89354e1`, `fe42d4e`) adds a `CHANGELOG.md` line.
  The sandbox's "every change adds a line to CHANGELOG.md" rule lives only in its project.json `guidance`, which
  section 7.2 sends to Jev (placement and landing) and not to workers; the sandbox has no AGENTS.md, and the landing
  checks are lint and test only, so nothing stopped them. Its CI's `check:changelog` diffs `origin/main...HEAD` and
  still passes on main because earlier commits touched the file. `ff57fd0` also changed `export type Line = {` to
  `export type Line ={` (lint passes; the coordinator noticed it and noted it). Open: whether guidance belongs in the
  worker prompt is the owner's call.

## 2026-11-01 J9, J10 and J12 on dev-madrid

Checked by `acceptance/j09-jev-refused.mjs`, `j10-ceiling.mjs` and `j12-codex.mjs` against the real sandbox, each
after `jv status --json` showed no running work, asserting on the store read-only; every config change was restored
and the restore checked (results/J09.json, J10.json, J12.json).

- Jev refused (J9): with `~/.jv/secrets/jev.key` renamed in place, `jv task create` of a single investigate task
  exited 2 with "Jev: no key configured (task TN6DEFT is queued; jv task resume TN6DEFT starts it once Jev
  answers)". The `--json` error carries only `error` and `exitCode`, so the task id is found by request id. The
  task was queued "step 1 (investigate) not placed: Jev: no key configured", its step pending with "Jev: no key
  configured", no run and no placement row. The preflight of `jv task create` is the login checks only, not `jev`,
  so the task row exists before the refusal. The wake line "[jv] TN6DEFT (Default port of the server) step
  investigate: not placed (Jev: no key configured). Run: jv task show TN6DEFT" was on the coordinator's screen and
  in its transcript about 1 s after the create. With the key back (mode 600, `jv doctor --check jev` OK) `jv task
  resume` placed the step (how `placed`) and it finished.
- Ceiling (J10): the ranking reads the latest `provider_usage` row by `observed_at` of any source (here a `stream`
  row, week 66%). With `claude-main.ceilingPct` 50 the decision's `state_json.menu.providers` was codex and
  claude-second only, and `chosen_json.candidates` kept claude-main with `eligible: false`, `reason:
  "usage-ceiling"`, `ceilingPct: 50`, `weeklyPct: 66`. Even with claude-main eligible, the menu's model entries name
  only the higher-ranked Claude provider (claude-second at 44%), so `menu.providers` is the place that shows an
  exclusion. `providers.json` is read at each placement; no restart or cache was involved.
- Codex (J12): with the installed policy's model descriptions edited (GPT "the model for investigation", every other
  line starting "Not for investigation."), Jev chose GPT via codex with probability 1 at medium effort; the
  decision's `skill_hash` differed from the placement before it. The run used `@openai/codex-sdk` with a thread id;
  its tool calls were `Shell` items and one `jv.jv_report` (the jv-report-mcp server named `jv`), followed by a
  `report` event and a reports row. The run took about 30 s, 15 322 input and 539 output tokens. Codex needed no
  login. A single investigate task gets a task worktree like any other task; the run's cwd was that worktree.

## 2026-11-01 J14 on dev-madrid

Checked by `acceptance/j14-child-task.mjs --tag j14a` against the real sandbox through the coordinator (results/J14.json),
asserting on the store read-only and on git in the sandbox checkout.

- The coordinator made the owner's request one automation task (TVMA33M); the workflow decision answered
  `needs_plan` true at 0.96, so no workflow override was needed. The plan step (Opus high, claude-sdk) wrote plan.md
  and reported needs-decision with options "A. Yes, as proposed", "B. Yes, with confirm on delete", "C. No new UI,
  list only"; the task went to waiting-owner with the plan step still `running` (a waiting step keeps its state).
- The coordinator did not create the child on its own: it recommended A and ended its reply with the numbered open
  question, no question mark. On the owner's "1 A" it ran `jv task create --kind feature --parent TVMA33M` (TB1EXPS)
  and said it would answer the parent only after the child landed. The child's start point was the parent's branch,
  which still pointed at main's `fe42d4e` (plan.md is not committed), so the live base commit cannot tell the two
  apart; `test/tasks.test.ts` "create --parent" now covers a parent branch ahead of main (the child's base is the
  parent's head and its worktree holds the parent's work).
- The child ran plan, implement (Opus xhigh), verify and document (Sonnet medium). Jev routed its landing to
  ask-owner (0.83; the change adds a delete route); "Land now" closed that row (`answered: Land now`) and a land row
  fast-forwarded the parent's branch in the parent's worktree: "landed a07ffd763b62 on jv/playwright-create-list-
  and-delete-a-cust-vma33m (the branch of the parent TVMA33M) (merge --ff-only); checks passed: lint, test". At that
  moment main was still `fe42d4e`.
- The coordinator answered the parent 5 s after the child's landing (`jv task answer`, then a `jv task message` with
  what landed); the plan step resumed in the same session, updated plan.md and reported done, then automate and
  verify ran on the parent's worktree, which held the child's commits. The parent's landing was ask-owner too (0.82);
  after "Land now" main fast-forwarded to `302f478`, which holds the child's three commits and the parent's.
- Observed, not a jv problem: the automation records at 1280x800 only, and the new form wraps at 390 px with the
  "VAT" label at the end of one line and its field on the next (sandbox UI, visible in the verify screenshots).

## 2026-11-01 Acceptance and verification summary

Checked by the journey scripts `acceptance/j01-install.mjs` to `j17-no-leaks.mjs` against the real sandbox
`jevellan-live-sandbox` (results in `acceptance/results/JNN.json`, assembled into `acceptance/RESULTS.md`), by the
unit suite, by `jv doctor`, and, for flags, by the entries above (each line names the entry or journey that
established it) plus `claude --help`, `claude remote-control --help`, `codex --help` and `codex resume --help` of the
installed versions, re-read at 19:05Z.

Journeys (every one passed on its recorded run):

- J1 Install: PASS 14/14. APM 0.24.0 installed the 14 skills, the agent and the Stop hook from GitHub `main`
  byte-identical to the package; `jv doctor` 26 OK, 4 WARN (providers without key files), 0 FAIL. Deviation: the
  `.gitignore` APM rewrites on every run is restored and APM's files are excluded through `.git/info/exclude`.
- J2 Providers: PASS 8/8. claude-main, claude-second and codex ready with weekly percentages; Jev reachable with
  `jev-latest` listed. Five-hour usage is not returned by any probe.
- J3 Coordinator: PASS 20/20 (third run; the first two failed only over-literal checks of the script). Deviations:
  Remote Control is off (long-lived token login, D-054, D-071; the owner command is `jv providers login
  claude-main`), and the first status reply named three finished tasks.
- J4 The three tasks: PASS 18/18 (tag j4c; attempts j4a and j4b abandoned, see the J4/J5/J16 section). Jev chose
  Sonnet medium, Opus high, Opus high against Jevellan's Opus medium, GPT medium, GPT high. All three landed, two
  after an owner "Land now" on a CHANGELOG.md merge conflict (D-076).
- J5 Visibility: PASS 15/15 (tag j5b, on a second visible README task). Events reached the store within 0.9 s and
  `jv tail --follow` within 1.15 s of the transcript write.
- J6 Takeover: PASS 23/23. J7 Lost and resumed: PASS 9/9 (lost seen 124 ms after the kill). J8 Restart from
  handoff: PASS 14/14. J9 Jev refused: PASS 17/17. J10 Ceiling: PASS 15/15. J11 Override: PASS 16/16. J12 Codex:
  PASS 13/13. J13 llm: PASS 16/16 (glm skipped: no key file). J14 Child task: PASS 21/21 (resumed with the same
  tag after the script missed the coordinator's question; no failed check).
- J15 Evals: PASS 14/14. `jv evals route --since 2026-11-01` exported 53 cases (10 override, 43 outcome; skipped 8
  owner, 4 pending, 1 stopped) into the router's `evals/cases.json`, which keeps its 10 hand cases (63 in all); the
  replay made 106 Jev calls and agreed on 150 of 164 questions, held-out 94% (threshold 60%), exit 0 (final run
  at 19:08Z; the first run at 19:00Z also agreed on 150 of 164, held-out 91%). `jv evals
  landing` exported 5 outcome cases (16 with the 11 hand cases), agreement 16/16. Neither cases file nor either
  `evals/RESULTS.md` holds a machine path, `/tmp/`, the owner's name or either e-mail, so the exporter needed no
  change. Of the final run's 14 router disagreements, 12 are on owner overrides and 2 on the J12 decision made
  under the temporarily edited policy; between the two runs Jev's answers moved on close calls (DAZQHVW, Sonnet 0.45
  against Opus 0.44, disagreed only in the first; DQBP4JJ effort, medium 0.51 against low 0.46, only in the second).
- J16 Viewer on the phone: PASS 29/29 over the tailnet address at 390 px.
- J17 No leaks: PASS 21/21 (tag j17c at 19:08Z, after the final J15 run; the j17b run at 19:04Z had stopped the
  coordinator and passed 21/21 too). The three key files and the four token values of
  20 or more characters in the codex home's `auth.json` (no Claude home has a `.credentials.json`) matched nothing in
  the store and its WAL and SHM, 69 log files, 8 `.jv-evidence` folders (148 files), `~/.jv/projects` and
  `providers.json`, the repository (9 528 files) or the acceptance outputs and journey logs. The Anthropic auth token
  variable name appears nowhere in those either, except the repository's code that sets or tests it (`src/env.ts`,
  `src/providers.ts`, three test files, README.md, their build output, the agent SDK in `node_modules` and the
  CodeGraph index), allowed by exact path and recorded as a deviation.

Final state (J17 `--final`): the coordinator stopped with `/exit` (j17b; j17c found it not running); no `jv-R`, `jv-coord-*` or `jv-login-*` tmux
session and no `jv ui`, `jv run` or `jv exec` process is left; the sessions jv does not own (`codex-bridge-owner-plan`,
`jv-bridge-ekoa-code`, `jv-build`, `rc`) are untouched; `jv status --json` shows no running work and the store no
live session (the two stopped tasks T3XKZ7A and TQ9JMCZ were still listed then; since D-083 `jv status` leaves
discarded tasks out); the sandbox
checkout is clean on `main` at `302f478`, and every one of the 10 landings into it is on main, J4's TC2SEC1
(`5499602`), T4HA3RT (`e86e090`) and TAFEFXT (`ceec900`) among them. After the run, the bug task THZFP9K below
landed `43e279e` on main, the sandbox's last commit; `jv status` is again empty.

Other verification results:

- Unit suite: `npm test` 406 of 406 passing at 19:06Z (bootstrap test included), after the fixes D-076 to D-080;
  408 of 408 after D-081 to D-083, installed with `jv update`.
- `jv doctor` from the sandbox at 19:07Z: 26 OK, 4 WARN (`key:glm`, `key:deepseek`, `key:kimi`, `login:glm`), 0
  FAIL. The installed router policy is byte-identical to the repository's.
- Findings of the journeys, after the run: `jv update --help` ran the update (fixed, D-081: it prints the usage,
  and an unknown argument exits 2); answering an ask-owner landing overwrote its reason (fixed, D-082: the closed
  row reads `<answer>; asked: <reason>`); `jv status --json` listed discarded tasks (fixed, D-083). As designed:
  project `guidance` reaches Jev and not workers (section 7.4 gives workers the project's `AGENTS.md`, and the
  sandbox's CHANGELOG rule is only in its guidance, so the comment commits of J7 and J11 add no CHANGELOG.md line);
  a single investigate task gets a task worktree (section 7.3). The sandbox's new customer form wrapping at 390 px
  went to the sandbox as a jv bug task, THZFP9K (implement Opus xhigh, verify Opus high, both on claude-second; Jev
  routed the landing to land): each label now sits above its field at 390 px and the form stays one row at 1440 px
  (before and after screenshots in its worktree's `.jv-evidence/`); it landed as `43e279e` with lint and test
  passing.

Claude Code 2.1.316, supported and used:

- `--effort <level>` (help; claude-tmux workers low, the coordinator high, phases 6 and 7).
- `--append-system-prompt-file <file>`: not in `--help`, works (phases 6 and 7; J3 recited the jv commands).
  `--append-system-prompt <text>` is in the help.
- `--session-id <uuid>` (names the transcript file), `--mcp-config`, `--strict-mcp-config`, `--settings
  <file-or-json>`, `--permission-mode` (`dontAsk` for workers, `bypassPermissions` for the coordinator), `--tools`,
  `--allowedTools`, `--model`, `--setting-sources user` (drops ancestor CLAUDE.md files), all accepted (phases 6 and
  7, every claude-tmux run, J3).
- `--resume <uuid>` in a fresh window continues the same transcript (J6 takeover); `--agent <name>` loads an agent
  file but leaves its placeholders unfilled (phase 6).
- `--remote-control [name]` is a flag of the main interactive command and is accepted with the flags above (phase 6).
- `-p --max-turns 1`: `--max-turns` is not in `--help` but a one-turn probe answered (seeds entry).

Claude Code 2.1.316, not supported or refused:

- Remote Control with a long-lived token login (`CLAUDE_CODE_OAUTH_TOKEN` or `claude setup-token`): refused with
  "Remote Control requires a full-scope login token..." (phase 6, J3; D-054, D-071). Not exercised: Remote Control
  with a full claude.ai login, which needs the owner's sign-in.
- The `claude remote-control` subcommand has no `--model`, no `--effort` and no `--append-system-prompt`: it takes
  `--name`, `--remote-control-session-name-prefix`, `--continue`, `--session-id`, `--permission-mode`, `--chrome`,
  `--spawn`, `--capacity`, `--create-session-in-dir` and debug flags (help, re-read at 19:05Z).
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` does not keep the `claude-artifacts` MCP instructions out of a session (phase 6).

Codex 0.153.4:

- Supported: `codex resume [SESSION_ID] [PROMPT]` (help; what jv attach runs for a codex run, not attached live in
  this run); `codex login status`; `codex
  app-server` over stdio JSON-RPC with `initialize`, `account/read`, `account/rateLimits/read` (one weekly window, no
  five-hour window) and `model/list`; the `@openai/codex-sdk` thread with the jv-report-mcp server named `jv`,
  reporting through `jv.jv_report` with no login step (phase 7, J12).
- Not supported or refused: a `CODEX_HOME` under `/tmp` (Codex refuses to create its PATH helpers there); the
  `ultra` effort that `model/list` offers is refused by jv's own effort mapping (exit 2); `gpt-6.1-sol` is not
  offered. Not exercised: Codex resume of a live run and whether `turn.completed` counts are per turn.

APM 0.24.0 and npm:

- Supported: `apm install owner/repo --target claude` (J1), a local directory path (a plain copy of the working tree,
  gitignored files included), and `apm install -g` with an absolute path or `owner/repo` (earlier APM probe).
- Not supported: `file://` URLs and bare-repository sources (`apm install file://...` fails with "Invalid repository
  path component: file:", a bare clone with "no apm.yml, SKILL.md, or plugin.json found", `git+file://` and `- git:
  file://...` with "Invalid virtual package path"); a relative local path at user scope; and a rerun that leaves
  `.gitignore` alone (J1).
- `npm ci --omit=dev` cannot build the TypeScript, because the compiler is a dev dependency; the bootstrap runs `npm
  ci`, `tsc`, then `npm prune --omit=dev` (D-005).
