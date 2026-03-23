---
name: office-status
description: Get or update the pipeline status for a project slug. Usage: $office-status <slug> [new-state] [owner] [notes]
disable-model-invocation: true

$ARGUMENTS format: `<slug> [new-state] [owner] [notes]`

Parse the arguments:
- **Slug only** → GET mode: read and display current status
- **Slug + state** → SET mode: update the status file

Status file path: `.ai-office/docs/runbooks/<slug>-status.md`

---

## GET mode (slug only)

Prefer the deterministic CLI path when available:
- `ai-office status get <slug>`
- If the CLI succeeds, report its output and stop.

Read `.ai-office/docs/runbooks/<slug>-status.md`.

If the file exists, display:
- Current state and owner
- Last updated timestamp
- Notes
- Review log (last 3 entries)
- Suggested next action based on current state (use the pipeline transition table from `$office-advance` for valid transitions)

If the file doesn't exist, scan `.ai-office/tasks/WIP/` and `.ai-office/tasks/TODO/` for files whose name or content matches the slug, and report what you find.

---

## SET mode (slug + state)

Prefer the deterministic CLI path when available:
- `ai-office status set <slug> <state> [owner] [notes]`
- If the CLI succeeds, report its output and stop.

Read the current status file. If it doesn't exist, create it with this template:

```
# <slug> — Status

**State:** <state>
**Owner:** <owner or "Unassigned">
**Updated:** <today's date ISO>

## Loop Guards

| Guard | Count | Max |
|-------|-------|-----|
| qa_iteration | 0 | 2 |
| review_iteration | 0 | 2 |
| uat_iteration | 0 | 1 |

## Notes
<notes or "—">

## Review Log

| Date | Owner | State | Evidence |
|------|-------|-------|----------|
| <today> | <owner> | <state> | Initial status set |
```

If the file already exists:
1. Update the `State:`, `Owner:`, and `Updated:` fields
2. Append a new row to the Review Log table with today's date, owner, new state, and notes as evidence
3. If `## Loop Guards` section is absent, add it with all counters reset to 0 (this can happen when status was created without the guards table)

Write the updated file, then confirm with: "Status updated: `<slug>` → `<state>`"

Valid pipeline states: `router` `create_project` `prd` `adr` `plan` `tasks` `ux_research` `design_ui` `dev` `security` `qa` `review` `user_acceptance` `release` `postmortem` `blocked`

<!-- ai-office-version: 1.5.0 -->
