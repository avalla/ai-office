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
selected PostgreSQL and binds that trusted deployment/bootstrap value into
`ProjectStorageConfig`, then into the project, task, task-link, and governance
repositories. One PostgreSQL `ProjectStorage` handle is bound to exactly one
trusted tenant context. The value is not tenant membership authority and is not
a request-scoped authenticated tenant selector; it must never come from client
JWT tenant or role claims. A future shared Pro HTTP/API process must bind each
request to its own authenticated principal and tenant authority rather than
reuse one process-global tenant selection for arbitrary requests. That
request-principal and API-routing boundary is a separate future slice; this PR
does not define multi-tenant HTTP/API request routing authority.

The default bootstrap reads this value from `process.env` as deployment
configuration. An explicit `ProjectStorageConfig` can supply the same trusted
composition input. Tenant creation/provisioning remains external to opening a
handle: bootstrap intentionally does not require the configured tenant row to
exist, so a handle may precede provisioning. The tenant foreign key rejects
project writes until the operator creates the tenant; this is not a claim that
the configured value is valid request authority. A standalone
administrative/migration connection may operate above a tenant only through
explicit SQL/tooling; the human/runtime repository path is never an accidental
table-owner bypass.

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

## Project definition payload objects

`core.project_owned_definition.payload_json` and
`core.project_definition_override.payload_json` hold a `jsonb` object; a
`disable` override holds SQL `NULL`. Each table enforces it with a
`<table>_payload_json_check` on `jsonb_typeof`, like the other `jsonb`
documents of this schema. The repository binds the payload object itself: the
driver serializes a `jsonb` parameter, so a JavaScript string bound to one is
stored as a JSON string, not parsed.

Before `20261006000300_project_definition_payload_object.sql` the repository
bound JSON text, and every payload it wrote is a `jsonb` string scalar whose
content is that text. The migration converts each such value to the object it
spells, leaves objects and SQL `NULL` untouched, and then adds the two checks.
A release older than the migration cannot write definitions to a migrated
database: its string payloads violate the checks (SQLSTATE `23514`), so
upgrade every writer with or before the migration. PostgreSQL's own detail for
that violation quotes a prefix of the rejected row; the Runtime prints no
driver text, but a database log may hold it. The repository also refuses, on
read and on write, any payload that is not an object: opened against a
database that has not been migrated it fails instead of returning or storing
JSON text. It raises `ProjectDefinitionPayloadShapeError`, whose `rowKey`
names the row by table and key and which never carries the payload. The
Runtime lists this error among those it prints: the command fails with
`Project definition payload must be a JSON object: <row key>. Classify and
repair the row with the query in supabase/README.md.` Use the query below to
find the rows.

`jsonb` keeps array order and does not keep the order of an object's members.
`project:definition:show` may therefore print the members of a payload in a
different order on PostgreSQL than on SQLite. Digests are unaffected: they are
computed over canonical JSON.

Apply the migration with definition writers stopped. It locks both tables
exclusively; if PostgreSQL reports a deadlock against a concurrent writer,
nothing was changed and the migration can simply be applied again.

The migration fails closed. If one value cannot be converted, it raises
`cannot convert N project definition payload(s) to jsonb objects` (SQLSTATE
`22000`), nothing is converted, no check is added and the migration is not
recorded; the runner applies pending migrations in one transaction, so later
pending migrations are not applied either. The error detail names at most
twenty rows by key with the reason, ends with `; and N more` when there are
more, and never quotes a payload. A value cannot be converted when it is:

- a string whose content is not JSON text;
- a string whose content is JSON text for an array, a scalar or `null`;
- a string whose content is JSON text holding an escaped U+0000, which `jsonb`
  cannot store. The project text rule never accepted that character, so such a
  row was written past the Runtime's mutation contract;
- a string whose content is JSON text `jsonb` cannot store for another reason,
  such as a lone surrogate escape;
- any other non-object `jsonb` value.

