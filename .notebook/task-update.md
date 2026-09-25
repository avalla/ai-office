# Task update flow
> Description edits through the authoritative Runtime

Entry: `packages/runtime-host/src/commands/task.ts:handleTaskCommand()`
Flow: CLI command → Runtime command allow-list → `UpdateTask.execute()` → `Task.updateDescription()` → SQLite save + audit

Command: `task:update --project <id> --task <id> --description <text>`
- Project and task ownership are validated before mutation.
- Description updates preserve lifecycle status and emit `task.description_updated`.
- `commandInvalidationTopics()` maps every `task:*` command to `task.updated` + `project.updated`.

Runtime service: source entrypoint `bun bin/ai-office.ts runtime start`; dashboard: `bun bin/ai-office.ts dashboard`.

Updated: 2026-09-25
