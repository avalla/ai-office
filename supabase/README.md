# AI Office Supabase database

This directory is the version-controlled database surface for the future AI
Office Pro composition. SQLite remains the only complete Runtime project
authority until every required `ProjectStorage` capability has a PostgreSQL
adapter and bootstrap explicitly reports the provider as complete.

## Authority boundaries

- `supabase/migrations/` is the authoritative ordered PostgreSQL schema history.
- `core` contains internal project authority. It is not intended to become the
  browser/mobile API surface merely because it lives in Supabase.
- future `private` schema functions will hold authorization helpers such as
  tenant/project membership checks. Security-definer helpers must use a fixed,
  empty `search_path` and fully-qualified references.
- a future `api` schema may expose security-invoker views and narrowly scoped
  RPCs to authenticated clients. `public` is not the application authority.
- Supabase Auth, RLS, Storage, Realtime, tenancy, and Runtime service principals
  are separate slices and are not silently implied by the current PostgreSQL
  repository parity.

## Test split

Use pgTAP for invariants owned by PostgreSQL itself:

- schema shape, indexes, constraints, triggers, and functions;
- cross-project / future cross-tenant ownership;
- append-only and immutable records;
- atomic database state-machine guards;
- future RLS allow/deny matrices.

Keep Vitest for TypeScript/application behavior:

- repository-port contracts;
- Postgres adapter mapping and errors;
- `PostgresClient` transaction participation;
- storage bootstrap/provider completeness;
- Runtime integration across database and non-database boundaries.

Do not delete a Vitest regression merely because pgTAP covers a similar database
constraint until the TypeScript behavior it protects is demonstrably redundant.

## Local workflow

Requires the Supabase CLI and a Docker-compatible container runtime.

```bash
supabase db start
supabase test db
supabase db lint --level error
```

To rebuild from migrations while developing schema changes:

```bash
supabase db reset
supabase test db
```

`supabase test db` discovers SQL/pg files recursively under `supabase/tests/`.
Each test file is transaction-isolated by the CLI; test files also use explicit
`BEGIN`/`ROLLBACK` so they remain readable and safe when run through pgTAP tools
directly.

## Tenant authority foundation

The first tenancy slice adds `core.tenant`, `core.tenant_member`,
`core.tenant_invite`, and staged `core.project.tenant_id` ownership. Tenant
identity is PostgreSQL infrastructure metadata: the portable `Project` domain and
SQLite/Lite composition remain tenant-agnostic.

`project.tenant_id` is intentionally nullable during the migration phase so the
current PostgreSQL repository contracts remain valid. A project may move from
unassigned to one tenant exactly once; ordinary reassignment or detachment then
fails at the database boundary. The authenticated Pro surface must later deny
unassigned projects, and a later migration may make ownership mandatory after
all Pro creation/import paths carry explicit tenant context.

Human principal IDs are UUIDs but core tables intentionally do not foreign-key
`auth.users`. That binding belongs to the Supabase Auth/RLS surface so the same
migration history remains valid against ordinary PostgreSQL. See
`docs/adr/ADR-0023-postgres-tenant-authority.md`.

## Next slices

The intended sequence after the tenant authority foundation is:

1. authorization helpers in a non-exposed `private` schema;
2. RLS and pgTAP multi-user/multi-tenant allow/deny coverage, including fail-closed
   behavior for unassigned projects;
3. tenant-scoped Pro project creation/import and, once migration is complete,
   mandatory project tenant ownership;
4. remaining PostgreSQL repository parity, designed tenant-aware from creation.
