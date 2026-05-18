---
name: office-route
description: Route a new request through AI Office and recommend the right next step. Usage: $office-route <request>
disable-model-invocation: true
---

Target host: Codex adapter

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
3. Check `pre_implementation_mode` in `.ai-office/project.config.md` when present.
4. Check `interactive_choices_mode` in `.ai-office/project.config.md` when present.
5. If `pre_implementation_mode` is `minimal`, ask only the minimum clarifying questions needed to avoid routing the work incorrectly.
6. If `pre_implementation_mode` is `confirm`, finish the analysis, propose one plan, and ask the user to confirm it before implementation starts.
7. If `pre_implementation_mode` is `collaborative`, finish the analysis, propose the recommended path plus 1-2 viable alternatives for non-trivial work, and ask which approach the user prefers or whether they want a different one.
8. If `interactive_choices_mode` is `buttons-when-available`, prefer host-provided structured choices for plan confirmation or approach selection, with concise text fallback when unavailable.
9. Identify the likely next artifact or pipeline stage, including whether a PRD, ADR, plan, or direct task work is appropriate.
10. Create or update the relevant `.ai-office/docs/` context artifact when appropriate.
11. End with the recommended next action, including the next AI Office command or CLI operation.

<!-- ai-office-version: 1.16.0 -->
