---
description: Get or update the pipeline status for a project slug. Usage: /office:status <slug> [new-state] [owner] [notes]
---

$ARGUMENTS format: `<slug> [new-state] [owner] [notes]`

Parse the arguments:
- **Slug only** → GET mode: read and display current status
- **Slug + state** → SET mode: update the status file

Status file path: `.ai-office/docs/runbooks/<slug>-status.md`

---

## GET mode (slug only)

Read `.ai-office/docs/runbooks/<slug>-status.md`.

If the file exists, display:
- Current state and owner
- Last updated timestamp
- Notes
- Review log (last 3 entries)
- Suggested next action based on current state (use the pipeline transition table from `/office:advance` for valid transitions)

If the file doesn't exist, scan `.ai-office/tasks/WIP/` and `.ai-office/tasks/TODO/` for files whose name or content matches the slug, and report what you find.

---

## SET mode (slug + state)

Read the current status file. If it doesn't exist, create it with this template:

```
# <slug> — Status

**State:** <state>
**Owner:** <owner or "Unassigned">
**Updated:** <today's date ISO>

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

Write the updated file, then confirm with: "Status updated: `<slug>` → `<state>`"

Valid pipeline states: `router` `create_project` `prd` `adr` `plan` `tasks` `ux_research` `design_ui` `dev` `security` `qa` `review` `user_acceptance` `release` `postmortem` `blocked`
