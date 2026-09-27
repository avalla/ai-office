# SurrealDB ProjectStorage subset experiment

This document records the second stage of the SurrealDB evaluation. It is an
experimental adapter for a deliberately incomplete subset of `ProjectStorage`.
It is not a Runtime storage authority, a PostgreSQL or SQLite replacement, or a
production migration. It does not evaluate worker admission, leases, fencing, or
concurrent ownership.

## Inventory before implementation

The current `ProjectStorage` capability list is defined in
`packages/storage-bootstrap/src/project-storage-bootstrap.ts`. Classification
is based on the port and current repository behavior, not repository names.
SQLite implements all 19 listed capabilities. PostgreSQL's current bootstrap
implements `projects`, `officeManifests`, `pipelines`, `tasks`,
`taskRequirements`, `governance`, `runtime`, `auditEvents`, and
`transactions`; its remaining capabilities stay incomplete and
`requireCompleteProjectStorage` rejects that provider composition.

| Capability | Classification | Behavioral basis |
| --- | --- | --- |
| `projects` | LOW-RISK | Metadata read/save; updates preserve the original `createdAt`. PostgreSQL scopes reads and conflicting writes by trusted tenant. |
| `profiles` | AUTHORITY-SENSITIVE | Resolves canonical local paths to projects and stores source/scan/question/profile evidence; active profile entries can supersede earlier evidence. |
| `officeManifests` | AUTHORITY-SENSITIVE | Stores project office/agent configuration revisions used by the Runtime. |
| `pipelines` | CONCURRENT | Run updates use expected versions and return a conflict result; callers depend on active-run lookup. |
| `tasks` | LOW-RISK | Project-owned record updates preserve project ownership and creation time; listing has deterministic priority/time/id ordering. |
| `taskRequirements` | LOW-RISK | Project-scoped many-to-many links have unique identity, idempotent link/unlink results, parent/project checks, and deterministic reads. |
| `runtime` | CONCURRENT | Stores agent runs, task locks, leases, and queue state used for ownership and execution. |
| `costs` | AUTHORITY-SENSITIVE | Persists pricing, budgets, and usage/cost accounting consumed by budget enforcement. |
| `governance` | AUTHORITY-SENSITIVE | Persists milestone, requirement, ADR, and review lifecycle state and status transitions. |
| `capabilities` | AUTHORITY-SENSITIVE | Persists resources, grants, simulations, and action-request state used by deterministic authorization. |
| `controlled` | AUTHORITY-SENSITIVE | Persists approvals and filesystem execution attempts/outcomes that gate protected mutations. |
| `auditEvents` | AUTHORITY-SENSITIVE | Append-only provenance records for state-changing actions. |
| `repositoryIdentities` | AUTHORITY-SENSITIVE | Maps repository identities to projects and informs local workspace ownership. |
| `projectStates` | AUTHORITY-SENSITIVE | Stores project state revisions and heads used by import/export and reconciliation. |
| `memoryReferences` | LOW-RISK | Stores and lists project-scoped references to reusable memory records. |
| `projectMemoryProvenance` | LOW-RISK | Records and reads project-scoped retrieval provenance; it does not grant resource access. |
| `operationalReads` | LOW-RISK | Read-only projections over existing project/runtime records; it has no write authority. |
| `transactions` | TRANSACTIONAL | Defines the atomic boundary used by multi-repository operations. |
| `jobOutbox` | CONCURRENT | Stores dispatchable jobs and conditional dispatched/failed transitions consumed by workers. |

The selected capabilities are `projects`, `tasks`, and
`taskRequirements`. They cover ordinary record creation/read/update, immutable
ownership fields, deterministic ordering, unique relation identity, project
scoping, and relations to an adjacent requirement record. The shared contract
also exercises the transaction runner as supporting infrastructure. Requirement
storage itself is outside this subset; the harness seeds fixture requirement
records directly, matching the current shared contract setup.

