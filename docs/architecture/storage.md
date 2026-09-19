# Storage design

AI Office separates authoritative project state, global reusable memory, and regenerable code intelligence. See the [architecture overview](overview.md) for the system-level boundary.

## Runtime, import, and integration roots

The linkable `ai-office` entry point selects a stable runtime data home from
`AI_OFFICE_HOME` or, by default, `~/.ai-office`. Program location and current
repository do not select user authority. The source bin requires explicit
user-mode opt-in, including `bun link`. The `dev:daemon`/`dev:cli` scripts and
their legacy aliases select the source checkout's `.ai-office`, independent of
caller cwd; global memory is isolated in the same directory. The normal active
database path is:

```text
<runtime-home>/project.sqlite
```

The current path model has three independent roles:

- the **runtime data root** above owns the daemon database, socket, onboarding drafts,
  and generated Markdown;
- the **source/import root** is the canonical repository path scanned by
  `project:import <path>` and recorded in the current runtime database;
- the **integration root** is supplied separately through `client:* --root` and
  contains the optional project instruction contract plus the shared guide,
  host pointers, and repository skills inspected or managed by that workflow.

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
- tasks, roles, agents, agent runs, task locks, and run events; each run created
  after migration `0030` carries an immutable, non-secret model routing record
  (`unrouted` or the resolved policy/profile/model), runtime-local and excluded
  from portable snapshots;
- pinned pipeline runs, ordered stage state, assignments, workflow decisions,
  reasoned overrides, and agent/action pipeline bindings;
- pricing, budgets, reservations, normalized usage, and costs;
- milestones, requirements, ADR records, reviews, and governance decisions;
- resources, capability grants, action requests, simulations, approvals, and execution records;
- append-only audit events.
- immutable portable project revisions plus local head/base metadata.
- append-only, runtime-local retrieval provenance for optional project memory
  (`agent_run_memory_retrieval`, `agent_run_memory_reference`): references,
  content digests, separate SHA-256 digests of the task-derived and the exact
  provider-sent query, and outcomes; never memory bodies or query text;
  excluded from portable snapshots.

The daemon creates, opens, and migrates this database before it opens its Unix
socket. Project migrations are versioned under `migrations/project/` and tracked
by `schema_migration`. The standalone project migration command targets the same
current-working-directory path. The database is not a cache: deleting it loses
the operational history for every project recorded in that runtime.

## Project-authority ports and migration inventory

`ProjectStorage` is the application-level composition of the repository ports
and transaction runner backed by one project authority. `ProjectStorageBootstrap`
in `packages/storage-bootstrap` is the single provider-selection and
construction boundary. It owns provider configuration, connection opening,
provider migrations, adapter composition, capability reporting, and close
lifecycle. Runtime command execution and daemon bootstrap consume its result
through application-facing repository ports; they do not construct provider
adapters directly.

SQLite remains the default and only complete Runtime authority. PostgreSQL is
selectable with `AI_OFFICE_STORAGE_PROVIDER=postgres` and
`AI_OFFICE_POSTGRES_URL`, and its migration runner reuses the SQL files under
`supabase/migrations/`. PostgreSQL currently exposes only `ProjectRepository`,
`TaskRepository`, `TaskRequirementRepository`, and `TransactionRunner`. The
bootstrap reports those capabilities without fabricating missing repositories;
requiring complete Runtime authority therefore fails with
`StorageProviderIncompleteError` and lists the missing capabilities. There is
no SQLite fallback or mixed-provider authority.

