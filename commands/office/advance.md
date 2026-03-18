---
description: Advance a project to the next pipeline stage. Usage: /office:advance <slug> <evidence> [next-stage]
---

$ARGUMENTS format: `<slug> <evidence> [next-stage]`

- **slug**: project identifier (e.g. `listing-creation`)
- **evidence**: what was completed (e.g. "all tests pass, lint clean")
- **next-stage** (optional): force a specific stage instead of the default next

---

## Pipeline Transitions

Default next stage per current state:

| Current | Default Next |
|---------|-------------|
| `router` | `prd` or `create_project` |
| `create_project` | `prd` |
| `prd` | `adr` |
| `adr` | `plan` |
| `plan` | `tasks` |
| `tasks` | `dev` |
| `ux_research` | `design_ui` |
| `design_ui` | `dev` |
| `dev` | `qa` |
| `security` | `dev` or `qa` |
| `qa` | `review` |
| `review` | `user_acceptance` |
| `user_acceptance` | `release` |
| `release` | `postmortem` |
| `postmortem` | _(done)_ |

Loop guards (increment counter in status file):
- `qa → dev` iterations: max 2 before `blocked`
- `review → dev` iterations: max 2 before `blocked`
- `user_acceptance → dev` iterations: max 1 before `blocked`

---

## Steps

1. Read `.ai-office/docs/runbooks/<slug>-status.md` to get current state
2. Determine the next stage (use argument if provided, otherwise use transition table)
3. Check loop guards — if iteration count would exceed max, set state to `blocked` instead and note the reason
4. Update the status file:
   - Set `State:` to the new stage
   - Set `Updated:` to today's date
   - Append a row to the Review Log: `| <today> | System | <new-stage> | <evidence> |`
5. Write the updated file
6. Respond with: "Advanced `<slug>`: `<old-state>` → `<new-state>`"
7. Show the next recommended action for the new stage (e.g., "Run /office:scaffold <slug> <stage>" or "Check `.windsurf/workflows/role-<role>.md` for guidance")
