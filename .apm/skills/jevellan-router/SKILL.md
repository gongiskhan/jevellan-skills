---
name: jevellan-router
description: "Jevellan internal. Not for direct use. Placement policy that Jev reads to choose the runtime, provider, model and effort of every task step."
disable-model-invocation: true
jv-version: 0.1.0
jv-eval-runner: evals/run.mjs
---

# Placement policy

This file is the policy Jev reads when the router places a step of a task: which model runs it, at what effort, and
on which provider account. The router script (`scripts/jv/src/route.ts`) builds the menu itself from
`~/.jv/providers.json`: only providers that are enabled, logged in, under their usage ceiling and able to run the
duty's runtime are offered. Jev then chooses among those options; it never sees a provider that cannot run the step.
The runtime follows from the provider and the step (a visible step on a provider of kind `claude-subscription` or `claude-endpoint` runs in tmux), so this policy
says nothing about runtimes.

The script reads only the level-2 sections below, by name. Everything above them, like this text, is for people.

- `model` and `effort` are the instructions sent with the model question and the effort question.
- `model descriptions` has one `<model id>: <text>` line per model id in providers.json. Each line becomes the
  criterion of that model's option. A model in the menu without a line stops placement with exit 2, so the policy
  cannot drift from the providers silently; `jv doctor` lists the missing ids.
- `effort guide` has one line per effort level; the lines for the levels in the menu become the effort question's
  criteria. The chosen effort is mapped afterwards onto the nearest level the chosen model supports.
- `questions` holds the workflow questions asked once when a task is created (a step whose rule is `jev:<id>` is
  skipped when the answer is false), each written `<id>: <question> true: <criterion> false: <criterion>`.
- `rules` is sent verbatim to Jev with every placement: the owner's standing preferences.

Owner rules that must hold no matter what Jev answers (an effort floor or ceiling for some kind of work) do not belong
here: they go in `~/.jv/projects/<project>/rules.json`, which the router applies after Jev and reports in the
decision row.

### How to improve this policy

Every placement is stored as a decision row with the sha256 of this file's body, the state Jev saw, the questions,
the answers with their probabilities, what the script chose, and later the step's outcome and any owner override. The
loop is:

1. Edit one thing in this file: a description, an effort guide line, a rule.
2. Install it with `jv update`.
3. Export cases with `jv evals route --since <date>`. The expected answer of a case is the owner's override when
   there is one, else Jev's choice when the step was done on the first attempt; failed steps come out unlabelled for
   a person to label. Every fifth case is held out.
4. Replay the policy against the cases with `node evals/run.mjs` (the runner this skill declares as
   `jv-eval-runner`). It prints agreement per question and every disagreement with its probabilities, and writes
   `evals/RESULTS.md` with the policy hash.
5. Read the disagreements, change one thing, run again. Commit when agreement on the held-out cases improves.

## model
Choose the model for this step. Read the task, the step's duty and instructions, what the earlier steps of this task reported, the recent history and the owner's rules in the state. Each option names a model, the provider account that would run it and the runtime; its text says what the owner uses that model for. Match the work this step will actually do to those texts, and follow the rules wherever they speak to this kind of work. Prefer the model the previous step of this task used when it fits, because consecutive steps on one model reuse its cache. Treat a provider whose weekly usage is close to its ceiling as a last resort. On a retry after a failure, prefer a model at least as strong as the one that failed.

## model descriptions
claude-opus-5-5: Strong default for planning, implementation, reviews and all UI work (the owner wants UI on Opus at high or extra high, never on Fable).
claude-fable-5-1: The strongest Claude model: deep architecture, stubborn bugs, the hardest design questions. Uses subscription quota fastest. Not for UI.
claude-sonnet-5-5: Only trivial, mechanical work and short documentation.
claude-haiku-5-5: Short answers and conversation turns.
gpt-6-astra: Long, well-specified implementation runs; nearly as strong as Fable and its quota lasts about five times longer. An independent reviewer for work written by Claude.
glm-5.3: Cheap implementation of small, clear changes and mechanical refactors when Claude quota is tight.
deepseek-chat: Cheap answers and investigation summaries.
kimi-k2-turbo-preview: Cheap answers and conversation turns, and summaries of long texts; never for changes to the repository.
qwen3:8b: A small local model: only the shortest answers and conversation turns, when nothing else is available.

## effort
Choose the reasoning effort for this step. Effort follows how hard the step is, not how important the task is. Each option says when that level fits; pick the lowest level that fits the work this step will do. Weigh the duty (answers and conversation need little; implementation, planning and verification are usually high), the size and ambiguity of the task, whether it is UI or visual work, and the attempt number: a retry after a step failed at a lower effort goes higher. When the chosen model does not support the level you pick, the next supported level above it is used.

## effort guide
low: Short answers and conversation replies. Never for implementation.
medium: Small fixes, documentation and mechanical changes.
high: Default for implementation, planning and verification.
xhigh: Features across many files, architecture, hard debugging, all UI work on Claude.
max: After a step failed at a lower effort, or when the task text asks for the hardest effort.

## questions
needs_plan: Does this task need a written plan before implementation? true: The work spans several parts of the system, changes stored data, or the request is ambiguous. false: A small, clear change that a capable engineer would just do.
needs_docs: Does this change need documentation written for people? true: It changes how someone runs, configures or uses the project. false: Internal change, tests, or a fix with no user-visible behaviour change.

## rules
The owner builds TypeScript and JavaScript web apps and agent platforms.
Effort follows difficulty, not importance: most implementation, planning and verification are high; routine work is medium; quick answers are low; extra high or max for the hardest design, debugging and UI work, or after a step failed at a lower effort.
UI, visual work and anything judged by looking goes to Opus at high or extra high. Not Fable: the owner finds it too fast and careless on interfaces.
Long, well-specified implementation prefers GPT through Codex, especially when Claude quota is tight.
Prefer staying on the model the previous step used when it fits: consecutive steps on the same model reuse its prompt cache.
Small, clear changes need no plan. Plan when the work spans several parts of the system, changes stored data, or the request is ambiguous.
Tests catch problems better than reviews. Review only when the owner's workflow has a review step.
Sonnet almost never. Haiku and the cheap endpoint models for answers and conversation.
A provider above 80% of its weekly ceiling is a last resort; above the ceiling it is not in the menu.
