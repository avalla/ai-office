# Final SurrealDB evaluation

Status: completed experimental evaluation. SurrealDB remains outside Runtime
storage composition; this report does not authorize production adoption.

## Executive summary

The three-stage evaluation found useful graph provenance queries in the
`AgentKnowledgeStore` experiment. The selected `ProjectStorage` subset passed
all 11 shared contracts unchanged, but its Project, Task, and
TaskRequirement adapters were more ceremonial than the current relational
implementations. The concurrency experiment showed that single-record claim,
lease, expected-version, and stale-owner predicates can be expressed as atomic
SurrealQL updates. Same-record concurrent transactions detect write conflicts;
disjoint writes after shared reads can both commit, so cross-record invariants
need explicit locking or a common coordination record.

The evidence supports **B — investigate/use SurrealDB as AgentKnowledgeStore
only**. Graph provenance is a demonstrated fit. Broader structured authority
would add adapter work and still needs multi-record admission/acceptance
characterization; the primitive tests do not establish Runtime parity.

No production database, Runtime provider, data, or infrastructure was changed.

## Experiment scope

| Stage | Evaluated | Not evaluated |
| --- | --- | --- |
| PR #64 | Experimental `AgentKnowledgeStore`, graph provenance, scoped retrieval, cycle checks, immutability | Runtime authority, vector/RAG, concurrent writes, production operations |
| PR #65 | `projects`, `tasks`, `taskRequirements`, ordinary transaction behavior | Runtime, leases, fencing, queue/outbox, production parity |
| PR #3 | Database primitives for atomic claim, leases, fencing, expected-version updates, terminal state, transaction anomalies, and PR #65 races | Complete `AgentRuntimeRepository`, `ProjectStorage`, multi-row admission authority, production migration |

The experiments use the existing `surrealdb@2.0.8` SDK and the repository's
pinned `surrealdb/surrealdb:v3.3.0` CI server. The concurrency test server used
the in-memory engine. Each pair of competing operations used distinct Surreal
client connections to the same database and a barrier immediately before the
operations. No application mutex or serial test calls model the races.

## Concurrency invariant matrix

This is the inspect-first comparison of the current SQLite and PostgreSQL
implementations. The mechanisms below are from the current ports, adapters, and
migrations.

| Operation | Protected state | SQLite mechanism | PostgreSQL mechanism | Failure prevented | Required atomicity |
| --- | --- | --- | --- | --- | --- |
| Acquire/reclaim task lock | One lease per task and run | One `INSERT ... ON CONFLICT(task_id) DO UPDATE ... WHERE expires_at <= acquired_at RETURNING`; task ID is the primary key and run ID unique | Same conditional upsert, plus tenant-scoped eligible-run predicate | Two active owners; lease reassignment before expiry | Claim or reclaim is one statement |
| Admit queued run | Run status/event, task lease, task/agent/role/pipeline authority | Transaction reads queued run and all observed authority, then writes `preparing` or `cancelled`, event, and possibly deletes lock | Transaction locks task, agent, role, lease, pipeline rows ordered by ID, stage rows ordered by pipeline/index/ID, then locks/rechecks queued run, updates, appends event, and releases invalid lock | Duplicate admission; using changed or expired authority | Run, event, and invalid-lock release commit together |
| Accept worker result | Running run, execution snapshot, task/agent/role state, task lease, pipeline/stage binding | Transaction checks composite snapshot and task-lock `run_id`, then conditionally updates run and appends event | Ordered row-lock boundary followed by one conditional `UPDATE ... FROM` rechecking the full authority fence; append event in transaction | Stale worker publishing result after lease/authority changes | State and event commit together |
| Save run transition | Run lifecycle and event history | Transaction reads current status/time, validates transition in adapter, performs status/time CAS, appends event; append-only event triggers | Transaction `SELECT ... FOR UPDATE`, adapter validates, conditional status/time update, append event; append-only trigger | Lost update, regression, terminal resurrection, duplicate transition | Run update and event commit together |
| Pipeline transition | Pipeline version and stage snapshot | `UPDATE ... WHERE version = expected`; trigger requires exactly `old + 1`, monotone timestamp; method itself has no transaction wrapper around stage writes | Repository transaction, `UPDATE ... WHERE version = expected`, validates full stage count, updates stages | Stale pipeline writer and lost update | Parent version and all stage writes together; SQLite relies on caller transaction |
| Governance status change | Status plus governance event | `BEGIN IMMEDIATE`, status conditional update, event append | Transaction, tenant predicate, conditional status update, event append | Stale status transition without its event | State and event commit together |
| Decide review | Pending review and one approval | `BEGIN IMMEDIATE`, read pending status, insert approval; unique `approval.review_id` | Transaction with tenant check and review `SELECT ... FOR UPDATE`, insert approval; unique `approval.review_id` | Two decisions for a review | Review decision and approval/event commit together |
| Append/dispatch outbox job | Dedupe key and one-way dispatch state | Unique `(project_id, dedupe_key)`, conditional dispatched/failed updates, immutability triggers | No `JobOutboxRepository` exists in the current PostgreSQL adapter package | Duplicate intent and repeat dispatch-state mutation | Dedupe insert is one statement; caller transaction is needed to couple intent with originating state |
| Active pipeline/stage uniqueness | One active pipeline per task and one active stage per pipeline | Partial unique indexes plus lifecycle triggers | Partial unique indexes and shape/identity triggers | Duplicate active runs/stages and invalid direct transitions | Constraint checked in each write transaction |

