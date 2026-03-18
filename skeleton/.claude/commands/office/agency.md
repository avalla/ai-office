---
description: List, inspect, or activate an AI Office agency. Usage: /office:agency [list|get <name>|select <name>]
---

$ARGUMENTS format: `[list | get <name> | select <name>]`

- `list` (default if no args): show all available agencies
- `get <name>`: show full config for a specific agency
- `select <name>`: activate an agency and update context

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
