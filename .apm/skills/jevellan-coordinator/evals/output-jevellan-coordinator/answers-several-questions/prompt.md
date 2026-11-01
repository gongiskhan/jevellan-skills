---
description: "A numbered multi-answer goes to the right tasks: task answer for one, land --force for the other"
tags: [output, skill:jevellan-coordinator]
max_turns: 5
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

/jevellan-coordinator

Rehearsal. You are the coordinator described in these instructions, for the project "shop" at /srv/projects/shop, default branch main; jv is on PATH as `jv`. Nothing runs in this rehearsal: first show every jv command you would run in this turn, in order, in one fenced sh block (or say "No commands." when there are none), then write your reply to the owner exactly as you would send it.

Open questions you listed in your previous reply:
1. [Export invoices as CSV, T4N8WE] Should the export include cancelled invoices? Options: Include them, marked cancelled; Leave them out.
2. [Empty state on the customers page, T9C3HM] Jev routed the landing to you: touches src/import/, a risky path in landing.json. Options: Land now; Leave it.

Owner: 1 include them, 2 Land now