| Port                                | Classification                                              | Migration notes                                                                            |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ProjectRepository`                 | simple CRUD                                                 | Project aggregate identity and ownership checks remain application rules.                  |
| `ProjectProfileRepository`          | simple CRUD; runtime-local/non-portable data                | Local source paths and scans need an explicit Pro representation.                          |
| `OfficeManifestRepository`          | append-only/event                                           | Manifest revisions are versioned authority.                                                |
| `TaskRepository`                    | simple CRUD                                                 | The next vertical slice must preserve task lifecycle validation.                           |
| `TaskRequirementRepository`         | conditional/concurrent mutation                             | Link/unlink ownership and idempotency are contract behavior.                               |
| `AgentRuntimeRepository`            | conditional/concurrent mutation; runtime-local/non-portable | Locks, admission fences, run transitions, and append-only run events are safety-sensitive. |
| `PipelineRunRepository`             | transactional aggregate                                     | Stage ordering, assignments, and transition constraints are aggregate behavior.            |
| `GovernanceRepository`              | transactional aggregate; append-only/event                  | Governance events and final review decisions require atomicity.                            |
| `CostRepository`                    | transactional aggregate; conditional/concurrent mutation    | Reservations, usage, and charge accounting must retain concurrency guarantees.             |
| `CapabilityPolicyRepository`        | conditional/concurrent mutation; runtime-local/non-portable | Capability policy remains authoritative in AI Office.                                      |
| `ControlledExecutionRepository`     | conditional/concurrent mutation; runtime-local/non-portable | Approval and execution state transitions must not be replayed.                             |
| `AuditEventRepository`              | append-only/event; runtime-local/non-portable               | Audit records remain sanitized and append-only.                                            |
| `RepositoryIdentityRepository`      | conditional/concurrent mutation; runtime-local/non-portable | Checkout identity and local path association are not portable authority.                   |
| `ProjectStateRepository`            | transactional aggregate                                     | Portable semantic state is the preferred Lite-to-Pro migration boundary.                   |
| `MemoryReferenceRepository`         | simple CRUD                                                 | Project-scoped references remain separate from global memory bodies.                       |
| `ProjectMemoryProvenanceRepository` | append-only/event; runtime-local/non-portable               | Retrieval provenance is excluded from portable snapshots.                                  |
| `OperationalReadRepository`         | simple CRUD/read-side query                                 | Read models query project authority and are not an independent source of truth.            |
| `TransactionRunner`                 | transactional aggregate boundary                            | PostgreSQL must use server-side connection transactions, not a PostgREST abstraction.      |
| `JobOutboxRepository`               | append-only/event; runtime-local/non-portable               | The outbox is project authority for queue wake-ups, while SQLite remains authoritative.    |

The following are intentionally outside this first project-storage boundary:
`GlobalMemoryRepository` backed by `global.sqlite`, the optional external
`ProjectMemoryProvider`, and the future regenerable code index backed by
`index.sqlite`. They must not be merged into the first PostgreSQL project
authority implementation.

### SQLite transaction migration hotspots

These existing SQLite transaction boundaries are deliberately unchanged. A
PostgreSQL adapter must account for them explicitly rather than assuming that
repository methods are independent statements:

| SQLite implementation                                         | Current boundary                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `database/sqlite-transaction-runner.ts`                       | `run()` uses `BEGIN IMMEDIATE` and owns commit/rollback.                                                          |
| `repositories/sqlite-agent-runtime.repository.ts`             | `admitQueuedRun()`, `saveRun()`, and `acceptWorkerResult()` use `database.transaction()`.                         |
| `repositories/sqlite-governance.repository.ts`                | `immediate()` uses `BEGIN IMMEDIATE`; milestone, requirement, ADR, and review saves use `database.transaction()`. |
| `repositories/sqlite-cost.repository.ts`                      | `immediate()` uses `BEGIN IMMEDIATE` for reservation/usage accounting.                                            |
| `repositories/sqlite-project-profile.repository.ts`           | `removeSource()` uses `database.transaction()`.                                                                   |
| `repositories/sqlite-memory-reference.repository.ts`          | `saveReference()` uses `database.transaction()`.                                                                  |
| `repositories/sqlite-project-memory-provenance.repository.ts` | `recordRetrieval()` uses `database.transaction()`.                                                                |
| `database/migrate.ts`                                         | Migration application is transactional; this is a schema-runner concern, not a repository contract.               |

`sqlite-global-memory.repository.ts` also contains an internal transaction,
but it belongs to `global.sqlite` and is intentionally excluded here. These
hotspots are documentation for subsequent adapter work; this boundary PR does
not rewrite them.

The first PostgreSQL foundation now implements `ProjectRepository`,
`TaskRepository`, `TaskRequirementRepository`, and `TransactionRunner` in the
`storage-postgres` package. Shared repository contracts run against both
adapters; PostgreSQL integration tests use the SQL in `supabase/migrations/`
against a real server. Migration authority is serialized by a transaction-scoped
PostgreSQL advisory lock, so concurrent bootstrap applies each ordered migration
once before committing. The migration runner is intentionally small and
idempotent for local integration setup and future Supabase deployment.

`core.requirement` is supporting schema for `TaskRequirementRepository` linkage,
not a migrated `RequirementRepository`. It currently carries the SQLite scalar
fields `id`, `project_id`, `requirement_key`, `title`, `description`,
`status`, `created_at`, and `updated_at`. `milestone_id` is intentionally
deferred because this slice does not introduce the `Milestone` aggregate or its
ownership constraints; a future `RequirementRepository` migration must add that
field with the corresponding milestone ownership model before PostgreSQL can claim
`RequirementRepository` parity. The reverse
`task_requirement_requirement_idx(requirement_id, task_id)` index is present for
future requirement-first lookup without expanding the current repository API.

The PostgreSQL adapter uses the server-side `postgres` driver. A shared
`PostgresClient` owns the pool and an async transaction-session context;
`PostgresTransactionRunner` reserves one driver transaction, and every
repository built from that client routes queries through the transaction-bound
session while the callback is active. Each context also has an explicit lifetime
token; escaped async work fails with a deterministic infrastructure error after
commit or rollback instead of falling back to the pool or using an ended session.
Normal awaited concurrency remains independent across top-level transactions, and
nested transactions preserve the application-visible
`TransactionAlreadyActiveError` behavior. No Runtime composition or provider
selection uses this package yet.

The next storage slice is centralized Runtime storage-provider/bootstrap
selection, followed by incremental migration of the remaining project
repositories. `global.sqlite`, governance beyond the requirement seed needed
by this slice, audit, capabilities, agent runtime, pipelines, and the code
index remain outside this PR. Runtime and daemon remain SQLite-only; this
PostgreSQL package is not Runtime authority.

## `global.sqlite` — implemented durable reusable memory

`<runtime-home>/global.sqlite` stores immutable versions of reusable roles and
patterns plus lessons. A role `key` identifies one logical role, `(id, version)`
identifies an exact revision, and creating a newer revision preserves both the
stable ID and every older revision. Deprecation is revision-specific and does
not delete history. The Runtime-backed CLI causes the persistent host to open and migrate the database lazily
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

## External project memory — optional, not authoritative

An optional provider such as CairnKeep keeps durable contextual memory outside
AI Office. AI Office does not open, migrate, back up, purge or uninstall that
store, and it is never read back as project state. The memory identity derives
from the portable `repositoryId`, not a path, and is used as a CairnKeep named
scope. `global.sqlite` keeps its M7 meaning. `runtime:purge` and repository
uninstall do not touch provider stores; purge removes the retrieval provenance
with `project.sqlite`. See [project memory](../development/project-memory.md).

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
manages `<integration-root>/AI-OFFICE.md`, minimal host instruction files, and
repository-local skills under `.agents/skills` and `.claude/skills`. These are
integration artifacts governed by their own ownership rules, not database state
or runtime authorization.

The normal install lifecycle derives that instruction contract in memory from
the current office manifest and project identity. It writes the project binding
plus ownership-safe guide, pointer, and skill changes, but does not persist a
second authoritative instruction contract. The JSON contract file remains an
optional input for direct machine-oriented `client:*` workflows.

`project:backup` creates a strict, checksummed `.aioffice` snapshot of the
documented, referentially closed portable subset and rejects live agent runs,
active pipelines, and unexpired locks while preserving task lifecycle state;
`project:restore` validates and restores it through the daemon.
The format contains semantic records rather than SQLite pages and never carries
absolute source/worktree paths or local Git remotes, secrets, machine authority,
capabilities, controlled-action approvals/executions, audit payloads, global
memory, or active execution state. See
[Project portability and synchronization](../development/project-portability-and-sync.md).

Portable revisions in `project.sqlite` are semantic-state observations, not
proof that an archive path was published. The no-clobber archive write happens
after the short SQLite transaction; failure leaves the observation reusable by
an identical retry and does not create a false cross-resource transaction.

A full runtime filesystem backup remains a separate disaster-recovery concern
and should be taken after a clean daemon shutdown so SQLite and its WAL are
consistent. Re-running `project:import` only rebuilds detected repository facts;
it is not portable restore. Integration-root files and `global.sqlite` retain
their separate ownership-aware backup decisions.

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

Exported `.aioffice` files are user-owned paths outside runtime purge and
repository uninstall. Neither lifecycle follows stored provenance or archive
paths to remove them.
