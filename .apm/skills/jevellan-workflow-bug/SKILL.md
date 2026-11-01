---
name: jevellan-workflow-bug
description: "Jevellan workflow bug: used by the Jevellan coordinator session only."
jv-version: 0.1.0
---

# Workflow: bug

## When to choose it

`--kind bug` is for something that should already work and does not: a crash, an error, a wrong result, a broken screen, a regression after a change, behaviour that contradicts the docs or what the owner was promised.

Choose another kind when:
- the owner wants new behaviour, or a deliberate change to how something works: feature;
- the owner only wants to know why something happens, with no fix yet: single with --duty investigate;
- the problem is in a browser automation of a flow on some site and the automation has to be rebuilt: automation;
- the bug belongs to an open task's work: `jv task message` to that task, no new task.

## A good bug brief

Written so a capable engineer can reproduce it without this conversation:
- What happens, exactly: the error text, the wrong value, the screen, as the owner reported it.
- What should happen instead.
- How to reproduce: the steps, the input or data, the account or role, the browser or device, when the owner gave them.
- Since when, when known: a release, a commit, a date, "after the import change".
- Where: the screen, endpoint, command or module, when you know it; say "unknown" rather than guess.
- Done when: the reproduction no longer fails, a test that failed for the reported reason now passes, and nothing around it broke.
- No runtime, provider, model or effort: Jev chooses those.

## The steps

The launcher runs them in this order and Jev places each one; you do not drive them.
1. implement: reproduces first with a failing test when the bug is testable, then fixes, and commits on the task branch.
2. verify: the project's test command and the browser journey for the affected screen if there is one, evidence in .jv-evidence/. A failure sends the task back to implement, at most twice.

Then landing: Jev routes the finished task to land, verify-then-land, or ask-owner. Only ask-owner comes to you: ask "Land now" or "Leave it" with the reason.

## Create it

```sh
jv task create --project <project> --kind bug --title "<short title>" --text "<the brief>" --json
```
