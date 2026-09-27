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
SurrealQL updates. The tested same-record transactions detected write conflicts;
disjoint writes after shared reads both committed. Protecting this cross-record
invariant required explicit named-record coordination in the experiment.

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
| PR #66 | Named-record claim, lease/fence predicates, expected-version/status CAS, terminal non-resurrection, transaction anomalies, and PR #65 contention | Complete `AgentRuntimeRepository`, `ProjectStorage`, multi-row admission authority, production migration |

The experiments use the existing `surrealdb@2.0.8` SDK and the repository's
pinned `surrealdb/surrealdb:v3.3.0` CI server. The concurrency test server used
the in-memory engine. Competing operations use distinct Surreal client
connections to the same database.
Barriers control different boundaries, described below; the lease and status
checks are sequential, controlled-state probes, not races. No application mutex
serializes competing writes.

## Concurrency invariant matrix

This is the inspect-first comparison of the current SQLite and PostgreSQL
implementations. The mechanisms below are from the current ports, adapters, and
migrations.

| Operation | Protected state | SQLite mechanism | PostgreSQL mechanism | Intended invariant | Required atomicity |
| --- | --- | --- | --- | --- | --- |
| Acquire/reclaim task lock | One lease per task and run | One eligible-run `INSERT ... ON CONFLICT(task_id) DO UPDATE ... WHERE expires_at <= acquired_at RETURNING`; task ID is the primary key and run ID unique | Same conditional upsert and eligible-run check, plus tenant scope | Two active owners; lease reassignment before expiry | Claim or reclaim is one statement |
| Admit queued run | Run status/event, task lease, task/agent/role/pipeline authority | Transaction reads queued run and all observed authority, then writes `preparing` or `cancelled`, event, and possibly deletes lock | Transaction locks task, agent, role, lease, pipeline rows ordered by ID, stage rows ordered by pipeline/index/ID, then locks/rechecks queued run, updates, appends event, and releases invalid lock | Duplicate admission; using changed or expired authority | Run, event, and invalid-lock release commit together |
| Accept worker result | Running run, execution snapshot, task/agent/role state, task lease, pipeline/stage binding | Transaction checks composite snapshot and task-lock `run_id`, then conditionally updates run and appends event | Ordered row-lock boundary followed by one conditional `UPDATE ... FROM` rechecking the full authority fence; append event in transaction | Stale worker publishing result after lease/authority changes | State and event commit together |
| Save run transition | Run lifecycle and event history | Transaction reads current status/time, validates transition in adapter, performs status/time CAS, appends event; append-only event triggers | Transaction `SELECT ... FOR UPDATE`, adapter validates, conditional status/time update, append event; append-only trigger | Lost update, regression, terminal resurrection, duplicate transition | Run update and event commit together |
| Pipeline transition | Pipeline version and stage snapshot | `UPDATE ... WHERE version = expected`; trigger requires exactly `old + 1`, monotone timestamp; method itself has no transaction wrapper around stage writes | Repository transaction, `UPDATE ... WHERE version = expected`, validates full stage count, updates stages | Stale pipeline writer and lost update | Parent version and all stage writes together; SQLite relies on caller transaction |
| Governance status change | Status plus governance event | `BEGIN IMMEDIATE`, status conditional update, event append | Transaction, tenant predicate, conditional status update, event append | Stale status transition without its event | State and event commit together |
| Decide review | Pending review and one approval | `BEGIN IMMEDIATE`, read pending status, insert approval; unique `approval.review_id` | Transaction with tenant check and review `SELECT ... FOR UPDATE`, insert approval; unique `approval.review_id` | Two decisions for a review | Review decision and approval/event commit together |
| Append/dispatch outbox job | Dedupe key and one-way dispatch state | Unique `(project_id, dedupe_key)`, conditional dispatched/failed updates, immutability triggers | No `JobOutboxRepository` exists in the current PostgreSQL adapter package | Duplicate intent and repeat dispatch-state mutation | Dedupe insert is one statement; caller transaction is needed to couple intent with originating state |
| Active pipeline/stage uniqueness | One active pipeline per task and one active stage per pipeline | Partial unique indexes plus lifecycle triggers | Partial unique indexes and shape/identity triggers | Duplicate active runs/stages and invalid direct transitions | Constraint checked in each write transaction |

