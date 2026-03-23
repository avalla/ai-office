---
name: office-task-update
description: Update metadata on an existing task without moving it. Usage: $office-task-update <task-id> [priority:HIGH|MEDIUM|LOW] [assignee:name] [estimate:4h] [labels:bug,auth] [deps:T001,T002] [slug:feature-slug]
disable-model-invocation: true

$ARGUMENTS format: `<task-id> [priority:HIGH|MEDIUM|LOW] [assignee:name] [estimate:4h] [labels:tag1,tag2] [deps:id,...] [slug:feature-slug]`

- **task-id**: task ID like `M1_T003`, or partial filename match (e.g. `fix-upload`)
- **priority**: new priority — `HIGH` | `MEDIUM` | `LOW`
- **assignee**: new agent/person name
- **estimate**: new time estimate like `2h`, `1d`
- **labels**: comma-separated tags — replaces existing labels entirely
- **deps**: comma-separated task IDs — replaces existing deps entirely
- **slug**: the parent feature/project slug — links this task to a pipeline slug for `$office-advance` matching

At least one optional field must be provided.

Examples:
- `$office-task-update M1_T003 priority:HIGH` — raise priority
- `$office-task-update M1_T003 labels:bug,auth estimate:3h` — set labels and estimate
- `$office-task-update fix-upload assignee:Security labels:security slug:auth-refactor` — reassign, tag, and link to slug

---

## Steps

0. **Prefer the deterministic CLI path when available**:
   - If `ai-office` is available in the project, run:
     `ai-office task update <task-id> [priority:HIGH] [assignee:name] [estimate:4h] [labels:tag1,tag2] [deps:id,...] [slug:feature-slug]`
   - Report the CLI result and stop unless the CLI is unavailable or errors in a way that requires manual recovery.

1. **Find the task file**: scan all subdirs of `.ai-office/tasks/` for a `.md` file whose name starts with or contains `<task-id>`. List candidates if multiple match.

2. **Parse fields to update**: extract only the keyword flags provided. Skip any not present.

3. **Update the task file** — for each provided field, replace the corresponding `**Field:**` line:
   - `**Priority:** <new>`
   - `**Assignee:** <new>`
   - `**Estimate:** <new>`
   - `**Labels:** <new>`
   - `**Dependencies:** <new>`
   - `**Slug:** <new>` (add the line if absent)

4. **Append to `## History`**:
   ```
   - <today ISO date>: Updated — <list changed fields, e.g. "priority: MEDIUM → HIGH, labels: — → bug,auth">
   ```

5. Confirm: "Updated `<task-id>`: <summary of changes>"

<!-- ai-office-version: 1.5.0 -->
