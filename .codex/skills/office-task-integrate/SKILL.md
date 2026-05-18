---
name: office-task-integrate
description: Integrate a reviewed task branch into the configured merge target. Usage: $office-task-integrate <task-id> [reason]
disable-model-invocation: true
---

Target host: Codex adapter

$ARGUMENTS format: `<task-id> [reason]`

Examples:
- `$office-task-integrate M1_T003`
- `$office-task-integrate M1_T003 "QA approved for UAT"`

---

## Steps

1. Confirm the task id to integrate.
2. Read `.ai-office/project.config.md` if needed to understand task isolation settings.
3. Ensure the task branch or worktree has only committed task-related changes before integrating.
4. Run `ai-office task integrate <task-id>` and include any provided reason if supported by the CLI.
5. Report the integration target branch and any follow-up step for UAT or release.

<!-- ai-office-version: 1.16.0 -->