There is no persisted monotonically increasing fencing counter in the current
Runtime. `WorkerAuthorityFence` carries execution provenance, task/agent/role snapshots,
and pipeline version/stage. Acceptance also compares the supplied run update
time. The task lease identifies its owner by `run_id` and expiry. PostgreSQL serializes
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
  transition methods enforce task lifecycle validity; the subset does not
  independently validate lifecycle transitions in direct storage writes.
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
counts from PR #65's report, not new measurements in PR #66.

## PR #66 — concurrency and fencing evidence

The experiment is an explicitly experimental `SurrealConcurrencyExperiment`;
it does not implement or claim `AgentRuntimeRepository` or `ProjectStorage`.
It uses one record per protected resource and tests predicates on those named
records.

| Probe | Mechanism and boundary | Observed result on v3.3.0 memory | What it does not establish |
| --- | --- | --- | --- |
| Claim | One conditional `UPDATE` checks empty owner/expiry and increments fence on one named record | 40/40 invocation pairs returned one `applied`, one `predicate_miss` or `conflict`; stored owner matched the winner and fence was 1 | Runtime task-lock/admission parity; which failure kind every possible schedule produces |
| Lease and fencing | Separate single-record updates check owner, fence, expiry, and (for mutation) running status; injected timestamps | 40 sequences: owner renewal applied; wrong owner and active reclaim missed predicates; expired reclaim applied; old owner mutation missed; new owner mutation applied | Concurrent renewal policy, composite Runtime worker authority, or result/event atomicity |
| Expected version | One conditional update increments version from expected value | 40/40 invocation pairs had one `applied`; version became 6 from 5 | Multi-record pipeline updates or arbitrary competing writers |
| Restricted status CAS | `compareAndSetProbeStatus` permits only `running → reviewing` and `reviewing → completed`, checks expected stored status | 40 sequences applied both permitted changes, rejected `running → queued` while nonterminal, and rejected terminal resurrection through stale or unsupported transitions | Complete AgentRun lifecycle enforcement, events, timestamps, admission, or worker acceptance |
| Same-record lost update | Two SDK transactions both read the record before either increments it | 40/40 pairs had one commit, one recognized conflict, and one increment | Persistent-backend recovery or all transaction anomalies |
| Write skew | Both transactions read the same two active records, then write different records | 40/40 pairs both committed, leaving neither active | Snapshot reads do not protect this cross-record invariant |
| Named-record `FOR UPDATE` | Both transactions register the same two records in the same order and read both before disjoint writes | 40/40 pairs had one commit, one recognized conflict, and one active record remaining | Predicate/phantom protection or Runtime admission/acceptance parity |
| Cross-project Task creation | Both real repository transactions first observe the task absent in their snapshots; then execute the unchanged save script | 40/40 pairs had one fulfilled save and one recognized conflict; one ownership edge and the successful caller's task snapshot persisted | Both project-validation reads finishing before either write, or a general promise that cross-project saves reject |
| Same-project Task creation | Same absent-snapshot boundary; identical task ID/project, differing title, description, priority | 40/40 pairs had one fulfilled save and one recognized conflict; exactly one ownership edge; full successful payload persisted; unrelated project had no task or edge | Last-writer-wins, caller-order preference, merge semantics, or update concurrency for an existing task |
| Duplicate TaskRequirement link | Both real `link()` calls complete parent and absent-edge reads before either `RELATE` is sent | 40/40 pairs had one `true`, one recognized transaction-conflict rejection, one edge; subsequent link returned `false` | Concurrent ProjectStorage boolean-result parity; the generic conflict does not identify the unique relation |

