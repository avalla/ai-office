---
description: Create a new task on the AI Office kanban board. Usage: /office:task-create <title> [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name]
---

$ARGUMENTS format: `<title> [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name]`

Parse the arguments:
- **title**: everything before the first `priority:`, `column:`, or `assignee:` keyword (required)
- **priority**: `HIGH` | `MEDIUM` | `LOW` — default `MEDIUM`
- **column**: `BACKLOG` | `TODO` — default `BACKLOG`
- **assignee**: name string — default `Unassigned`

Examples:
- `/office:task-create Fix upload timeout` → MEDIUM, BACKLOG, Unassigned
- `/office:task-create Add billing page priority:HIGH column:TODO assignee:Developer`

---

## Steps

1. Generate a task ID: `TASK-<timestamp>-<4-char-random>` where timestamp is current unix ms and random is 4 alphanumeric chars (e.g. `TASK-1742300000000-a3f2`)

2. Determine the output path: `.ai-office/tasks/<COLUMN>/<task-id>.md`

3. Create the task file with this content:

```
# <title>

**ID:** <task-id>
**Priority:** <priority>
**Status:** <column>
**Assignee:** <assignee>
**Created:** <today ISO date>

## Description
<If title is descriptive enough, derive a 1-2 sentence description. Otherwise leave a placeholder.>

## Acceptance Criteria
- [ ]

## Notes
```

4. Update `.ai-office/tasks/README.md`:
   - Read the current counts
   - Increment the count for the target column
   - Update the `Updated:` date
   - Write the file back

5. Confirm: "Created task `<task-id>`: **<title>** → `<column>`"
