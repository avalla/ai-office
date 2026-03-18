# AI Office Framework

A file-based virtual agency system for AI-assisted software development. Provides a structured pipeline (router → PRD → ADR → plan → dev → QA → release) with milestones, a full kanban task board, and role-based agent guidance — all as Claude Code slash commands.

## Quick Start

```bash
# Install into a project (defaults to current directory)
./install.sh [project-root]

# Then configure it
./setup.sh [project-root]
```

Then in Claude Code:

```
/office:ai-office         ← interactive wizard (start here)
/office:route add a new user profile editing feature
```

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Bash (macOS / Linux / WSL)

## Commands

| Command | Description |
|---------|-------------|
| `/office:ai-office` | Interactive wizard — discover commands and execute actions step by step |
| `/office:route <request>` | Classify and route a request to the right pipeline stage |
| `/office:status <slug> [state] [owner]` | Get or update pipeline status for a feature |
| `/office:advance <slug> <evidence>` | Advance to next stage, reassign tasks to the next agent |
| `/office:validate <slug> <stage>` | Check quality gates before advancing |
| `/office:scaffold <slug> <stage>` | Create PRD / ADR / plan / review artifacts |
| `/office:milestone <create\|list\|status\|close\|archive>` | Manage project milestones |
| `/office:task-create <title> [ms:] [priority:] [assignee:]` | Add a task (validates milestone exists) |
| `/office:task-move <task-id> <column> [reason]` | Move a task between columns |
| `/office:task-list [column] [ms:] [assignee:]` | View the kanban board |
| `/office:report <status\|investor\|tech-debt\|audit>` | Generate reports |
| `/office:review <path> [sectors:]` | Multi-sector document/code review |
| `/office:graph [package] [format:]` | Repo dependency visualization |
| `/office:agency [list\|get <name>\|select <name>]` | Manage active agency mode |
| `/office:script <list\|run\|create\|validate> <name>` | Run markdown runbooks |
| `/office:setup` | Interactive project reconfiguration wizard |
| `/office:doctor` | Framework health check |
| `/office:_meta` | Show installed version, check for updates |

## Directory Structure

After install, your project will have:

```
.claude/
└── commands/
    └── office/          ← 18 slash commands
        └── .version     ← installed version stamp

.ai-office/
├── office-config.md     ← agency identity & config
├── project.config.md    ← tech stack, agency, quality thresholds, advance_mode
├── agency.json          ← active agency selection
├── milestones/          ← milestone definitions (M1.md, M2.md, …)
├── tasks/
│   ├── BACKLOG/         ← task files: <MS>_T<NNN>-<slug>-<assignee>.md
│   ├── TODO/
│   ├── WIP/
│   ├── REVIEW/
│   ├── DONE/
│   ├── ARCHIVED/        ← old/superseded tasks
│   └── README.md        ← column counts
├── docs/
│   ├── prd/
│   ├── adr/
│   └── runbooks/
├── agents/              ← 21 agent profiles (personality, competencies, skills, …)
├── agencies/            ← agency configurations + templates
├── templates/           ← document templates (prd, adr, qa-checklist, …)
├── scripts/             ← custom runbooks
└── memory/
```

## Task File Format

Tasks are named `<MS>_T<NNN>-<slug>-<assignee>.md` (e.g. `M1_T003-fix-upload-timeout-developer.md`).

Frontmatter fields: **ID**, **Milestone**, **Priority**, **Status**, **Assignee**, **Dependencies**, **Created**, **Started**, **Completed**, **Estimate**, and a **Time Log** table with per-agent hours.

`M0` is reserved for unscheduled/misc tasks. All other milestones must be created with `/office:milestone create` before tasks can reference them.

## Milestone Workflow

```bash
# 1. Define milestones first
/office:milestone create M1 "Auth & Onboarding" target:2026-04-01
/office:milestone create M2 "Billing" target:2026-05-01

# 2. Create tasks within a milestone
/office:task-create "Setup database schema" ms:M1 assignee:Developer estimate:4h

# 3. Check milestone progress
/office:milestone status M1

# 4. Close and archive when done
/office:milestone close M1
/office:milestone archive M1
```

## Agencies

Five agency templates are bundled and installed during setup:

| Agency | Use case |
|--------|----------|
| `software-studio` | Full-stack web/mobile — complete SDLC with all quality gates |
| `lean-startup` | Rapid MVP — minimal process, maximum speed |
| `game-studio` | Game development — interactive experiences and games |
| `creative-agency` | Media & content — creative production pipeline |
| `media-agency` | Video and movie production — pre-production to delivery |
| `penetration-test-agency` | Security testing — pentests, audits, remediation |

## Project Configuration

`setup.sh` (or `/office:setup`) writes `.ai-office/project.config.md`:

```yaml
---
agency: software-studio
project_name: my-app
typecheck_cmd: "npm run typecheck"
lint_cmd: "npm run lint"
test_cmd: "npm run test"
test_runner: vitest
ui_framework: react
design_system: "shadcn/ui"
coverage_min: 80
lighthouse_min: 90
advance_mode: manual   # manual | auto
---
```

`advance_mode` controls how `/office:advance` behaves:
- `manual` — pauses and asks for confirmation before each stage transition (default)
- `auto` — validates and advances automatically without prompting

## Pipeline

```
router → prd → adr → plan → tasks → dev → qa → review → user_acceptance → release → postmortem
                                     ↘ ux_research → design_ui ────────────────────────────┘
                                                   ↘ security → dev / qa
```

Each stage transition via `/office:advance` automatically reassigns open tasks to the responsible agent for the incoming stage.

## Updating

```bash
# Check installed version vs available
/office:_meta

# Apply update
./update.sh [project-root]
```

## Versioning

The framework version is in `VERSION`. Installing stamps `.claude/commands/office/.version` in the target project. `/office:_meta` compares the two and reports if an update is available.
