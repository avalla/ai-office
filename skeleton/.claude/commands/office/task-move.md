---
description: Move a task to a different kanban column. Usage: /office:task-move <task-id> <column> [reason]
---

$ARGUMENTS format: `<task-id> <column> [reason]`

- **task-id**: task ID like `M1_T003`, or partial filename match (e.g. `fix-upload`)
- **column**: target column — `BACKLOG` | `TODO` | `WIP` | `REVIEW` | `DONE` | `ARCHIVED`
- **reason**: optional note to record in the task file

---

## Steps

1. **Find the task file**: scan all subdirs of `.ai-office/tasks/` for a `.md` file whose name starts with or contains `<task-id>`. If the ID is a partial slug, match against filename. List candidates if multiple match.

2. **Determine current column** from the file's current directory path.

3. **Update the task file**:
   - Change `**Status:**` to the new column name
   - If moving to `WIP`: set `**Started:**` to today's ISO date (if currently `—`)
   - If moving to `DONE`: set `**Completed:**` to today's ISO date
   - If moving to `ARCHIVED`: set `**Completed:**` to today's ISO date (if currently `—`) and prepend `[ARCHIVED] ` to the title heading
   - If reason provided: append a row to `## Notes`: `<today ISO>: moved to <column> — <reason>`

4. **Move the file**: move it from `.ai-office/tasks/<OLD_COLUMN>/` to `.ai-office/tasks/<NEW_COLUMN>/`. Keep the filename unchanged.

5. **Update `.ai-office/tasks/README.md`**:
   - Decrement count for old column
   - Increment count for new column
   - Update `Updated:` date

6. Confirm: "Moved `<task-id>`: `<OLD_COLUMN>` → `<NEW_COLUMN>`"
