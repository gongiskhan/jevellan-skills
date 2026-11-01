---
name: jevellan-duty-verify
description: "Jevellan internal. Not for direct use. Duty verify of a Jevellan task step: runs the tests and browser journeys and saves evidence."
disable-model-invocation: true
jv-needs:
  - repo-write
  - shell
  - browser
jv-version: 0.1.0
---

# Duty: verify

This step checks the work on the task branch and reports what it found. You do not fix anything: when a check fails, report it, and the launcher sends the task back to the step that wrote the code, with your report. The step instructions say what to check; what follows is how.

1. Find what to check: the earlier steps' summaries in your task block, plan.md when it exists, and the files this branch changed against its base branch (`git diff --name-only <base>...HEAD`).
2. Run the project's test command, project.json.testCommand, in full, once. Your task block or step instructions give it when it is set. When none is given, use the command the project documents (the test script in package.json, AGENTS.md, the README) and say in the report which one you used and that project.json sets none. Save the output to .jv-evidence/tests.txt. When something fails, run the failing tests once more on their own to tell a flaky test from a real failure, and report both runs.
3. Browser journeys, for every screen the change touches or could affect. If the skill web-testing is available, use it for browser journeys; otherwise use Playwright directly with the project's dev server command from project.json.devCommand.
   - Drive the screens the way a person would: navigate, click, fill and submit, and check what appears. Cover the states the change affects, such as empty, error, long content and a signed-out user, not only the first render.
   - Check every journey at a desktop width (1440 by 900) and a phone width (390 by 844).
   - Save screenshots under .jv-evidence/ with names that say the screen, the state and the width (`customers-empty-phone.png`), and videos or traces there too when the step asks for them.
   - Start the dev server on a free port, and stop at the end only the processes you started.
   - When the change touches no screen, or the project has no interface, say so and skip this part.
4. Leave the worktree as you found it apart from .jv-evidence/: change no code or tests and commit nothing. A throwaway journey script, if you need one, goes under .jv-evidence/ too.

## Your report

Report done when you finished checking, whether the checks passed or not; the result is in testsRun:

- testsRun: command lists what you ran (the test command, and the journeys); passed is true only when everything you ran passed, the test command and every journey; summary gives the counts and the first failure in a sentence.
- screenshots: every screenshot with a caption that says what it shows.
- summary: what you checked, what passed, what failed with the exact error and where, and what you could not check and why. When a test is flaky, say which one and what its two runs showed.

Report blocked only when you could not check at all, for a reason outside the change (the dev server needs a service or credentials that are not there, no browser can start), with ownerCommands when the owner can fix it.
