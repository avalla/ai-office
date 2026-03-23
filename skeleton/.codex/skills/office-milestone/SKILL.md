---
name: office-milestone
description: Manage project milestones. Usage: $office-milestone <create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask]|list|status <id>|close <id>|archive <id>>
disable-model-invocation: true

$ARGUMENTS format: `<create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask] | list | status <id> | close <id> | archive <id>>`

Milestones directory: `.ai-office/milestones/`
Each milestone is a file: `.ai-office/milestones/<id>.md`

Milestone IDs are short identifiers like `M1`, `M2`, `sprint-1`, `alpha`. `M0` is reserved for unscheduled/misc tasks and cannot be created, closed, or archived via this command.

Prefer the deterministic CLI path when available:
- `ai-office milestone create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask]`
- `ai-office milestone status <id>`
- `ai-office milestone list`
- If the CLI succeeds for the requested action, report its output and stop.

---

## `create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask]`

Arguments:
- **id**: milestone identifier (e.g. `M1`, `v1.2`, `sprint-3`)
- **name**: human-readable goal (e.g. `"Notifications working"`)
- **target**: optional due date `YYYY-MM-DD`
- **tasks**: task generation mode — `ask` (default), `yes` (auto-create without prompting), `no` (skip)

### Steps

1. Check that `<id>` is not `M0`. If it is, refuse: "M0 is reserved for unscheduled tasks."
2. Check if `.ai-office/milestones/<id>.md` already exists. If so, warn and stop.
3. **Gather context** — read the following if they exist:
   - `.ai-office/project.config.md` → `agency`, `project_name`, `ui_framework`
   - Any PRD in `.ai-office/docs/prd/` whose filename or title relates to the milestone name (fuzzy match)
   - Any ADR in `.ai-office/docs/adr/` similarly related
   - Existing tasks in `.ai-office/tasks/` for this milestone (in case the ID was used before)
4. **Generate task suggestions** — reason about `<name>` plus any gathered context to produce a list of tasks that represent the work needed to reach this milestone.

   **Reasoning rules:**
   - Cover the full pipeline for each deliverable: backend logic, API/integration layer, UI (if `ui_framework` is set), tests, and docs/runbook
   - Group related work into cohesive tasks (not micro-tasks); aim for tasks completable in ≤ 1 day
   - Assign each task to the appropriate agent based on its type (see agent mapping below)
   - Suggest realistic priorities: `high` for blocking work, `medium` for core features, `low` for polish/docs
   - Estimate effort: `1h`–`8h` per task; flag anything over `8h` as "consider splitting"
   - Suggest 4–12 tasks — if the milestone scope seems larger, note it and suggest sub-milestones

   **Agent assignment heuristics:**

   | Task type | Agent |
   |-----------|-------|
   | DB schema, migrations, RLS | `developer` |
   | API endpoints, business logic | `developer` |
   | UI components, screens | `developer` |
   | State management, hooks | `developer` |
   | Unit + integration tests | `qa` |
   | E2E / acceptance tests | `qa` |
   | Security review | `security-specialist` |
   | Performance audit | `reviewer` |
   | Architecture decision | `architect` |
   | PRD / requirements doc | `pm` |
   | Runbook / ops doc | `ops` |
   | Design mockup | `designer` |

5. **Present the suggested tasks:**

   ```
   Milestone <id>: <name>

   Suggested tasks (N):

   | # | Title | Assignee | Priority | Estimate |
   |---|-------|----------|----------|----------|
   | 1 | Create notifications table + RLS | developer | high | 2h |
   | 2 | Implement send-notification edge function | developer | high | 3h |
   | 3 | Add notification preferences to user profile | developer | medium | 2h |
   | 4 | Build notification bell UI component | developer | medium | 4h |
   | 5 | Write unit tests for notification logic | qa | medium | 2h |
   | 6 | E2E test: user receives notification | qa | medium | 2h |
   | 7 | Security review: notification payload validation | security-specialist | high | 1h |
   | 8 | Runbook: deploy and rollback procedure | ops | low | 1h |
   ```

6. **Task creation mode:**

   - If `tasks:no`: confirm milestone created, skip to step 7. Suggest: "Run `$office-task-create` to add tasks manually."
   - If `tasks:yes` OR (`tasks:ask` AND `advance_mode` is `auto`): create all suggested tasks immediately (step 6a).
   - If `tasks:ask` AND `advance_mode` is `manual` (default): ask:
     ```
     Create these tasks? Options:
       all      — create all N tasks as shown
       select   — I'll tell you which numbers to create (e.g. "1 2 3 5")
       edit     — show me each task to adjust before creating
       none     — skip, I'll create tasks manually
     ```
     Wait for the user's response, then proceed accordingly.

   **6a — Creating tasks:**
   For each task to create, call the same logic as `$office-task-create` with:
   - title from the suggestion
   - `ms:<id>`
   - `assignee:<agent>`
   - `priority:<priority>`
   - `estimate:<estimate>`
   - Auto-assign the next available task number within this milestone (scan existing `<id>_T*` files)