There is no persisted monotonically increasing fencing counter in the current
Runtime. `WorkerAuthorityFence` is a composite snapshot (run update time and
execution provenance, task/agent/role snapshots, pipeline version/stage), and
the task lease identifies its owner by `run_id` and expiry. PostgreSQL serializes
those rows in a documented order; SQLite serializes writes in its transaction
model and rechecks conditional state.

## PR #64 — AgentKnowledgeStore evidence

- The graph represented existing Agent, Run, Task, Memory, Decision, and
  SourceReference concepts with typed provenance edges. Native traversal made
  the fixed Memory → SourceReference → Run → Task/Agent provenance trace one
  query; `AFFECTS` and `DEPENDS_ON` directly express the existing queries.
- Native traversal was useful for these explicit paths. The experiment does
  not establish that arbitrary graph queries are simpler than relational
  queries.
- Knowledge IDs and source IDs are immutable by adapter transaction checks;
  editing content requires a new ID. Schema types and unique indexes do not
  enforce field immutability against a direct database writer.
- Supersession and dependency cycle checks use recursive queries in the write
  transaction, reject self/cycles, and fail closed at 256 hops. The database
  does not enforce acyclicity independently of the adapter.
- Every record and relation stores tenant/project identifiers; scoped keys,
  adapter predicates, and returned-record checks enforce scope. A shared
  database credential can still query another tenant directly; this is not
  PostgreSQL RLS or a same-credential boundary.
- Retrieval is deterministic case-insensitive substring search, optionally
  agent-filtered; current-decision search traverses task edges and omits
  superseded decisions. Vector search and RAG were not evaluated.
- The fixed provenance trace benefits from native traversal. Cycle validation,
  scope agreement, and immutability remain adapter logic, so the graph model
  also adds transaction/query templates and validation.

## PR #65 — structured ProjectStorage evidence

- The selected subset was `projects`, `tasks`, and `taskRequirements` plus its
  transaction runner. All **11 shared `ProjectStorage` contract cases were
  reused unchanged**; zero were impossible to reuse. Seven Surreal-specific
  tests covered trusted-tenant denial, rejected-link preservation, missing
  parent rollback, typed relation enforcement, lifecycle rejection, and
  explicit subset composition.
- Ordinary commit and rollback passed through the shared transaction tests.
- The database enforces schema field types, globally unique external IDs,
  typed relation endpoint tables, task ownership uniqueness, and unique
  task/requirement relation pairs. Adapter predicates enforce tenant/project
  scope and project agreement across existing records and edges. Domain
  constructors enforce task lifecycle validity.
- Project updates preserve `createdAt`, and task updates preserve
  `projectId`/`createdAt`, through adapter write shape; the database does not
  reject direct-writer mutation of those historical values.
- `TaskRepository.save` reads the project before the task/relation write.
  `TaskRequirementRepository.link` reads task, requirement, and existing edge
  before `RELATE`. Those reads and writes use the same transaction but PR #65
  did not test concurrent writers.
