---
name: office-route
description: Route a new request through AI Office and recommend the right next step. Usage: $office-route <request>
disable-model-invocation: true
---

$ARGUMENTS format: `<request>`

Argument guidance:
- Treat the full argument string as the incoming request to classify.

Examples:
- `$office-route Add user profile editing`
- `$office-route Audit subscription refunds flow`

---

## Steps

1. Read `AI-OFFICE.md` and `.ai-office/project.config.md` if it exists.
2. Summarize the request in one sentence and classify it as quick fix, feature, refactor, audit, or operational task.
3. If context is missing, ask only the minimum clarifying questions needed to avoid routing the work incorrectly.
4. Identify the likely next artifact or pipeline stage, including whether a PRD, ADR, plan, or direct task work is appropriate.
5. Create or update the relevant `.ai-office/docs/` context artifact when appropriate.
6. End with the recommended next action, including the next AI Office command or CLI operation.

<!-- ai-office-version: 1.11.0 -->
