---
trigger: model_decision
description: Use this rule when the user mentions AI Office, .ai-office artifacts, milestones, task board operations, status files, or any /office workflow.
---

# AI Office Workspace Rule

1. Read `AI-OFFICE.md` before making assumptions about workflow stages, artifacts, or handoffs.
2. Treat `.ai-office/` artifacts as the source of truth for project state.
3. Prefer the deterministic `ai-office` CLI for state changes such as task creation, task moves, status updates, milestone operations, and validation.
4. Use the matching `/office-*` workflow when the user is asking for a repeatable AI Office operation.
5. Keep Windsurf-specific wrapper behavior thin. The framework logic lives in `AI-OFFICE.md`, `.ai-office/`, and the CLI.