The following potentially attractive capabilities are deferred: `profiles`
and `officeManifests` because their data influences Runtime configuration or
workspace resolution; `pipelines`, `runtime`, and `jobOutbox` because they
contain version, lease, or worker ownership semantics; `costs`, `governance`,
`capabilities`, `controlled`, `auditEvents`, `repositoryIdentities`, and
`projectStates` because they carry authorization, accounting, lifecycle, or
provenance authority; `memoryReferences`, `projectMemoryProvenance`, and
`operationalReads` because they are less representative than the selected
write-bearing contracts. No deferred capability is advertised as implemented.

## Canonical behavior matrix

This matrix is the pre-implementation comparison of the shared contract and the
two current relational adapters. The implementations agree on the listed
shared-contract behaviors. PostgreSQL additionally applies trusted tenant
predicates; SQLite has no tenant context. The experiment will preserve the
PostgreSQL tenant behavior in its explicit adapter context and will not describe
it as PostgreSQL RLS parity.

| Operation | Expected result | SQLite | PostgreSQL | Canonical contract |
| --- | --- | --- | --- | --- |
| Missing project/task lookup | `null` | `null` | `null` within configured tenant | `null` |
| Project save then lookup | Same snapshot | `INSERT ... ON CONFLICT(id) DO UPDATE` | Tenant-scoped insert/update | Snapshot round-trip |
| Project update | Mutable metadata changes; `createdAt` retained | Conflict update omits `created_at` | Conflict update omits `created_at` | Updated snapshot and original creation time |
| Task save then lookup/update | Same snapshot; update allowed | Conflict update mutable columns only | Conflict update mutable columns only, under tenant scope | Updated snapshot and original creation time |
| Task ownership change | Existing project remains | Conflict update omits `project_id` | Conflict update omits `project_id` | Existing owner retained |
| Task list | Project-only, priority desc/time asc/id asc | SQL order above | Same SQL order plus tenant join | Exact ordered IDs |
| Requirement link | First `true`, duplicate `false` | Unique pair plus `ON CONFLICT DO NOTHING` | Unique pair plus `ON CONFLICT DO NOTHING` | Idempotent boolean |
| Invalid/cross-project requirement link | `false`, no mutation | `INSERT ... SELECT` ownership predicate | `INSERT ... SELECT` ownership predicate (a missing tenant project errors) | `false` for the shared contract's mismatched task/requirement project cases |
| Relation reads | Project-only, ordered by key/id | Joins task and requirement with project equality | Same joins plus tenant/project predicates | Exact stable order and no cross-project rows |
| Transaction commit/rollback | All writes commit/rollback together | SQLite transaction runner | PostgreSQL transaction-bound session | Shared multi-repository transaction expectations |

The implementations differ for an invalid `TaskRequirementRepository.link`
when the supplied project does not exist in the PostgreSQL tenant: PostgreSQL
throws `PostgresTenantScopeError`, whereas SQLite returns `false`. This
tenant-context case is not part of the common contract and will be reported as
an implementation difference; the SurrealDB adapter will not claim parity for
that disputed case. A separate cross-tenant access contract will verify that a
trusted adapter context cannot read or mutate another tenant's records.

## Representation and integrity findings

Projects, tasks, and requirement fixtures are normal schemafull records
addressed by URL-encoded external IDs. Project-to-task ownership and
task-to-requirement linkage use separate typed relation tables with unique
ownership/endpoint indexes. The first relation is a one-to-many ownership edge;
the second is the existing many-to-many business relation. The knowledge graph
schema remains separate and independently versioned.

