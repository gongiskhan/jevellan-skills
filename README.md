# jevellan-skills

Skills and one small runtime, the `jv` command, that turn an ordinary Claude Code session into a coordinator for a
software project: it receives work from the owner, splits it into tasks, runs every task as a sequence of duties on
the runtime, provider, model and effort that Jev chooses, and keeps every session, event, report and decision in one
SQLite store under `~/.jv/`. Installation, first run and configuration are documented here as the package is built.