- The three selected repositories were more ceremonial than the existing SQL
  approach: Project uses transaction-scoped conditional update/create; Task
  checks and writes a project ownership edge; TaskRequirement performs three
  reads before an edge write and sorts relation results in the adapter.

The PR #65 source measurements are preserved here:

| Repository | Adapter LOC | Schema LOC | Validation LOC | SurrealQL statements/templates | Explicit transaction sites | Shared cases |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| ProjectRepository | 61 | 50 | 0 | 5 statements / 2 templates | 1 | 3 |
| TaskRepository | 86 | 50 | 2 | 11 statements / 3 templates | 1 | 4 |
| TaskRequirementRepository | 179 | 50 | 3 | 8 statements / 8 templates | 1 | 1 |
| Transaction runner/context | 59 combined | — | 0 | 0 raw statements; SDK begin/commit/cancel | 1 | 3 |

The ProjectStorage subset schema has 37 repeatable DDL statements. These are
counts from PR #65's report, not new measurements in PR #3.

## PR #3 — concurrency and fencing evidence

The experiment is an explicitly experimental `SurrealConcurrencyExperiment`;
it does not implement or claim `AgentRuntimeRepository` or `ProjectStorage`.
It uses one record per protected resource and tests predicates on those named
records.

| Invariant | PostgreSQL mechanism | SurrealDB mechanism | Database atomic? | Adapter validation? | Observed result | Implementation complexity |
| --- | --- | --- | --- | --- | --- | --- |
| Atomic task claim | Conditional `INSERT ... ON CONFLICT ... WHERE expires_at <= acquired_at` plus unique task/run keys | One conditional `UPDATE ... WHERE owner is empty or lease expired`, incrementing the generation on that record | Yes; one SurrealQL statement, with same-record write conflict detection | Maps no returned row or recognized conflict to `false` | 40/40 two-client races had one winner, one loser, and stored owner/fence matched | One conditional statement plus conflict normalization |
| Active lease and renewal | `UPDATE ... WHERE run_id = owner`, active status and `expires_at > now`; reclaim only after expiry | Conditional update checks owner, fence, unexpired timestamp; claim checks expiry; all timestamps injected | Yes; one update per transition | No read-before-write | Across 40 sequences owner renewal succeeded, non-owner renewal failed, active reclaim failed, expiry reclaim succeeded | Three conditional templates; controlled clock |
| Stale-owner fencing | Result `UPDATE ... FROM` rechecks task-lock owner, lease, run snapshot, and authority rows under deterministic row locks | Mutation is one `UPDATE` checking owner, generation, lease time, and running state | Yes for the named resource record | No application lock; predicate values come from the caller | Across 40 sequences stale Worker A using fence N could not overwrite Worker B at N+1 | Five predicate terms in one update; generation is an experiment field, not a current Runtime column |
| Expected version | `UPDATE ... WHERE version = expected` inside repository transaction | `UPDATE ... WHERE version = expected_version`, then `version += 1` | Yes; one record update | No pre-read | 40/40 competing pairs accepted one writer; stored version was 6 from 5 | One conditional statement |
| Terminal state | Adapter lifecycle graph + `FOR UPDATE`/old-status-and-time conditional update; terminal status has no allowed outgoing transition | One update requires expected current status and a nonterminal current state | Yes; one record update | The test states encode current lifecycle and do not implement the complete domain graph | 40/40 stale `running → queued` transitions failed after `running → completed` | Lifecycle predicate remains explicit in the adapter query |
| Same-record lost update | PostgreSQL row lock/CAS; repository transaction | Two independent SDK transactions read/update the same record; commit conflict detected and surfaced | Yes for same-key writes under snapshot isolation | Adapter must handle/propagate conflict | 40/40 pairs had one commit and one transaction-conflict rejection; stored value advanced once | SDK `isRetryableConflict` alone did not classify the v3.3.0 response in this run; a narrow message fallback was needed |
| Write skew | PostgreSQL `SERIALIZABLE` or explicit locks on shared authority rows; current agent admission uses ordered row locks | Snapshot transaction plus `FOR UPDATE` on every named coordination record; ordinary reads do not protect a predicate | Not for disjoint writes after shared reads; explicit named-row locks create a conflict | Adapter/schema must identify and lock a common record set in deterministic order; no predicate lock is tested | 40/40 ordinary disjoint-write pairs both committed; 40/40 pairs locking both named rows had one conflict and retained one active record | Requires explicit coordination beyond a read predicate |
| Concurrent Task save | SQL unique IDs/FKs and transaction boundary | Surreal unique external-ID and unique task-owner relation constraints | Yes for identity/ownership constraints; overall repository transaction | Pre-read still provides validation/result shape | 40/40 cross-project duplicate-ID pairs had one completed save, one rejected save, and one persisted owner | DB prevents dual ownership; loser surfaces a write error rather than a normalized conflict result |
| Concurrent TaskRequirement link | Unique `(in, out)` index and `INSERT ... ON CONFLICT DO NOTHING` | Unique relation-pair index and transactional `RELATE` after reads | Yes for one relation pair | Three validation reads before relation write | 40/40 duplicate-link pairs produced one `true`, one rejected write, and one stored edge | Safe against duplicate persisted edges; not idempotent result parity under races |

