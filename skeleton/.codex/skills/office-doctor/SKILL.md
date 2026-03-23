---
name: office-doctor
description: Check the health of the AI Office framework installation
disable-model-invocation: true

Audit the AI Office framework setup in this project. Check each item and report PASS / WARN / FAIL.

If `ai-office` is available in the project, prefer running `ai-office doctor`.
If the CLI succeeds, report its output and stop.

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
- [ ] `.ai-office/docs/context/` exists — WARN if missing (created on first `$office-route`)
- [ ] `.ai-office/agents/` exists and is non-empty (at least one agent folder with `personality.md`)
- [ ] `.ai-office/agencies/` exists and has at least one subdirectory with `config.md`
- [ ] `.ai-office/milestones/` exists
- [ ] `.ai-office/templates/` exists — WARN if missing
- [ ] `.ai-office/memory/` exists

### Config Files
- [ ] `.ai-office/office-config.md` exists and has `Agency Identity` section
- [ ] `.ai-office/tasks/README.md` exists
- [ ] `.mcp.json` exists at project root — WARN if missing (run `/install` or copy from framework skeleton)
- [ ] If `.mcp.json` exists: check that adapters required by the active agency are present (read `agency` from `project.config.md`, cross-reference against `software-mcp-proposals.md`)

### Project Configuration
- [ ] `.ai-office/project.config.md` exists — WARN if missing (run `$office-setup`)
- [ ] If it exists: YAML frontmatter has `agency`, `project_name`, `typecheck_cmd`, `lint_cmd`, `test_cmd`, `advance_mode` — WARN for each missing field
- [ ] `.ai-office/agency.json` exists and `name` field matches `agency` in `project.config.md`
- [ ] `.ai-office/agencies/<agency>/config.md` exists and has `## Active Agents` section — WARN if missing (run `$office-agency profile`)

### Codex Integration
- [ ] `.codex/skills/` directory exists
- [ ] All 23 expected skills present: `office-meta`, `office-advance`, `office-agency`, `office`, `office-doctor`, `office-graph`, `office-milestone`, `office-report`, `office-review`, `office-role`, `office-route`, `office-run-tests`, `office-scaffold`, `office-script`, `office-setup`, `office-status`, `office-task-create`, `office-task-list`, `office-task-move`, `office-task-update`, `office-validate`, `office-validate-secrets`, `office-verify`
- [ ] `.codex/skills/.version` exists (version stamp)

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

### Agency Profile
- [ ] At least one agency directory present in `.ai-office/agencies/`
- [ ] Active agency dir has `config.md` with `## Active Agents` table — WARN if missing
- [ ] `.ai-office/software-mcp-proposals.md` exists — WARN if missing

---

## Output Format

```
AI Office Doctor — <today>

✅ Directory structure: 16/16 checks passed
✅ Config files: 2/2
✅ Project configuration: project.config.md present, all required fields set (my-project, advance_mode: manual)
✅ Agency profile: my-project — developer, qa, security-specialist, ops (custom)
✅ Codex integration: 23/23 skills, version 1.5.0
✅ Task board integrity: counts match, filename convention followed
✅ Milestones: M1 (active), M2 (active)
✅ Agent profiles: 21 agents, all personality.md present

Overall: HEALTHY / DEGRADED / BROKEN

Issues to fix:
- <list any WARN or FAIL items with suggested fix>
```

<!-- ai-office-version: 1.5.0 -->
