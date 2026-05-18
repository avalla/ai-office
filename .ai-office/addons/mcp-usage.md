# Addon: MCP Adapter Usage

When MCP servers are configured in `.mcp.json`, prefer their tools over manual file reads for external services.

## Tool Preferences

| Task | Prefer |
|------|--------|
| Fetch URLs / scrape pages | `fetch` MCP tool |
| Multi-step reasoning | `sequential-thinking` MCP tool |
| Browser automation / E2E | `playwright` MCP tool |
| Performance audits | `lighthouse` MCP tool |
| Database queries | `postgresql` MCP tool |
| Supabase operations | `supabase` MCP tool |
| Security scanning | `snyk` MCP tool |
| UI generation (design→code) | `stitch` MCP tool |
| Image/video generation | `runcomfy` MCP tool |
| iOS Simulator control | `ios-simulator` MCP tool |

## Rules

- Check `.mcp.json` to confirm which servers are configured before using a tool.
- If a required MCP tool is not configured, fall back to file/bash operations and note the gap.
- Never expose MCP auth tokens (`${VAR}` placeholders) in output or logs.
- Prefer MCP tools for external service calls to keep audit trails consistent.

## AI Office Slash Commands (Claude Code)

Use these slash commands for all framework operations — do not manipulate `.ai-office/` files directly:

| Operation | Command |
|-----------|---------|
| Route a new request | `/office-route <description>` |
| Advance pipeline stage | `/office-advance <slug> <evidence>` |
| Scaffold an artifact | `/office-scaffold <slug> <stage>` |
| Validate a stage gate | `/office-validate <slug> <stage>` |
| Multi-sector review | `/office-review <path>` |
| Create a task | `/office-task-create <title>` |
| Move a task | `/office-task-move <id> <column>` |
| List tasks | `/office-task-list` |
| Run tests | `/office-run-tests <slug>` |
| Scan for secrets | `/office-validate-secrets` |
| Health check | `/office-doctor` |