### Race strategy and counts

Each resource race used two independent Surreal clients connected to the same
namespace/database. The test barrier releases both attempts together. Test
connections, schema setup, and data preparation happen before the barrier.
Times are supplied directly; no sleeps or wall-clock lease expiry is used.

| Case | Repeated work |
| --- | ---: |
| Claim race | 40 two-client races |
| Lease renewal/expiry/reclaim/stale mutation | 40 controlled-time sequences |
| Expected-version CAS | 40 two-client races |
| Terminal transition | 40 stale-transition sequences |
| Lost update | 40 two-transaction same-record races |
| Write skew without locks | 40 two-transaction disjoint-record races |
| Write skew with `FOR UPDATE` on both coordination records | 40 two-transaction disjoint-record races |
| PR #65 Task save | 40 two-client ownership races |
| PR #65 TaskRequirement link | 40 two-client duplicate-link races |

The claim uses one conditional SurrealQL update. A loser may receive the
database's transaction conflict rather than an empty update result; the
experiment maps the server conflict message or empty result to `false`, and
rethrows other errors. The pinned 3.3.0 server response was not recognized by
the SDK 2.0.8 `isRetryableConflict` predicate in this environment, so a narrow
message match was required. This is adapter ceremony and a version-sensitive
error-classification limitation. No conflict is silently retried.

### Transaction isolation characterization

On the pinned server and in-memory engine, dirty/partial transaction effects
were not observed; ordinary transaction rollback had already passed the PR #65
contracts. Same-record transaction writes did not silently overwrite: the
conflicting transaction failed. Disjoint writes after both transactions read
the same two records both committed, demonstrating write skew when invariants
depend on multiple records. A second experiment locked both named coordination
records with `FOR UPDATE`: one transaction then conflicted and the other left one
record active in all 40 races. This demonstrates a usable explicit coordination
primitive for this fixed record set, not predicate locking or automatic
protection. The test does not characterize every storage engine or deployment
topology. SurrealDB describes its transaction model as snapshot isolation and
specifies `FOR UPDATE` for named-record protection; the observations are
consistent with that model.

### PR #65 read-before-write races

`TaskRepository.save` is protected against dual task identity/ownership by the
unique external-ID key and unique task-owner edge, but the losing concurrent
save rejects rather than returning a normalized conflict result. The
adapter's project check alone would have a time-of-check/time-of-use window;
the database identity and relation constraints are the safety backstop.

`TaskRequirementRepository.link` likewise has a unique pair index. The
concurrent loser rejects after both calls pass validation reads and attempt
`RELATE`; the edge table remains singular. This is a TOCTOU error-path
limitation, not a duplicate-edge integrity failure. The ordinary duplicate
contract still returns `false` when its pre-read sees the existing edge.

## Security and tenant isolation

SurrealDB schema types and unique keys are database-enforced. PR #65's tenant
and project filters are trusted adapter context, not database row-level
security. Task/project/requirement agreement, current lifecycle validation,
composite worker authority, and cross-record fence rules are adapter checks.
The connection credential can query outside a repository's tenant scope.
Nothing in these experiments changes the current PostgreSQL tenant boundary or
claims same-credential isolation.

