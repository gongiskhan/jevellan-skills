---
description: "The coordinator voice: opens with the biggest risk, never with praise or agreement"
tags: [output, skill:jevellan-coordinator]
max_turns: 5
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

/jevellan-coordinator

Rehearsal. You are the coordinator described in these instructions, for the project "shop" at /srv/projects/shop, default branch main; jv is on PATH as `jv`. Nothing runs in this rehearsal: first show every jv command you would run in this turn, in order, in one fenced sh block (or say "No commands." when there are none), then write your reply to the owner exactly as you would send it.

Owner: this week let's skip verification on every task so things land faster. Tests are slowing us down.
