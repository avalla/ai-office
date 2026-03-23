---
name: office-task-update
description: Update AI Office task metadata without moving the task. Usage: /office-task-update <task-id> [priority:...] [assignee:...] [estimate:...] [labels:...] [slug:...]
disable-model-invocation: true
---

$ARGUMENTS format: `<task-id> [priority:...] [assignee:...] [estimate:...] [labels:...] [slug:...]`

Examples:
- `/office-task-update M0_T001 priority:HIGH labels:billing,backend estimate:3h`

---

## Steps

1. Collect the task id and only the fields the user wants to change.
2. Run `ai-office task update <task-id> ...`.
3. Confirm the updated metadata and mention any meaningful effect on milestone or workflow tracking.

<!-- ai-office-version: 1.9.0 -->
