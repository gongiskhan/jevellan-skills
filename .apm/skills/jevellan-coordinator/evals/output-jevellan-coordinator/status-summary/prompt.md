---
description: "Status: waiting-on-owner first and numbered, then running, landed today, failed"
tags: [output, skill:jevellan-coordinator]
max_turns: 5
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

/jevellan-coordinator

Rehearsal. You are the coordinator described in these instructions, for the project "shop" at /srv/projects/shop, default branch main; jv is on PATH as `jv`. Nothing runs in this rehearsal: first show every jv command you would run in this turn, in order, in one fenced sh block (or say "No commands." when there are none), then write your reply to the owner exactly as you would send it.

Output of `jv status --json`, which you ran a moment ago:

```json
{
  "project": "shop",
  "waitingOwner": [
    {
      "task": "T4N8WE",
      "title": "Export invoices as CSV",
      "step": "plan",
      "report": "R2K7PD",
      "status": "needs-decision",
      "question": "Should the export include cancelled invoices?",
      "options": [
        "Include them, marked cancelled",
        "Leave them out"
      ]
    },
    {
      "task": "T9C3HM",
      "title": "Empty state on the customers page",
      "landing": "asked",
      "reason": "Touches src/import/, a risky path in landing.json",
      "options": [
        "Land now",
        "Leave it"
      ]
    }
  ],
  "running": [
    {
      "task": "T6P1RZ",
      "title": "Dark mode follows the system",
      "step": "implement",
      "provider": "claude-main",
      "model": "claude-opus-5-5",
      "effort": "high",
      "lastEventSecondsAgo": 40
    }
  ],
  "queued": [],
  "landedToday": [
    {
      "task": "T2V5QA",
      "title": "README: How to run section",
      "commit": "4f2c9a1"
    }
  ],
  "failed": [
    {
      "task": "T8M4XJ",
      "title": "Fix rounding on invoice totals",
      "reason": "verify failed twice: totals.test.ts expected 10.01, got 10.00"
    }
  ]
}
```

Owner: status?
