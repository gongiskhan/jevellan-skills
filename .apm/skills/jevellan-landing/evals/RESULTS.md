# Eval results: jevellan-landing

- Date: 2026-11-01T14:16:45.461Z
- Skill hash: `f458fb15a602631adaf0d50d38be3e57d76b5d6ff4ebb52daaba79163ca23b42`
- Cases: 7 cases (7 scored, 0 unlabelled, 0 stale), split all from `cases.json`
- Jev: jev-latest (answered by jev-1.14.0), 7 calls, 8015 input and 322 output tokens
- Held-out agreement: 100% (threshold 60%): pass

## Agreement

| question | dev | held-out | all |
| --- | --- | --- | --- |
| landing_route | 4/5 (80%) | 2/2 (100%) | 6/7 (86%) |
| **all questions** | 4/5 (80%) | 2/2 (100%) | 6/7 (86%) |

## Disagreements

- hand-land-deploy-workflow (dev, hand) landing_route: expected ask-owner, Jev verify-then-land [verify-then-land 0.54, ask-owner 0.45, land 0.01]

## Unlabelled

None.

## Stale

None.
