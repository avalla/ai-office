---
description: List tasks on the kanban board. Usage: /office:task-list [column] [ms:M1] [assignee:name]
---

$ARGUMENTS format (all optional): `[column] [ms:M1] [assignee:name]`

- **column**: filter by `BACKLOG` | `TODO` | `WIP` | `REVIEW` | `DONE` — omit for all
- **ms**: filter by milestone (e.g. `ms:M1`) — omit for all
- **assignee:name**: filter by assignee

---

## Steps

1. Determine which columns to scan:
   - If a specific column is given: scan only that column
   - If no column arg: scan all active columns (`BACKLOG`, `TODO`, `WIP`, `REVIEW`, `DONE`)
   - `ARCHIVED` is **never** included by default — only when explicitly requested (`/office:task-list ARCHIVED`)

   Active column dirs:
   - `.ai-office/tasks/BACKLOG/`
   - `.ai-office/tasks/TODO/`
   - `.ai-office/tasks/WIP/`
   - `.ai-office/tasks/REVIEW/`
   - `.ai-office/tasks/DONE/`
   - `.ai-office/tasks/ARCHIVED/` (only when explicitly requested)

2. For each `.md` file found (excluding `README.md`), read and extract:
   - ID (`**ID:**`)
   - Milestone (`**Milestone:**`)
   - Title (first `# ` heading)
   - Priority (`**Priority:**`)
   - Assignee (`**Assignee:**`)
   - Status/column (`**Status:**`)
   - Dependencies (`**Dependencies:**`)
   - Estimate (`**Estimate:**`)
   - Total Time (`**Total Time:**`)

3. Apply filters: milestone filter (if `ms:` arg provided), assignee filter (if `assignee:` arg provided).

4. Display grouped by column, then sorted by milestone within each column:

```
## WIP (2)
| ID | Milestone | Title | Priority | Assignee | Estimate | Time |
|----|-----------|-------|----------|----------|----------|------|
| M1_T003 | M1 | Fix upload timeout | HIGH | Developer | 4h | 1.5h |
| M2_T001 | M2 | Auth middleware | MEDIUM | Security | 2h | 0h |

## TODO (1)
| ID | Milestone | Title | Priority | Assignee | Estimate | Time |
...
```

5. Append summary: `Total: X tasks across Y columns` and, if milestones are present, a milestone breakdown:

```
Milestones: M0 (3 tasks) · M1 (5 tasks) · M2 (2 tasks)
```

If no tasks found in the requested scope, say so clearly.
