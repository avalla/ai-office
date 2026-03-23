---
name: office-task-create
description: Create a task on the AI Office board using the deterministic CLI. Usage: $office-task-create <title> [ms:M1] [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name] [deps:id,...] [estimate:4h] [labels:tag1,tag2] [slug:feature-slug]
disable-model-invocation: true
---

$ARGUMENTS format: `<title> [ms:M1] [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name] [deps:id,...] [estimate:4h] [labels:tag1,tag2] [slug:feature-slug]`

Argument guidance:
- Treat everything before the first keyword flag as the task title.
- Pass optional metadata through without inventing missing values.

Examples:
- `$office-task-create Fix upload timeout`
- `$office-task-create Add billing page ms:M1 priority:HIGH column:TODO assignee:Developer estimate:4h labels:feature,billing slug:billing-flow`

---

## Steps

1. Parse the task title and any provided metadata flags.
2. Run `ai-office task create ...` with the parsed values.
3. Return the created task id, column, and filename.
4. If the task should move immediately after creation, suggest `$office-task-move`.

<!-- ai-office-version: 1.9.0 -->
