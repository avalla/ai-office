# Storage design

AI Office separates authoritative project state, global reusable memory, and regenerable code intelligence. See the [architecture overview](overview.md) for the system-level boundary.

## Runtime-root resolution

The production daemon and CLI use their current working directory as the
runtime root. There is no public data-directory flag or environment setting.
The active database path is therefore:

```text
<runtime-root>/.ai-office/project.sqlite
```

The runtime root and an imported source repository are usually conceptually
related, but current code does not require them to be the same path.
`project:import /other/repository` records that repository in the current
daemon's database; it does not create `/other/repository/.ai-office/`. A single
runtime database may contain several imported project IDs.

## `project.sqlite` — implemented and authoritative

`<runtime-root>/.ai-office/project.sqlite` currently stores:

- projects, imported-source metadata, onboarding questions, profile facts, and immutable office-manifest revisions;
- tasks, roles, agents, agent runs, task locks, and run events;
- pricing, budgets, reservations, normalized usage, and costs;
- milestones, requirements, ADR records, reviews, and governance decisions;
- resources, capability grants, action requests, simulations, approvals, and execution records;
- append-only audit events.

The daemon creates, opens, and migrates this database before it opens its Unix
socket. Project migrations are versioned under `migrations/project/` and tracked
by `schema_migration`. The standalone project migration command targets the same
current-working-directory path. The database is not a cache: deleting it loses
the operational history for every project recorded in that runtime.

## `global.sqlite` — initial schema, not connected

`~/.ai-office/global.sqlite` is the future durable store for reusable knowledge across projects. Its initial migration defines global roles, patterns, and lessons. The current daemon does not open this database, and no application repositories manage it yet. Reusable-memory behavior belongs to M7.

Provider pricing currently remains in `project.sqlite`. Moving any catalog data to global storage requires an explicit future design and compatibility plan.

## `index.sqlite` — initial schema, not connected

`<runtime-root>/.ai-office/index.sqlite` is intended for regenerable code intelligence. Its initial migration defines source files, symbols, code edges, chunks, and FTS. The current daemon does not open or create it, and no indexer populates it yet. Code intelligence belongs to M8.

Unlike project and global state, index data is derived and may be rebuilt from source plus authoritative metadata.

## Markdown policy

SQLite is authoritative. Generated Markdown is a deterministic, human-readable projection:

```text
database -> Markdown
```

Generated project profiles and governance views are not read back as independent state.

## Events and write ownership

`project.sqlite.audit_event` is append-only. The daemon records lifecycle and sanitized command metadata through an application service; SQLite triggers reject updates and deletes, and payloads exclude raw CLI arguments and onboarding answers.

`agent_run_event` is also append-only and records persisted run transitions. Task-lock rows prevent concurrent runs for the same task.

Agents never open database files or receive raw SQL access. Project writes go through application services and repository ports, with short transaction boundaries around state changes.

## Other local artifacts and backup boundary

The daemon listens on `<runtime-root>/.ai-office/daemon.sock`, removes it on a
clean shutdown, and replaces an unreachable stale socket. SQLite may maintain
`project.sqlite-wal` and `project.sqlite-shm` while the database is open; those
files must not be deleted or separated from the main database during live
operation.

Onboarding may use `.ai-office/drafts/office-manifest.json`, while project and
governance exports write deterministic Markdown under `.ai-office/generated/`.
Applied manifest revisions and the data behind those projections remain
authoritative in SQLite. Coding-client integration may consume
`.ai-office/agent-instructions.json`, but that contract plus repository-level
`AGENTS.md` and `CLAUDE.md` are integration artifacts governed by their own
ownership rules, not database state or runtime authorization.

There is no built-in backup/restore or legacy-state import command. A filesystem
backup should be taken after a clean daemon shutdown so SQLite and its WAL are
consistent. Re-running `project:import` rebuilds detected repository facts; it
does not restore tasks, runs, manifests, governance, costs, capabilities,
controlled actions, approvals, executions, or audit history.
