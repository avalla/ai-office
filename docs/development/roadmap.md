# Development roadmap

## Long-term product direction

AI Office is intended to evolve from coordinating individual agent runs into a
local, auditable **virtual engineering organization**. AI Office defines the
organization and governs the process; a coding client or model runtime is a
replaceable worker, not the source of role behavior or workflow authority.

```text
AI Office
  |-- organization and roles
  |-- agent pipeline engine
  |-- policy and capabilities
  |-- connectors
  |     `-- GitHub
  `-- worker runtimes
        |-- Codex
        |-- Claude Code
        |-- Gemini CLI
        |-- OpenCode
        `-- local or future runtimes
```

Two boundaries govern this direction:

1. A generic, client-agnostic Agent Pipeline Engine owns pipeline and stage
   orchestration, assignment, policy gates, transitions, retries, controlled
   loops, approvals, artifacts, and audit.
2. GitHub remains an external system behind connector and application ports. A
   GitHub connector exposes repository resources and operations; it never
   decides which role works next, whether a review is independent, or whether
   policy permits merge.

The M6E office manifest is the configuration precursor for this direction. It
currently stores roles and ordered pipeline descriptions, while the active host
follows their stages. It is not yet a durable pipeline executor. The milestones
below preserve that distinction and do not change the scope or status of M0-M10.

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

Status: implemented.

- deterministic, offline `project:import` scan and persisted detected facts;
- progressive LLM-generated onboarding batches through the existing metered gateway;
- strict structured-output validation, generation provenance, prompt version, round, and semantic input hash;
- structured answers projected into the project profile without creating capability grants;
- at most five questions per round and three generated rounds;
- daemon-backed interactive and automation-friendly CLI flows.

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

The runtime resolves pipeline definitions but does not yet persist or execute a
multi-stage pipeline state machine. The provider-backed `project:onboard` path
remains an optional headless compatibility flow.

### M6F — External coding-client integration

Status: implemented.

- tool-independent schema-versioned operating policy and project instruction
  contract;
- deterministic canonical `AGENTS.md` compiler;
- application port plus Codex CLI and Claude Code infrastructure adapters;
- passive detection, inspection, deterministic planning, explicit plan-hash
  approval, preconditioned atomic apply, and validation;
- preservation of user-owned canonical instructions and managed Claude bridge;
- daemon-backed `client:*` machine interface, separate from project onboarding;
- no global configuration mutation or persistence in the first slice.

Client version probing, machine preference persistence, integration removal,
additional coding clients, and internal-agent context composition remain future
work.

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

Status: future.

- global roles and patterns;
- project pattern adoption;
- lesson extraction;
- validation and deprecation;
- cross-project search.

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

- task-aware context builder;
- memory and code retrieval;
- dependency-aware context;
- token-budgeted context packing;
- provenance for assembled context.

## M9 — Productization

Status: future.

Focus: user-facing product surfaces, packaging, and operability.

- web UI;
- plugin SDK;
- MCP server;
- packaged binaries;
- backup/export/import.

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

Status: future.

Goal: add a durable, generic orchestration layer that executes validated office
pipelines without embedding software-development or GitHub-specific business
logic in the runtime, a connector, or a host skill.

Conceptual primitives, subject to design assessment before implementation:

- `Pipeline`: a versioned declarative workflow definition;
- `PipelineStage`: one stage definition and its responsibility boundary;
- `PipelineRun`: one durable execution of a pinned pipeline definition;
- `StageRun`: one durable stage execution or attempt within a pipeline run.

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

Depends on: M3 agent/run foundations, M5 governance concepts, M6A capability
policy, M6D-lite controlled-action integration, M6E office manifests, and M8.5
context assembly. Its placement after M10 preserves the already planned M7-M10
sequence and does not pull this work into an active milestone.

Exit direction:

- a pipeline run pins the definition and policy inputs needed for reproducible
  decisions;
- stage state survives restart and produces an end-to-end audit trail;
- branching, bounded review/fix cycles, failure, cancellation, and approval
  gates have deterministic semantics;
- stage execution cannot create authority outside the capability system;
- the engine contains no GitHub-, Codex-, Claude-, Gemini-, or OpenCode-specific
  workflow logic.

## M12 — Worker runtime adapters and organization profiles

Status: future.

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

## M11-M14 dependency summary and open design questions

```text
M6E office definitions + M6 policy/actions + M8.5 context
                         |
                         v
                M11 Pipeline Engine
                  |             |
                  v             v
       M12 Runtime adapters   M13 GitHub connector
                  \             /
                   v           v
              M14 Software development pipelines
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
  human workflow approvals.

These questions require milestone-specific assessments and, where a durable
architectural choice is ready, an ADR. This roadmap direction does not itself
select an implementation or authorize work on M11-M14.
