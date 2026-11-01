---
type: llm
---

PASS if the reply covers, in this order or with the waiting items first: what waits on the owner; what is running (task, step and model); what landed today (with its commit or title); and what failed with its reason; and if it ends with the two open questions numbered 1 and 2, each naming its task and its options.
FAIL if any of those categories present in the status output is missing, if it pastes the raw JSON, or if the numbered questions are not at the end. Answer FAIL if you cannot tell.
