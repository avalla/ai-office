---
name: office-advance
description: Advance work to the next AI Office stage after checking readiness and evidence. Usage: $office-advance <slug> <evidence> [next-stage]
disable-model-invocation: true
---

$ARGUMENTS format: `<slug> <evidence> [next-stage]`

Argument guidance:
- The first argument is the pipeline slug.
- The second argument is a short evidence summary.
- The optional third argument is the target stage if it should not be inferred.

Examples:
- `$office-advance billing-sync "PRD approved and scope frozen" adr`
- `$office-advance search-rewrite "dev checks passed and review complete" user_acceptance`

---

## Steps

1. Read `AI-OFFICE.md` and the relevant `.ai-office/docs/runbooks/<slug>-status.md` file if present.
2. Confirm the current stage, the requested next stage, and the evidence available.
3. Check that the current artifact set is complete enough for the transition.
4. If the transition is not ready, explain the exact missing artifact or evidence instead of advancing.
5. If the transition is ready, update the relevant status artifact and summarize the next owner and next workflow.

<!-- ai-office-version: 1.9.1 -->
