# Task update flow
> Description and priority edits through the authoritative Runtime

Entry: `packages/runtime-host/src/commands/task.ts:handleTaskCommand()`
Flow: CLI command → Runtime command allow-list → `UpdateTask.execute()` → `Task.updateDescription()` / `Task.updatePriority()` → SQLite save + audit (one transaction)

Command: `task:update --project <id> --task <id> [--description <text>] [--priority <integer>]`
- At least one of `--description` / `--priority` is required; both may be given together.
- Project and task ownership are validated before mutation.
- Description updates preserve lifecycle status and emit `task.description_updated` (`{ descriptionUpdated: true }`).
- Priority updates preserve lifecycle status and emit `task.priority_updated` (`{ from, to }`).
- Priority: integer `-2147483648..2147483647` (`minTaskPriority`/`maxTaskPriority`, portable to PostgreSQL `integer`), default `0`, higher sorts first (`ORDER BY priority DESC`), negative allowed; range enforced once by domain `validateTaskPriority()` (`DomainValidationError`) on create and update. Not re-checked on read or `project:restore` (snapshot schema still accepts safe integers for legacy SQLite backups). `--priority` must be plain decimal integer text (`CliUsageError` otherwise), parser shared with `task:create`.
- `commandInvalidationTopics()` maps every `task:*` command to `task.updated` + `project.updated`.

Runtime service: source entrypoint `bun bin/ai-office.ts runtime start`; dashboard: `bun bin/ai-office.ts dashboard`.

Updated: 2026-10-05
