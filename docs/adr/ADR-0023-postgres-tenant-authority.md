# ADR-0023: PostgreSQL tenant authority for shared deployments

Status: accepted

## Context

AI Office Lite and Pro share the same application/domain contracts but use
materially different deployment boundaries. Lite is local-first and uses SQLite;
Pro is expected to use PostgreSQL/Supabase for shared, authenticated deployments.
The portable `Project` domain must not gain Supabase-only identity concepts just
to satisfy infrastructure concerns.

The existing PostgreSQL adapter already stores project authority in `core` and
is intentionally usable against ordinary PostgreSQL as well as Supabase. Future
multi-user access needs first-class tenant ownership, membership, invitations,
and RLS, while the generic PostgreSQL migration set must not require
`auth.users`, PostgREST, or another Supabase-only object merely to start.

## Decision

1. `core.tenant` is the shared-deployment tenant/workspace authority.
2. `core.tenant_member` models many-to-many human membership. One authenticated
   principal UUID may belong to several tenants with a tenant-local role.
3. `tenant_member.user_id` and invitation actor IDs are UUID identity references,
   but core authority does not foreign-key `auth.users`. Authentication binding
   belongs to the Supabase API/RLS layer; this keeps migrations valid on ordinary
   PostgreSQL.
4. `core.project.tenant_id` is PostgreSQL infrastructure metadata, not a field on
   the portable `Project` domain object.
5. Tenant-aware PostgreSQL project provisioning is an explicit composition
   boundary. The tenant-bound PostgreSQL repositories receive a trusted tenant
   context from `ProjectStorageBootstrap`; it is never derived from JWT claims,
   ambient state, or a default tenant. Project creation, repository import, and
   portable restore all use that bound context, while SQLite remains
   tenant-agnostic.
6. Migration `20260919050000_project_tenant_required.sql` completes the staged
   transition by refusing to run while any project has `tenant_id IS NULL`, then
   enforcing `core.project.tenant_id NOT NULL`. Existing orphan rows must be
   assigned by an authoritative operator before retrying the migration; the
   migration never guesses ownership.
7. Tenant deletion is restricted while projects remain assigned. Memberships and
   invitations are tenant-owned support records and cascade on tenant deletion.
8. Project IDs remain globally unique. `UNIQUE (id, tenant_id)` is nevertheless
   explicit so future denormalized/high-volume tables can enforce composite
   project/tenant ownership with foreign keys rather than trigger-only checks.
9. Normal project-owned aggregates do not automatically duplicate `tenant_id`.
   They inherit tenancy through `project_id`. Future high-volume or cross-project
   authorities such as audit, costs, memory, or outbox may denormalize
   `tenant_id` where query/security value justifies it, and must then bind it to
   the project with a composite foreign key.
10. Project transfer between tenants is not an ordinary CRUD mutation. If the
    product later needs transfer, it must be an explicit audited operation with
    preconditions and transaction semantics.
11. RLS, authorization helpers, API views/RPCs, Supabase Auth binding, and
    Runtime service-principal behavior are follow-up slices. This ADR does not
    claim tenant isolation is complete merely because tenant tables exist.

## Consequences

- SQLite/Lite remains free of tenant/account concepts.
- The PostgreSQL/Supabase schema gains a stable ownership root before more
  repository parity expands the schema.
- Existing PostgreSQL contracts require explicit tenant fixtures/context.
- Tenant-bound server-side repositories add tenant predicates/checks even when
  the table-owner connection bypasses RLS; administrative SQL remains a
  separate, explicit authority.
- Portable Project identity and repository identity are not tenant authority.
- Supabase RLS can derive access through
  `principal -> tenant_member -> tenant -> project` without putting a "current
  tenant" mutable global into the database or JWT.
- The database retains a clear distinction between human membership and future
  Runtime/agent service principals.
