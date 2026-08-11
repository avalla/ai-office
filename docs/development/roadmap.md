# Development roadmap

## M0 — Repository health

Status: implemented on `main`.

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

Status: future.

- controlled-action gateway exposed to agent executors;
- no direct filesystem or infrastructure adapter dependency in agent runtime;
- scheduling returns run and action identifiers without blocking the daemon command FIFO;
- action and approval state available through daemon-backed CLI commands;
- interrupted `executing` and `execution_unknown` actions remain observable without automatic replay;
- end-to-end flow from agent intent to controlled filesystem modification.

Exit criteria:

- the simulated executor can be replaced incrementally without granting direct resource access;
- capability revocation takes effect immediately;
- a complete read, simulate, approve, execute, and audit workflow passes end to end.

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
