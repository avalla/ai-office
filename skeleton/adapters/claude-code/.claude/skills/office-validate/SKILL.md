---
name: office-validate
description: Run deterministic AI Office validation for a pipeline stage. Usage: /office-validate <slug> <stage>
disable-model-invocation: true
---

$ARGUMENTS format: `<slug> <stage>`

Examples:
- `/office-validate billing-sync prd`
- `/office-validate search-rewrite dev`

---

## Steps

1. Collect the feature slug and stage.
2. Run `ai-office validate <slug> <stage>`.
3. Summarize the pass, warn, and fail results.
4. If validation fails, explain the smallest useful next action instead of claiming the work is complete.

<!-- ai-office-version: 1.9.0 -->
