---
name: office-task-move
description: Move a task to a different kanban column. Usage: $office-task-move <task-id> <column> [reason]
disable-model-invocation: true

$ARGUMENTS format: `<task-id> <column> [reason]`

- **task-id**: task ID like `M1_T003`, or partial filename match (e.g. `fix-upload`)
- **column**: target column — `BACKLOG` | `TODO` | `WIP` | `REVIEW` | `BLOCKED` | `DONE` | `ARCHIVED`
- **reason**: optional note to record in the task file

---

## Steps

0. **Prefer the deterministic CLI path when available**:
   - If `ai-office` is available in the project, run:
     `ai-office task move <task-id> <column> [reason]`
   - Report the CLI result and stop unless the CLI is unavailable or errors in a way that requires manual recovery.

1. **Find the task file**: scan all subdirs of `.ai-office/tasks/` for a `.md` file whose name starts with or contains `<task-id>`. If the ID is a partial slug, match against filename. List candidates if multiple match.

2. **Determine current column** from the file's current directory path.

3. **Update the task file**:
   - Change `**Status:**` to the new column name
   - If moving to `WIP`:
     - Set `**Started:**` to today's ISO date (if currently `—`)
     - Derive the branch name from the task filename: extract `<ms>` and `T<NNN>-<slug>` parts, then compose `task/<ms>/T<NNN>-<slug>` (replace `_` with `/` between milestone and task number, e.g. `task/M1/T003-fix-upload-timeout`)
     - Run `git checkout -b <branch-name>` (if the branch already exists, run `git checkout <branch-name>` instead)
     - Update `**Branch:**` in the task file to `<branch-name>`
     - Append to `## History`: `- <today ISO>: branch created — <branch-name>`
   - If moving to `DONE`: set `**Completed:**` to today's ISO date; append to `## History`: `- <today ISO>: branch ready for squash merge at milestone close — <branch-name>`
   - If moving to `ARCHIVED`: set `**Completed:**` to today's ISO date (if currently `—`) and prepend `[ARCHIVED] ` to the title heading
   - If moving to `BLOCKED`: a reason is strongly recommended — if none provided, append a warning note: `<today ISO>: moved to BLOCKED — no reason given; add unblock criteria`
   - If reason provided: append a row to `## Notes`: `<today ISO>: moved to <column> — <reason>`
   - **Append to `## History`**: `- <today ISO date>: <OLD_COLUMN> → <NEW_COLUMN><if reason: — reason>`

4. **Move the file**: move it from `.ai-office/tasks/<OLD_COLUMN>/` to `.ai-office/tasks/<NEW_COLUMN>/`. Keep the filename unchanged.

5. **Update `.ai-office/tasks/README.md`**:
   - Decrement count for old column
   - Increment count for new column
   - Update `Updated:` date

6. Confirm: "Moved `<task-id>`: `<OLD_COLUMN>` → `<NEW_COLUMN>`"

<!-- ai-office-version: 1.5.0 -->