Single-statement probes use database conditional updates rather than an
application read followed by a write. The observed single-record outcomes are
evidence for those predicates. They are not proof that a multi-record Runtime
operation is database-atomic or behaviorally equivalent to either SQL adapter.

### Race strategy and counts

All eight integration cases run their repeated work **40 times**. The combined
transaction case includes 40 same-record lost-update races, 40 unlocked write-skew
races, and 40 named-record `FOR UPDATE` races. Claim and version tests synchronize
invocation only; they do not require both statements to read an old value.
Lease and status tests are explicitly sequential sequences. Times are supplied
directly; no sleep, retry loop, or wall-clock lease expiry selects an outcome.
Barriers have a fail-only deadline to prevent an indefinitely hanging test.

For PR #65 operations, test-local spies intercept `querySurreal` while retaining
the actual repositories, query text, independent clients, and SDK transaction
context. They assert that **both** participants reached the intended boundary:

- `link()`: pause immediately before the actual `RELATE` call. Reaching this
  point proves each call has completed the task, requirement, and absent-edge
  reads. Neither write is sent before both arrive. This deterministically
  demonstrates the validation-read/write window in this duplicate-link case.
- Task save: its project validation, conditional update, and create/relate path
  are one server query. Before that unchanged query, each already-active
  transaction reads the task and asserts it absent, then waits for the other.
  This forces competing creation from absent snapshots. It does **not** prove
  both internal project-validation reads precede either write. Splitting that
  query to claim such a boundary would change the operation being evaluated.

These are test-only interceptors, not new production interfaces or repository
hooks. Earlier invocation-only barriers established concurrent calls, not that
both validation reads had finished; those earlier claims are superseded here.

### Conflict results and classification

Every conditional probe returns one of `applied`, `predicate_miss`, or `conflict`.
A predicate miss is an empty update result; a recognized database conflict is
reported separately. Unexpected database errors propagate unchanged. No probe
silently retries. Claim/CAS callers might treat a conflict as a lost competition,
but a renewal conflict alone is **not evidence of stale worker authority**.
Even a renewal predicate miss can mean invalid requested expiry rather than
ownership loss. Production Runtime integration would require an
**operation-specific conflict/retry policy** with fresh authority checks.

The classifier first uses SDK 2.0.8 `isRetryableConflict()`. It also retains an
exact-message fallback for the pinned server's unstructured error rendering:

```text
There was a problem with the key-value store: Transaction conflict: Write conflict, retry the transaction. This transaction can be retried
```

The fallback previously used substring matching; it now accepts only this full
message on an `Error`. A plain error carrying this response is not recognized
by the SDK helper. Structured `QueryError` responses with
`details.kind = TransactionConflict` are recognized by the SDK, including
commit conflicts observed during hardening. This distinction is version-sensitive
adapter ceremony, not a stable cross-version API contract.

Ten classifier cases cover the structured SDK path, the exact unstructured
response, a generic error, shortened/altered/prefixed/suffixed messages,
`Transaction not found`, a lookalike non-Error object, and null. Five renewal
unit cases distinguish applied/empty results/conflict/unexpected error and
assert no automatic retry. Two cleanup cases prove a failed cancel cannot
replace an original work or commit error.

### Transaction isolation characterization

The shared contracts establish ordinary commit/rollback. There is no dedicated
dirty-read or partial-visibility test, so this evaluation claims neither.
Same-record tests synchronize after both reads; one write transaction commits
and the other conflicts. Disjoint writes after shared reads both commit,
demonstrating the tested write skew. Registering both named records with
`FOR UPDATE` retained one active record in all 40 trials.

The official [transaction documentation](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions)
describes snapshot isolation and `FOR UPDATE` as named-record commit-conflict
registration, rather than PostgreSQL-style blocking row locks. These observations
are consistent with that account. The experiment does not test predicate or
phantom protection, other engines, or deployment topologies. Runtime authority
spans a larger, evolving set of records; all participating writers would need a
complete shared coordination set and deterministic order. The two-record probe
does not establish Runtime admission or worker-result acceptance parity.

