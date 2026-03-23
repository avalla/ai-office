---
name: office-status
description: Read or update the AI Office status for a pipeline slug. Usage: $office-status <slug> [state] [owner] [notes]
disable-model-invocation: true
---

$ARGUMENTS format: `<slug> [state] [owner] [notes]`

Argument guidance:
- With only a slug, this is a read operation.
- With state, owner, and notes, this is a deterministic update.

Examples:
- `$office-status billing-sync`
- `$office-status billing-sync dev Developer "Implementation started"`

---

## Steps

1. If the user wants the current state, run `ai-office status get <slug>` and summarize the result.
2. If the user wants to update state, collect slug, state, owner, and notes, then run `ai-office status set <slug> <state> <owner> "<notes>"`.
3. Report the updated state and any important next-stage implication.
4. If required update fields are missing, ask only for the missing required values.

<!-- ai-office-version: 1.9.1 -->
