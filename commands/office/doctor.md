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
- [ ] `.ai-office/docs/runbooks/` exists
- [ ] `.ai-office/docs/prd/` exists
- [ ] `.ai-office/docs/adr/` exists
- [ ] `.ai-office/agents/` exists
- [ ] `.ai-office/agencies/` exists

### Config Files
- [ ] `.ai-office/office-config.md` exists and has `Agency Identity` section
- [ ] `.ai-office/tasks/README.md` exists
- [ ] `.windsurf/workflows/pipeline.md` exists

### Project Configuration
- [ ] `.ai-office/project.config.md` exists — WARN if missing (run `/office:setup`)
- [ ] If it exists: YAML frontmatter has `agency`, `project_name`, `typecheck_cmd`, `lint_cmd`, `test_cmd` — WARN for each missing field
- [ ] `.ai-office/agency.json` exists and `name` field matches `agency` in `project.config.md`

### Claude Code Integration
- [ ] `.claude/commands/office/` directory exists
- [ ] All 15 commands present: `_meta.md`, `route.md`, `status.md`, `advance.md`, `validate.md`, `scaffold.md`, `setup.md`, `task-create.md`, `task-move.md`, `task-list.md`, `report.md`, `review.md`, `graph.md`, `agency.md`, `script.md`, `doctor.md`
- [ ] `.claude/commands/office/.version` exists (version stamp)

### Task Board Integrity
- [ ] `.ai-office/tasks/README.md` counts match actual file counts in each column (count files, compare)
- [ ] No task files exist directly in `.ai-office/tasks/` root (they must be in column subdirs)

### Agent Profiles
- [ ] At least 5 agent folders in `.ai-office/agents/` each with `personality.md`

### MCP Server (Windsurf)
- [ ] `.windsurf/mcp_config.json` references `ai-office` server
- [ ] Check if the server path in the config exists on disk

---

## Output Format

```
AI Office Doctor — <today>

✅ Directory structure: 11/11 checks passed
✅ Config files: 3/3
✅ Project configuration: project.config.md present, all required fields set (software-studio)
✅ Claude Code integration: 15/15 commands, version 1.1.0
✅ Task board integrity: counts match
✅ Agent profiles: 17 agents found
⚠️  MCP server: config present, server file exists (Windsurf only)

Overall: HEALTHY / DEGRADED / BROKEN

Issues to fix:
- <list any WARN or FAIL items with suggested fix>
```