### PR #65 integrity versus caller semantics

Task identity and ownership constraints remain database backstops; both creation
tests retain exactly one owner and one complete successful payload. The generic
transaction error does not tell us which record/index caused the conflict, so
we do not attribute rejection to one particular constraint. Save returns void;
these forced creation races produce one fulfilled and one rejected promise.
There is no assertion about which client wins and no last-writer-wins guarantee.
The ordinary contract allows updating mutable fields while preserving the
existing project ID, even when a caller supplies another project ID. A later
save is therefore not evidence of dual ownership or guaranteed rejection.

The shared link contract requires first `true`, existing `false`. The forced
concurrent duplicate-link test demonstrates persisted uniqueness but **does not
have concurrent boolean-result parity**: the loser rejects. Its observed generic
transaction conflict has no relation/index identity, so there is no safe narrow
unique-relation normalization here. Broadly returning `false` would hide
unrelated conflicts. This is additional adapter ceremony before broader
structured-storage adoption. Ordinary duplicate calls still return `false`.

The transaction wrapper now preserves the original error when best-effort
cancellation also fails: the server can already have aborted the transaction,
and cleanup previously replaced the conflict with `Transaction not found`.
No database error is converted to a successful repository result.

## Security and tenant isolation

SurrealDB schema types and unique keys are database-enforced. PR #65's tenant
and project filters are trusted adapter context, not database row-level
security. Task/project/requirement agreement is checked by the subset adapter, while task
lifecycle transitions belong to the domain. Composite worker authority and
cross-record fences exist in the SQL adapters; they are not implemented by
this SurrealDB subset.
The connection credential can query outside a repository's tenant scope.
Nothing in these experiments changes the current PostgreSQL tenant boundary or
claims same-credential isolation.

## Implementation complexity

PR #66 keeps five conditional-write templates: claim, renewal, fenced mutation,
version CAS, and restricted status CAS. Each touches one probe record. Schema
setup uses seven independent `DEFINE ... IF NOT EXISTS` statements; there is no
production composition or migration. The status allowlist and tagged outcomes
are explicit experimental adapter logic.

The PR #65 repository measurements above are historical, not recalculated scores
for this hardening. Its transaction context now additionally preserves original
errors during failed cleanup. Test-only orchestration and 17 unit cases are
separate from those repository measurements. The SQL ports and shared contracts
remain the behavioral baseline.

## Operational comparison

The current AI Office authority remains SQLite on the local daemon, with a
PostgreSQL/Supabase adapter and migration path. PR #64–#66 exercised neither a
production-like deployment nor persistent SurrealDB data.

