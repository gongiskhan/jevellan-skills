---
name: jevellan-workflow-automation
description: "Jevellan workflow automation: used by the Jevellan coordinator session only."
jv-version: 0.1.0
---

# Workflow: automation

## When to choose it

`--kind automation` is for a browser automation of a flow on a real site or application, built with Playwright as scripts in the project's automation folder (project.json automationDir, default automations/): filling a form on a portal, downloading reports, submitting a recurring declaration, checking a page for changes.

Choose another kind when:
- the owner wants end-to-end tests of this project's own screens: feature (tests for new behaviour) or bug (a failing or flaky test);
- the owner wants the project itself to gain a feature that happens to use a browser: feature;
- the request changes an automation an open task is building: `jv task message` to that task, no new task.

## A good automation brief

Written so a capable engineer can build it without this conversation:
- The target: the site or application and the entry page (a URL when the owner gave one).
- The flow, step by step, as the owner does it today, and its end state (a file saved, a form submitted, a value read).
- The inputs: where each value comes from (an export file, arguments, environment variables) and which credentials it needs. Name the environment variable a credential will be read from, never its value.
- What a full run may do: whether the automation may really submit, send, pay or delete on the target, or must stop before it. Every script gets a --dry-run flag that stops before the first such action.
- The evidence that proves it works: screenshots, a video, the file it produced.
- When it should run, if the owner said so (the automation itself schedules nothing).
- No runtime, provider, model or effort: Jev chooses those.

## The steps

The launcher runs them in this order and Jev places each one; you do not drive them.
1. plan, only when Jev answers needs_plan true: plan.md with the flow to automate step by step, the selectors or APIs discovered, and what evidence proves it works.
2. automate: Playwright scripts in the automation folder, discovered by driving the real target, one script per flow with a --dry-run flag, committed on the task branch.
3. verify: runs the automation end to end against the target, records video and screenshots to .jv-evidence/, and reports what ran and what it produced. A failure sends the task back to automate, at most twice.

Then landing: Jev routes the finished task to land, verify-then-land, or ask-owner. Only ask-owner comes to you: ask "Land now" or "Leave it" with the reason.

## Create it

```sh
jv task create --project <project> --kind automation --title "<short title>" --text "<the brief>" --json
```
