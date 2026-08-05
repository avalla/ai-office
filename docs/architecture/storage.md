# Storage design

## global.sqlite

Stores:

- reusable roles;
- agent templates;
- patterns and versions;
- playbooks;
- lessons;
- provider pricing catalog.

## project.sqlite

Stores:

- tasks and dependencies;
- milestones;
- requirements;
- ADRs;
- agents and runs;
- review and approval state;
- budget reservations;
- usage and costs;
- append-only audit events.

## index.sqlite

Stores regenerable material:

- source files;
- symbols;
- code edges;
- chunks;
- FTS;
- embeddings in a later milestone.

## Markdown policy

The database is the source of truth.

Markdown is generated as a human-readable projection.

Initial synchronization is one-way:

```text
database -> Markdown
```

## Audit events

`project.sqlite.audit_event` is an append-only log. The daemon records lifecycle
and sanitized command metadata through an application service. SQLite triggers
reject updates and deletes; payloads never contain raw CLI arguments or answers.

`agent_run_event` is also append-only and records every persisted run state. Task locks are short-lived rows keyed by task, preventing concurrent runs for the same task.

Pricing, budgets, reservations, normalized usage, and costs currently live in the project database so the single local daemon can enforce one write boundary. Moving the reusable pricing catalog to `global.sqlite` is deferred until global storage is connected in M6; historical cost rows already retain their pricing version.
