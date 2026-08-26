# Storage design

AI Office separates authoritative project state, global reusable memory, and regenerable code intelligence. See the [architecture overview](overview.md) for the system-level boundary.

## Runtime, import, and integration roots

The linkable `ai-office` entry point selects a stable runtime data home from
`AI_OFFICE_HOME` or, by default, `~/.ai-office`. Program location and current
repository do not select authority. The legacy `bun run daemon` and
`bun run cli` development scripts explicitly retain current-working-directory
compatibility. The normal active database path is:

```text
<runtime-home>/project.sqlite
```

The current path model has three independent roles:

- the **runtime data root** above owns the daemon database, socket, onboarding drafts,
  and generated Markdown;
- the **source/import root** is the canonical repository path scanned by
  `project:import <path>` and recorded in the current runtime database;
- the **integration root** is supplied separately through `client:* --root` and
  contains the project instruction contract plus any `AGENTS.md` and
  `CLAUDE.md` inspected or managed by that workflow.

The three roots often coincide, but current code does not require that.
`project:import /other/repository` does not create
`/other/repository/.ai-office/project.sqlite`, and a single runtime database may
contain several imported project IDs. Likewise, client integration never moves
the runtime database into its integration root.

## Repository-local project binding

`ai-office install <path>` creates
`<project-root>/.ai-office/project.json` after canonicalizing the repository.
The strict schema-version `2` contract contains exactly `schemaVersion`,
`managedBy: "ai-office"`, and an opaque portable `repositoryId`. It has no
runtime `projectId`, absolute path, runtime locator, hostname, credential,
capability, client executable path, or copied project data.

The binding is intended to be committed. It is a visible identity anchor, not
authority: each runtime maps `repositoryId` to its own project row and records
canonical checkout paths in SQLite. A fresh clone or purged runtime establishes
that mapping through normal install. An additional checkout in an existing
runtime must match a known Git remote; incompatible or unverifiable copied
identities fail closed. Schema-version 1 runtime-project bindings remain
readable and are migrated by install.

Install resolves and targets its explicit directory exactly, allowing an
intentional nested project to be created. Status, uninstall, and automatic
project-scoped resolution walk real ancestors on the same filesystem device.
The nearest valid binding wins, so a nested AI Office project shadows an outer
one. Traversal stops at the filesystem root or before crossing a device
boundary. A symlinked `.ai-office`, symlinked `project.json`, invalid filesystem
type, malformed contract, foreign ownership, or unsupported schema fails
closed.

Binding plan/apply uses expected file hashes, atomic create/update, and fresh
inspection. Uninstall preserves the portable binding, removes ownership-safe
client artifacts, and detaches only the current checkout in SQLite; unrelated
`.ai-office/` entries and other checkouts remain. See
[ADR-0008](../adr/ADR-0008-repository-local-project-binding.md).

## `project.sqlite` — implemented and authoritative

`<runtime-home>/project.sqlite` currently stores:

- projects, imported-source metadata, historical onboarding questions, profile facts, and immutable office-manifest revisions;
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

## `global.sqlite` — implemented durable reusable memory

`<runtime-home>/global.sqlite` stores immutable versions of reusable roles and
patterns plus lessons. A role `key` identifies one logical role, `(id, version)`
identifies an exact revision, and creating a newer revision preserves both the
stable ID and every older revision. Deprecation is revision-specific and does
not delete history. The daemon-backed CLI opens and migrates the database lazily
for `memory:*` commands through an application repository port. It is durable
global memory authority at user scope, not project authority, and it is not
inside the runtime purge boundary. Exact project adoption references remain in
authoritative `project.sqlite`.

Project ownership and task provenance are validated against `project.sqlite`
before global writes. Project adoption rows have a local project foreign key;
their global pattern target cannot have a cross-database foreign key and is
therefore validated by the application service. Global SQLite transactions
remain short and never span provider or connector calls.

