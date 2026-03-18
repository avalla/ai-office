---
description: Check the health of the AI Office framework installation
---

Audit the AI Office framework setup in this project. Check each item and report PASS / WARN / FAIL.

## Checks

### Directory Structure
- [ ] `.ai-office/` exists
- [ ] `.ai-office/tasks/BACKLOG/` exists
- [ ] `.ai-office/tasks/TODO/` exists
- [ ] `.ai-office/tasks/WIP/` exists
- [ ] `.ai-office/tasks/REVIEW/` exists
- [ ] `.ai-office/tasks/DONE/` exists
- [ ] `.ai-office/tasks/ARCHIVED/` exists
- [ ] `.ai-office/docs/runbooks/` exists
- [ ] `.ai-office/docs/prd/` exists
- [ ] `.ai-office/docs/adr/` exists
- [ ] `.ai-office/agents/` exists and is non-empty (at least one agent folder with `personality.md`)
- [ ] `.ai-office/agencies/` exists
- [ ] `.ai-office/milestones/` exists
- [ ] `.ai-office/templates/` exists — WARN if missing
- [ ] `.ai-office/memory/` exists

### Config Files
- [ ] `.ai-office/office-config.md` exists and has `Agency Identity` section
- [ ] `.ai-office/tasks/README.md` exists
- [ ] `.mcp.json` exists at project root — WARN if missing (run `/install` or copy from framework skeleton)
- [ ] If `.mcp.json` exists: check that adapters required by the active agency are present (read `agency` from `project.config.md`, cross-reference against `software-mcp-proposals.md`)

### Project Configuration
- [ ] `.ai-office/project.config.md` exists — WARN if missing (run `/office:setup`)
- [ ] If it exists: YAML frontmatter has `agency`, `project_name`, `typecheck_cmd`, `lint_cmd`, `test_cmd`, `advance_mode` — WARN for each missing field
- [ ] `.ai-office/agency.json` exists and `name` field matches `agency` in `project.config.md`

### Claude Code Integration
- [ ] `.claude/commands/office/` directory exists
- [ ] All 21 commands present: `_meta.md`, `advance.md`, `agency.md`, `ai-office.md`, `doctor.md`, `graph.md`, `milestone.md`, `report.md`, `review.md`, `role.md`, `route.md`, `run-tests.md`, `scaffold.md`, `script.md`, `setup.md`, `status.md`, `task-create.md`, `task-list.md`, `task-move.md`, `validate.md`, `validate-secrets.md`
- [ ] `.claude/commands/office/.version` exists (version stamp)

### Task Board Integrity
- [ ] `.ai-office/tasks/README.md` counts match actual file counts in each active column (count `.md` files excluding `README.md`, compare — ARCHIVED is not included in counts)
- [ ] No task files exist directly in `.ai-office/tasks/` root (they must be in column subdirs)
- [ ] Task filenames follow the `<MS>_T<NNN>-<slug>-<assignee>.md` convention — WARN for any that don't

### Milestones
- [ ] If milestones exist in `.ai-office/milestones/`: each has valid frontmatter with `id`, `name`, `status` fields — WARN for each missing field
- [ ] No tasks reference a milestone ID that has no corresponding file in `.ai-office/milestones/` (except M0) — WARN if found

### Agent Profiles
- [ ] At least 13 agent folders present in `.ai-office/agents/` (core software-studio roster)
- [ ] Each agent folder has `personality.md` — FAIL for any missing
- [ ] Each agent folder has `competencies.md`, `triggers.md`, `workflows.md` — WARN for any missing

### Agency Templates
- [ ] At least one agency directory present in `.ai-office/agencies/`
- [ ] Each agency dir has `config.md` and `pipeline.md`
- [ ] Each agency dir has `templates.md` — WARN if missing
- [ ] `.ai-office/software-mcp-proposals.md` exists — WARN if missing

---

## Output Format

```
AI Office Doctor — <today>

✅ Directory structure: 15/15 checks passed
✅ Config files: 2/2
✅ Project configuration: project.config.md present, all required fields set (software-studio, advance_mode: manual)
✅ Claude Code integration: 21/21 commands, version 1.2.0
✅ Task board integrity: counts match, filename convention followed
✅ Milestones: M1 (active), M2 (active)
✅ Agent profiles: 21 agents, all personality.md present
✅ Agency templates: 6 agencies found, all with templates.md

Overall: HEALTHY / DEGRADED / BROKEN

Issues to fix:
- <list any WARN or FAIL items with suggested fix>
```
