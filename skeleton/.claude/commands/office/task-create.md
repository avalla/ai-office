---
description: Create a new task on the AI Office kanban board. Usage: /office:task-create <title> [ms:M1] [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name] [deps:T001,T002] [estimate:4h]
---

$ARGUMENTS format: `<title> [ms:M1] [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name] [deps:id,...] [estimate:4h]`

Parse the arguments:
- **title**: everything before the first keyword flag (required)
- **ms**: milestone ID — must exist in `.ai-office/milestones/` unless it is `M0` — default `M0` (unscheduled)
- **priority**: `HIGH` | `MEDIUM` | `LOW` — default `MEDIUM`
- **column**: `BACKLOG` | `TODO` — default `BACKLOG`
- **assignee**: agent/person name — default `Unassigned`
- **deps**: comma-separated task IDs this task depends on (e.g. `M1_T002,M1_T003`) — default `—`
- **estimate**: time estimate like `2h`, `1d` — default `—`

Examples:
- `/office:task-create Fix upload timeout` → M0, MEDIUM, BACKLOG, Unassigned
- `/office:task-create Add billing page ms:M1 priority:HIGH column:TODO assignee:Developer estimate:4h`
- `/office:task-create Auth middleware ms:M2 assignee:Security deps:M1_T002-setup-db-developer`

---

## Steps

1. **Validate milestone**:
   - If `ms` is `M0`: proceed (M0 is always valid, no file required).
   - Otherwise: check that `.ai-office/milestones/<ms>.md` exists.
     - If it does not: stop and output:
       ```
       ❌ Milestone <ms> does not exist.
       Create it first: /office:milestone create <ms> "<name>"
       Or use ms:M0 for unscheduled tasks.
       ```
   - If the milestone exists but its frontmatter `status` is `archived`: warn and stop:
       ```
       ⚠️  Milestone <ms> is archived. Choose an active milestone or ms:M0.
       ```

2. **Determine the next sequence number** for the milestone:
   - Scan all `.md` files in `.ai-office/tasks/` (all column subdirs including ARCHIVED)
   - Find files whose names start with `<ms>_T` and extract the numeric sequence (e.g. `T003` → 3)
   - Next number = max found + 1, zero-padded to 3 digits
   - If none found for this milestone, start at `T001`

3. **Build the task ID and filename**:
   - Slug: title converted to kebab-case, lowercase, max 40 chars, strip special chars
   - Assignee slug: assignee name in lowercase, spaces → hyphens
   - Task ID: `<ms>_T<NNN>` (e.g. `M1_T003`)
   - Filename: `<ms>_T<NNN>-<slug>-<assignee-slug>.md` (e.g. `M1_T003-fix-upload-timeout-developer.md`)
   - Output path: `.ai-office/tasks/<COLUMN>/<filename>`

4. **Create the task file**:

```markdown
# <title>

**ID:** <ms>_T<NNN>
**Milestone:** <ms>
**Priority:** <priority>
**Status:** <column>
**Assignee:** <assignee>
**Dependencies:** <deps or —>
**Created:** <today ISO date>
**Started:** —
**Completed:** —
**Estimate:** <estimate or —>

## Description

<Derive a 1–2 sentence description from the title. Leave a placeholder if the title is too brief.>

## Acceptance Criteria

- [ ]

## Time Log

| Agent | Hours | Date | Notes |
|-------|-------|------|-------|

**Total Time:** 0h

## Notes
```

5. **Update `.ai-office/tasks/README.md`**:
   - Read current counts
   - Increment count for the target column
   - Update the `Updated:` date
   - Write the file back

6. Confirm: "Created `<ms>_T<NNN>`: **<title>** → `<COLUMN>` (`<filename>`)"