`sourceProjectId` and `sourceTaskId` on global patterns and lessons are
historical provenance identifiers validated at write time. They are not
cross-database foreign references with permanently guaranteed existence:
`global.sqlite` can outlive `runtime:purge` of the originating project database
and can be read from another runtime.

Commands using the default user runtime share this global-memory trust
boundary. Explicit `AI_OFFICE_HOME` isolation selects a separate global
database as well. Agents do not receive the database or raw SQL access, and lesson
extraction remains explicit and application-validated. Global audit,
memory-write authorization policy, poisoning protection, and quotas are future
hardening work rather than guarantees of the current storage boundary.

Provider pricing currently remains in `project.sqlite`. Moving any catalog data to global storage requires an explicit future design and compatibility plan.

## `index.sqlite` — initial schema, not connected

`<runtime-home>/index.sqlite` is intended for regenerable code intelligence. Its initial migration defines source files, symbols, code edges, chunks, and FTS. The current daemon does not open or create it, and no indexer populates it yet. Code intelligence belongs to M8.

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

The daemon listens on `<runtime-home>/daemon.sock`, removes it on a
clean shutdown, and replaces an unreachable stale socket. SQLite may maintain
`project.sqlite-wal` and `project.sqlite-shm` while the database is open; those
files must not be deleted or separated from the main database during live
operation.

Onboarding may use
`<runtime-home>/drafts/office-manifest.json`, while project and
governance exports write deterministic Markdown under
`<runtime-home>/generated/`. Applied manifest revisions and the data
behind those projections remain authoritative in SQLite.

Coding-client integration instead consumes an optional
`<integration-root>/.ai-office/agent-instructions.json` contract and inspects or
manages `<integration-root>/AGENTS.md` and `<integration-root>/CLAUDE.md`. These
are integration artifacts governed by their own ownership rules, not database
state or runtime authorization.

The normal install lifecycle derives that instruction contract in memory from
the current office manifest and project identity. It writes the project binding
plus ownership-safe `AGENTS.md`/`CLAUDE.md` changes, but does not persist a
second instruction contract. The JSON contract file remains an optional input
for direct machine-oriented `client:*` workflows.

There is no built-in backup/restore or legacy-state import command. A filesystem
backup should be taken after a clean daemon shutdown so SQLite and its WAL are
consistent. Re-running `project:import` rebuilds detected repository facts; it
does not restore tasks, runs, manifests, governance, costs, capabilities,
controlled actions, approvals, executions, or audit history. When the
integration root differs, its contract and instruction files require a separate
ownership-aware backup decision.

## Offline purge

`runtime:purge` is an explicitly offline lifecycle operation. It first returns
a deterministic plan without mutating state. Applying the exact plan hash is
allowed only while the daemon is unreachable and re-plans before deletion, so a
changed database, sidecar, draft, projection, or socket invalidates approval.

The purge owns only the known runtime artifacts under the selected runtime
home: `project.sqlite` and its sidecars, future `index.sqlite` files if present,
`daemon.sock`, `drafts/`, and `generated/`. Unknown entries are reported and
preserved, including `global.sqlite`. The runtime home is removed only if it is
empty afterward. Global state, source files, dependencies, and distinct
integration roots are outside this lifecycle boundary. Removal is not a
cross-file atomic transaction, so derived files and SQLite sidecars are removed
before the authoritative `project.sqlite`; any failure stops the purge and
requires a fresh plan for the remaining state.

Repository-local `uninstall` is not purge. It preflights an exact lifecycle
plan, removes managed client artifacts in dependency order, and detaches the
current canonical checkout while preserving `.ai-office/project.json`. It does
not delete a project row, other checkout associations, repository identity
mapping, `project.sqlite`, runtime artifacts, or `global.sqlite`. It makes no
false cross-filesystem/SQLite atomicity claim: a partial failure reports paths
already or possibly modified and gives deterministic recovery.