## Implementation complexity

PR #3 source counts use physical lines, including imports, comments, and blank
lines. “Templates” counts literal SurrealQL templates including schema and
namespace/database DDL. Conditional-write templates are statements with an
owner, expiry, version, status, or fence predicate. No production persistence
abstraction was introduced.

| Measurement | PR #3 result |
| --- | ---: |
| Experiment adapter LOC | 220 |
| Schema LOC | 7 DDL statements inside the adapter file |
| Explicit TypeScript business validation LOC | 0; the narrow conflict classifier is 8 lines |
| SurrealQL statement/template count | 16: 7 schema DDL, 7 probe operations, 2 namespace/database definitions |
| Adapter transaction call sites | 0 |
| Conditional-write templates | 5 |
| Adapter read-before-write sequences | 0 |
| Concurrency-specific integration tests | 7 cases |
| Race/lifecycle repetitions | 40 per repeated case |

The concurrency adapter is smaller than the PR #65 subset but deliberately
does not perform multi-record admission/acceptance. The named-record lock primitive worked in this one fixed-set test, but all Runtime writers still need a shared lock set and order. PR #65's 326 LOC across the
three selected repositories plus the 59-LOC transaction runner/context were
measured independently. Counts are not a score; the SQL implementations remain
the behavioral baseline.

## Operational comparison

The current AI Office authority remains SQLite on the local daemon, with a
PostgreSQL/Supabase adapter and migration path. PR #64–#3 exercised neither a
production-like deployment nor persistent SurrealDB data.

| Area | SurrealDB evidence | Current PostgreSQL/Supabase architecture |
| --- | --- | --- |
| Local development | Pinned Docker service worked for the three integration suites; local tests need a running server and four separate clients for race tests | SQLite tests are file-local; PostgreSQL contract tests use the existing local Supabase/PostgreSQL test service |
| Single node | Officially documented single-node RocksDB server is an available self-hosted model; this experiment used memory storage only | Current local daemon uses embedded SQLite; PostgreSQL is the server-backed alternative |
| Persistent storage | Not exercised. A persistent filesystem/backend and process recovery were not tested | SQLite and current PostgreSQL suites use persistent database engines; normal project DB migrations are already established |
| Backup/restore | Not exercised. Official CLI supports logical `surreal export`/`surreal import`; a full restore and application verification remain unproven here | Existing Supabase/PostgreSQL backup and restore operations are outside this experiment; current SQLite project backup/restore is a product workflow |
| Schema upgrades | PR #64/#65 use repeatable `DEFINE ... IF NOT EXISTS`; this stage added seven independent probe definitions. No Surreal version-to-version schema upgrade was tested | Versioned SQL migrations and upgrade tests are part of the existing PostgreSQL/SQLite architecture |
| Server upgrades | No upgrade performed. Self-hosted operation requires backup, version review, restart/migration coordination, and smoke tests; v3.3.0 has server-side data migration behavior | Supabase manages its database service lifecycle; application migrations remain explicit and tested |
| Health/readiness | CI already gates the service on `/health`; `/ready` can distinguish completed startup on v3.2+; not integrated into AI Office runtime health | PostgreSQL readiness is managed by local/Supabase infrastructure and current daemon/provider health paths |
| Observability | Current docs provide `/metrics` and OTLP options; this experiment added no dashboards, alerting, or Runtime instrumentation | PostgreSQL/Supabase observability uses the existing provider and local service tooling; no apples-to-apples workload comparison was run |
| Failure recovery | Transaction rollback and same-key conflict were tested; server crash recovery and disk recovery were not | SQLite/PostgreSQL have broader production migration/recovery tests in the current repository, though those tests do not establish a whole-system DR rehearsal |
| CI ergonomics | Existing Surreal workflow runs the pinned in-memory service; concurrency adds about 3 seconds locally for all 7 cases/40 repetitions | SQLite contract suite runs without external services; PostgreSQL suites use the existing local service or CI job |
| Resource footprint | No matched benchmark. The in-memory test container is not a meaningful production comparison | No matched benchmark |
| Production maturity | A documented Community single-node RocksDB path exists; horizontal self-hosted HA requires the separately operated distributed-storage/Enterprise route, or a managed service. The project did not evaluate support, backup objectives, or incident response | PostgreSQL/Supabase is already an implemented and tested AI Office adapter, with tenant predicates/RLS and forward migrations |

