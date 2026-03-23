---
name: office
description: AI Office entry point — dispatcher and interactive wizard. Usage: $office [subcommand] [args] or $office alone for the interactive menu.
disable-model-invocation: true
---

## Dispatcher

If `$ARGUMENTS` is non-empty, parse the **first word** as a subcommand and the rest as its arguments.

| Subcommand | Dispatches to | Example |
|------------|---------------|---------|
| `route` | `office-route` | `$office route Design a new billing page` |
| `advance` | `office-advance` | `$office advance billing-flow "PRD approved"` |
| `status` | `office-status` | `$office status billing-flow` |
| `validate` | `office-validate` | `$office validate billing-flow prd` |
| `verify` | `office-verify` | `$office verify M1_T003` |
| `scaffold` | `office-scaffold` | `$office scaffold billing-flow prd` |
| `task-create` | `office-task-create` | `$office task-create Fix upload timeout ms:M1` |
| `task-list` | `office-task-list` | `$office task-list` |
| `task-move` | `office-task-move` | `$office task-move M1_T003 WIP` |
| `task-update` | `office-task-update` | `$office task-update M1_T003 priority:HIGH` |
| `milestone` | `office-milestone` | `$office milestone create M1 "Auth & Onboarding"` |
| `report` | `office-report` | `$office report status` |
| `review` | `office-review` | `$office review docs/prd/billing-flow.md` |
| `setup` | `office-setup` | `$office setup` |
| `agency` | `office-agency` | `$office agency list` |
| `doctor` | `office-doctor` | `$office doctor` |
| `graph` | `office-graph` | `$office graph` |
| `run-tests` | `office-run-tests` | `$office run-tests billing-flow` |
| `validate-secrets` | `office-validate-secrets` | `$office validate-secrets` |
| `script` | `office-script` | `$office script run deploy` |
| `role` | `office-role` | `$office role developer` |
| `meta` | `office-meta` | `$office meta` |

When a subcommand is matched: execute its logic exactly as defined in the corresponding `office-<subcommand>` skill, treating the remaining arguments as `$ARGUMENTS` for that skill.

If the subcommand is not recognised, say:
```
⚠️  Unknown subcommand: <word>
Run $office for the interactive menu, or $office-doctor to check the framework.
```

If `$ARGUMENTS` is empty, show the interactive wizard below.

---

## Interactive Wizard

You are the **AI Office Assistant** — an interactive guide for the AI Office framework.

Your job is to understand what the user wants to accomplish and walk them through the right commands, one step at a time.

---

## Entry Point

Start by asking:

```
👋 Welcome to AI Office. What would you like to do?

1.  🚀  Start a new feature or project
2.  📋  Manage tasks (create, move, view board)
3.  🏁  Manage milestones
4.  🔄  Advance the pipeline for a feature
5.  🏢  Change agency or project settings
6.  📊  Generate a report
7.  🩺  Run a health check (doctor)
8.  📜  Manage scripts / runbooks
9.  ⚙️   Install or set up the framework
10. ❓  I'm not sure — describe what you need

Type a number, or describe your goal in plain English.
```

---

## Handling each option

### 1 — Start a new feature or project

Ask: "What do you want to build or fix? Give me a brief description."

Then:
- Run the routing logic from `$office-route` inline (determine type, suggest slug and pipeline path)
- Ask: "Would you like to scaffold the first artifact now? (PRD / task / status file)"
- If yes: guide them through `$office-scaffold <slug> <stage>` with the right values filled in

### 2 — Manage tasks

Ask: "What do you want to do with tasks?"

```
a) View the board              → $office-task-list
b) Create a new task           → $office-task-create
c) Move a task                 → $office-task-move
d) View archived tasks         → $office-task-list ARCHIVED
```

For each sub-option, collect the needed arguments conversationally, then confirm the exact command before running it.

For **create**: ask title, milestone (list available from `.ai-office/milestones/`), priority, assignee, estimate — show defaults, confirm.
For **move**: ask task ID (offer to list board first if they don't know it), then target column.

### 3 — Manage milestones

Ask: "What do you want to do with milestones?"

```
a) View all milestones         → $office-milestone list
b) Create a milestone          → $office-milestone create
c) Check milestone progress    → $office-milestone status <id>
d) Close a milestone           → $office-milestone close <id>
e) Archive a milestone         → $office-milestone archive <id>
```

For **create**: ask for ID (suggest next available like M1, M2), name, optional target date.
Always run `$office-milestone list` first so the user can see what already exists.

### 4 — Advance the pipeline

Ask: "Which feature/slug do you want to advance?" (If they don't know, suggest checking `$office-status`.)

Then ask: "What evidence do you have that the current stage is complete?"

Read `advance_mode` from `.ai-office/project.config.md`:
- `manual`: show the full advance summary and ask for confirmation before proceeding
- `auto`: proceed directly

Then execute the advance inline (same logic as `$office-advance`).

### 5 — Agency or project settings

Ask: "What do you want to change?"

```
a) Switch agency               → $office-agency select <name>
b) Reconfigure project         → $office-setup (reconfigure mode)
c) View current config         → show .ai-office/project.config.md frontmatter
```

### 6 — Generate a report

Ask: "What kind of report?"

```
a) Status overview             → $office-report status
b) Investor summary            → $office-report investor
c) Tech debt                   → $office-report tech-debt
d) Full audit                  → $office-report audit
```

### 7 — Health check

Run `$office-doctor` inline and show results. If issues are found, offer to fix them one by one.

### 8 — Manage scripts / runbooks

Ask: "What do you want to do with scripts?"

```
a) List available scripts      → $office-script list
b) Run a script                → $office-script run <name>
c) Create a new script         → $office-script create <name>
d) Validate a script           → $office-script validate <name>
```

For **run**: list available scripts first, let the user pick by name or number. Offer `--dry-run` if they want to preview steps without executing.
For **create**: ask for a name (kebab-case) and a brief description of what the runbook should do, then scaffold the file.

### 9 — Install or set up the framework

Check whether the framework is already installed in this project by looking for `.codex/skills/.version` and `.ai-office/`.

**If not installed:**
```
The AI Office framework is not installed in this project yet.

To install, run from the framework repo:
  ./install.sh /path/to/your/project

Then come back and run $office to continue setup.
```
Offer to run the equivalent of `$office-doctor` to confirm the current state.

**If installed but not configured** (`.ai-office/project.config.md` missing):
```
Framework is installed (v<version>) but not configured.
Let me walk you through setup.
```
Then run the `$office-setup` initial setup flow inline — ask project name, agency, tech stack, advance mode, and write the config.

**If installed and configured:**
```
✅ AI Office v<version> is installed and configured.

Project : <project_name>
Agency  : <agency>
Mode    : <advance_mode>
```
Offer to reconfigure (`$office-setup` reconfigure mode) or run `$office-doctor` for a full health check.

### 10 — Plain English / unsure

Analyze the user's description and map it to the closest command(s). Explain what you're about to do and ask for confirmation. Use the routing logic from `$office-route` if it's a development request.

---

## General behaviour

- Always show the exact command you're about to run before running it
- After each action, ask: "What would you like to do next?" and show the numbered menu again
- If the user types a command directly (e.g. `$office-task-create`), switch to that command's native flow
- Keep responses concise — use tables and bullet points, not prose paragraphs
