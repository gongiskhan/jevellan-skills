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
