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
compose concrete implementations. SQLite remains the only implemented project
authority provider and the default Runtime composition. A future Pro
composition will use server-side PostgreSQL database connections so
transaction boundaries and concurrency semantics remain explicit and
preservable.

This decision establishes the repository/composition boundary; it does not yet
make Runtime backend selection interchangeable. Runtime command execution and
daemon bootstrap still open and migrate SQLite directly, then use the SQLite
composition factory. Connection, migration, and provider selection belong to a
subsequent infrastructure slice and must be centralized there rather than
duplicated across command handlers.

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
  project SQLite adapter construction is isolated behind the SQLite composition
  factory. The current Runtime composition remains SQLite-specific at its
  database open/migrate boundary.
- PostgreSQL can be introduced incrementally and contract-tested alongside
  SQLite without changing domain lifecycle or authorization semantics.
- Each backend must deliberately reproduce the documented transaction,
  conditional-mutation, append-only, and portability guarantees.
- Auth, object storage, realtime synchronization, and multi-user policy remain
  future Pro capabilities rather than scope for this persistence boundary.

## Links

- [Storage design](../architecture/storage.md)
- [Development roadmap](../development/roadmap.md)
