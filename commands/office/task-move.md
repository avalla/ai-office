---
description: Move a task to a different kanban column. Usage: /office:task-move <task-id> <column> [reason]
---

$ARGUMENTS format: `<task-id> <column> [reason]`

- **task-id**: full task ID like `TASK-1742300000000-a3f2`, or a partial match (slug of the title)
- **column**: target column — `BACKLOG` | `TODO` | `WIP` | `REVIEW` | `DONE`
- **reason**: optional note to record in the task file

---

## Steps

1. **Find the task file**: search all subdirs of `.ai-office/tasks/` for a file matching `<task-id>` in the filename or whose `**ID:**` field matches. List candidates if multiple match.

2. **Determine current column** from the file's current directory path.

3. **Update the task file**:
   - Change `**Status:**` field to the new column name
   - If moving to `WIP`: add `**Started:** <today ISO>` after Status if not present
   - If moving to `DONE`: add `**Completed:** <today ISO>` after Status if not present
   - If reason provided: append a line to the `## Notes` section: `<today>: moved to <column> — <reason>`

4. **Move the file**: rename/move it from `.ai-office/tasks/<OLD_COLUMN>/` to `.ai-office/tasks/<NEW_COLUMN>/`

5. **Update `.ai-office/tasks/README.md`**:
   - Decrement count for old column
   - Increment count for new column
   - Update `Updated:` date

6. Confirm: "Moved `<task-id>`: `<old-column>` → `<new-column>`"
