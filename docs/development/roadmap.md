# Development roadmap

## Long-term product direction

AI Office is intended to evolve from coordinating individual agent runs into a
local-first, auditable **virtual professional organization**. Software
engineering remains the first vertical being implemented and validated; the long-term
core should govern professional work without making software-development,
GitHub, or repository concepts universal domain assumptions.

AI Office defines the organization, policy, evidence, workflow, approvals, and
audit semantics. A coding client, model runtime, domain integration, or external
system is a replaceable worker or connector, not the source of role behavior,
workflow authority, or professional judgment.

```text
AI Office
  |-- organization and roles
  |-- agent pipeline engine
  |-- policy and capabilities
  |-- provenance, artifacts, evidence, and audit
  |-- connectors
  |     |-- GitHub
  |     `-- future domain systems
  `-- worker runtimes
        |-- Codex
        |-- Claude Code
        |-- Gemini CLI
        |-- OpenCode
        `-- local or future runtimes

Vertical profiles
  |-- software development (first vertical)
  `-- future professional domains
        `-- legal (reference vertical)
```

The reusable core is expected to converge on Projects or other work containers,
Tasks, Agents and AgentRuns, Pipelines, Artifacts, Reviews, Approvals, Policies,
Memory, Audit, and Authoritative Executors. Domain packs and adapters may add
vocabulary, schemas, reviewers, evidence, connectors and policy constraints for
software, manufacturing, legal, finance, operations, compliance and procurement,
but they do not fork those governance and authority semantics.

Three boundaries govern this direction:

1. A generic, client-agnostic Agent Pipeline Engine owns pipeline and stage
   orchestration, assignment, policy gates, transitions, retries, controlled
   loops, approvals, artifacts, and audit.
2. GitHub remains an external system behind connector and application ports. A
   GitHub connector exposes repository resources and operations; it never
   decides which role works next, whether a review is independent, or whether
   policy permits merge.
3. Domain verticals may add vocabulary, templates, integrations, evidence
   models, and stronger policy, but they must not fork orchestration, capability,
   approval, provenance, or audit semantics into a second implementation.

The M6E office manifest is the configuration precursor for this direction. The
M11 enforcement foundation now persists pinned sequential pipeline and stage
runs for explicitly enforced definitions; guidance-only definitions still rely
on the active host. A successful explicit `run:tick` of a stage-bound run is
reconciled into its bound stage. M11.5 queue-backed orchestration, disabled by
default, automates dispatch and orchestration of subsequent work without
repeated operator-driven ticks. Advanced orchestration remains future work. M14
is intended to deliver the first complete software-development
vertical. This direction preserves M0-M14 scope and implementation status and
does not rename the current `Project` aggregate, change existing schemas, or
claim support for another professional domain.

## M0 — Repository health

Status: implemented.

- install dependencies;
- pass typecheck;
- migration runner;
- CI;
- coding conventions.

## M1 — Project and task vertical slice

Status: implemented on `main`.

- create/list projects;
- create/list tasks, with task lifecycle rules in the domain;
- SQLite repositories;
- event log;
- integration tests;
- functional CLI.

## M1.5 — Existing project onboarding

Status: implemented on `main`.

- canonical, idempotent local repository import;
- deterministic language, framework, database, test, and documentation scan;
- timestamped scan history and refreshed detected profile facts;
- persisted onboarding questions and structured answers;
- interactive and automation-friendly onboarding commands;
- categorized profile view and deterministic Markdown projection.

## M2 — Local daemon

Status: implemented on `main`.

- daemon lifecycle over an owner-only Unix domain socket;
- versioned local HTTP API;
- CLI daemon client with interactive prompt forwarding;
- single-writer command queue;
- health and status endpoint;
- append-only lifecycle and command audit events;
- graceful shutdown and stale socket recovery.
- deterministic offline runtime purge with exact plan-hash approval and
  preservation of foreign `.ai-office/` entries.

The daemon is now described as the current persistent host for the AI Office
Runtime. This terminology clarification does not change the implemented M2
socket protocol, process lifecycle, or compatibility surface; see ADR-0014.

## M3 — Agent runtime

Status: implemented on `main`.

- role and agent definitions;
- agent runs;
- scheduler;
- mock executor;
- task locking;
- worktree abstraction.

## M4 — LLM gateway and cost control

Status: implemented on `main`.

- provider interface;
- provider mock and one real provider;
- usage normalization;
- pricing versions;
- cost events;
- budgets and reservations;
- fallback policy.

## M5 — Governance

Status: implemented on `main`.

- milestones;
- ADR workflows;
- requirements;
- reviews and approvals;
- Markdown export.

## M6 — Capability security and controlled actions

Goal: agents must never access local or external resources directly. All real operations pass through deterministic authorization, connector boundaries, simulation, approval when required, execution-time revalidation, and audit.

### M6A — Capability model and policy engine

Status: implemented on `main`.

- project-scoped resource registry;
- explicit capability grants for users, agents, roles, workflows, and applications;
- deny-by-default authorization;
- typed, connector-specific constraints with safe intersection rules;
- grant validity, expiry, and immediate revocation;
- deterministic risk classification;
- enforced action-request state machine;
- canonical payload serialization and hashing;
- typed authorization and policy errors;
- SQLite persistence and migration;
- essential append-only audit events;
- fake connector for policy and lifecycle tests.

Exit criteria:

- no matching capability results in denial;
- expired or revoked grants are ignored;
- resource, operation, arguments, and effective constraints are included in the payload hash;
- authorization decisions are deterministic, explainable, and never delegated to an LLM.

### M6B — Connector SDK and filesystem sandbox

Status: implemented on `main`.

- common connector contract and registry;
- operation descriptors for risk, simulation, reversibility, and approval requirements;
- filesystem resource scopes with canonical roots;
- `filesystem.list`, `filesystem.read`, and `filesystem.search`;
- simulated `filesystem.create`, `filesystem.write`, `filesystem.move`, and `filesystem.delete`;
- path traversal and absolute-path escape prevention;
- symlink escape prevention;
- sensitive-file denylist;
- binary, file-size, and output-size limits;
- deterministic unified diff generation;
- source hashes and execution preconditions;
- filesystem security and integration tests.

Exit criteria:

- simulations never modify real files;
- simulation artifacts deterministically capture source hashes and destination-absence preconditions for later execution;
- paths cannot escape an allowed root through traversal or symlinks;
- agents cannot obtain credentials or sensitive files through the connector.

### M6C-lite — Trusted local controlled execution

Status: implemented on `main`.

Threat model: AI Office is a local, single-user application in the user's trust
domain. It prevents accidental or unauthorized agent access, path escape, stale
simulation, replay, and unapproved mutation. It does not yet defend against a
hostile process with the same Unix privileges concurrently mutating the same
filesystem namespace.

- dedicated local `ActionApproval` bound to immutable action and simulation hashes;
- approval required for every real filesystem mutation;
- execution-time revalidation of grants, constraints, resource, action, and artifact;
- one-shot execution record and database-enforced replay prevention;
- `execution_unknown` for an ambiguous filesystem/SQLite outcome;
- pragmatic create/write/move/delete using the M6B sandbox and Node/Bun APIs;
- source-hash and destination-absence precondition checks immediately before mutation;
- sanitized append-only events in the existing audit log;
- daemon-backed approve, reject, execute, show, and list flows.

Exit criteria:

- every real filesystem mutation requires an explicit local approval;
- revoked/expired grants and disabled resources block unexecuted actions;
- changed source, path escape, symlink, hard link, and sensitive paths fail closed;
- one action obtains at most one execution attempt;
- create/write/move/delete work end-to-end through the daemon CLI;
- same-user concurrent-writer races and the SQLite/filesystem crash gap are documented residual risks.

### M6C.5 — LLM-assisted adaptive project onboarding

Status: historical implementation; provider-backed onboarding was superseded
by host-only onboarding in [ADR-0010](../adr/ADR-0010-host-only-onboarding.md).

- deterministic, offline `project:import` scan and persisted detected facts;
- conversational questions and synthesis now belong to the active coding host;
- the Runtime validates and persists approved office state without provider calls;
- historical generated questions and provenance remain readable, and
  `project:answer` can close previously stored questions;
- `project:onboard` and the Runtime question generator are no longer implemented.

This milestone does not connect the agent runtime to controlled actions and does not add reusable memory, code indexing, RAG, or autonomous permission changes.

### M6D-lite — Agent controlled-action integration

Status: implemented.

- controlled-action gateway exposed to agent executors;
- no direct filesystem or infrastructure adapter dependency in agent runtime;
- controlled scheduling returns a run ID and `run:tick` returns its action ID without blocking the daemon command FIFO;
- action and approval state available through daemon-backed CLI commands;
- interrupted `executing` and `execution_unknown` actions remain observable without automatic replay;
- end-to-end flow from agent intent to controlled filesystem modification.

Exit criteria:

- the simulated executor can be replaced incrementally without granting direct resource access;
- capability revocation takes effect immediately;
- a complete read, simulate, approve, execute, and audit workflow passes end to end.

M6D-lite accepts one structured action intent at scheduling time. Runs without an
intent retain the deterministic simulator. Autonomous LLM tool selection,
multi-step tool loops, subprocess execution, and real Git worktrees remain
future work.

The M6C.5 provider-backed onboarding entry point was subsequently removed by
the host-only decision in ADR-0010. Its applied migrations remain for upgrade
compatibility and preserve historical questions and provenance; no current
command creates new provider-generated onboarding batches.

### M6E — Skill-first office onboarding

Status: implemented.

- repository-scoped `ai-office` skill as the primary conversational interface;
- host-authenticated onboarding without provider credentials in AI Office;
- strict schema-versioned office manifests with mission, roles, preferences,
  constraints, and provenance;
- default pipelines for feature, bugfix, maintenance, research, and release
  tasks;
- deterministic context, validation, apply, show, and pipeline-resolution
  commands for host adapters;
- immutable SQLite revisions and sanitized apply audit events;
- permission preferences kept separate from capability authorization.

M6E itself introduced definitions, not execution authority. The later M11
foundation now persists explicitly enforced runs; guidance-only definitions
retain the original M6E behavior. Conversational questions and synthesis remain
host-only, and the daemon exposes no provider-backed onboarding fallback.

### M6F — External coding-client integration

Status: implemented.

- tool-independent schema-versioned operating policy and project instruction
  contract;
- deterministic shared `AI-OFFICE.md` compiler with minimal Codex and Claude
  discovery files;
- repository-local `ai-office` skills for Codex and Claude, with no duplicated
  authoritative state;
- application port plus Codex CLI and Claude Code infrastructure adapters;
- passive detection, inspection, deterministic planning, explicit plan-hash
  approval, preconditioned atomic apply, and validation;
- preservation of user-owned canonical instructions and managed Claude bridge;
- ownership-aware, plan-hash-approved client integration removal;
- daemon-backed `client:*` machine interface, separate from project onboarding;
- no global configuration mutation or persistence in the first slice.

The original managed `AGENTS.md` projection remains upgrade-compatible through
ordinary idempotent install; current installs migrate it to the shared guide and
repository skills while preserving user-owned files.

Lifecycle root resolution is worktree-aware for descendant invocations, and
offline status attests deterministic skill/pointer drift while conservatively
reporting manifest-dependent guidance as unverified.

Client version probing, machine preference persistence, additional coding
clients, and internal-agent context composition remain future work.

Deferred until after M6:

- GitHub write connector;
- SQLite mutation connector;
- shell execution connector;
- production deployment actions;
- connector marketplace;
- multi-tenant isolation;
- microVM or distributed sandboxing;
- full approval web UI.

## M7 — Reusable memory

Status: implemented.

- validated, versioned global roles and patterns in `global.sqlite`;
- explicit project adoption of exact pattern versions with usage tracking;
- validated lesson capture with optional project/task provenance;
- deterministic validation, version-conflict handling, and deprecation;
- bounded cross-project text search that excludes deprecated memory.

Semantic retrieval, autonomous LLM lesson extraction, pattern outcome feedback
from a future pipeline runtime, global audit, memory-write policy, poisoning
protection, and quotas remain deferred.

## M7.5 — Repository lifecycle UX

Status: implemented.

- user-facing `install`, `status`, and exact-plan `uninstall` orchestration over
  existing project, office-manifest, and coding-client services;
- strict, schema-versioned, committable `.ai-office/project.json` identity
  anchor with a portable repository ID and no path, runtime project ID, secret,
  capability, or copied authoritative state;
- stable user runtime home selected by `AI_OFFICE_HOME` or `~/.ai-office`,
  independent from program distribution and current repository;
- SQLite mapping from portable repository identity to runtime-local project ID,
  with canonical multi-checkout associations and fail-closed remote evidence;
- canonical same-filesystem ancestor discovery with nearest nested-project
  precedence and symlink fail-closed behavior;
- automatic project-ID resolution for project-scoped commands;
- idempotent install reconciliation, default office only when absent, passive
  client detection, and ownership-safe sequential client apply;
- status schema version `4`, including distinct repository identity and runtime
  association plus offline repository/client inspection when
  the daemon is unavailable;
- lifecycle uninstall that preserves the portable identity, user content,
  project/runtime authority, other checkouts, runtime purge scope, and global
  reusable memory while reporting partial mutations honestly;
- offline exact-plan `update` for the current source-linked Bun distribution,
  with clean/upstream Git preconditions, exact target and remote-identity binding,
  isolated temporary-ref acquisition, selected-user and distribution-development
  Runtime presence checks, frozen dependency install, bare-link refresh, and
  explicit partial recovery while preserving Runtime and global state. This
  source-maintenance exception requires no operational source opt-in and grants
  no Runtime authority (ADR-0011); published-package and automatic updates remain
  outside this feature;
- linkable source-checkout `ai-office` bin while published packages and
  compiled binaries remain M9 work. Per-user background service management
  has since shipped as `ai-office service install|status|uninstall`.

The repository artifact is portable identity metadata rather than project
authority. Clones and purged runtimes establish a local SQLite mapping through
normal install. Additional or moved checkouts reuse authority when Git remote
evidence matches; copied or conflicting identities fail closed. Explicit
rebind remains exceptional recovery. See ADR-0008 and ADR-0009.

## M7.6 — Portable project state

Status: implemented.

Focus: move one logical AI Office project between installations without making
its checkout path or SQLite file the project identity or transport format.

Delivered:

- stable repository-portable identity reused across moves, clones, backup, and
  restore;
- machine-local bindings from that identity to the current checkout;
- versioned, checksummed `.aioffice` semantic snapshots;
- daemon-authoritative `project:backup` and transactional `project:restore`;
- explicit portable-state allowlisting that excludes managed credentials,
  structured credential-labelled profile state, capabilities, controlled-action
  approvals, audit authority, active execution state, and absolute paths;
- execution-quiescent capture, referential closure, trigger-valid governance
  replay, and network-safe Git provenance;
- authority-based quiescence that preserves task lifecycle semantics while
  excluding live runs, pipelines, and locks;
- state-observation revisions separated from no-clobber archive publication;
- intrinsic portability and structured credential-label validation before
  snapshot-head advancement;
- project-owned identity reservations for materialized and shallow lineage IDs;
- deterministic multi-checkout provenance selection with ambiguity omission;
- idempotent migration for projects that predate portable identity;
- immutable state revision metadata and a provider-neutral remote port.

See [Project portability and sync](project-portability-and-sync.md).

## M7.7 — Welcome, onboarding, and project handover

Status: implemented.

Focus: make the product entry point explicit after installation and give the
office a deterministic answer to "what should I do next?".

Delivered:

- a pure domain handover model: handover states, six readiness dimensions with
  explicit `not_started`/`discovered`/`needs_input`/`ready`/`unknown` values, a
  testable existing-versus-new repository heuristic, a stable review
  fingerprint projection, and a deterministic recommended-action catalogue;
- explicit repository-review evidence: `ConfirmRepositoryUnderstanding` records
  a user-origin `handover` / `repository_review` project profile entry with the
  review summary, the bound scan, and a fingerprint of the material repository
  facts, superseding any earlier confirmation;
- `AssessProjectHandover`, an application service that derives the model from
  lifecycle status, project profile evidence, the current office manifest,
  governance records, tasks, and open project questions;
- `ai-office next [path] [--json]` with an independently versioned
  schema-version `1` report carrying structured recommended actions, and
  `ai-office handover:confirm` for the confirmation itself;
- a first-connection welcome on `install`, compact contextual guidance on human
  `status`, and no change to the `install` or `status` JSON envelopes;
- a single client-neutral handover workflow compiled into the projected
  repository skill, validated against the checked-in distribution skill, and
  pointed at from the derived `AI-OFFICE.md` guide;
- a degraded assessment when the runtime is unreachable that reports `unknown`
  instead of advising an unnecessary reinstall.

No migration was introduced: the confirmation reuses the existing project
profile entry table and its `superseded_at` column, so it is portable in
`.aioffice` snapshots and survives repository re-imports, uninstall, and
reinstall. The repository scan additionally records source-file counts and
commit evidence; projects imported by earlier releases lack them and report
`unknown` maturity until they are re-imported.

An approved office manifest is never treated as proof of repository
understanding, so a project configured before this milestone reports
`in_progress` with a `discovered` repository review rather than becoming ready
automatically. Handover transfers organizational context ownership only: it
grants no capability, bypasses no approval, alters no policy, and starts no
agent run.

## M7.8 — Operational read models and dashboard

Status: implemented.

Focus: give AI Office one authoritative interpretation of operational state, and
a human surface that consumes it without inventing a second one.

Delivered:

- explicit application read models for project summary, task operational state,
  pipeline/run state, agent activity, reviews/approvals, and sanitized activity,
  with a `queryApiVersion` contract versioned independently of the daemon
  command protocol;
- `OperationalQueryService`, the single place that decides which persisted facts
  feed which read model, plus an `OperationalReadRepository` port added only for
  the cross-project roll-ups the per-aggregate repositories cannot serve without
  a query per project;
- a read-only `GET /api/*` query surface on the existing Unix socket whose
  handlers parse, validate, and serialize but hold no SQL and no domain logic;
- an in-memory invalidation bus and `GET /api/events` server-sent stream that
  carries topics only, persists nothing, and cannot become a second source of
  truth;
- `ai-office dashboard`, a foreground loopback host that serves the console
  (since rebuilt as a React application, see M17) and forwards `/api/*` to the daemon socket;
- honest reporting of the gap between persisted and operational state: a task
  scheduled for a run still reads `pending`, so the read model publishes
  `recordedStatus`, `operationalStatus`, and the reasons they differ, and the UI
  lists divergent tasks separately.

Task/requirement summaries use explicit links introduced in M7.9 and exposed by
the consolidation query changes. Empty linkage is available with zero counts.
Task/milestone association remains unmodelled and explicitly unavailable;
requirement progress does not infer task completion or milestone membership.

No migration and no index were introduced: the queries reuse existing access
paths. The dashboard is read-only by construction — it starts, stops, retries,
approves, assigns, and cancels nothing. A Human Approval Inbox and an authorized
control plane remain future work and must route through the existing command,
capability, approval, and audit semantics; see
[ADR-0015](../adr/ADR-0015-operational-read-models-and-loopback-dashboard.md).

The daemon still opens no TCP listener. The loopback port belongs to the
dashboard command and is released with it. The console is a local same-user
observability surface and introduces no authenticated human or operator
boundary.

## M7.9 — Task lifecycle completion and reconciliation

Status: implemented.

Focus: make `task.status` trustworthy. The lifecycle was designed as
authoritative operational state and written by exactly one subsystem — the
pipeline — so work finished any other way left the board stale forever, with no
CLI surface able to correct it.

Delivered:

- the task lifecycle declared once as a transition table in the domain, with
  `block`, `unblock`, `fail`, and `submitForReview` added so every status except
  `assigned` is reachable, and terminal states provably unreachable in reverse;
- one semantic CLI command per transition (`task:start`, `task:submit-review`,
  `task:complete`, `task:block`, `task:unblock`, `task:fail`, `task:cancel`),
  each validating the current state, refusing an impossible one with the allowed
  set named, and committing its status write and audit event together. There is
  deliberately no generic `task:set-status`;
- `task:transitions`, a read-only preflight that publishes the allowed
  transitions and the command that performs each one;
- an explicit many-to-many `task_requirement` relation with project-ownership
  triggers, CLI link/unlink commands, and no inference from titles or keys;
- `task:list` showing linked requirement progress beside — never instead of —
  the task status, and marking a contradiction rather than hiding it;
- `task:reconcile`, read-only by default, detecting terminal-pipeline/open-task,
  active-pipeline/terminal-task, stale pending tasks, completed tasks with open
  requirements, and in-flight tasks with no execution. `--fix` requires an
  approved plan hash and repairs only the one finding whose correct outcome
  existing code already defines. One approved plan is one transaction: all of
  its repairs commit or none do. Every suggestion the report prints is
  executable from the status shown beside it;
- `task:record-completion`, an explicit operator attestation that work was
  completed outside the lifecycle AI Office holds. It reaches only `completed`,
  only from `pending`, `assigned`, and `blocked`, never from a terminal status,
  always with a mandatory rationale and an approved plan hash, and it emits
  `task.completion_recorded` with `correction: true` rather than any
  `task.status_changed`. It is neither `task:set-status` nor a shorthand for
  `task:start` followed by `task:complete`.

Requirement verification deliberately does **not** complete a task: one
requirement may be delivered by several tasks, one task may deliver several
requirements, and implementation routinely finishes before governance
verification. Reconciliation surfaces the mismatch and an operator decides.

Migration `0026` adds the linkage table and links nothing. Historical task state
is not rewritten; reconciliation identifies questionable tasks after an upgrade,
and the operator corrects them explicitly.

Portable archive format version 2 carries the links; version 1 stays frozen
where it shipped and cannot express them. A project with no links still exports
version 1, byte-identical to before, and both versions are readable. Writing
links into a version 1 envelope is refused rather than silently dropped.

## M7.10 — Safe development CLI/runtime isolation

Status: implemented on `main` (consolidation integrated through #31 and #38–#42).

- `dev:cli` and `dev:daemon` select the source checkout's `.ai-office` using
  their entry-point location, including linked worktrees and descendant cwd;
- both project and global-memory databases default to that isolated home;
- development entry points ignore ambient `AI_OFFICE_HOME` and report selected
  paths on stderr, preserving JSON stdout;
- the source bin, including `bun link`, requires explicit
  `AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1` for operational user-runtime
  access; local help remains available;
- development aliases and migrations share the same source-root semantics;
- test fixtures are temporary and isolated; manually created development state
  persists for inspection until explicitly removed.

The same consolidation delivers the reviewed M3/M7.8/M7.9 integration fixes:
bounded run outcomes and nonzero unsuccessful exit codes; eligibility checks and
atomic queued-run admission; host-owned cancellation and approved reconciliation;
and exact task/requirement summaries shared by CLI and operational queries.
An execution whose terminal result cannot be persisted reports `interrupted`
and retains its lock for inspection. See [run recovery](run-recovery.md) and the
[implementation plan](../implementation/project-consolidation-and-worker-plan.md).

## M7.11 — Durable project memory provider

Status: historical initial slice; superseded by Native Agent Knowledge.

Focus: give workers durable, repository-scoped context from an optional
external memory provider without creating a second authority. CairnKeep
remembers; AI Office decides.

Delivered:

- a provider-neutral, read-only `ProjectMemoryProvider` application port and a
  disabled default that is never invoked;
- an optional CairnKeep adapter over its stdio MCP server, isolated in
  `packages/cairnkeep-memory`, restricted server-side to `memory_search` and
  refused unless exactly that tool is exposed;
- a memory identity derived only from the portable `repositoryId`
  (`aio-<digest>`, used as a CairnKeep named scope), shared by every checkout
  and worktree;
- one `RunContextAssembler` owning additional worker context: the existing
  global-memory lookup plus at most one bounded, task-derived project memory
  search per worker run;
- explicit query, result, excerpt, total, message, deadline and concurrency
  limits, deterministic ordering, and fail-closed response validation;
- advisory-labelled context that is omitted unless something was injected and
  pinned in the existing worker input digest;
- append-only retrieval provenance per AgentRun (migration `0028`) with
  references and digests but no memory bodies, queries or paths;
- graceful fallback for disabled, unavailable, timed-out, incompatible,
  malformed, oversized and empty providers;
- environment-only host configuration, an additive `projectMemory` status block,
  `project-memory:status [--probe]`, and provenance in `run:show`.

Not included: memory writes, semantic retrieval, checkout-local CairnKeep
`project` scopes, dashboard rendering, service-definition configuration, remote
CairnKeep HTTP, and any CairnKeep capability, playbook, artifact, work-evidence,
evaluation, trajectory or skill system. `global.sqlite` is unchanged. See
[project memory](project-memory.md) and
[ADR-0018](../adr/ADR-0018-optional-non-authoritative-project-memory-provider.md).

### Follow-up — Reviewed project memory promotion

Status: superseded as a CairnKeep write plan by the Native Agent Knowledge
milestone below. AK-05 established the admission and review policy for new
knowledge through `AgentKnowledgeStore`; no CairnKeep write-back was added.
AK-08 removed the remaining read-only CairnKeep diagnostics and import path.
Semantic retrieval and dashboard provenance remain separate work.

### Separate follow-up — Project retention and removal

Status: assessment pending; no removal operation implemented.

Decide archival versus physical removal, installed checkout behavior, active work,
portable identity, global-memory references, and audit retention independently
of runtime isolation. `runtime:purge` is still whole-runtime removal and project
uninstall still preserves authority. The existing `governance_event` cascade
and append-only delete guard must be reconciled with the chosen retention policy
before supporting deletion; do not bypass the guard as a cleanup shortcut.

## Native Agent Knowledge & CairnKeep Retirement

Status: AK-01–AK-11 merged. AK-12 (knowledge record lifecycle) is a candidate,
not yet planned or registered.
This is a separate, sequential migration milestone; M7.11 describes the
historical CairnKeep retrieval path. See
[ADR-0025](../adr/ADR-0025-native-agent-knowledge-store.md).

| Slice | Scope                                                                        | Depends on                        |
| ----- | ---------------------------------------------------------------------------- | --------------------------------- |
| AK-01 | Canonical, bounded `AgentKnowledgeStore` contract and trusted portable scope | SurrealDB evaluation PRs #64–#66  |
| AK-02 | SurrealDB retrieval parity and compatibility term                            | AK-01 merged                      |
| AK-03 | Explicit, independent Runtime knowledge composition                          | AK-02 merged                      |
| AK-04 | `RunContextAssembler` cutover and run provenance                             | AK-03 merged                      |
| AK-05 | Governed knowledge admission with immutable provenance                       | AK-04 merged                      |
| AK-06 | Explicit, idempotent CairnKeep named-scope import                            | AK-05 merged                      |
| AK-07 | CairnKeep deprecation in guidance and setup                                  | AK-06 merged                      |
| AK-08 | CairnKeep implementation removal and final docs                              | AK-07 merged                      |
| AK-09 | Managed Agent Knowledge configuration and SurrealDB deployment support       | AK-03–AK-05; AK-08 for final docs |
| AK-10 | Durable project knowledge policy in agent guidance; `knowledge:search`       | AK-05, AK-08                      |
| AK-11 | Governed non-run knowledge admission provenance                              | AK-05, AK-10                      |

AK-01–AK-10 each map to one reviewed PR. AK-09 was delivered as one operational
task with four delivery slices below, tracked by one requirement and task.
Completion required proven retrieval, writes,
legacy-data disposition, failure behavior, documentation, and operational
coherence. SQLite/PostgreSQL remain the only operational authority; SurrealDB
is knowledge storage only. No vector search, RAG redesign, or permanent
dual-source layer is included.

AK-02 shares the existing CairnKeep literal-term selector with the application
boundary and verifies SurrealDB's bounded, scoped, deterministic search.
AK-03 adds an explicitly configured SurrealDB connection to Runtime bootstrap
with bounded startup, sanitized diagnostics, and owned shutdown. AK-04 routes
worker retrieval through this store and preserves bounded context and run
provenance; AK-08 removes the remaining CairnKeep diagnostics and import
implementation. See
[native agent knowledge retrieval](agent-knowledge.md).
AK-05 governs new run-sourced writes. AK-06 adds an operator-reviewed,
idempotent import of one bounded CairnKeep named scope, preserving its scope,
key and content digest without inventing run provenance. Imported records and
historical run retrieval evidence remain readable; external CairnKeep data is
never deleted by AI Office. See the same guide.

### AK-11 — Governed non-run knowledge admission provenance

**Status:** implemented on `main` via PR #99, verified through the enforced
delivery pipeline. Decision recorded in
[ADR-0030](../adr/ADR-0030-typed-governed-knowledge-admission-provenance.md).
The Implement stage was closed by an audited pipeline override because no
developer model profile was configured; the change was host-implemented,
reviewed by a reviewer run with operator approval, and verified by a QA run.
AK-10 left one gap: admission required a completed worker run, so durable
knowledge learned during handover or an interactive Codex/Claude session could
only be reported to the user. AK-11 replaces the run-only model with a closed,
typed admission source: `agent_run` (unchanged, including its plan hash),
`handover` (the project's current user-confirmed repository review), and
`operator_confirmed` (project evidence the Runtime resolves, explicitly
confirmed by the named operator at `knowledge:admit`). Provenance is validated
per source, bound into the plan hash, stored as typed immutable fields with the
record, and explained by `knowledge:trace`. See
[admission provenance](agent-knowledge.md#admission-provenance-ak-11).

**Delivered:** explicit `--source` selection on `knowledge:plan` and
`knowledge:admit`; `confirmationId` in `handover:confirm` output; SurrealDB
knowledge schema version 3 with an in-place upgrade; `admissionSource` and
`admission` in `knowledge:trace`; `provenanceKind` in `knowledge:search` and
the admission result; provenance in admission audit events; updated canonical
skill policy and handover guidance for Codex and Claude.

**Non-goals:** fabricating agent runs; trusting host-session identifiers;
automatic persistence of handover or session findings; supersede, relate or
deprecate; a confidence schema; retrieval redesign; another backend;
reintroducing CairnKeep; any change to authoritative SQLite/PostgreSQL state.

**Known limits:** operator confirmation is trusted-local, not human-presence
authentication; evidence is verified at plan and admission time and not
re-validated afterwards; `knowledge:trace` references the admission audit
events without reading them back; a confirmed handover review restored from a
portable snapshot is accepted while it is still the current review.

**Deferred, found in review:**

- AK-12 candidate: `supersedeDecision` compares task IDs to keep supersession
  within one task, and two non-run decisions both have none, so it would treat
  them as the same task. No command reaches it today; supersede, relate and
  deprecate must define their rule for records without a task.
- Follow-up: `knowledge:trace` prints the tenant ID that `knowledge:search`
  hides. This predates AK-11 and now also applies to non-run records; removing
  it changes an existing output contract and needs its own decision.

### AK-10 — Durable project knowledge policy

**Status:** implemented on `main` via PR #98. AK-10 closes a behavioral gap, not a
storage one: agents were not told to identify durable knowledge learned during
project work, so it was rediscovered across runs. One canonical policy now
tells agents to classify what they learned, search existing knowledge, and
propose verified, non-authoritative, project-specific context through the
existing `knowledge:plan` → review → `knowledge:admit` path. Both skill
surfaces embed it verbatim and the handover workflow carries the matching
boundary, and the generated project instructions (`AI-OFFICE.md`) route every
client to the policy. The only new command is the read-only `knowledge:search`,
needed because no CLI surface could check for an existing record before a new
plan. See [durable project knowledge policy](agent-knowledge.md#durable-project-knowledge-policy-ak-10).

**Non-goals:** another memory subsystem or provider; reintroducing CairnKeep;
automatic ingestion of task results or repository content; making
`AgentKnowledgeStore` authoritative; any worker-side write path; changing
admission provenance, approval or the store contract.

**Known limits, not addressed here:** admission required a completed worker
run, so knowledge from interactive host sessions and handover was reported to
the user rather than admitted (closed by AK-11); there is no supersede or
relate command; search remains literal and bounded.

### AK-09 — Managed Agent Knowledge configuration and SurrealDB deployment support

**Status:** implemented on `main` via PR #75. AK-09 closes the operational gap
left by AK-03: managed services now load Agent Knowledge configuration and
protected credentials from the Runtime home without editing generated systemd
units or launchd plists. Foreground environment configuration remains supported.
SurrealDB remains a secondary, advisory knowledge store.

**Requirements**

1. Define a canonical, validated Agent Knowledge configuration source under
   `AI_OFFICE_HOME`, separate from project authority, snapshots and generated
   Markdown. It holds non-secret provider, endpoint, namespace, database and,
   for SQLite, trusted tenant configuration. Select a protected host credential
   source for the SurrealDB password and any sensitive username or future token.
   First assess whether the owner-only `credentials/` pattern from ADR-0020 can
   be reused without weakening its provider-name allowlist or value validation;
   use a narrowly equivalent infrastructure credential source only if reuse is
   unsuitable. Do not introduce a general secrets manager by default.
2. Define explicit source selection and precedence. A managed Runtime uses
   only its canonical Runtime-home configuration and credentials, regardless
   of the installing shell or service-manager environment. Foreground
   `ai-office runtime start` retains the existing explicit environment form;
   absent provider remains disabled. Invalid selected sources are
   `misconfigured`, never silently replaced by values from another source.
   Do not migrate ambient secrets into persistent files automatically.
3. Make `service install` render only `AI_OFFICE_HOME` and non-secret source
   markers needed by the Runtime, with equivalent systemd --user and launchd
   behavior. Restart, logout/login, reboot and repeated installation must
   reconstruct the same configuration without embedding credentials, copying
   the invoking environment, or deleting Runtime-home configuration. Keep the
   existing managed-definition/outdated inspection behavior coherent.
4. Preserve tenant semantics: SQLite requires a trusted configured
   `AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID`; PostgreSQL uses its authoritative
   storage tenant. Missing or malformed managed values produce a sanitized
   `misconfigured` startup observation. Keep bounded connection startup and
   failure isolation: an unreachable or rejected SurrealDB connection reports
   `unavailable` and leaves the authoritative Runtime available.
5. Retain `/health`'s `knowledge.provider` and startup-only
   `knowledge.startup` states (`disabled`, `misconfigured`, `connected`,
   `unavailable`). Review whether an existing command exposes enough
   sanitized operator diagnostics before proposing `knowledge:status`; any
   added command must report state and safe issue codes only. Never expose
   endpoint, username, password or secret-derived values in health, service
   status, logs, errors, snapshots or generated views.
6. Publish a supported persistent SurrealDB deployment guide: installation
   and tested version; same-machine service bound to `127.0.0.1`; persistent
   storage rather than `memory`; account, namespace, database and tenant;
   systemd and macOS service operation where applicable; start/restart and
   health verification; `misconfigured` versus `unavailable`; outage behavior;
   backup, restore, upgrade and troubleshooting. State clearly that
   SQLite/PostgreSQL remain authoritative for project, task, run, approval and
   audit state. The guide must work without hand editing AI Office service
   definitions.
7. Add a dedicated persistent-storage integration or CI test that starts
   SurrealDB on disk, writes scoped knowledge with provenance, stops and
   restarts the server, and verifies the same records, tenant/repository
   isolation and provenance. The existing `memory` service tests do not prove
   restart durability. A dedicated suite is acceptable if this is too costly
   for the fast checks.

**Acceptance criteria**

- On a clean Linux or macOS machine, an operator can configure the managed
  Runtime through documented supported commands/files, install its service,
  and obtain `knowledge.startup: connected` after login or reboot without
  relying on the shell used for installation. Workers retrieve scoped knowledge.
- Re-running `ai-office service install` may regenerate definitions but retains
  the canonical configuration and credentials; restart still connects.
- Unit, plist, `service status`, `/health`, logs, sanitized errors, snapshots
  and generated Markdown contain no SurrealDB password. They expose no
  endpoint or username through diagnostics. Tests cover both platforms and
  secret-bearing failure paths, including a wrong password.
- Missing/invalid provider, endpoint, namespace, database, credential or
  SQLite tenant is `misconfigured` with no cross-source fallback. Wrong
  credentials or an unreachable server produce sanitized `unavailable`; neither
  prevents the authoritative Runtime from starting. PostgreSQL always derives
  the knowledge tenant from its authoritative storage configuration.
- Foreground environment configuration continues to work as documented;
  unset provider remains disabled and does not require SurrealDB.
- Automated restart evidence proves knowledge records, tenant/repository
  scope and provenance survive a persistent SurrealDB stop/start. The operator
  guide covers backup/restore and upgrade verification.

**Delivery slices:** A — configuration schema, validation, precedence, tenant
and credential boundary; B — Runtime bootstrap, systemd/launchd markers and
service reinstall regression; C — persistent SurrealDB deployment test,
restart/recovery and health behavior; D — operator guide, diagnostics decision
and end-to-end acceptance. These are delivery checkpoints within AK-09, not
new Runtime task or requirement aggregates.

**Dependencies:** AK-03 composition, AK-04 worker retrieval/provenance,
AK-05 admission, ADR-0009 Runtime home, ADR-0014 managed host, ADR-0020
credential boundary, ADR-0025 knowledge authority. AK-08 is needed only to
align final current documentation after CairnKeep removal; AK-09 must not
reopen that decision.

**Non-goals:** replacing SQLite/PostgreSQL authority; moving project, task,
run, approval or audit state into SurrealDB; SurrealDB clustering or Cloud;
vector/semantic search; changing `AgentKnowledgeStore` without demonstrated
need; reintroducing CairnKeep; a generic secrets manager; or requiring
SurrealDB when knowledge is disabled.

## M7.12 — Agent model routing

Status: implemented.

Focus: make each run's model an explicit, auditable, provider-neutral part of
execution so inexpensive models serve high-volume roles and stronger models are
reserved for roles that need them, without weakening role budgets.

Delivered:

- the distinction between semantic role `modelPolicy`, host model profiles,
  an immutable per-run resolved model, and host-only provider credentials;
- host-local routing read once at Runtime start from the canonical
  `<AI_OFFICE_HOME>/model-routing.yaml`; in the foreground
  `AI_OFFICE_MODEL_ROUTING_FILE` overrides it and `AI_OFFICE_LLM_MODEL` remains
  the lowest precedence compatibility default;
- managed systemd and launchd Runtimes that read only the canonical file through
  a generated, non-secret `AI_OFFICE_MODEL_ROUTING_SOURCE=runtime_home` marker,
  with no credentials in service definitions;
- deterministic precedence (project agent override, host-global agent override,
  role policy, default profile, legacy default) that fails closed on explicit
  invalid configuration; project overrides are keyed by Runtime project id;
- structurally immutable loaded routing state;
- resolution inside the scheduling transaction and an immutable
  `agent_run.model_routing_json` (migration `0030`); pre-existing runs remain
  explicitly unrecorded;
- execution from the persisted selection only, with worker `supportsModel` and
  `requiresModelSelection` checks, Claude `--model`/`--effort` mapping, and a
  first-party gateway worker (`run:tick --worker gateway`) that executes routed
  `openai:` runs through `MeteredLlmGateway` with exact model enforcement,
  provider-neutral execution parameters and the role budget as the run budget;
- an explicit inclusive `ModelUsage` contract priced by mutually exclusive
  buckets, a worst-case reservation that prices each token once, and answered
  but rejected provider responses (model mismatch, malformed usage) charged at
  the reserved envelope instead of released (migration `0031`);
- controlled-action payloads treated as ordinary connector data, never as model
  authority;
- a client-free model-reference parser and `resolveModelRef` in the gateway
  registry;
- read-only `agent:models`, `model:check` and `run:show --json` inspection that
  separates assigned model, actual model, usage and gateway-metered versus
  client-reported cost;
- unchanged role budgets and portable snapshot schema.

Not included, tracked in M7.13: a credential boundary for managed services
(since implemented, ADR-0020), gateway execution for Anthropic models,
co-reservation of wider budget scopes, an audited override mutation command,
dashboard rendering of the selection, and routing hot reload. See [ADR-0019](../adr/ADR-0019-agent-model-routing.md).

## M7.13 — Model routing follow-ups

Status: complete. Managed-service credentials, native Anthropic gateway execution,
co-reservation, audited operator overrides, dashboard detail and hot reload are
implemented.

- **Managed-service provider credentials** — implemented. Acceptance: a managed
  Runtime can execute gateway runs without credentials in service definitions,
  routing files, SQLite, logs, diagnostics or dashboard state; the secret source
  is explicit, owner-only, documented for systemd and launchd equally, and
  `model:check` reports presence by name only. Delivered: owner-only
  `<AI_OFFICE_HOME>/credentials/<NAME>` files read once at Runtime start with
  symlink, file-type, owner, permission, size and format checks that fail
  closed; a non-secret `AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE=runtime_home`
  marker in the managed Runtime unit and plist that makes the Runtime ignore
  ambient credential variables; strict source separation, so a foreground
  Runtime keeps reading only its environment and never the credential files;
  local `credential set|status|remove` with bounded stdin-only input, atomic
  owner-only replacement and metadata-only status; debug diagnostics without
  credential-derived data; `model:check` credential presence by name and origin; no
  migration and no portable-format change. See
  [ADR-0020](../adr/ADR-0020-managed-provider-credential-boundary.md).
- **Gateway execution for Anthropic models.** Acceptance: a native adapter that
  applies or rejects `reasoning_effort` and `max_output_tokens` exactly, reports
  the effective model and request ID, and passes the same gateway worker
  metering, mismatch and budget tests as OpenAI.
- **Budget co-reservation.** Acceptance: a gateway run atomically reserves its
  `agent_run` budget together with any configured project, task and agent
  budgets, and releases all of them on failure.
- **Audited override management.** Acceptance: an operator command changes
  host-global or project overrides with an audit record, never from an agent,
  and never alters an already scheduled run.
- **Dashboard rendering.** Acceptance: run detail shows assigned model, actual
  model, usage and gateway-metered versus client-reported cost from the existing
  read model without exposing host paths or credentials.
- **Routing reload.** Acceptance: an explicit, audited reload replaces the frozen
  routing state atomically between schedules without restarting the Runtime.

## M8 — Code intelligence

Status: future.

- incremental file indexing;
- TypeScript symbol extraction;
- import and call edges;
- FTS5;
- change-impact query;
- optional embeddings.

## M8.5 — Intelligent context assembly

Status: future.

- task-aware context builder, extending the M7.11 `RunContextAssembler` seam;
- memory and code retrieval, including semantic project memory retrieval;
- dependency-aware context;
- token-budgeted context packing;
- provenance for assembled context.

## M9 — Productization

Status: future.

Focus: user-facing product surfaces, packaging, and operability.

- web UI beyond the local read-only operations console shipped in M7.8;
- plugin SDK;
- MCP server;
- packaged binaries;
- remote snapshot transport with a deterministic filesystem adapter;
- optimistic-concurrency push/pull and explicit divergence diagnostics;
- GitHub, S3-compatible, and R2 remote adapters after the transport contract is
  proven independently of any provider.

Portable backup/restore shipped in M7.6. Remote snapshot transport remains
future work and must not copy mutable SQLite files or silently overwrite a
newer remote head.

## M9.5 — Multi-machine semantic sync

Status: future.

Focus: evolve from whole-project snapshots to immutable changes or
entity-level revisions with globally unique identifiers. Independent changes
may then merge when they touch different entities; incompatible concurrent
writes require explicit conflict resolution. This milestone does not imply an
event-sourced rewrite of the current runtime.

## M10 — Security hardening

Status: future.

Focus: stronger security boundaries and hostile-local-process resilience. This
scope is separate from M9 productization.

The hardened M6C assessment, ADRs, and native spike remain the research baseline
for this future milestone. They are not production components and are not
requirements for M6D-lite. M10 includes:

- Rust/openat2 production filesystem boundary;
- cryptographic or hardware user-presence approvals;
- hardened hostile-local-process threat model;
- tamper-evident audit chain and optional external anchoring;
- advanced crash recovery and reconciliation;
- durable filesystem mutation journal;
- native artifact build, signing, and supply-chain hardening;
- multi-platform hardened execution and capability qualification.

## M11 — Agent Pipeline Engine

Status: in progress; enforcement foundation implemented.

Goal: add a durable, generic orchestration layer that executes validated office
pipelines without embedding software-development or GitHub-specific business
logic in the runtime, a connector, or a host skill.

Conceptual primitives, subject to design assessment before implementation:

- `Pipeline`: a versioned declarative workflow definition;
- `PipelineStage`: one stage definition and its responsibility boundary;
- `PipelineRun`: one durable execution of a pinned pipeline definition;
- `StageRun`: one durable stage execution or attempt within a pipeline run.

Implemented foundation:

- guidance-only versus explicitly enforced manifest definitions;
- pinned, restart-safe sequential pipeline and stage runs bound to existing tasks;
- registered-agent assignment with role matching and configurable separation of duties;
- stage-scoped capability intersection in action request and execution-time revalidation;
- explicit completion, approval, rejection, cancellation, and attributed override events;
- daemon-backed start, status, assignment, transition, and override commands;
- pipeline diagnostics in project status and append-only audit integration.

Still future within M11: branching, bounded cycles, retries/timeouts,
machine-interpretable artifacts, generalized conditions and failure
compensation. Explicitly scheduled runs can use the first bounded text worker
through an explicit tick. Successful completion of a stage-bound run is
reconciled into its bound pipeline stage, subject to approval gates and
pipeline semantics. Automated dispatch and orchestration of subsequent work
without repeated operator-driven ticks arrived with M11.5 queue-backed
orchestration, which is disabled by default.

A future pipeline definition must be able to describe:

- responsible role and deterministic agent assignment rules;
- task, inputs, outputs, and typed or structured artifacts;
- required capabilities and applicable policy references, without granting
  those capabilities merely by declaring them;
- conditions, dependencies, transitions, branching, and bounded cycles such as
  `review -> fix -> review`;
- retries, timeouts, cancellation, failure handling, compensation or escalation
  where meaningful;
- workflow approval gates and human checkpoints;
- complete, sanitized provenance and audit.

The daemon and application services remain authoritative for orchestration
state. Domain rules own legal transitions and invariants; infrastructure ports
invoke workers and connectors. No SQLite transaction may remain open while a
worker, provider, subprocess, Git operation, connector call, or human approval
is pending. Recovery must be explicit and replay-safe, especially where an
external effect has an ambiguous outcome.

Pipeline policy must be able to enforce separation of duties from actual agent
and stage-run provenance. Role labels alone are not sufficient evidence of
independence. Workflow approval gates remain separate from M5 governance
reviews and M6 controlled-action approvals; none substitutes for another.

This milestone should also establish a provisional structured-artifact contract
for machine-interpretable stage outcomes, while avoiding a prematurely stable
public schema.

The delivered foundation depends on M3 agent/run foundations, M5 governance,
M6A policy, M6D-lite controlled actions and M6E manifests. A first worker slice
requires explicit bounded context and a reviewed execution/authority boundary;
it does not require the whole M8/M8.5 index and retrieval system. Advanced
context selection remains M8.5. The milestone number preserves historical
organization, not a requirement to finish all M8–M10 scope before extending the
already-implemented sequential foundation.

Exit direction:

- a pipeline run pins the definition and policy inputs needed for reproducible
  decisions;
- stage state survives restart and produces an end-to-end audit trail;
- branching, bounded review/fix cycles, failure, cancellation, and approval
  gates have deterministic semantics;
- stage execution cannot create authority outside the capability system;
- the engine contains no GitHub-, Codex-, Claude-, Gemini-, or OpenCode-specific
  workflow logic.

## M11.5 — Durable Queue-Driven Agent Orchestration

Status: implemented.

Goal: make an enforced PipelineRun progress through the existing authoritative
agent and approval lifecycle without requiring repeated `run:tick` commands.

Implemented:

- provider-neutral application queue and outbox ports with an optional BullMQ
  adapter for host-local Redis/Valkey;
- additive SQLite transactional outbox with bounded secret-free payloads,
  deterministic delivery IDs, at-least-once replay, and sanitized queue health;
- Runtime-owned dispatcher and logical orchestration/AgentRun consumers with
  graceful shutdown and pending-intent restart recovery;
- manifest-driven deterministic agent assignment, exact canonical role identity,
  separation checks, and SQLite validation on every delivery;
- persisted/versioned role guidance loaded during `agent:sync`, pinned to each
  AgentRun, included in execution provenance, and injected separately from
  generic Runtime constraints;
- fenced AgentRun completion bridged to exact current PipelineStage completion,
  approval blocking, automatic next-stage orchestration, and terminal task
  completion.

BullMQ is delivery only: it is not a workflow engine, authority store, approval
store, model router, capability grant, memory store, or audit log. Retry policy
is application-owned and excludes ambiguous effects, stale fences, validation
failures, and approval decisions. CairnKeep integration has been retired.

Redis/Valkey is an external operator prerequisite and is never installed by AI
Office. Redis data loss is recoverable for pending SQLite outbox intent; a
completed authoritative run is a safe no-op when a stale job is replayed.
Multi-host scheduling, stronger hostile-local-process security, persisted
Artifact Review & Approval runtime behavior, branching/cycles, autonomous memory
promotion, and true tool-loop or worktree execution remain future work under
M11.6/M12/M14.

## M11.6 — Artifact Review & Approval Workflow

Status: Phase A documented; Phases B-D future.

Goal: make reviewable output a generic, cross-domain orchestration capability.
AI Office is not a software-development workflow engine: software engineering is
one domain adapter over the shared task, artifact, review, approval and
authoritative-execution model.

The capability does not replace the current Task, AgentRun, PipelineRun, M5
governance review, M6 controlled-action approval, or Runtime audit. It
coordinates them while preserving each subject, authority boundary, provenance
and recovery rule. The current runtime does not yet persist or execute this
workflow.

### Phase A — Domain model and documentation

Status: documented by [ADR-0021](../adr/ADR-0021-artifact-review-and-approval-workflow.md),
the [domain model](../architecture/domain-model.md), and the
[architecture overview](../architecture/overview.md).

- define a verifiable, non-file-specific Artifact and immutable artifact
  versions with logical identity, type, metadata, producer AgentRun/operator
  provenance, and stable fingerprint;
- define separate ReviewRequest and ReviewResult concepts, with every review
  bound to the exact artifact version/fingerprint;
- define pluggable human, LLM, policy/rules, CI, external-system, and
  domain-specific reviewers without making an LLM the default authority;
- define deterministic ReviewPolicy for required/optional reviewers, quorum,
  artifact type, risk, domain routing, and mandatory human approval;
- define stale-review semantics, correction loops, audit/provenance, replay and
  recovery invariants;
- document the distinction between work executed, artifact produced, artifact
  reviewed, artifact approved, external action executed, and task completed.

This phase changes documentation only. It does not claim a persisted Artifact
aggregate, review commands, policy evaluator, or new Task status values.

### Phase B — Core Runtime

Status: future.

- persist artifacts and immutable versions, fingerprints, producer provenance and
  external-resource references;
- persist review requests/results and append-only stale transitions;
- evaluate review policies and quorum deterministically;
- support changes_requested -> new AgentRun -> new artifact version -> new
  review while retaining one task and the full history;
- expose artifact/review/approval state through the authoritative Runtime and
  existing operational read-model conventions;
- emit or extend existing audit events only after checking for duplicate
  lifecycle events; candidate names include artifact.created,
  artifact.version_created, review.requested, review.completed,
  review.changes_requested, review.approved, review.stale, artifact.approved,
  and artifact.released;
- preserve exact artifact fingerprint, review/approval identity, policy/plan hash,
  producer/reviewer provenance, and execution binding for replay and recovery.

The implementation must choose compatible aggregates, migrations, ports and
read-model projections. It must not add a competing review engine or hold a
transaction open across workers, providers, human decisions, connectors or
external effects.

### Phase C — Software adapter

Status: future; depends on M13 and M14.

- represent a Git Pull Request as a software-domain PullRequestArtifact, not
  as a core-domain entity;
- retain repository, branch, base branch, PR number/URL and a version fingerprint
  such as headSha;
- support human, LLM, CI/check and security reviewers through adapters;
- ensure approval of abc123 cannot authorize merge of def456;
- connect approved artifacts to the existing GitHub connector and authoritative
  merge executor only after all policy and controlled-action gates pass.

A software flow is therefore Task -> AgentRun -> branch/PR artifact ->
ReviewRequest -> independent reviews -> approval -> authoritative GitHub merge.
PR/code review is one specialization, not the platform model.

### Phase D — Domain adapters

Status: future; depends on M11.6 core runtime, M12, M15 and relevant product/security work.

Assess domain packs or adapters for manufacturing, legal, finance, operations,
compliance, procurement and other professional workflows. Candidate artifact
types include process-change proposals, quality plans, legal research
memoranda, contract drafts, court-filing drafts, purchase-order proposals,
accounting reports and compliance reports. Candidate package names such as
@ai-office/domain-manufacturing or @ai-office/domain-legal are directional
only and are not selected package contracts.

A manufacturing flow may be:

```text
Reduce reject rate on production line 4
  -> Quality Analyst Agent analyzes MES data
  -> Process Change Proposal v1
  -> Process Engineer review
  -> Quality Manager approval
  -> authoritative MES executor
  -> production-metric verification
  -> Task completed
```

The AI may propose 182°C -> 178°C, but it cannot equate the proposal with a
process change. Only an authorized executor may mutate MES/PLC/SCADA state, and
every proposal, review, approval, execution and observed outcome needs
provenance/audit.

A legal flow may be:

```text
Defensive brief task
  -> Legal Research Agent -> Research Artifact
  -> Legal Drafter -> Draft v1
  -> Legal LLM Reviewer -> findings
  -> Draft v2 -> citation/policy checks
  -> Lawyer Reviewer -> approved
  -> authoritative publication/submission
  -> Task completed
```

Professional approval may be mandatory human approval even when citation
checking or policy checking is automated. The system must identify the exact
draft version actually approved.

### Cross-phase invariants

- an agent cannot self-assert approval unless policy explicitly permits it;
- every approval identifies the exact artifact version/fingerprint reviewed;
- changing an artifact makes earlier approval stale/non-current unless policy
  explicitly defines otherwise; history is never deleted;
- review is not authorization for an external side effect;
- human review is a first-class state;
- replay/recovery never converts stale approval into current approval;
- AgentRun completed != Task completed when review is required;
- domain adapters cannot weaken provenance, identity, policy, capability,
  authoritative-executor or audit invariants.

## M12 — Worker runtime adapters and organization profiles

Status: future.

A bounded precursor is implemented: explicit `run:tick --worker claude|codex`, an
application worker port, tool-free task/stage context, immutable dispatch
provenance and inspectable generated output. It does not deliver the complete
M12 organization profiles, repository-editing Codex execution, or M14 software vertical. See
[agent runtime](agent-runtime.md) and [ADR-0017](../adr/ADR-0017-bounded-external-worker.md).

Follow-up recorded from the bounded Codex worker: delegation must become
governed child execution rather than executor-internal work. The Codex worker
refuses every model for which the client can start native sub-agents, because
such a child ran on another model outside the run's provenance and usage. A
governed design needs a child AgentRun with `parent_run_id`, a delegated role
and purpose, its own executor identity, model routing and reasoning effort, a
delegated capability subset, a token and cost budget with aggregated usage,
limits on children and depth, cancellation and failure propagation,
provenance, fencing, lifecycle and queue integration, and an execution tree in
the dashboard. Native Codex or Claude delegation should require Runtime
admission. Executor credentials should likewise be modelled by trust mode.

Follow-up recorded from the bounded Codex worker: executor-level filesystem
confinement. The worker runs Codex under its read-only sandbox, which prevents
writes but not reads: the client's built-in `apply_patch` reveals whether a
host path exists and whether a guessed line is in it, invisibly to the
Runtime, and `codex-cli` 0.160.0 has no supported setting that removes the
tool (see [agent runtime](agent-runtime.md)). Confidentiality of the Runtime
user's files therefore needs an outer boundary built by the executor, not by
the client. Candidates to investigate: on Linux, Bubblewrap or user
namespaces with explicit read-only roots, the host home, configuration and
secrets hidden, and only the system libraries and certificates the client
needs; on macOS, a Seatbelt policy with explicit read roots and the minimum
platform reads; alternatively a containerized executor with a deliberately
constructed filesystem view. The boundary must show the worker only its
isolated `HOME`/`CODEX_HOME` and explicitly mounted inputs, make arbitrary
host paths invisible so that absolute-path probes cannot distinguish host
state, keep provider networking working, keep credential handling bounded and
keep cleanup deterministic.

Other follow-ups recorded from the bounded Codex worker review, none of them
addressed yet: the process-group wait has no upper bound when the Runtime is
itself the reaper of orphaned processes; an unrouted run without
`--worker-model` is refused with `WORKER_MODEL_REQUIRED` only at execution,
after probes and dispatch provenance, rather than before dispatch; the tests
do not fail when the `O_NOFOLLOW` open or the owner check of the login file
is removed; the collaboration and provider-metadata refusals are tested
against a fake CLI, so they are re-verified by hand for each audited version;
and the client's own outbound connections to the provider's hosts during a
run, attributed to its analytics, have not been enumerated.

Goal: make worker execution replaceable and extend onboarding from office
description to an explicit, reviewable organization-to-runtime mapping.

- define a worker-runtime application port for starting, observing, cancelling,
  and collecting normalized stage results;
- add adapters incrementally for evidenced runtimes such as Codex, Claude Code,
  Gemini CLI, OpenCode, and local or CI-backed workers;
- derive architect, developer, reviewer, QA, security, and other behavior from
  the agent profile, pipeline stage, effective context, policy, and capability
  set rather than hardcoding it in a client adapter;
- keep provider/model invocation behind the LLM gateway and coding-worker
  execution behind the runtime port; these are related infrastructure choices,
  not one abstraction;
- keep M6F project instruction integration distinct from worker execution:
  configuring a client to consume project instructions does not make it an
  authenticated or authorized pipeline worker;
- record runner identity, adapter/version, assigned agent identity, inputs,
  outputs, and outcome provenance without exposing credentials or hidden model
  reasoning.

Future onboarding may:

1. detect available coding runtimes and supported versions;
2. detect configured external integrations such as GitHub installations;
3. propose mappings from organization roles to runners;
4. plan and, after explicit confirmation, configure the required adapters;
5. propose initial capability requests and constraints without silently granting
   them;
6. offer pipeline templates and client-specific instruction integration.

An illustrative result could map Architect to Codex, Developer to Claude Code,
Reviewer to Codex, and QA to a local or CI worker. Such a mapping never weakens
independence policy: using the same runtime product for two roles does not imply
that the same agent identity or execution may implement and independently
review one change.

Depends on: M11, M6F external client integration, and M8.5 effective context
assembly.

## M13 — GitHub connector and GitHub App

Status: future.

Goal: expose GitHub as a protected external resource through the connector
model, with GitHub App authentication and controlled inbound and outbound
integration.

- GitHub App installation and repository authorization, with credentials kept
  behind infrastructure credential references and never exposed to agents;
- signed webhook ingestion with delivery deduplication, replay handling,
  project/repository ownership validation, and sanitized audit;
- project-scoped repository resources and controlled operations for issues,
  branches, commits and push, pull requests, reviews, review comments, checks,
  and merge;
- trusted operation descriptors, constraints, risk, simulation or preview where
  possible, approval requirements, execution-time revalidation, and outcome
  handling consistent with the M6 connector boundary;
- correlation between external GitHub identities/events and internal pipeline,
  stage, artifact, action, and audit identities;
- GitHub Actions evaluated as an optional execution backend, check producer, or
  integration point, never as AI Office's primary orchestrator.

Webhook adapters translate authenticated external deliveries into application
commands or facts. They do not choose the next role or directly bypass pipeline
and policy evaluation. The connector performs authorized GitHub operations but
does not decide who develops, who reviews, when QA or security is required, or
whether merge policy is satisfied.

The implementation assessment must decide the exact boundary between local Git
worktree/commit operations, remote Git transport, and GitHub API operations.
That split must preserve the current rule that agents do not receive direct
repository, shell, credential, or connector authority.

Depends on: M6 connector and controlled-action foundations and M11 pipeline
orchestration. M12 workers may consume the connector through those boundaries;
they must not depend on GitHub SDK objects directly.

## M14 — Software development pipelines

Status: future.

Goal: build reusable, policy-governed software delivery workflows on the generic
engine, worker-runtime ports, and GitHub connector.

Initial role responsibilities should remain configurable but preserve these
default boundaries:

- **Architect:** request analysis, assessment, design, implementation plan,
  risks, and acceptance criteria; normally no implementation capability for the
  same change;
- **Developer:** branch/worktree implementation, tests, commits, and requested
  fixes; no authority to approve the developer's own work;
- **Reviewer:** independent correctness, maintainability, and architectural
  review, with changes requested or approval; ideally no capability to mutate
  the branch under review;
- **QA:** builds, automated and acceptance testing, failure-path and regression
  verification;
- **Security:** risk- or policy-triggered security review with only the
  capabilities required for that assessment.

Separation of duties is a policy invariant, not a prompt convention. For one
change, an implementing agent must not also act as its independent reviewer,
approve its own pull request, bypass required gates, or merge when policy
requires a distinct reviewer, security reviewer, or human. The Policy Engine
must evaluate agent identity, role, stage provenance, artifact subject, and
required approvals before advancing or permitting merge.

Reusable declarative templates may cover feature, bugfix, hotfix,
dependency-update, and release workflows. A possible project layout is shown
only to communicate direction; no path or file format is selected yet:

```text
.ai-office/
|-- office.yml
|-- agents/
|     |-- architect.yml
|     |-- developer.yml
|     |-- reviewer.yml
|     |-- qa.yml
|     `-- security.yml
|-- pipelines/
|     |-- feature.yml
|     |-- bugfix.yml
|     |-- hotfix.yml
|     |-- dependency-update.yml
|     `-- release.yml
`-- policies/
      |-- repository.yml
      |-- reviews.yml
      `-- merge.yml
```

A software-delivery pipeline may coordinate assessment, plan approval,
branch/worktree preparation, implementation, test, push, pull request, structured
review, bounded fix loops, QA, conditional security review, human approval, and
merge. The engine owns this lifecycle; GitHub only reflects and performs the
external repository operations it is authorized to expose.

Agent reviews should be able to return machine-interpretable artifacts in
addition to human-readable text. A provisional shape may contain `decision` and
`findings`, with each finding carrying severity, category, file, line, message,
and suggestion. The pipeline can then apply policy, publish GitHub comments,
start a fix loop, or block/allow later stages. Exact schema, diff anchoring, and
versioning remain design work.

Risk-based routing should integrate with, but not silently redefine, the
existing trusted operation risk model. An illustrative change-risk policy could
route low-risk work through tests and independent review with optional
autonomous merge, medium-risk work through mandatory independent review,
high-risk work through review plus security review and human approval, and
critical work through mandatory human approval and merge. These levels and
gates are examples, not a finalized classification.

Depends on: M11 Agent Pipeline Engine, M12 worker runtime adapters, M13 GitHub
integration, M6A policy/capability enforcement, and the relevant M8/M8.5 code
intelligence and context foundations.

Exit direction:

- feature and fix workflows complete through branch, pull request, independent
  review, bounded remediation, QA, policy approval, and merge;
- structured review findings drive deterministic gates without trusting free
  text as authorization;
- separation-of-duties violations fail closed;
- merge is impossible until all effective policy gates are satisfied;
- changing the selected worker runtime does not change workflow semantics.

## M15 — Domain-neutral professional work and vertical profiles

Status: design assessment and architectural decision; no M15 runtime
implementation.

Goal: prove that the orchestration, policy, provenance, approval, artifact, and
audit foundations can support professional work beyond software development
without weakening the existing software vertical or prematurely renaming its
implemented aggregates.

The current `Project` model, repository binding, software governance vocabulary,
and M14 delivery workflows remain valid. M15 must first define a compatibility
boundary between that implemented model and any more general professional-work
concepts. Candidate conceptual terms such as `Workspace`, `Matter`, or
`WorkUnit` are design vocabulary only until a milestone assessment and, where
necessary, an ADR select concrete domain and storage changes.

M15-1 records the [shared-model boundary assessment](m15-shared-professional-model.md).
M15-2 and M15-3 exercise it with a [legal design probe](m15-legal-design-probe.md)
and a [manufacturing exception-management design probe](m15-manufacturing-exception-management-probe.md).
M15-4 records the [accepted cross-domain authority and evidence boundary](../adr/ADR-0027-cross-domain-authority-and-evidence.md):
one Project authority with a tagged portable key, versioned trusted knowledge
scope, deterministic mandatory evidence and domain-scope composition, and
verified professional-decision principals. These are design artifacts; their
target contracts are not implemented Runtime capabilities. Later implementation
slices must specify storage, wire formats and provider protocols, and cover
fresh and upgrade behavior before production use.

Core capabilities to assess:

- a domain-neutral work container that can host tasks, requirements or
  obligations, artifacts, evidence, events, decisions, reviews, approvals, and
  pipelines without assuming a Git repository;
- the Artifact Review & Approval capability, including exact version binding,
  stale-review semantics, correction loops, policy-driven reviewer requirements,
  and separation from authoritative external execution;
- first-class provenance from source material through extracted evidence or
  claims, agent/stage execution, generated artifacts, review, and final human
  approval;
- source anchoring precise enough for domain adapters to identify document,
  revision, page, paragraph, record, or other stable evidence location;
- explicit states for assertions or evidence such as alleged, supported,
  disputed, established, superseded, or domain-defined equivalents, without
  allowing model confidence to substitute for verification;
- vertical-defined human checkpoints and prohibited transitions, while keeping
  approval authority deterministic and outside model judgment;
- domain-scoped capability constraints and access control that compose with the
  existing deny-by-default policy rather than bypassing it;
- vertical profiles or plugins for domain vocabulary, pipeline templates,
  structured artifact schemas, connectors, and policy presets;
- retention, redaction, confidentiality, export, and audit requirements exposed
  through explicit contracts rather than hidden in prompts.

### Product editions and deployment profiles

M15 should preserve one shared core while allowing distinct deployment
profiles. `Lite` and `Pro` are packaging and infrastructure profiles, not
separate product forks and not duplicated domain implementations.

Candidate direction:

```text
AI Office Lite
  - local-first, single-user
  - SQLite authority
  - local filesystem artifacts
  - local Runtime / CLI / dashboard

AI Office Pro
  - shared organization deployment
  - Supabase-backed PostgreSQL authority
  - Supabase Auth, Storage, RLS, and Realtime where appropriate
  - multi-user organization / site / department boundaries
  - domain packs and external-system integrations
```

The orchestration, capability, approval, provenance, audit, agent, task, and
pipeline semantics must remain common to both profiles. Product packaging must
not introduce edition-specific policy branches throughout the core. Optional
capabilities should instead compose through explicit modules and ports.

Portable project state should remain a migration boundary between local and
shared deployments. A future Lite-to-Pro migration must preserve compatible
project state without transferring machine-local capability grants, action
approvals, secrets, or other non-portable authority.

Supabase is the preferred candidate data platform for Pro because it combines
PostgreSQL, authentication, object storage, RLS, and realtime facilities behind
one operational platform. ADR-0022 records the persistence boundary:
repository ports and server-side PostgreSQL transactions are shared paths, while
SQLite remains the Lite composition and Supabase Auth, Storage, RLS, and
Realtime remain future capabilities.

PR #55 adds the centralized `ProjectStorageBootstrap` boundary. SQLite remains
the default and complete Runtime authority. PR #56 adds PostgreSQL governance
parity: `ProjectRepository`, `TaskRepository`, `TaskRequirementRepository`,
`GovernanceRepository`, and `TransactionRunner` are now implemented and
contract-tested against real PostgreSQL. The governance slice includes
milestones, full requirements, ADRs, reviews, approvals, governance events,
project ownership constraints, append-only rules, transactional finalization,
the same-project requirement/milestone composite foreign key with
column-specific delete nulling, and persistent review-subject ownership guards.
The following AgentRuntime and audit slice adds the complete
`AgentRuntimeRepository` and `AuditEventRepository` ports. It extends the
existing identity-only `core.agent_run` review subject in place and adds only
read-only pipeline projections needed for worker fences; it does not add
PipelineRunRepository parity. The next office/pipeline vertical slice evolves
those same `core.pipeline_run` and `core.pipeline_stage_run` tables in place,
adds authoritative `OfficeManifestRepository` and `PipelineRunRepository`
persistence, and adds the append-only `core.pipeline_override` relation.
PostgreSQL remains intentionally partial: its implemented capability groups are
exactly `projects`, `packBindings`, `definitions`, `officeManifests`,
`pipelines`, `tasks`, `taskDependencies`, `taskRequirements`, `governance`,
`runtime`, `auditEvents`, and `transactions`; a request to use it as complete Runtime authority still
fails closed with the missing capability list; no SQLite fallback or hybrid
authority is allowed. PostgreSQL connection configuration is explicit
through `AI_OFFICE_STORAGE_PROVIDER=postgres` and `AI_OFFICE_POSTGRES_URL`, and
secrets remain runtime configuration rather than project state.

The next storage slices are parity for the remaining `ProjectStorage` repositories
(profiles, costs, capabilities/resources, controlled actions, repository identities,
project state, memory, operational reads, or job outbox as dependency analysis
warrants). Only after all required `ProjectStorage`
repositories exist may PostgreSQL become a complete Runtime authority.

### Manufacturing reference vertical

Manufacturing is a reference operational vertical alongside the legal design
probe. Legal stresses provenance, evidence, professional approval, and
confidentiality; manufacturing stresses event-driven orchestration,
departmental boundaries, high-volume operational context, physical-world side
effects, and integration with systems of record.

The manufacturing vertical should be able to model domain context such as:

- organization, site, department, work center, production line, and machine;
- product, material, BOM, routing, production order, operation, batch, and lot;
- warehouse, inventory, stock movement, shipment, supplier, and purchasing
  context;
- quality checks, non-conformities, scrap, CAPA, and maintenance events;
- commercial, accounting, logistics, and planning relationships needed to
  coordinate work across departments.

The first implementation direction should focus on exception management rather
than direct machine control. Candidate end-to-end scenarios include:

1. delayed production order;
2. material shortage affecting an order;
3. abnormal scrap or quality event.

AI Office should orchestrate analysis, task creation, assignment, escalation,
approval, and controlled actions while ERP, MES, WMS, QMS, CMMS, PLC, and other
industrial systems remain authoritative for their own operational data and
execution responsibilities.

Direct model-to-machine mutation is outside the intended boundary. Physical or
safety-relevant actions must pass through deterministic services, capability
policy, execution preconditions, and human approval where required.

### Domain Store and canonical operational model

Pro deployments should assess a domain-specific operational store behind a
generic Domain Provider boundary. The domain store is not a replacement ERP,
MES, WMS, QMS, or CMMS. It is a canonical, queryable context layer that can
normalize external identities and relationships while preserving source-system
ownership and provenance.

For a Supabase-backed Pro deployment, candidate schema boundaries are:

```text
core.*
manufacturing.*
integration.*
audit.*
```

The manufacturing store may contain normalized entities and event projections,
while source systems remain authoritative. High-frequency telemetry should not
be copied blindly into the AI Office authority database; event buses,
historians, or time-series systems remain appropriate for machine-scale data.

The generic application boundary should support operations conceptually similar
to:

```text
DomainProvider
  - getEntity(reference)
  - query(query)
  - getDocuments(reference)
  - getEvents(reference)
```

Agents should consume domain data through this boundary, never through direct
database credentials or unrestricted SQL.

Shared deployments should assess first-class organization structure without
forcing it into software-project vocabulary:

```text
Organization
  -> Site
    -> Department
      -> Team
        -> Role / Agent
```

Department and site scope should compose with the existing deny-by-default
capability system and future authenticated user identity. Supabase RLS may
enforce storage visibility, but it does not replace AI Office capability policy
or controlled-action authorization.

Manufacturing integrations should favor event-driven ingestion and typed
connectors:

```text
ERP / MES / WMS / QMS / CMMS / OPC-UA / MQTT
                    |
                    v
          integration / event layer
                    |
          +---------+---------+
          |                   |
          v                   v
    domain projections   AI Office triggers
```

Supabase Realtime may support user-facing synchronization and operational views,
but it is not assumed to be the industrial event bus. MQTT, NATS, Kafka, or
another dedicated transport may be more appropriate depending on deployment
scale and latency requirements.

### Legal reference vertical

Legal work is the reference second vertical for testing the domain-neutral
boundary because it stresses provenance, evidence, separation of duties,
confidentiality, irreversible external actions, and human accountability.
Illustrative concepts include a legal matter, parties, source documents,
facts/claims, evidence, deadlines/events, legal issues, drafts, reviews, and
filing or communication artifacts.

An illustrative pipeline may coordinate:

```text
document intake
  -> classification and source registration
  -> fact / chronology extraction
  -> legal-issue identification
  -> authorized research
  -> draft
  -> adversarial review
  -> citation / source verification
  -> human lawyer review and approval
  -> controlled external action
```

The legal vertical must preserve at least these invariants:

- generated legal assertions and citations are traceable to authorized sources;
- free-text model output is never itself evidence of a source, decision, or
  approval;
- generated, reviewed, approved, communicated, and filed are distinct states;
- no pipeline may advance directly from AI generation to an external filing or
  client/court communication when policy requires human approval;
- a vertical connector may expose case-law, document-management, calendaring,
  filing, or communication operations, but it does not decide strategy or grant
  itself authority;
- adversarial agents may challenge a draft, but the engine must preserve their
  provenance and any required independence rather than treating role labels as
  proof;
- confidential matter access is scoped explicitly and auditable;
- domain plugins may implement conflict checks, citation verification, document
  redaction, evidence timelines, legal holds, and court/deadline integrations
  without moving those concerns into the generic pipeline engine.

This roadmap item is an architecture and product direction, not a claim that the
current product provides legal advice, satisfies professional obligations, or is
ready for regulated legal deployment. Jurisdiction-specific professional,
privacy, retention, security, and human-supervision requirements require their
own assessment before production use.

Depends on: M11 orchestration and structured artifacts, M9 plugin/product
surfaces, M12 worker-runtime adapters, M10 security work where the deployment
threat model requires it, and lessons from M14 as the first complete vertical.

Exit direction:

- software delivery remains a first-class vertical rather than a special case
  embedded in generic orchestration;
- a second vertical can define its own vocabulary, artifacts, connectors, and
  policy without forking pipeline, capability, approval, or audit engines;
- source-to-claim-to-artifact provenance is queryable and survives review;
- vertical human gates are deterministic, enforceable, and auditable;
- repository identity is no longer an accidental prerequisite for generic
  professional-work orchestration.

See [Professional-work verticals](professional-work-verticals.md).

## M16 — Generic Core & Domain Packs

Status: active in AI Office and in progress. GP-03 public contracts, GP-04
host-local catalog/resolver, GP-05 exact project binding, GP-07 definition
ownership and source-pinned overrides, and GP-06 derived effective
configuration with read-only inspection are merged. Pack-driven Runtime
behavior remains planned.

AI Office is transitioning from a software-development-oriented implementation
into a domain-neutral operational core. Domain-specific semantics are supplied
by Domain Packs built on stable core contracts. M15 assesses the reusable work
container, artifact/evidence, approval, provenance, tenant, and deployment
boundaries; M16 specifies pack installation and progressively extracts the
development vertical. M16 depends on the relevant M11/M11.6 orchestration and
artifact contracts, M14's software workflows as extraction input, M15's
cross-domain architecture decision, and the existing AgentKnowledgeStore and
ProjectStorage authority boundaries. M9's broad plugin SDK and a package
marketplace are not prerequisites.

The core keeps project authority, tasks, AgentRuns, pipeline execution,
governance, approval enforcement, controlled actions, audit, storage and
knowledge ports. Packs contribute versioned defaults and templates for domain
roles, agent archetypes, task and artifact types, pipeline templates, stronger
policies, evidence/approval requirements, terminology, prompts, knowledge
guidance, and capability needs. The project owns its instantiated definitions:
it can replace, extend, disable, or override pack contributions and define a
complete office with no official pack. A deterministic resolved project
configuration combines pinned pack versions, project definitions and overrides
before the existing Runtime consumes it. Pack definitions never grant capability
or replace core lifecycle engines. Runtime composition may load trusted packs;
domain and application core packages must not import a pack implementation.

The first reference pack is `development`; final package naming follows the
package-boundary ADR. It receives the current software roles, repository and
GitHub concepts, code review, CI evidence, and software pipeline defaults in
compatibility stages. Minimal `legal` and `manufacturing` reference packs test
the same runtime, task, agent, pipeline, review, approval, storage, knowledge,
audit, and provenance contracts without claiming legal-product or MES readiness.
Pack selection is project-owned and authoritative where explicitly set. The
transition is additive: (1) add contracts without behavior change; (2) add
deterministic resolution of packs, project definitions and overrides; (3) map
existing projects through a visible implicit development compatibility profile
without rewriting their office, roles, agents or pipelines; (4) extract
development defaults incrementally and prove semantic parity; (5) offer an
explicit, reviewed development-pack adoption path; (6) consider requiring
explicit pack selection for _new_ projects only after empty/custom projects are
supported. Existing projects continue operating at every stage. Missing or
incompatible explicitly selected packs fail closed; legacy compatibility is
versioned and auditable, never a silent replacement. A future multi-pack
project uses explicit namespace, conflict, and policy composition rules rather
than import order. Pack upgrades do not overwrite project-owned modifications.

Delivery tasks GP-01–GP-21 (with GP-10A/B/C extraction slices), the
post-GP-06 hardening follow-ups GP-22 and GP-23, and their
dependency graph, acceptance criteria, extraction inventory, migration stages,
and non-goals are in the
[Generic Core & Domain Packs plan](generic-core-domain-packs.md). The
[accepted core/pack boundary ADR](../adr/ADR-0026-core-domain-pack-boundary.md)
is the GP-02 architectural decision, not an implemented Runtime contract. The
[M15-4 decision](../adr/ADR-0027-cross-domain-authority-and-evidence.md)
supplies its four authority/evidence prerequisites; GP-02 reviewed the
contract against them after M15-4 integration. The AI
Office project record has a distinct active M16 milestone with one requirement
linked to each task. Existing GP task prerequisites are stored as typed task
dependency edges; GP-02's cross-milestone M15-4 prerequisite is also stored as
a typed task dependency edge in the project Runtime. GP-10A/B/C remain separately tracked extraction
slices.

GP-01's source audit and extraction map passed final repository review.
M15-4's authority/evidence decision passed final repository review in PR #81.
GP-02 completed the ADR-0026/ADR-0027 alignment review and accepted the
Domain Pack contract. GP-03's schema-1 contract package passed implementation
review and merged in PR #84. GP-04 adds only a host-local installed-pack
catalog and exact dependency closure; it does not persist project selection
or alter Runtime project semantics. GP-05 adds an authoritative, audited,
portable exact selection with a checked project pack configuration revision;
SQLite and PostgreSQL use forward migrations, and portable archives add
format version 5. Operators can show, preview and apply a selection through
the Runtime. An empty selection remains valid and no pack is inferred from
the project or host. GP-05 does not resolve project definitions or change
running work. GP-07 adds project-owned descriptive definitions and typed
project-owned workflows, exact pack-source overrides, constrained
replace/extend/disable operations, conflict/security validation, SQLite and
PostgreSQL persistence, audited checked revisions and portable archive format 6. Existing OfficeManifest, role, agent, pipeline, task, run pin and binding
state remain unchanged. GP-06 resolves exact packs and project definitions into
a derived, digest-pinned, inspectable view without scheduling from it. GP-08
adds `project:pack:upgrade`: a read-only reconciliation report and a
digest-approved, audited apply that changes the selection and retargets project
overrides together, preserves project values, and blocks on unresolved
conflicts; it adds no migration and no run pinning. GP-11 defines pack role
archetypes as a definition layer: a stable role identity independent of pack
version and presentation, declarative pack-owned role capabilities in the
schema-1 manifest, project rename, replace, omit and add, and deterministic
upgrade merge rules with capability changes bound to plan approval. It adds
forward SQLite and PostgreSQL migrations for role omission and portable archive
format 7, and creates no Runtime role, grant or binding. GP-12 defines pack
agent archetypes as the same kind of definition layer: a stable agent identity,
declarative role, prompt, knowledge and requested-capability references in the
schema-1 manifest with requests bounded by the role's declared set, project
replace, disable and add, and upgrade rules that reuse GP-08 and GP-11. It adds
forward SQLite and PostgreSQL migrations for agent disable and portable archive
format 8. It creates no Runtime agent and leaves model, tools, pipeline
participation and approval eligibility to a later activation task. GP-13
completes the definition layer for pack workflow templates: a stable workflow
identity and stage identity, project replace (rename, another task type,
reordered, added or removed stages that name roles of the same pack), extend
and disable of a pack workflow, a derived workflow view, and upgrade rules
that reuse GP-08, GP-11 and GP-12. It adds forward SQLite and PostgreSQL
migrations that admit workflow overrides and portable archive format 9. It
does not touch the pipeline engine, pipeline runs, pins, approvals or guards;
runs do not pin pack configuration yet, and blocking a change on in-flight
pinned runs is deferred to GP-24. GP-09 adds a versioned, read-only legacy
development profile and `project:configuration:legacy`: a deterministic,
digest-pinned description of the office, roles, agents, task-kind routing and
pipelines the Runtime reads from a legacy project today. It proves
legacy-state parity against the Runtime's own readers, and that a pre-pack
database fixture, its in-flight pipeline runs and format 1–4 archive fixtures
load unchanged. The evidence has limits, recorded in the GP-09 section of
`generic-core-domain-packs.md`: the fixtures were synthesized by the code of
this task, not kept from the releases that wrote those formats, and a
restored archive is re-exported at format 6, not at its own format. It
infers no pack, adds no migration, archive format or audit event type, and
leaves `project:configuration:show` unchanged. It is not execution parity:
comparing execution from a resolved configuration with legacy execution is
the follow-up Runtime task `a45ddb12-3159-4b60-9b8b-c26516720834`, equivalence
with a real development pack belongs to GP-10A/B, and the derived profile is
reproducible by digest but leaves no audit record. GP-10A defines the
development pack, `org.ai-office.development@0.1.0`, as a committed reference
artifact in `packages/domain-pack-development`: the four development roles,
one agent per role, the five task types and the role capabilities as ID-only
labels. It proves expressible-subset parity: for a project that holds the
legacy defaults and is bound to the pack through a test-supplied catalog, the
roles, agents and task types of the resolved configuration equal those of the
legacy profile, on the GP-09 fixture and on the shipped `agents/` directory
and default office manifest. It is not execution parity: the comparison
covers only what the schema-1 pack vocabulary expresses, and the legacy
fields outside it (tools, model policy, limits, guidance, responsibilities,
the Runtime role name, pipeline, approval and check semantics) are listed
with their owning task. The pack is not registered in any catalog, not
adopted by any project and not read by the Runtime, and nothing was removed
from the legacy path. GP-10B-1 extends the pack to `0.2.0` with the four
development workflows, `delivery`, `bugfix`, `discovery` and `release`,
within manifest schema 1. It proves expressible-subset parity for workflows:
the resolved workflows equal the legacy default pipelines on pipeline ID,
name, description, the ordered stages by ID and role, and one route per
workflow, on the GP-09 fixture and on the shipped default office manifest.
It is not execution parity, and it is not equality of the whole legacy
pipeline: stage names, objectives and checks, the route
`maintenance -> delivery`, and every enforcement, approval and separation
setting stay outside the pack and are listed with what was delivered, what
remains and the task that owns the residue (GP-10B-2, or the provisionally
numbered policy task GP-25). Prompts were not delivered, the pack contract
is unchanged, the pack is still unregistered and unread by the Runtime, and
nothing was removed from the legacy path; the pack must not become
authoritative for Runtime execution without a separately approved task. The
execution parity task `a45ddb12-3159-4b60-9b8b-c26516720834` depends on
GP-10B-1, GP-10B-2 and the policy task. GP-10B-2 is delivered as two pull
requests. The first, the contract, is an additive schema-1 extension with the
descriptive vocabulary that residue needs: workflow stage `title`,
`objective` and `checks`, role `responsibilities`, prompt `text` and workflow
`additionalTaskTypes`, with the same fields in project-owned and `replace`
payloads, the resolved view, upgrade reconciliation and portable archive
format 10. It adds no migration, CLI command or error code, leaves the
development pack at `0.2.0` and the legacy path untouched, and records two
limits: project text stays bounded at 16,000 UTF-16 code units, below the
65,536-byte legacy guidance bound, and a mutation over the 16 KiB argument
limit cannot be sent. The fields are declarative; nothing in the Runtime
reads them. The second pull request extends the development pack to `0.3.0`
with the descriptive defaults (role responsibilities, stage title, objective
and checks), the `maintenance -> delivery` route as `additionalTaskTypes`,
the four role guidance prompts (the bytes of `agents/<id>/system.md`, named
by the agent of the role) and reference prompts for the static
instruction-contract text and the requirement-assessment message. It proves
expressible-subset parity on the GP-09 fixture and on the shipped defaults
and moves the residue list to `schemaVersion` 3 with the seven GP-10B-2
entries delivered. It is not execution parity; `knowledge` and `policies`
stay empty, the pack is still unregistered and unread by the Runtime, no
instruction file or provider request is generated from a pack prompt and
nothing was removed from the legacy path. GP-25, whose number is now
confirmed, gives the schema-1 `policies` contribution a typed form: a policy
targets one workflow of its own pack and declares its `enforcement` and, per
stage, `requiresApproval`, `requiresIndependentApproval`,
`requiresDifferentAgentFrom` and the admitted `operations`, which are opaque
operation names independent of pack capabilities and of GP-16. A pack whose
policies are all typed resolves, and `project:configuration:show` lists a
derived `policies` view; a policy without a target workflow still fails
closed. Policies are pack-owned: a project cannot override or own one, a
workflow replacement must keep every governed stage and separation order
(`policy_target_missing`), and the policy of an existing workflow changes
only through `project:pack:upgrade`, whose plan reports `policyChanges` and
`targetPolicies` (`project:pack:apply` refuses it with
`policy_change_requires_upgrade`). It adds no migration and no archive
format, and nothing is enforced from a policy: the Runtime still reads only
the OfficeManifest pipelines. The policies of the development reference pack
and their parity tests are a second GP-25 pull request that follows the pack
version of GP-10B-2. Aliases, the development pack's policy data (GP-25, second pull
request), Runtime enforcement from pack policies (`a45ddb12`), evidence and
adoption (GP-10C), automatic
selection, remote marketplace/downloads, executable validators and Runtime
execution from packs remain deferred. M16 remains incomplete until its
end-to-end exit criteria are met.

### Post-GP-06 hardening follow-ups

Status: GP-22 is implemented; GP-23 is assessed, with U+0000 allowed in pack
manifest text by design. They are
separate, independently completable M16 tasks that harden the merged GP-06 and
GP-07 contracts. They are not unfinished GP-06 or GP-07 acceptance criteria, and
neither reopens that work. Each depends only on merged GP-06 and GP-07; neither
depends on the other, and no other GP task depends on them.

- GP-22 — Binding composition preflight (implemented). GP-07 checks a
  prospective project-owned definition against the currently resolved pack
  closure. GP-22 closes the inverse path, where a later `project:pack:apply`,
  or a portable restore whose sections are valid individually, produced a
  collision that only GP-06 reported as `duplicate_effective_definition`.
  Binding preview/apply check the prospective pack closure against existing
  project-owned definitions; apply repeats the comparison inside its
  transaction against the closure resolved before it. Portable restore
  validates the combined prospective binding, project definitions and resolved
  closure after archive structural validation and before authoritative state
  is committed, when the exact closure is resolvable on the restore host. Pack
  availability stays host-local operational state: an archive whose exact pack
  artifacts are absent locally still restores, GP-06 reports its existing
  closure failure (`pack_unavailable` for an absent selected pack,
  `pack_dependency_failure` for an absent dependency), and a collision fails
  closed once the exact closure becomes resolvable. Binding mutation stays
  strict.
  Both use the existing shared resolver; no second resolver is introduced.
  The preflight rejects with `pack_definition_collision`, the code GP-07
  already uses; `duplicate_effective_definition` stays GP-06's backstop
  diagnostic. In a binding preview the collision is listed after a GP-04
  availability failure and before the GP-11 capability refusal. Applying the
  unchanged active selection remains a GP-05 no-op.
  The restore preflight runs only on the path that writes binding and
  definition state (outcome `restored`), and closure resolution stays outside
  the database transaction.
  GP-06 stays the fail-closed backstop. No migration or archive format was
  added.
- GP-23 — Pack manifest U+0000 policy assessment (assessed: allowed by
  design). Project definition text rejects U+0000 because PostgreSQL `jsonb`
  cannot represent it consistently with SQLite. Pack manifest text is
  validated separately. GP-23 traced manifest text through its real
  persistence, canonicalization and serialization boundaries without assuming
  the answer, and recorded one evidence-backed outcome: U+0000 is allowed
  explicitly by design, with regression tests and a documented distinction.
  Manifest text is not persisted: it stays in the installed catalog's artifact
  bytes and in derived output, where the escape `\u0000` survives parsing,
  RFC 8785 canonicalization, both digests, resolution and
  `project:configuration:show`. Project storage and portable archives hold
  pack identities only. The one path that copies template text into a stored
  project payload, `convert_to_replace`, is checked against the project
  definition text rule before any write and is refused as
  `prospective_configuration_invalid` on SQLite and PostgreSQL alike. No
  restriction was introduced, and no code, migration or archive format
  changed.

Scope, exact acceptance criteria and non-goals are in the
[plan's hardening section](generic-core-domain-packs.md#post-gp-06-hardening-follow-ups).

### GP-16 pack capability contracts

Status: implemented; the contract was approved by the owner on 2026-10-06.

GP-16 is a definition-layer task. A pack capability may declare the operations
it needs, by connector operation name and mode, as required or optional. The
Runtime host exposes its registered connector descriptors through a read-only
application port. Resolution, `project:pack:preview`, `project:pack:apply` and
`project:pack:upgrade` fail closed with `missing_required_capability_provider`
or `capability_provider_mismatch` when a required operation has no registered
provider or the provider offers it in another mode. `project:configuration:show`
reports each binding in a derived `capabilities` view. A change to an existing
capability's contract is refused by `project:pack:apply` and reviewed through
`project:pack:upgrade`, whose plan lists it under `planDigest`.

A binding grants nothing. Grants, constraints, approval and controlled
execution are unchanged and still separately authorize every use; a request
for a bound operation without a grant is denied as before. There is no
scheduler or run gate: rejecting a run for a missing provider belongs to the
execution parity task `a45ddb12-3159-4b60-9b8b-c26516720834` and GP-24.
Provider binding is host-local availability and is not part of
`configurationDigest`, which narrows ADR-0026 on purpose. GP-25 stage
operations are opaque names and do not reference these declarations. No migration and no portable archive
format are added, and the development pack is not edited.

The contract, the three meanings of "capability", the owner decisions, the
acceptance criteria and what is unmet relative to the original wording are in
the [plan's GP-16 section](generic-core-domain-packs.md#gp-16-pack-capability-contracts).

Exit: development, legal, manufacturing, and empty/custom fixtures run the same
core lifecycles without changes to core for each domain. Legacy development
fixtures still load, resolve roles and agents, run pipelines, create tasks,
complete approvals, retrieve knowledge, persist state, and retain audit and
provenance. Project-owned roles, agents, prompts, validators, capabilities,
artifacts, knowledge settings and pipelines can be customized or replaced
without pack forks; upgrades preserve these choices. Package import and
cross-domain scenario tests prevent development semantics from returning to
core. Domain-specific adapters remain behind public ports and controlled
actions.

Non-goals: complete legal software or MES; ERP integration; third-party
marketplace or remote registry; dynamic downloads or untrusted executable
plugins; runtime-generated packs; replacement of the pipeline engine,
governance, ProjectStorage, AgentKnowledgeStore, model routing, or worker queue.

## M17 — Execution Observability & Heterogeneous Actors Foundation

Status: planned; requirements, delivery slices and proposed ADR only. No
ExecutorSession, hook ingress or generic Actor implementation is claimed.

Goal: observe managed Codex/Claude executor work end to end and expose it in
the operational console, while separating Actor, Role, Capability, Assignment,
Execution, Presence and Evidence so future domain packs can add other kinds of
participants. `AgentRun` remains the current governed AI execution record;
M17 adds a compatible path toward a general work execution model without a
cosmetic rename or destructive migration. ExecutorSession records the provider
session, never another pipeline, stage or task authority. Hooks supply verified,
sanitized telemetry and cannot advance workflows.

The [M17 delivery plan](m17-execution-observability.md) records EO-R01–EO-R22,
EO-T01–EO-T14, task dependencies, requirement coverage, security/correlation
semantics, storage parity, recovery, three exit scenarios and non-goals. The
[proposed ADR-0028](../adr/ADR-0028-actor-execution-and-observation.md) is the
first decision gate, not current architecture. M17 consumes M11/M11.5 execution
authority, the relevant M12 worker launch/observe boundary, ADR-0015 read
models, M15/M16 core/pack constraints and the React dashboard delivered by
PR #86. It does not duplicate M12 worker-port work, M16 pack resolution, M10
same-UID hardening, model routing, or the dashboard migration. PostgreSQL
storage work must meet the existing ProjectStorage/RLS contract and any
remaining M15-PG-PARITY prerequisite.

Exit requires a managed pipeline/stage/AgentRun launched through AI Office to
produce a verified ExecutorSession and lifecycle event, with authoritative
task/stage/run linkage and last activity visible in React Work/Pipelines/Agents
through query APIs and SSE invalidation; session end and authoritative run
completion remain separate. A manually launched supported executor can appear
as external/unbound for one deterministic registered project, without an
invented task, role or governed run. Human/robot/service/machine contract
fixtures must fit core actor/execution/presence seams without LLM-specific
fields or production adapters. Existing data, CLI, fencing, task locks,
approvals and SQLite/PostgreSQL behavior remain compatible.

Non-goals: MES, OPC-UA, PLC or robot fleet control; human time tracking,
employee surveillance or HR attendance; generic workflow engine rewrite;
renaming AgentRun everywhere for naming purity; inferred assignment of external
sessions; hook-driven pipeline authority; every executor/provider; or production
human/robot/machine/service adapters.

## M11-M17 dependency summary and open design questions

```text
M6E office definitions + M6 policy/actions + M8.5 context
                         |
                         v
                M11 Pipeline Engine
                  |
                  v
        M11.6 Artifact Review & Approval
                  |             |
                  v             v
       M12 Runtime adapters   M13 GitHub connector
                               /
                   v           v
              M14 Software development pipelines
                         |
                         v
           M15 Domain-neutral work and vertical assessment
                          |
                          v
           M16 Generic Core & Domain Packs
                          |
                          v
       M17 Execution Observability & Heterogeneous Actors
```

These milestones intentionally defer:

- the stable pipeline file format, public API, storage schema, and whether
  definitions remain inside an evolved office manifest or use separately
  versioned project files;
- how a running pipeline behaves when its source definition or organization
  profile changes;
- the canonical change-risk model and its composition with connector-operation
  risk, where untrusted input must never lower effective risk;
- the precise independence rule across agent identities, runtime sessions,
  models, providers, and human actors;
- structured review artifact versioning and durable anchoring to changing diffs;
- local Git versus GitHub API ownership of branch, commit, push, worktree, and
  precondition semantics;
- webhook ordering, installation lifecycle, delivery reconciliation, and
  external identity mapping;
- runner isolation, credential delegation, cancellation, crash recovery, and
  ambiguous external outcomes;
- the policy thresholds for autonomous merge and the authentication required for
  human workflow approvals;
- whether generic professional work needs a new aggregate or semantic facade,
  and how existing `Project` identity and portable snapshots remain compatible;
- the minimum generic provenance/evidence contract that supports multiple
  verticals without embedding legal or software-specific semantics in the core;
- how vertical plugins declare stronger retention, confidentiality, approval,
  redaction, and external-action rules without becoming independent policy
  engines.

These questions require milestone-specific assessments and, where a durable
architectural choice is ready, an ADR. The accepted M16 ADR records the pack
boundary; later tasks must implement it without silently changing existing
project semantics. This roadmap direction does not itself select an
implementation or authorize work on M11-M17.
