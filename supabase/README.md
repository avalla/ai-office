# AI Office Supabase database

This directory is the version-controlled database surface for the future AI
Office Pro composition. SQLite remains the only complete Runtime project
authority until every required `ProjectStorage` capability has a PostgreSQL
adapter and bootstrap explicitly reports the provider as complete.

## Authority boundaries

- `supabase/migrations/` is the authoritative ordered PostgreSQL schema history.
- `core` contains internal project authority. It is not intended to become the
  browser/mobile API surface merely because it lives in Supabase.
- `private` contains the authorization helpers for tenant/project membership.
  It is not a Data API surface. Security-definer helpers use a fixed, empty
  `search_path` and fully-qualified references; public `EXECUTE` is revoked.
- a future `api` schema may expose security-invoker views and narrowly scoped
  RPCs to authenticated clients. `public` is not the application authority.
- Human access is `JWT -> authenticated -> auth.uid() -> core.tenant_member ->
  RLS`. JWT claims are identity context only; tenant membership and roles remain
  database authority. The Runtime uses its existing server-side PostgreSQL trust
  boundary and does not depend on Supabase `service_role`. PostgreSQL
  repositories are composed with an explicit trusted tenant ID; table-owner
  access is still guarded by tenant predicates/checks.
- Tenant visibility/access: membership-backed RLS determines which tenant and
  project rows an authenticated human can read; JWT tenant/role claims do not.
- Collaboration mutation authority: ordinary project-owned collaboration tables
  retain their table-specific owner/admin/member policies.
- Governance authority: `core.review`, `core.approval`, and
  `core.governance_event` are authoritative surfaces with authenticated
  tenant-scoped `SELECT` only; no direct human governance CRUD or forged actor.
- Runtime authority: `core.agent_run` is a Runtime projection with authenticated
  tenant-scoped `SELECT` only. Governance and projection writes stay on the
  Runtime/server-side table-owner path pending a separately designed bound
  RPC/API slice.

## Test split

Use pgTAP for invariants owned by PostgreSQL itself:

- schema shape, indexes, constraints, triggers, and functions;
- cross-project / future cross-tenant ownership;
- append-only and immutable records;
- atomic database state-machine guards;
- RLS allow/deny matrices, including the separation between tenant visibility
  and governance authority.

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

The tenancy slice adds `core.tenant`, `core.tenant_member`,
`core.tenant_invite`, and mandatory `core.project.tenant_id` ownership. Tenant
identity is PostgreSQL infrastructure metadata: the portable `Project` domain and
SQLite/Lite composition remain tenant-agnostic.

`20260919050000_project_tenant_required.sql` completes the staged migration. It
fails closed when existing rows have `tenant_id IS NULL`; operators must establish
a deterministic authoritative ownership mapping before retrying. It then enforces
`core.project.tenant_id IS NOT NULL`, while the existing tenant FK and immutable
assignment trigger remain active.

`ProjectStorageBootstrap` requires `AI_OFFICE_POSTGRES_TENANT_ID` for environment
selected PostgreSQL and binds that trusted value into project, task, task-link,
and governance repositories. Project creation, repository import, and portable
restore therefore provision through an explicit tenant-bound composition. A
standalone administrative/migration connection may operate above a tenant only
through explicit SQL/tooling; the human/runtime repository path is never an
accidental table-owner bypass.

Human principal IDs are UUIDs but core tables intentionally do not foreign-key
`auth.users`. That binding belongs to the Supabase Auth/RLS surface so the same
migration history remains valid against ordinary PostgreSQL. See
`docs/adr/ADR-0023-postgres-tenant-authority.md`.

The authorization migration keeps ordinary PostgreSQL portable: when
`auth.uid()` or the `authenticated` role is absent, human identity resolves to
`NULL`, no Supabase-specific grants/policies are installed, and helper decisions
fail closed. The server-side PostgreSQL storage owner remains usable for the
existing Runtime contracts. `tenant_invite.token_hash` is write-only to the
authenticated table surface; safe invitation columns use explicit column
grants.

## Next slices

The remaining sequence after tenant-scoped project authority is:

1. invite acceptance/auth binding and remaining PostgreSQL repository parity,
   designed tenant-aware from creation;
2. a separately designed PostgreSQL AgentRuntime principal and parity slice.

Portable `Project` identity is not PostgreSQL tenant ownership. Repository identity
is a portable checkout binding, not tenant authority. Authenticated identity is
not tenant membership authority: membership remains database-backed.
