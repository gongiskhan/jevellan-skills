---
name: jevellan-duty-automate
description: "Jevellan internal. Not for direct use. Duty automate of a Jevellan task step: builds Playwright automations with a dry-run flag and evidence."
disable-model-invocation: true
jv-needs:
  - repo-write
  - shell
  - browser
jv-version: 0.1.0
---

# Duty: automate

This step builds a browser automation with Playwright against a real target, as scripts in the project's automation folder (project.json.automationDir, default automations/; your task block gives it when it is set), and commits them on the task branch.

1. Read the task, plan.md when it exists, and what the automation folder already holds (shared helpers, configuration, conventions). Extend what is there instead of duplicating it.
2. Discover by driving the real target. Open it with Playwright and walk the flow one step at a time, reading the actual page and its network traffic. Choose selectors from roles, labels and test ids (getByRole, getByLabel, getByTestId) over CSS paths and texts that change. Wait on real conditions (a response, an element's state), never on fixed sleeps. Note what you learned (pages, selectors, requests, timings) in the script's header comment.
3. Write one script per flow, in the automation folder, in the project's language (TypeScript when the project uses it). Each script:
   - runs with one command, written in its header comment and in the automation folder's README;
   - takes its inputs from arguments or environment variables, never from values written into the script;
   - reads credentials only from environment variables or from the secrets file the project already uses, and never writes them into the script, logs, screenshots, evidence or the report;
   - has a --dry-run flag that walks the flow up to the first action that would change anything on the target (submit, send, pay, delete, publish, save), stops there and prints what it would have done;
   - saves screenshots of the key states, and a trace or video, under .jv-evidence/ (one folder per flow);
   - exits non-zero with a message naming the step that failed.
4. Run each flow once with --dry-run, then once in full. A full run that would change real data on the target (send, pay, delete, publish, submit for real) happens only when the task says it may; otherwise report needs-decision with the options instead of running it.
5. Commit the scripts, helpers and their README with messages that say what and why, with no attribution. Evidence stays in .jv-evidence/ and is never committed.

## Your report

Report done when every flow ran in full once (or up to the point the task allows). The summary names each flow, the exact commands to run it with and without --dry-run, and what the full run produced. Fill in testsRun with the full-run command, passed true only when every run succeeded, and what it did; screenshots with a caption each; changedFiles with every file you touched; limitations with any step that still needs a person (a captcha, a second factor), which also goes in ownerCommands when the owner must act.

Report blocked when the target cannot be reached or needs a sign-in you do not have, with ownerCommands naming what the owner must provide and in which environment variable.
