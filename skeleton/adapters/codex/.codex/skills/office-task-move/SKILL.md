---
name: office-task-move
description: Move a task between AI Office board columns and keep history consistent. Usage: $office-task-move <task-id> <column> [reason]
disable-model-invocation: true
---

$ARGUMENTS format: `<task-id> <column> [reason]`

Examples:
- `$office-task-move M0_T001 WIP "started work"`
- `$office-task-move M1_T004 REVIEW "acceptance criteria met"`

---

## Steps

1. Collect the task id, destination column, and optional reason.
2. Run `ai-office task move <task-id> <column> "<reason>"`.
3. Summarize the move and call out any branch or worktree information created as part of task isolation.
4. If the move implies a next workflow, suggest it explicitly.

<!-- ai-office-version: 1.9.0 -->