| Invariant | Enforcement |
| --- | --- |
| Entity identity uniqueness | DATABASE: unique external-ID indexes; IDs are globally unique as in the current SQLite/PostgreSQL schema. |
| Task has one project owner | DATABASE: enforced typed `office_project_task` relation plus unique `out` endpoint index. |
| Relation endpoint existence/table type | DATABASE: enforced typed SurrealDB relation tables reject absent or wrong-table endpoints. |
| Tenant visibility | ADAPTER: every query includes trusted constructor tenant context; record IDs are not tenant authorization. |
| Task and requirement project equality | ADAPTER: task, requirement, and existing-edge reads validate the requested scope before relation creation. |
| Domain value validity and task lifecycle | APPLICATION/domain constructors and transition methods. |
| Project mutable fields and task immutable `project_id`/`createdAt` | Adapter write shape only patches mutable columns; the database does not enforce historical immutability against direct writers. |

The pinned server tests confirmed typed endpoint enforcement and ordinary
transaction rollback. The SurrealDB `record<T>` type alone did not reject a
missing target record when a task was created; the enforced ownership relation
does. No read-before-write sequence is used for project/task duplicate writes.

## Deferred capabilities

All capabilities outside the selected subset remain deferred in this PR. In
particular there is no AgentRuntimeRepository, admission, lease, fencing,
concurrent claim, queue/outbox authority, production provider selection,
Runtime bootstrap integration, production migration, existing-data migration,
vector search, RAG, or benchmark suite.

