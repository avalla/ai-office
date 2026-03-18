---
description: Advance a project to the next pipeline stage, reassign tasks, and optionally auto-continue. Usage: /office:advance <slug> <evidence> [next-stage]
---

$ARGUMENTS format: `<slug> <evidence> [next-stage]`

- **slug**: project identifier (e.g. `listing-creation`)
- **evidence**: what was completed (e.g. "all tests pass, lint clean")
- **next-stage** (optional): force a specific stage instead of the default next

---

## Stage → Agent Mapping

Each stage has a responsible agent. When advancing, all tasks for this slug are reassigned to the agent for the incoming stage.

| Stage | Responsible Agent |
|-------|------------------|
| `router` | Router |
| `create_project` | PM |
| `prd` | PM |
| `adr` | Architect |
| `plan` | Planner |
| `tasks` | Planner |
| `ux_research` | UX Researcher |
| `design_ui` | Designer |
| `dev` | Developer |
| `security` | Security Specialist |
| `qa` | QA |
| `review` | Reviewer |
| `user_acceptance` | PM |
| `release` | Release Manager |
| `postmortem` | Ops |

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

1. **Read advance_mode**: read `.ai-office/project.config.md` and extract `advance_mode`. Default: `manual`.

2. **Read current state**: read `.ai-office/docs/runbooks/<slug>-status.md` to get current state.

3. **Determine the next stage**: use the `[next-stage]` argument if provided, otherwise use the transition table above.

4. **Check loop guards**: if the iteration count would exceed the max, set state to `blocked` instead and note the reason.

5. **In `manual` mode**: before making changes, output a summary:
   ```
   Advancing: <slug>
   <old-state> → <new-stage>
   Evidence: <evidence>
   Agent: <responsible agent for new stage>
   ```
   Then ask: "Proceed? (yes / no)" and wait for confirmation.
   In `auto` mode: skip the confirmation prompt and proceed immediately.

6. **Update the status file**:
   - Set `State:` to the new stage
   - Set `Updated:` to today's date
   - Append a row to the Review Log: `| <today> | <new-agent> | <new-stage> | <evidence> |`

7. **Reassign tasks**: scan `.ai-office/tasks/` (BACKLOG, TODO, WIP, REVIEW columns — not DONE or ARCHIVED) for files whose name or `**ID:**` field contains the slug. For each:
   - Update `**Assignee:**` to the responsible agent for the new stage
   - If moving into an active work stage (`dev`, `qa`, `security`, `design_ui`) and task is in `BACKLOG` or `TODO`: move it to `TODO` (do not auto-move to WIP — that's the agent's job)
   - Append a note to `## Notes`: `<today ISO>: reassigned to <agent> (stage: <new-stage>)`

8. **Respond**:
   ```
   Advanced `<slug>`: `<old-state>` → `<new-state>`
   Tasks reassigned to: <agent> (N tasks updated)
   ```

9. **Next action**: show the recommended action for the new stage:
   - `prd` → "Run `/office:scaffold <slug> prd` to create the PRD"
   - `adr` → "Run `/office:scaffold <slug> adr` to create the ADR"
   - `plan` → "Run `/office:scaffold <slug> plan` to create the plan"
   - `tasks` → "Run `/office:task-create <title> ms:<milestone>` to add tasks"
   - `dev` / `security` / `qa` / `review` / `user_acceptance` → "Run `/office:validate <slug> <stage>` when ready to advance"
   - Other stages → "Check `.ai-office/agents/<agent>/personality.md` for role guidance"
