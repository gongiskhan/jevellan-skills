---
name: jevellan-workflow-feature
description: "Jevellan workflow feature: used by the Jevellan coordinator session only."
jv-version: 0.1.0
---

# Workflow: feature

## When to choose it

`--kind feature` is for something the project does not do yet, or behaviour the owner wants changed on purpose: a new screen, command, option, field, message or integration, or a change to how something works today.

Choose another kind when:
- something that should already work is broken or wrong: bug;
- the deliverable is a browser automation of a flow on some site: automation;
- the work is one step and changes no behaviour (a question about the code, documentation only, a general answer): single with --duty;
- the request is a follow-up to an open task: `jv task message` to that task, no new task.

## A good feature brief

Written so a capable engineer can act on it without this conversation:
- What: the behaviour to add or change, in the owner's words, with the exact texts, fields and options the owner named.
- Why: the problem it solves or who asked for it, so the engineer can make the small trade-offs.
- Where: the screens, commands, modules or files involved, when you know them; say "unknown" rather than guess.
- Done when: how the owner will see the result (which screen, which state, which command) and what the tests must prove.
- Constraints: what must not change, the standing preferences from the notes that apply, choices the owner already made.
- No runtime, provider, model or effort: Jev chooses those.

## The steps

The launcher runs them in this order and Jev places each one; you do not drive them.
1. plan, only when Jev answers needs_plan true: plan.md at the worktree root with the change in one paragraph, the files to touch, the tests to add or change, and open questions as needs-decision only when a choice is the owner's.
2. implement: follows plan.md when it exists, commits on the task branch, adds or changes the tests that cover the change and runs only those.
3. verify: the project's test command, then browser journeys for every screen the change touches at desktop and phone widths, screenshots in .jv-evidence/. passed is true only when everything passed. A failure sends the task back to implement, at most twice.
4. document, only when Jev answers needs_docs true: the README, docs/ and the changelog for what changed, nothing else.

Then landing: Jev routes the finished task to land, verify-then-land, or ask-owner. Only ask-owner comes to you: ask "Land now" or "Leave it" with the reason.

## Create it

```sh
jv task create --project <project> --kind feature --title "<short title>" --text "<the brief>" --json
```
