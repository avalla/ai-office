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