SurrealDB's own documentation describes schema-enforced typed relations and
transaction-scoped query objects; this experiment used the [typed relation
model](https://surrealdb.com/docs/reference/query-language/statements/define/table)
and the JavaScript SDK `beginTransaction()` API. SurrealDB SDK types and
SurrealQL are confined to the adapter package.

## Canonical write models and transactions

| Entity/capability | Write model | Observed behavior |
| --- | --- | --- |
| Project | PATCH-or-CREATE | Conditional UPDATE changes name, description, and updated_at; missing IDs use CREATE ONLY. createdAt is retained. A duplicate ID under a different tenant fails closed. |
| Task | PATCH-or-CREATE | Checks that the input project is visible in the trusted tenant, patches mutable task fields only, or creates the task and its project ownership edge together. projectId and createdAt are not rewritten on update. |
| Task requirement | INSERT-ONLY link / DELETE unlink | Existing links return false; new links use RELATE; unlink removes only a matching tenant/project edge. No UPSERT is used. |
| Transaction runner | TRANSACTION | Uses the SDK transaction-scoped query object and AsyncLocalStorage to route repository calls onto the active transaction. Nested runner calls fail with TransactionAlreadyActiveError. |

Projects and tasks use record IDs derived from the globally unique external ID. Tenant predicates are adapter filters over trusted construction context; another tenant can neither read nor overwrite a row through these repositories. This is record-ID uniqueness plus adapter isolation, not PostgreSQL RLS. Project filters also apply to task lists and relation queries. Cross-project task/requirement pairs return false and leave prior edges intact.

Task creation uses an enforced typed project-to-task relation with a unique task endpoint. Task/requirement links use a separate enforced typed relation with a unique (in, out) index. SurrealDB rejects missing or wrong-type relation endpoints and enforces uniqueness. It does not enforce tenant agreement or equality of the stored tenant/project fields with referenced endpoints; adapter scope predicates do that. SQLite/PostgreSQL provide equivalent parent/project checks in SQL constraints and predicates.

Ordinary transactions are proven by the shared tests: project/task writes commit together and roll back together after an injected failure. Task writes and requirement linking also use the SDK transaction object. No competing writer, isolation level, conditional-claim, or fencing behavior is measured here.

## Shared contract reuse

- Reused unchanged: all 11 cases in tests/contracts/project-storage.contract.ts, through the same defineProjectStorageContracts call used by SQLite and PostgreSQL.
- Setup adaptation: the harness creates an isolated SurrealDB database per contract test, provides a fixed trusted tenant context, and seeds requirement fixtures through package-local test support because Governance is outside the subset.
- Impossible to reuse: 0 shared cases. The canonical transaction, repository, and expected-result APIs were sufficient without branching or weakening assertions.
- SurrealDB-specific cases: 7 for cross-tenant read/write/link denial, valid-state preservation after rejected links, missing-parent rollback, typed ownership and endpoint behavior, invalid lifecycle transition, and explicit partial capability naming.

## Integrity ownership

| DATABASE | ADAPTER | APPLICATION |
| --- | --- | --- |
| Globally unique project/task/fixture IDs; unique task owner; unique relation endpoints; typed endpoint existence/table constraints; schema field types and required fields. | Trusted tenant predicates; task input-project scope check; same-project checks for task/requirement link; idempotent false result from the pre-read; deterministic relation result ordering. | Domain constructors validate project/task values; Task transition methods reject invalid lifecycle transitions before persistence. |

The database does not enforce immutable fields against a direct database writer. The adapter preserves Project.createdAt, Task.createdAt, and Task.projectId by omitting them from update statements. Task status is stored as a string; lifecycle validity remains an application/domain responsibility.

## Read-before-write and concurrency evidence

Two operations currently use validation reads before their write:

1. TaskRepository.save reads the candidate project under the trusted tenant, then conditionally updates or creates the task and ownership relation in one SDK transaction.
2. TaskRequirementRepository.link reads the task, requirement, and existing edge, then writes the relation in one SDK transaction.

The relation unique endpoint index is the database backstop for duplicate links. The adapter pre-read provides the canonical boolean result for ordinary retries. This experiment does not establish whether transaction isolation prevents competing validations from both proceeding.

The selected PostgreSQL project/task/task-requirement adapters do not use FOR UPDATE; their ownership checks are SQL predicates and unique/FK constraints. PostgreSQL row locks are present in excluded PostgresAgentRuntimeRepository for run/task/agent/role/lock/pipeline/stage state and in PostgresGovernanceRepository for governance transitions. Those are relevant PR 3 comparison points, but they are not implemented here.

## Adapter ceremony measurements

Counts use source-file lines including imports, comments, and blanks; validation LOC counts only explicit TypeScript business-rule guard/throw lines, not SQL predicates, mapping, or generic missing-row handling. SurrealQL counts include schema DDL separately, and query-template counts are repository call sites, not statements nested inside a control-flow script.

| Repository | Adapter LOC | Schema LOC | Validation LOC | SurrealQL statements / templates | Explicit transaction call sites | Shared cases |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| ProjectRepository | 61 | 50 | 0 | 5 statements / 2 templates | 1 | 3 |
| TaskRepository | 86 | 50 | 2 | 11 statements / 3 templates | 1 | 4 |
| TaskRequirementRepository | 179 | 50 | 3 | 8 statements / 8 templates | 1 | 1 |
| Supporting transaction runner | 59 across runner/context | — | 0 | 0 raw SurrealQL statements; SDK begin/commit/cancel | 1 | 3 |

The separate ProjectStorage schema contains 37 repeatable DDL statements. Requirement fixture records are part of the relation target schema, not an exposed Governance capability.

| Area | Complexity | Evidence |
| --- | --- | --- |
| ProjectRepository | MORE CEREMONIAL | Current SQLite/PostgreSQL adapters use a single INSERT ... ON CONFLICT; SurrealDB uses a transaction-scoped conditional update/create script to preserve createdAt. |
| TaskRepository | MORE CEREMONIAL | A scoped parent check and project/task ownership relation are needed alongside the task record; current SQL adapters write one task row with FK/tenant predicates. |
| TaskRequirementRepository | MORE CEREMONIAL | Typed edges fit the many-to-many relation, but three reads before RELATE and adapter-side deterministic sorting exceed the relational INSERT ... SELECT ... ON CONFLICT DO NOTHING path. |
| Transaction runner | ROUGHLY EQUIVALENT | The SDK supplies a transaction object; a small async-local context routes repository queries through it. Shared commit/rollback expectations pass. |

These observations measure implementation effort only; they are not a database recommendation.