| Area | SurrealDB evidence | Current PostgreSQL/Supabase architecture |
| --- | --- | --- |
| Local development | Pinned Docker service worked for the three integration suites; local tests need a running server and four separate clients for race tests | SQLite tests are file-local; PostgreSQL contract tests use the existing local Supabase/PostgreSQL test service |
| Single node | Officially documented single-node RocksDB server is an available self-hosted model; this experiment used memory storage only | Current local daemon uses embedded SQLite; PostgreSQL is the partial server-backed adapter, not complete Runtime authority |
| Persistent storage | Not exercised. A persistent filesystem/backend and process recovery were not tested | SQLite and current PostgreSQL suites use persistent database engines; normal project DB migrations are already established |
| Backup/restore | Not exercised. Official CLI supports logical `surreal export`/`surreal import`; a full restore and application verification remain unproven here | Existing Supabase/PostgreSQL backup and restore operations are outside this experiment; current SQLite project backup/restore is a product workflow |
| Schema upgrades | PR #64/#65 use repeatable `DEFINE ... IF NOT EXISTS`; this stage added seven independent probe definitions. No Surreal version-to-version schema upgrade was tested | Versioned SQL migrations and upgrade tests are part of the existing PostgreSQL/SQLite architecture |
| Server upgrades | No upgrade performed. Self-hosted operation requires backup, version review, restart/migration coordination, and smoke tests; this experiment did not exercise server-side data migration | Supabase manages its database service lifecycle; application migrations remain explicit and tested |
| Health/readiness | CI already gates the service on `/health`; `/ready` can distinguish completed startup on v3.2+; not integrated into AI Office runtime health | PostgreSQL readiness is managed by local/Supabase infrastructure and current daemon/provider health paths |
| Observability | Current docs provide `/metrics` and OTLP options; this experiment added no dashboards, alerting, or Runtime instrumentation | PostgreSQL/Supabase observability uses the existing provider and local service tooling; no apples-to-apples workload comparison was run |
| Failure recovery | Transaction rollback and same-key conflict were tested; server crash recovery and disk recovery were not | SQLite/PostgreSQL have broader production migration/recovery tests in the current repository, though those tests do not establish a whole-system DR rehearsal |
| CI ergonomics | Existing Surreal workflow runs the pinned in-memory service; all eight concurrency cases retain 40 repetitions; the job also runs the 17 classifier/result/cleanup unit cases | SQLite contract suite runs without external services; PostgreSQL suites use the existing local service or CI job |
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
  the persisted invariant is safe; specific classification or another
  deliberate strategy is needed if callers require a stable boolean contract.
- Runtime admission and result acceptance depend on multiple authority rows.
  Ordinary snapshot reads allowed the tested disjoint-write anomaly; a
  complete shared coordination set and operation-specific conflict handling
  remain unproven for Runtime authority.
- Unstructured conflict responses retain an exact-message fallback alongside
  the SDK's structured classifier; this is version-sensitive.
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

## Validation

Against the pinned v3.3.0 in-memory server, the hardened suites pass:

- AgentKnowledgeStore integration: **16/16**.
- ProjectStorage subset: **18/18** (11 unchanged shared contracts + 7 specific cases).
- Concurrency/fencing: **8/8**, with 40 repetitions per repeated case.
- Classifier/result/cleanup unit tests: **17/17**.

That is **42 server-backed cases plus 17 unit cases, 59 total**. The SurrealDB CI
job supplies the endpoint and runs all four files unconditionally; failures fail
the job. It has no path filter or continue-on-error exemption.
Full `bun run check` passed in an isolated checkout of the same branch with
these hardened files: skill validation, typecheck, lint, **1,643 tests passed,
118 optional-service tests skipped**. The original checkout had **1,636 passed,
7 failed, 118 skipped** in the previously recorded four daemon CLI files; its
local state was preserved. The isolated full check plus the separate live
SurrealDB suites are the local validation evidence. `git diff --check` passed.
Hardened-HEAD GitHub job results are recorded in the PR description.
The pre-existing `.ai-office/` directory is excluded from all changes.

## Final recommendation

**B — investigate/use SurrealDB as AgentKnowledgeStore only.**

The native graph traversal produced concrete value for provenance, scoped
relationships, and current-decision lookup. The structured subset passed its
shared contracts but was more ceremonial than SQL, and forced duplicate-link
races lack boolean-result parity. Task creation from absent snapshots produced
a rejected loser in both project arrangements. Named-record claim, fence, and
version predicates worked in the tested cases. Snapshot reads allowed the
tested cross-record write skew; `FOR UPDATE` retained the fixed two-record
invariant in all 40 trials.
Current Runtime authority spans a larger and evolving record set; its complete
shared coordination set, deterministic order across writers, and predicate/phantom
protection remain unproven. These results justify keeping the
graph/knowledge investigation distinct from authoritative Runtime storage.

This recommendation is not production authorization. Any SurrealDB production
use requires a separate ADR, milestone, operational rehearsal, and explicit
acceptance of its tenant, migration, recovery, and conflict-handling boundaries.
