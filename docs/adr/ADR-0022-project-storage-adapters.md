# ADR-0022: Project authority uses interchangeable storage adapters

- Status: Accepted
- Date: 2026-09-19
- Tags: architecture, storage, postgresql, sqlite

## Context and Problem Statement

AI Office Lite is local-first and requires SQLite to remain the authoritative
project store. AI Office Pro is intended to provide a shared deployment backed
by Supabase PostgreSQL. Application services already use repository ports, but
Runtime composition and command context types exposed SQLite repository
classes, making a second authoritative backend unnecessarily invasive.

## Decision Drivers

- Preserve Lite behavior, existing databases, and SQLite transaction semantics.
- Keep domain and application semantics shared across Lite and Pro.
- Keep storage-provider details out of repository contracts and policy logic.
- Preserve the portable `.aioffice` semantic state as the Lite-to-Pro boundary.

## Decision Outcome

The application repository ports are the stable contracts for project
authority. A `ProjectStorage` composition groups those ports, the durable
`JobOutboxRepository`, and the `TransactionRunner`; infrastructure packages
compose concrete implementations. SQLite remains the default and only complete
Runtime authority. `ProjectStorageBootstrap` is the centralized provider
selection and construction boundary used by Runtime command execution and daemon
bootstrap. It can explicitly bootstrap the partial PostgreSQL foundation while
reporting its capabilities.

The repository/composition and provider-selection boundaries remain explicit
as PostgreSQL parity is added incrementally. PostgreSQL now implements the
`AgentRuntimeRepository` and `AuditEventRepository` ports in addition to the
project, task, task-requirement, governance, and transaction capabilities. Its
runtime migration extends the existing governance `core.agent_run` table in
place; identity-only rows remain valid and are excluded from runtime reads until
they have a complete runtime shape. The minimal pipeline projection used by
worker fences is not PipelineRunRepository parity.

PostgreSQL selection for complete Runtime authority still fails closed with
`StorageProviderIncompleteError`; there is no SQLite fallback or mixed project
authority. Server-side PostgreSQL connections keep transaction boundaries and
concurrency semantics explicit and preservable as remaining repository parity is
added.

Supabase/PostgREST and `supabase-js` are not the core repository abstraction.
`supabase-js` may be added later for Supabase Auth, Storage, and Realtime.
AI Office capability policy remains authoritative for protected actions;
Supabase RLS is defense-in-depth for data visibility and cannot replace
capability policy or controlled-action authorization.

The first PostgreSQL implementation targets project authority only. `global.sqlite`
remains durable reusable user-level memory, and `index.sqlite` remains a
separate regenerable future code index.

## Consequences

- Runtime and application command contexts depend on repository ports, while
  project provider construction is isolated behind `ProjectStorageBootstrap`.
  Global reusable memory remains explicitly backed by `global.sqlite`.
- PostgreSQL can be introduced incrementally and contract-tested alongside
  SQLite without changing domain lifecycle or authorization semantics; it
  remains partial until all required `ProjectStorage` repositories exist.
- Each backend must deliberately reproduce the documented transaction,
  conditional-mutation, append-only, and portability guarantees.
- Auth, object storage, realtime synchronization, and multi-user policy remain
  future Pro capabilities rather than scope for this persistence boundary.

## Links

- [Storage design](../architecture/storage.md)
- [Development roadmap](../development/roadmap.md)
