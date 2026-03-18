# AI Office Framework

A file-based virtual agency system for AI-assisted software development. Provides a structured pipeline (router → PRD → ADR → plan → dev → QA → release) with a full kanban task board and role-based agent guidance — all as Claude Code slash commands.

## Quick Start

```bash
# Install into a project
./tools/ai-office-framework/install.sh

# Or from any directory, targeting a project root
./install.sh /path/to/your/project
```

Then in Claude Code:

```
/office:route add a new user profile editing feature
```

## Commands

| Command | Description |
|---------|-------------|
| `/office:route <request>` | Classify and route a request to the right pipeline stage |
| `/office:status <slug> [state] [owner]` | Get or update pipeline status for a feature |
| `/office:advance <slug> <evidence>` | Advance to next stage |
| `/office:validate <slug> <stage>` | Check quality gates before advancing |
| `/office:scaffold <slug> <stage>` | Create PRD / ADR / plan / review artifacts |
| `/office:task-create <title> [priority:] [column:] [assignee:]` | Add a task |
| `/office:task-move <task-id> <column> [reason]` | Move a task between columns |
| `/office:task-list [column] [assignee:]` | View the kanban board |
| `/office:report <status\|investor\|tech-debt\|audit>` | Generate reports |
| `/office:review <path> [sectors:]` | Multi-sector document/code review |
| `/office:graph [package] [format:]` | Repo dependency visualization |
| `/office:agency [list\|get <name>\|select <name>]` | Manage active agency mode |
| `/office:script <list\|run\|create\|validate> <name>` | Run markdown runbooks |
| `/office:doctor` | Framework health check |
| `/office:_meta` | Show installed version, check for updates |

## Directory Structure

After install, your project will have:

```
.claude/
└── commands/
    └── office/          ← 15 slash commands
        └── .version     ← installed version stamp

.ai-office/
├── office-config.md     ← agency identity & config
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
└── scripts/             ← custom runbooks
```

## Updating

```bash
# Check installed version vs available
/office:_meta

# Apply update
./tools/ai-office-framework/update.sh
# or
./update.sh /path/to/your/project
```

## Pipeline

```
router → prd → adr → plan → tasks → dev → qa → review → user_acceptance → release → postmortem
                                      ↘ ux_research → design_ui ─────────────────┘
                                                   ↘ security → dev / qa
```

## Versioning

The framework version is stored in `VERSION`. When installed, the version is stamped to `.claude/commands/office/.version` in the target project. Running `/office:_meta` compares the two and reports if an update is available.