7. **Create `.ai-office/milestones/<id>.md`**, populating Goals and Definition of Done from the task list:

```markdown
---
id: <id>
name: "<name>"
target: <target or "">
status: active
created: <today ISO>
---

# <id>: <name>

**Target:** <target or "—">
**Status:** active
**Created:** <today ISO>

## Goals

> <one-sentence summary inferred from the milestone name and tasks>

## Definition of Done

<one checkbox per suggested task title>
- [ ] <task 1 title>
- [ ] <task 2 title>
...

## Notes
```

8. Update `.ai-office/milestones/README.md` — add a row for this milestone (create the file if it doesn't exist).
9. Confirm:
   ```
   ✅ Milestone <id> created: <name>
   Tasks created: N  (or "skipped")
   Run `$office-milestone status <id>` to see progress.
   ```

---

## `list`

Read all `.md` files in `.ai-office/milestones/` (excluding `README.md`). For each, extract frontmatter fields.

Output:

```
Milestones

| ID | Name | Target | Status | Tasks |
|----|------|--------|--------|-------|
| M1 | Auth & Onboarding | 2026-04-01 | active | 7 (3 done) |
| M2 | Billing | 2026-05-01 | active | 2 (0 done) |
| M0 | Unscheduled | — | — | 5 |

Active: 2 · Complete: 0
```

For the Tasks column: count `.md` files in `.ai-office/tasks/` (all columns) whose filename starts with `<id>_`. Count DONE separately.

If no milestones exist: "No milestones defined. Run `$office-milestone create M1 "My first milestone"` to get started."

---

## `status <id>`

1. Read `.ai-office/milestones/<id>.md`.
2. Scan `.ai-office/tasks/` (all columns including ARCHIVED) for files starting with `<id>_`.
3. Group tasks by column.
4. Compute completion stats:
   - Total tasks, done count, percentage
   - Breakdown by priority: count done vs total for each of HIGH / MEDIUM / LOW
   - List any unique labels across all tasks for this milestone

Output:

```
Milestone M1: Auth & Onboarding
Target: 2026-04-01 · Status: active

Progress: ████████░░ 4/7 tasks done (57%)

By priority:
  HIGH    3/4 done  ███░
  MEDIUM  1/2 done  █░
  LOW     0/1 done  ░

Labels in use: bug, auth, feature

DONE (4)
  ✅ M1_T001-setup-db-developer
  ✅ M1_T002-auth-endpoints-developer
  ...

WIP (1)
  🔄 M1_T005-login-ui-developer

TODO (2)
  ⏳ M1_T006-forgot-password-developer
  ⏳ M1_T007-session-management-developer

Blocked: none
Overdue: — (target not passed)
```

---

## `close <id>`

1. Read the milestone file. If status is already `complete` or `archived`, warn and stop.
2. Check if any tasks for this milestone are in `WIP`, `TODO`, or `BACKLOG`. If yes, list them and warn: "X tasks are not done. Close anyway? (respond 'yes' to confirm)"
3. **Squash merge task branches into `dev`**:
   - Collect all DONE tasks for this milestone that have a `**Branch:**` value (not `—` and not `merged`).
   - Verify the current git branch is not already `dev`. If not on `dev`, run `git checkout dev`.
   - For each task branch (in task-ID order):
     - Run `git merge --squash <branch-name>`
     - Run `git commit -m "squash(<id>): <task-title> (<task-id>)"` using the task title from `# <title>` in the task file
     - Run `git branch -d <branch-name>` to clean up the local branch
     - Update `**Branch:**` in the task file to `merged`
     - Append to the task's `## History`: `- <today ISO>: squash-merged into dev and branch deleted`
   - If any merge has conflicts: stop, report the conflict, and ask the user to resolve before continuing.
   - After all merges: report "Squash-merged N branches into dev."
4. Update the frontmatter: `status: complete`, add `completed: <today ISO>`.
5. Confirm: "Milestone `<id>` closed. N task branches squash-merged into dev."

---

## `archive <id>`

1. Read the milestone file. Status must be `complete` first — if not, refuse: "Milestone must be closed before archiving."
2. Update frontmatter: `status: archived`, add `archived: <today ISO>`.
3. Find all task files for this milestone: scan every column subdirectory of `.ai-office/tasks/` for `.md` files whose names start with `<id>_`. For each file **not already in ARCHIVED**:
   - Update its `**Status:**` field to `ARCHIVED`
   - Prepend `[ARCHIVED] ` to the title heading (if not already present)
   - Set `**Completed:**` to today's ISO date (if currently `—`)
   - Append to `## History`: `- <today ISO>: Archived with milestone <id>`
   - Move the file to `.ai-office/tasks/ARCHIVED/`
   - Decrement the count for the old column and increment ARCHIVED in `.ai-office/tasks/README.md`

   Repeat for each task file in sequence (there is no bulk move — process them one by one).
4. Confirm: "Milestone `<id>` archived. N tasks moved to ARCHIVED."

<!-- ai-office-version: 1.5.0 -->