Official operational references: [self-hosted deployment models](https://surrealdb.com/docs/manage/self-hosted/deployment-models),
[backup and recovery](https://surrealdb.com/docs/manage/self-hosted/backups-and-recovery),
[upgrades and patching](https://surrealdb.com/docs/manage/self-hosted/upgrades-and-patching),
[health and readiness](https://surrealdb.com/docs/reference/rest-api/http-protocol),
[monitoring and observability](https://surrealdb.com/docs/manage/self-hosted/monitoring-and-observability),
[metrics](https://surrealdb.com/docs/manage/observability/metrics), and
[transactions](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions).
These references describe product capabilities; only the in-memory pinned-server
behavior stated above was observed in this experiment.

## Where SurrealDB helps

- Graph relation records give provenance and task relationships an explicit
  typed edge representation.
- Fixed provenance traversal and per-record atomic conditional updates were
  concise and behaved as required in the tests.
- Same-record write conflicts prevent silent lost updates under the tested
  snapshot transactions.
- The existing server image and SDK made the opt-in integration tests
  reproducible in CI without Surreal Cloud.

## Where SurrealDB adds ceremony

- The Project/Task/TaskRequirement subset needs explicit relation schemas,
  tenant predicates, parent checks, and read-before-write validation beyond
  the existing relational writes.
- Concurrent duplicate operations can reject on database conflict even when
  the persisted invariant is safe; the adapter must normalize this if callers
  require a stable boolean contract.
- Runtime admission and result acceptance depend on multiple authority rows.
  Snapshot isolation does not protect a read predicate or disjoint record
  writes by itself; every invariant needs named coordination rows and conflict
  handling.
- Error classification for the tested 3.3.0 conflict response required a
  message fallback despite the SDK's conflict helper.
- Schema upgrade, persistent-storage recovery, backup restore, and production
  monitoring procedures were not exercised.

## Remaining unknowns

- Whether `FOR UPDATE` on a common task/pipeline coordination row is a clean
  replacement for the PostgreSQL admission lock order under real competing
  multi-row authority writers.
- Whether every authority writer can consistently name and lock the same
  records, including task, agent, role, lease, pipeline, and stages, without
  predicate or phantom gaps.
- Transaction-conflict error shape and retry classification across supported
  server/SDK combinations and persistent backends.
- Persistent RocksDB/SurrealKV behavior under restart, backup restore, disk
  pressure, and server upgrade; CI used only the pinned in-memory service.
- Whether production telemetry, operating procedures, recovery objectives,
  and support model meet AI Office needs.
- Runtime-level concurrent admission, cancellation, acceptance, outbox
  delivery, and governance transitions have not been implemented or tested on
  SurrealDB.

## Validation caveat

The local `bun run check` passed skill validation, typecheck, and lint, then
failed in seven daemon CLI e2e assertions about project binding and model-check
output; the other 1,619 tests passed. The same four e2e files passed 14/14 in a
clean detached worktree at the PR #65 merge commit, and PR #65's GitHub `validate`
check was green. The local failure is therefore checkout/environment-sensitive;
its cause was not changed or resolved in this experiment. The pre-existing
`.ai-office/` directory was preserved and excluded from this PR.

## Final recommendation

**B — investigate/use SurrealDB as AgentKnowledgeStore only.**

The native graph traversal produced concrete value for provenance, scoped
relationships, and current-decision lookup. The structured subset passed its
shared contracts but was more ceremonial than SQL, and its two validation-read
operations showed rejected loser outcomes under concurrency. Atomic single-row
claims, fences, and versions worked. Snapshot isolation allowed the tested
cross-record write skew without explicit locks; `FOR UPDATE` prevented that
fixed two-record anomaly, but current Runtime authority spans multiple records
and its shared lock set remains unproven. These results justify keeping the
graph/knowledge investigation distinct from authoritative Runtime storage.

This recommendation is not production authorization. Any SurrealDB production
use requires a separate ADR, milestone, operational rehearsal, and explicit
acceptance of its tenant, migration, recovery, and conflict-handling boundaries.
