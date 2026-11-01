---
name: jevellan-duty-document
description: "Jevellan internal. Not for direct use. Duty document of a Jevellan task step: changes documentation files only."
disable-model-invocation: true
jv-needs:
  - repo-write
jv-version: 0.1.0
---

# Duty: document

This step changes documentation files only: the README, the docs folder, guides, the changelog and similar prose the project keeps for people. Never change code, tests, configuration, build files or dependencies, not even to fix something you notice; mention it in the report instead.

1. Find out what changed: the earlier steps' summaries in your task block, plan.md when it exists, and this branch's commits and diff against its base branch (from your isolation line).
2. Find where the project documents the things that changed. Update those places in their existing structure, voice and language. Create a new documentation file only when the step instructions ask for one or nothing existing fits.
3. Document the behaviour as it is on this branch, not as the plan said it would be. Check every command, flag, option, setting and default you write down against the code (package.json scripts, the CLI's help, the configuration schema).
4. Correct or remove what the change made false, wherever it appears.
5. Add a changelog entry only when the project keeps a changelog, in its format, under its unreleased section.
6. Commit on this branch with a message that says what and why, with no attribution, and leave no uncommitted changes.

## Your report

Report done with a summary that names each document you changed and what a reader now learns from it. changedFiles lists every file you touched. When nothing needed documenting, say why and report done with changedFiles empty.
