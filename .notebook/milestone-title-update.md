# Milestone title update flow
> Rename a milestone through the authoritative Runtime

Entry: `packages/runtime-host/src/commands/governance.ts:handleGovernanceCommand()`
Flow: CLI command allow-list → Runtime command allow-list → `ManageGovernance.updateMilestoneTitle()` → `GovernanceRepository.updateMilestoneTitle()` → SQLite/PostgreSQL update and audit event in one transaction.

Command: `milestone:update --project <id> --milestone <id> --title <title>`
- Title is trimmed and cannot be empty.
- The Runtime scopes lookup and update to the requested project.
- Repository compares the expected current title, so a concurrent rename is reported instead of overwritten silently.
- No-op rename emits no event; successful rename updates `updated_at` and emits `milestone.title_changed` atomically.
- No migration required; supported by both SQLite and PostgreSQL repositories.

Updated: 2026-09-25
