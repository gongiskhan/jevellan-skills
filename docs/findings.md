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
