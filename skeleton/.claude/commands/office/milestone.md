---
description: Manage project milestones. Usage: /office:milestone <create <id> <name> [target:YYYY-MM-DD]|list|status <id>|close <id>|archive <id>>
---

$ARGUMENTS format: `<create <id> <name> [target:YYYY-MM-DD] | list | status <id> | close <id> | archive <id>>`

Milestones directory: `.ai-office/milestones/`
Each milestone is a file: `.ai-office/milestones/<id>.md`

Milestone IDs are short identifiers like `M1`, `M2`, `sprint-1`, `alpha`. `M0` is reserved for unscheduled/misc tasks and cannot be created, closed, or archived via this command.

---

## `create <id> <name> [target:YYYY-MM-DD]`

1. Check that `<id>` is not `M0`. If it is, refuse with: "M0 is reserved for unscheduled tasks."
2. Check if `.ai-office/milestones/<id>.md` already exists. If so, warn and stop.
3. Create `.ai-office/milestones/<id>.md`:

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

> Describe what this milestone delivers.

## Definition of Done

- [ ]

## Notes
```

4. Update `.ai-office/milestones/README.md` — add a row for this milestone (create the file if it doesn't exist).
5. Confirm: "Created milestone `<id>`: **<name>**" + suggest running `/office:task-create` with `ms:<id>`.

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

If no milestones exist: "No milestones defined. Run `/office:milestone create M1 "My first milestone"` to get started."

---

## `status <id>`

1. Read `.ai-office/milestones/<id>.md`.
2. Scan `.ai-office/tasks/` (all columns including ARCHIVED) for files starting with `<id>_`.
3. Group tasks by column.

Output:

```
Milestone M1: Auth & Onboarding
Target: 2026-04-01 · Status: active

Progress: ████████░░ 4/7 tasks done (57%)

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
3. Update the frontmatter: `status: complete`, add `completed: <today ISO>`.
4. Confirm: "Milestone `<id>` closed."

---

## `archive <id>`

1. Read the milestone file. Status must be `complete` first — if not, refuse: "Milestone must be closed before archiving."
2. Update frontmatter: `status: archived`, add `archived: <today ISO>`.
3. Move any remaining tasks for this milestone to `.ai-office/tasks/ARCHIVED/` (if not already there).
4. Confirm: "Milestone `<id>` archived. N tasks moved to ARCHIVED."
