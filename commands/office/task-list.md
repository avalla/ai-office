---
description: List tasks on the kanban board. Usage: /office:task-list [column] [assignee:name]
---

$ARGUMENTS format (all optional): `[column] [assignee:name]`

- **column**: filter by `BACKLOG` | `TODO` | `WIP` | `REVIEW` | `DONE` — if omitted, show all
- **assignee:name**: filter by assignee name

---

## Steps

1. Determine which columns to scan (all if no column arg, specific column otherwise):
   - `.ai-office/tasks/BACKLOG/`
   - `.ai-office/tasks/TODO/`
   - `.ai-office/tasks/WIP/`
   - `.ai-office/tasks/REVIEW/`
   - `.ai-office/tasks/DONE/`

2. For each `.md` file found (excluding `README.md`), read and extract:
   - ID (`**ID:**`)
   - Title (first `# ` heading)
   - Priority (`**Priority:**`)
   - Assignee (`**Assignee:**`)
   - Status/column (`**Status:**`)

3. Apply assignee filter if provided.

4. Display as a grouped table per column:

```
## WIP (2)
| ID | Title | Priority | Assignee |
|----|-------|----------|----------|
| TASK-... | Fix upload timeout | HIGH | Developer |

## TODO (1)
| ID | Title | Priority | Assignee |
...
```

5. Append a summary line: `Total: X tasks across Y columns`

If no tasks found in the requested scope, say so clearly.
