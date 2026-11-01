---
name: jevellan-landing
description: "Jevellan internal. Not for direct use. Landing policy that Jev reads to route a finished task to land, verify-then-land or ask-owner."
disable-model-invocation: true
jv-version: 0.1.0
jv-eval-runner: evals/run.mjs
---

# Landing policy

When every step of a task is done, `jv land` asks Jev one question, landing_route, with the landing state of the task: its title, kind and text, the final step summaries, the changed files with their additions and deletions, the checks that already ran and whether they passed, the corrections the task needed (retries and their reasons), and riskyAreas, the project's risky paths from landing.json. The script reads three sections of this file: "landing_route" is sent as the question's instructions, "routes" holds one criterion line per route ("<route>: <criterion>", nothing else), and "rules" is sent with the state as the standing rules. Everything outside those three sections, this paragraph included, is for people and is ignored by the script.

To change the policy: edit one thing, run `jv evals landing` to replay it against the stored landing decisions, read the disagreements, and keep the change only when agreement on the held-out cases improves.

## landing_route

Choose how this checked task reaches the project's default branch. Judge it from what changed (the files, their size, and whether any of them falls in a risky area), from what the checks that passed actually exercise, and from the corrections the task needed on the way. Landing puts the change on the default branch, where the owner releases it later; it deploys nothing. Production behaviour, in the routes, means deployed systems, live data, credentials, billing, infrastructure and deploy configuration, not the ordinary feature, UI, test or documentation changes every task makes. A small change outside the risky areas that the passing checks cover lands; a behaviour change the checks do not exercise is verify-then-land. When two routes fit about equally, choose the more cautious one.

## routes

land: Small or low-risk change outside the project's risky areas, covered by the checks that passed.
verify-then-land: A behaviour change the checks do not exercise, or a medium-sized change, outside the risky areas.
ask-owner: Touches a risky area, changes stored data or production behaviour, or is large or hard to undo.

## rules

Risky areas. A change touches a risky area when any changed file, or the behaviour the summaries describe, involves one of these: stored data (database schemas, the shape of records and files the application keeps, data formats other systems read or write); authentication, sessions, permissions and credentials; money (payments, billing, prices, invoices, refunds); deletion (anything that removes, purges or overwrites data or files people keep); concurrency (locks, queues, background workers, retries, jobs that run in parallel); migrations of any kind (schema, data, configuration); and any changed file under one of the project's risky paths, listed in riskyAreas. A path or file name that suggests one of them (migrat, auth, login, credential, pay, billing, delete, remove, lock, queue) counts as touching it unless the summaries show plainly that it does not. A change that only displays something about one of them (a heading or a total shown on a page that lists orders, a currency label next to a price) without changing how it is computed, stored, charged or sent does not touch it.

Production. Production behaviour means what deployed systems do with live data, credentials and billing, and how they are built and run: deploy scripts, CI workflows, infrastructure, and environment and deploy configuration. A change to any of those is a change to production behaviour and goes to the owner however small it is, because no check that runs before landing exercises a deployed system. Ordinary feature, UI, test and documentation changes are not: they land on the default branch, and the owner releases them later. Such a change, small and outside the risky areas, lands when the passing checks cover it; when it changes behaviour the checks do not exercise, it is verify-then-land.

Size. Small is at most two files and about a hundred changed lines; large is more than twelve files or more than about a thousand changed lines; medium is everything in between. Generated files and lock files count for little; tests count for less than the code they test.

Checks. A check counts as coverage only when it passed on this branch and exercises the changed behaviour. No checks, or a verify report whose tests did not pass, is no coverage. Tests added by the task cover what they assert, not the whole change.

Corrections. A task that needed retries (a verification failed and was fixed) leans one route more cautious, unless the final checks plainly cover what failed.

Documentation-only and test-only changes outside the risky areas whose checks passed land.
