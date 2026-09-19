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
5. Tenant assignment is staged. Existing PostgreSQL repository writes may create
   an unassigned project while migration work is in progress. `NULL -> tenant`
   is allowed once; an assigned project cannot be detached or moved through an
   ordinary update.
6. The authenticated Pro surface must later fail closed for projects whose
   `tenant_id` is NULL. Once all Pro project-creation/import paths are explicitly
   tenant-scoped, a later migration may make `tenant_id` mandatory.
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
- Existing PostgreSQL contracts continue to run during the staged migration.
- Supabase RLS can later derive access through
  `principal -> tenant_member -> tenant -> project` without putting a "current
  tenant" mutable global into the database or JWT.
- The database retains a clear distinction between human membership and future
  Runtime/agent service principals.
