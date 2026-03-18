# AI Office Framework

A file-based virtual agency system for AI-assisted software development. Provides a structured pipeline (router → PRD → ADR → plan → dev → QA → release) with a full kanban task board and role-based agent guidance — all as Claude Code slash commands.

## Quick Start

```bash
# Install into a project (defaults to current directory)
./install.sh [project-root]

# Then configure it
./setup.sh [project-root]
```

Then in Claude Code:

```
/office:route add a new user profile editing feature
```

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Bash (macOS / Linux / WSL)

## Commands

| Command | Description |
|---------|-------------|
| `/office:route <request>` | Classify and route a request to the right pipeline stage |
| `/office:status <slug> [state] [owner]` | Get or update pipeline status for a feature |
| `/office:advance <slug> <evidence>` | Advance to next stage with evidence |
| `/office:validate <slug> <stage>` | Check quality gates before advancing |
| `/office:scaffold <slug> <stage>` | Create PRD / ADR / plan / review artifacts |
| `/office:task-create <title> [priority:] [column:] [assignee:]` | Add a task to the kanban board |
| `/office:task-move <task-id> <column> [reason]` | Move a task between columns |
| `/office:task-list [column] [assignee:]` | View the kanban board |
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
    └── office/          ← 16 slash commands
        └── .version     ← installed version stamp

.ai-office/
├── office-config.md     ← agency identity & config
├── project.config.md    ← tech stack, agency, quality thresholds
├── agency.json          ← active agency selection
├── tasks/
│   ├── BACKLOG/
│   ├── TODO/
│   ├── WIP/
│   ├── REVIEW/
│   ├── DONE/
│   └── README.md
├── docs/
│   ├── prd/
│   ├── adr/
│   └── runbooks/
├── agents/              ← agent role profiles
├── agencies/            ← agency configurations
├── scripts/             ← custom runbooks
└── memory/
```

## Agencies

Five agency templates are bundled and installed during setup:

| Agency | Use case |
|--------|----------|
| `software-studio` | Full-stack web/mobile — complete SDLC with all quality gates |
| `lean-startup` | Rapid MVP — minimal process, maximum speed |
| `game-studio` | Game development — interactive experiences and games |
| `creative-agency` | Media & content — creative production pipeline |
| `penetration-test-agency` | Security testing — pentests, audits, remediation |

## Project Configuration

`setup.sh` (or `/office:setup` inside Claude Code) writes `.ai-office/project.config.md`:

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
---
```

`/office:validate` and `/office:review` read this file to apply project-specific checks and thresholds.

## Pipeline

```
router → prd → adr → plan → tasks → dev → qa → review → user_acceptance → release → postmortem
                                     ↘ ux_research → design_ui ────────────────────────────┘
                                                   ↘ security → dev / qa
```

## Updating

```bash
# Check installed version vs available
/office:_meta

# Apply update
./update.sh [project-root]
```

## Versioning

The framework version is in `VERSION`. Installing stamps `.claude/commands/office/.version` in the target project. `/office:_meta` compares the two and reports if an update is available.
