---
description: List, inspect, activate, or create an AI Office agency. Usage: /office:agency [list|get <name>|select <name>|create <slug>]
---

$ARGUMENTS format: `[list | get <name> | select <name> | create <slug> [--from=<base>] [--name=<display-name>] [--desc=<description>]]`

- `list` (default if no args): show all available agencies
- `get <name>`: show full config for a specific agency
- `select <name>`: activate an agency and update context
- `create <slug>`: scaffold a new custom agency from an existing base

Agencies directory: `.ai-office/agencies/`
Selection file: `.ai-office/agency.json`

---

## `list` (or no args)

Scan `.ai-office/agencies/` for subdirectories. For each, read its `config.md` (or first `.md` file) and extract the first heading and description line.

Output:
```
Available Agencies

| Agency | Focus | Best For |
|--------|-------|----------|
| software-studio | Full-stack web/mobile apps | SaaS, web apps, APIs |
| game-studio | Game development | Games, interactive experiences |
| ...

Currently active: <name from .ai-office/agency.json, or "none">
```

---

## `get <name>`

Read all `.md` files inside `.ai-office/agencies/<name>/`. Concatenate and display their contents, clearly separated by filename headings.

---

## `select <name>`

1. Check `.ai-office/agencies/<name>/` exists. If not, list available agencies and stop.

2. Read `.ai-office/agencies/<name>/config.md` (or equivalent) to get agency details.

3. Write `.ai-office/agency.json`:
```json
{
  "name": "<name>",
  "selectedAt": "<ISO timestamp>",
  "custom": false
}
```

4. Output:
```
✅ Agency activated: <name>

<summary of agency's agent roster and focus>

Active agents for this agency:
- <role>: <brief description>
- ...

Next steps:
- Use /office:route to start a new request
- Use /office:task-list to see the current board
- Agent role guides: `.ai-office/agents/<role>/personality.md`
```

---

## `create <slug> [--from=<base>] [--name=<display-name>] [--desc=<description>]`

Run the framework's `create-agency.sh` script to scaffold a new custom agency.

1. Locate `create-agency.sh`:
   - Try `./create-agency.sh` (repo root, when running inside the framework itself)
   - If not found, error: "create-agency.sh not found. This command must be run from the AI Office framework root."

2. Build the command from the provided arguments:
   - `<slug>` is required — the directory name for the new agency
   - `--from=<base>` (optional, default: `software-studio`) — agency to copy from
   - `--name=<display-name>` (optional) — human-readable name
   - `--desc=<description>` (optional) — one-line description

3. Run: `bash ./create-agency.sh <slug> [--from=<base>] [--name=<name>] [--desc=<desc>]`

4. Show the script output verbatim.

5. On success, suggest next steps:
```
Next steps:
- Edit the agency files in skeleton/.ai-office/agencies/<slug>/
  - config.md   — agents, quality gates, tech stack
  - pipeline.md — workflow stages and variants
  - templates.md — project directory templates
- Use /office:agency select <slug> to activate it in a project
- Use ./setup.sh <project-root> --agency=<slug> to install it
```
