# Eval results: jevellan-router

- Date: 2026-11-01T19:08:26.888Z
- Skill hash: `482b01793ddb5b50cd9cabffe9fc7732da68c54849ed90d579001a057165a1bf`
- Cases: 63 cases (63 scored, 0 unlabelled, 0 stale), split all from `cases.json`
- Jev: jev-latest (answered by jev-1.14.0), 106 calls, 206919 input and 10199 output tokens
- Held-out agreement: 94% (threshold 60%): pass

## Agreement

| question | dev | held-out | all |
| --- | --- | --- | --- |
| model | 36/41 (88%) | 10/10 (100%) | 46/51 (90%) |
| effort | 38/43 (88%) | 8/10 (80%) | 46/53 (87%) |
| provider | 32/34 (94%) | 9/9 (100%) | 41/43 (95%) |
| needs_docs | 6/6 (100%) | 2/2 (100%) | 8/8 (100%) |
| needs_plan | 6/6 (100%) | 3/3 (100%) | 9/9 (100%) |
| **all questions** | 118/130 (91%) | 32/34 (94%) | 150/164 (91%) |

## Disagreements

- DNW4JKV (dev, override) model: expected claude-sonnet-5-5, Jev claude-opus-5-5 [claude-opus-5-5 0.80, gpt-6-astra 0.19, claude-sonnet-5-5 0.01, claude-fable-5-1 0.00]
- DNW4JKV (dev, override) effort: expected low, Jev high [high 0.83, xhigh 0.13, medium 0.04, low 0.00]
- D03VRSY (held-out, override) effort: expected low, Jev medium [medium 0.96, low 0.03, high 0.01, xhigh 0.00]
- D9HR13N (dev, override) model: expected gpt-6-astra, Jev claude-haiku-5-5 [claude-haiku-5-5 0.38, claude-sonnet-5-5 0.28, claude-opus-5-5 0.19, gpt-6-astra 0.14]
- D9HR13N (dev, override) provider: expected codex, Jev claude-second [claude-second 0.92, claude-main 0.08]
- DQBP4JJ (dev, override) model: expected claude-sonnet-5-5, Jev gpt-6-astra [gpt-6-astra 0.61, claude-opus-5-5 0.18, claude-sonnet-5-5 0.16, claude-haiku-5-5 0.05]
- DQBP4JJ (dev, override) effort: expected low, Jev medium [medium 0.51, low 0.46, high 0.03, xhigh 0.00]
- DY887AF (held-out, override) effort: expected low, Jev medium [medium 0.98, low 0.01, high 0.01, xhigh 0.00]
- DMJ84FK (dev, override) model: expected claude-fable-5-1, Jev claude-sonnet-5-5 [claude-sonnet-5-5 0.88, claude-opus-5-5 0.12, gpt-6-astra 0.00, claude-fable-5-1 0.00]
- DMJ84FK (dev, override) effort: expected high, Jev medium [medium 0.98, high 0.02, low 0.00, xhigh 0.00]
- D9EDQBW (dev, override) effort: expected low, Jev medium [medium 0.98, low 0.01, high 0.01, xhigh 0.00]
- DHWE517 (dev, override) provider: expected claude-main, Jev claude-second [claude-second 0.97, claude-main 0.03]
- D0JDV1R (dev, outcome) model: expected gpt-6-astra, Jev claude-opus-5-5 [claude-opus-5-5 0.96, claude-fable-5-1 0.02, claude-haiku-5-5 0.02, gpt-6-astra 0.00]
- D0JDV1R (dev, outcome) effort: expected medium, Jev low [low 0.53, medium 0.37, high 0.10, xhigh 0.00]

## Unlabelled

None.

## Stale

None.
