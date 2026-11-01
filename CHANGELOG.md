# Changelog

All notable changes to this package are recorded here.

## 0.1.0 - 2026-11-01

The first release: an ordinary Claude Code session becomes the coordinator of a project, every task step runs as its
own session placed by Jev, and one SQLite store holds every session, event, report and decision.

### Package and skills

- APM package for the Claude target and an npm package with the same `jv` entry: 14 `jevellan-*` skills (the router
  and landing policies, the coordinator, eight duties, three workflows), the coordinator agent and the Stop hook.
- Internal skills carry `disable-model-invocation: true`; APM keeps the frontmatter on install and Claude Code honours
  it.
- Default workflows: feature (plan when needed, implement, verify, document when needed), bug (implement, verify) and
  automation (plan when needed, automate, verify), with verify going back to implement or automate on failure.

### Install and bootstrap

- `jv bootstrap` and `jv update` build the runtime into versioned folders under `~/.jv/` and switch the
  `~/.jv/runtime` and `~/.jv/skills` links atomically; a failed build leaves the installed one untouched, and an
  unchanged package rebuilds nothing.
- The `~/.jv/bin/jv` shim pins the Node binary the bootstrap ran with. Bootstrap writes providers.json from the
  template, prepares one home per provider, and installs the Stop hook, the skills and the coordinator agent into every
  Claude provider home.

### Store and command line

- One SQLite store (`node:sqlite`, WAL) with the schema of version 1, request ids that make every create idempotent,
  and nothing ever deleted.
- The `jv` command line with `--json` on every command and exit codes 2 refused, 3 not found, 4 conflict.
- `jv doctor` preflights: tools, logins, key files and modes, Jev, the store, disk, the project hook, skill versions
  and copies, model descriptions.

### Runtimes

- `claude-sdk` (the agent SDK, the default), `claude-tmux` (interactive Claude Code in tmux for visible steps, events
  from the native transcript), `codex` (the Codex SDK) and `llm` (one-answer calls for the answer and converse
  duties, through the SDK or any OpenAI-compatible endpoint).
- Every run ends with one report: the `jv_report` tool (in process, or the stdio `jv-report-mcp`), or a fenced block
  for `llm`. The Stop hook and a backstop make a turn without a report end as blocked.
- Workers get a minimal environment; secrets travel only in child environments and a redactor masks them in all
  stored text.
- `jv attach` takes a session over in tmux; lost runs are detected and `jv task resume` continues the same native
  session.

### Placement

- The router asks Jev, with the placement policy, for the model, effort and provider of every step; providers at or
  over their ceiling or not signed in are left out of the menu. No Jev, no placement, and no default model.
- Workflow questions (`needs_plan`, `needs_docs`) decide optional steps at task creation.
- Owner rules in `rules.json` (effort bounds, landing route) apply after Jev; `jv task override --undo|--keep`
  records the owner's placement on the decision row.

### Tasks and landing

- `jv task create|show|message|answer|stop|resume|override`, a git worktree and branch per task, child tasks
  (`--parent`) and ordering (`--after`), per-project workflow overrides.
- `jv land`: Jev routes a finished task to land, verify-then-land or ask-owner using `landing.json` risky paths and
  checks; landing merges the default branch in, runs the checks and fast-forwards. Child tasks land into their
  parent's branch. One landing at a time per project.
- `jv gc` archives worktrees of finished tasks; nothing is deleted.

### Coordinator

- `jv coordinator start|stop|restart|status`: one Claude Code session per project in tmux, on claude-main with Opus
  at high effort, its prompt built from the coordinator skill, the project, its `AGENTS.md` and the handoff.
- Wake lines (`[jv] ...`) typed into its window when a task needs it, rate limited per project.
- `jv handoff` and `jv notes write|show`; `jv coordinator restart` types the handoff as the first message of the new
  session. Remote Control when the coordinator runs on a full claude.ai login of claude-main
  (`jv providers login claude-main`; its workers may keep a token).

### Providers and usage

- `jv providers check` probes logins and usage per provider, fills model lists from what each login offers, and
  checks Jev; `jv providers login` signs a provider in through tmux.
- `jv usage` shows usage by ISO week from probes, streams and local token sums.

### Viewer

- `jv ui`: a read-only page over the store (projects, tasks, sessions, decisions, usage) with live updates, dark and
  light, phone width, report screenshots from `.jv-evidence/`; loopback by default, `--bind` for a tailnet address.

### Evals

- `jv evals route|landing` exports decisions into each policy's `evals/cases.json` with a stable held-out split;
  `evals/run.mjs` replays the current policy through Jev, writes `evals/RESULTS.md` and fails below the threshold.
- The `jv-eval-runner` frontmatter lets Skillio use a policy's own runner (Skillio pull request 2).
- Trigger cases for the workflow skills and output cases for the coordinator skill.

### Known gaps

- `commitPlan` in project.json is not read; `plan.md` is never committed.
