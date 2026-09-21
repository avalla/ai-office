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
on the active host. Advanced orchestration and worker dispatch remain future
work. M14 is intended to deliver the first complete software-development
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
- status schema version `3`, including distinct repository identity and runtime
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
- linkable source-checkout `ai-office` bin while published packages, compiled
  binaries, and background service management remain M9 work.

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
- `ai-office dashboard`, a foreground loopback host that serves a dependency-free
  console and forwards `/api/*` to the daemon socket;
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

Status: implemented (initial read-only slice).

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

Status: future.

Durable memory promotion must be explicit and review-gated:

```text
AgentRun outcome
       ↓
memory candidate (AI Office state, provenance-linked to the run)
       ↓
AI Office review / approval
       ↓
CairnKeep reviewed-memory proposal/apply
```

This needs its own write port, candidate model, approval semantics distinct from
governance reviews, pipeline approvals and controlled-action approvals, and
poisoning, retention and conflict policy. The read-only retrieval port is not
widened for it. Later M8.5 context assembly may add semantic retrieval,
dependency-aware selection and dashboard provenance on the same assembler seam.

### Separate follow-up — Project retention and removal

Status: assessment pending; no removal operation implemented.

Decide archival versus physical removal, installed checkout behavior, active work,
portable identity, global-memory references, and audit retention independently
of runtime isolation. `runtime:purge` is still whole-runtime removal and project
uninstall still preserves authority. The existing `governance_event` cascade
and append-only delete guard must be reconciled with the chosen retention policy
before supporting deletion; do not bypass the guard as a cleanup shortcut.

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
machine-interpretable artifacts, generalized conditions, failure compensation,
and automated worker-runtime dispatch. Explicitly scheduled runs can use the
first bounded text worker; this does not automate pipeline advancement.

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
failures, and approval decisions. CairnKeep remains read-only.

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

A bounded precursor is implemented: explicit `run:tick --worker claude`, an
application worker port, tool-free task/stage context, immutable dispatch
provenance and inspectable generated output. It does not deliver the complete
M12 organization profiles or M14 software vertical. See
[agent runtime](agent-runtime.md) and [ADR-0017](../adr/ADR-0017-bounded-external-worker.md).

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

Status: future.

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
PostgreSQL remains intentionally partial: its implemented capability groups are
exactly `projects`, `tasks`, `taskRequirements`, `governance`, and
`transactions`; a request to use it as complete Runtime
authority still fails closed with the missing capability list; no SQLite fallback
or hybrid authority is allowed. PostgreSQL connection configuration is explicit
through `AI_OFFICE_STORAGE_PROVIDER=postgres` and `AI_OFFICE_POSTGRES_URL`, and
secrets remain runtime configuration rather than project state.

The next storage slice is parity for the remaining `ProjectStorage` repositories
(agents/roles, pipelines/runs, audit, capabilities/resources, or job outbox as
dependency analysis warrants). Only after all required `ProjectStorage`
repositories exist may PostgreSQL become a complete Runtime authority. The
identity-only `core.agent_run` projection used to validate governance review
subjects is not agent-runtime repository parity.

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

## M11-M15 dependency summary and open design questions

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
          M15 Domain-neutral vertical profiles
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
architectural choice is ready, an ADR. This roadmap direction does not itself
select an implementation or authorize work on M11-M15.
