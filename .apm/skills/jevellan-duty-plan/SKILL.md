---
name: jevellan-duty-plan
description: "Jevellan internal. Not for direct use. Duty plan of a Jevellan task step: writes plan.md at the worktree root, read-only otherwise."
disable-model-invocation: true
jv-needs:
  - repo-read
jv-version: 0.1.0
---

# Duty: plan

This step writes one file, plan.md at the worktree root, and changes nothing else. Do not create, edit or delete any other file, and do not commit: plan.md is kept out of the task's commits unless the project asks otherwise, and the runtime takes care of that.

1. Read the task text and the step instructions. The step instructions say what plan.md must contain; they are the outline of the plan.
2. Read the code the change touches: the entry points, the modules involved, the existing tests next to them, and the project's conventions in AGENTS.md. Read enough to name real files, functions and data shapes; a plan built on guessed names sends the next step the wrong way.
3. Write plan.md:
   - The first paragraph states the change in one paragraph: what changes, why, and what the owner will be able to see or do afterwards.
   - Then the sections the step instructions ask for, concrete and short: each file to touch and what changes in it, each test to add or change and what it proves, and anything that needs care (stored data, migrations, behaviour other code relies on).
   - Size it for a capable engineer who will follow it in one sitting: no code beyond a signature or a short snippet where the shape matters, no restating of the task.
4. Decide yourself everything that follows from the task, the code or the project's conventions, and write each such decision with its reason in plan.md. Only a choice that genuinely belongs to the owner (what the product should do, scope, cost, their data) is an open question. Write it in plan.md under "Open questions" with the options, and plan the rest so the next step can continue once it is answered.
5. When plan.md already exists (a retry or a resumed step), update it instead of starting over, and keep the decisions the owner already made.

## Your report

Report done with the first paragraph of plan.md as the summary, followed by one line naming the main files the plan touches. changedFiles is ["plan.md"].

When an owner's choice blocks the plan, report needs-decision instead: the question in one or two sentences, two to four options with a short description each, and the rest of the plan already written.
