---
name: office
description: AI Office entrypoint. Route the request to the right workflow or deterministic CLI action.
disable-model-invocation: true
---

Examples:
- `$office help me start a billing feature`
- `$office create a task for fixing auth retries`
- `$office check project health`

---

## Steps

1. Read `AI-OFFICE.md` and check `.ai-office/project.config.md` when present.
2. Infer whether the user needs routing, status, task board work, milestone management, validation, setup, or a doctor check.
3. For a new feature, bug, audit, or initiative, call `$office-route`.
4. For task board mutations, prefer `$office-task-create`, `$office-task-move`, `$office-task-update`, or `$office-task-integrate`.
5. For milestone operations, call `$office-milestone`.
6. For stage readiness, call `$office-validate` or `$office-advance`.
7. For installation or configuration checks, call `$office-doctor` or `$office-setup`.
8. Prefer deterministic `ai-office` CLI commands for state mutations whenever the CLI supports the operation.

<!-- ai-office-version: 1.9.1 -->
