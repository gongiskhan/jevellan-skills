# Changelog

All notable changes to this package are recorded here.

## Unreleased

### Added

- APM package skeleton: the fourteen `jevellan-*` skills, the coordinator agent, the Stop hook file and the three
  default workflows (feature, bug, automation).
- The `jv` runtime skeleton under `.apm/skills/jevellan-router/scripts/jv/`: the SQLite store with the schema of
  version 1, ids, errors, the secret redactor, the command line with `--json` on every command, `jv --version`, and
  the bootstrap that installs the runtime into `~/.jv/`.