Nothing is dropped, rewritten or skipped on the operator's behalf. The
migration's detail is not the complete list. This query is: it returns every
payload that is not yet an object, by key, with the verdict the migration
would reach for it and never its content. It needs PostgreSQL 16 or later.
On JSON text nested pathologically deep, this query and the migration's
per-row reason both fail with `54001 stack depth limit exceeded` instead of a
verdict; the migration still fails closed, changing nothing.

```sql
WITH listed AS (
  SELECT 'owned' AS source, project_id, NULL::text AS pack_id,
         NULL::text AS pack_version, NULL::text AS manifest_digest,
         kind, local_id, payload_json
    FROM core.project_owned_definition
   WHERE jsonb_typeof(payload_json) <> 'object'
  UNION ALL
  SELECT 'override', project_id, pack_id, pack_version, manifest_digest,
         kind, local_id, payload_json
    FROM core.project_definition_override
   WHERE payload_json IS NOT NULL AND jsonb_typeof(payload_json) <> 'object'
)
SELECT source, project_id, pack_id, pack_version, manifest_digest, kind, local_id,
       CASE
         WHEN jsonb_typeof(payload_json) <> 'string'
           THEN format('jsonb %s, not a JSON object', jsonb_typeof(payload_json))
         WHEN pg_input_is_valid(payload_json #>> '{}', 'jsonb')
           THEN CASE jsonb_typeof((payload_json #>> '{}')::jsonb)
                  WHEN 'object' THEN 'convertible'
                  ELSE format('JSON %s, not a JSON object',
                              jsonb_typeof((payload_json #>> '{}')::jsonb))
                END
         WHEN (pg_input_error_info(payload_json #>> '{}', 'jsonb')).sql_error_code = '22P05'
           THEN 'JSON text holding an escaped U+0000, which jsonb cannot store'
         WHEN pg_input_is_valid(payload_json #>> '{}', 'json')
           THEN 'JSON text that jsonb cannot store'
         ELSE 'not JSON text'
       END AS verdict
  FROM listed
 ORDER BY source, project_id, pack_id, pack_version, manifest_digest, kind, local_id;
```

A row whose verdict is `convertible` needs nothing: its text is JSON for an
object that `jsonb` can store, and the migration converts it. Every other row
has to be repaired, whether or not the migration's detail named it. For each,
read the stored text with `payload_json #>> '{}'`, keep a copy, and decide as
the project's operator what the definition should be. Then, as the database
owner, write the corrected payload as an object and advance the project's
definition revision in the same transaction:

```sql
BEGIN;
UPDATE core.project_owned_definition
   SET payload_json = '{"id":"counsel","title":"Counsel"}'::jsonb
 WHERE project_id = '<project>' AND kind = '<kind>' AND local_id = '<id>';
UPDATE core.project_definition_head
   SET revision = revision + 1, changed_at = now()
 WHERE project_id = '<project>';
COMMIT;
```

or, in place of the first statement, delete the row by its full key when the
definition should not exist; for an override that restores the pack's own
definition. An override row is addressed by `project_id`, `pack_id`,
`pack_version`, `manifest_digest`, `kind` and `local_id`.

The revision step is required, not optional. A failed migration leaves the
previous release in service, and that release replaces a project's whole
definition state from what it read. The repository accepts a replacement only
when the head revision still equals the one the writer read, so advancing it
with the repair makes a writer that read the bad row fail as stale and read
again, instead of silently writing the bad value back. Stopping the Runtime
for the repair works too, but the revision step holds either way.

A corrected payload has to satisfy the same rules a Runtime mutation would:
the exact `id`, the descriptive fields of its kind and the project text rule.
The repair is outside the Runtime and writes no audit event, so record it
operationally. Then run the query again until every row is `convertible`, and
apply the migrations again until they succeed; the migration re-checks every
row each time.

## Next slices

The remaining sequence after tenant-scoped project authority is:

1. invite acceptance/auth binding and remaining PostgreSQL repository parity,
   designed tenant-aware from creation;
2. a separately designed PostgreSQL AgentRuntime principal and parity slice.

Portable `Project` identity is not PostgreSQL tenant ownership. Repository identity
is a portable checkout binding, not tenant authority. Authenticated identity is
not tenant membership authority: membership remains database-backed.
