# Development roadmap

## M0 — Repository health

- install dependencies;
- pass typecheck;
- migration runner;
- CI;
- coding conventions.

## M1 — Project and task vertical slice

- create/list project;
- create/list/start/complete task;
- SQLite repositories;
- event log;
- integration tests;
- functional CLI.

## M1.5 — Existing project onboarding

- canonical, idempotent local repository import;
- deterministic language, framework, database, test, and documentation scan;
- timestamped scan history and refreshed detected profile facts;
- persisted onboarding questions and structured answers;
- interactive and automation-friendly onboarding commands;
- categorized profile view and deterministic Markdown projection.

## M2 — Local daemon

- daemon lifecycle over an owner-only Unix domain socket;
- versioned local HTTP API;
- CLI daemon client with interactive prompt forwarding;
- single-writer command queue;
- health and status endpoint;
- append-only lifecycle and command audit events;
- graceful shutdown and stale socket recovery.

## M3 — Agent runtime

Status: implemented on `main`; 57 tests across 14 files at milestone completion.

- role and agent definitions;
- agent runs;
- scheduler;
- mock executor;
- task locking;
- worktree abstraction.

## M4 — LLM gateway and cost control

Status: implemented on `main`; 87 tests across 18 files at milestone completion.

- provider interface;
- provider mock and one real provider;
- usage normalization;
- pricing versions;
- cost events;
- budgets and reservations;
- fallback policy.

## M5 — Governance

Status: implemented on `main`; 110 tests across 26 files at milestone completion.

- milestones;
- ADR workflows;
- requirements;
- reviews and approvals;
- Markdown export.

## M6 — Capability security and controlled actions

Goal: agents must never access local or external resources directly. All real operations pass through deterministic authorization, connector boundaries, simulation, approval when required, execution-time revalidation, and audit.

### M6A — Capability model and policy engine

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
- atomic writes using temporary files and rename;
- filesystem security and integration tests.

Exit criteria:

- simulations never modify real files;
- approved writes fail when the source changes after simulation;
- paths cannot escape an allowed root through traversal or symlinks;
- agents cannot obtain credentials or sensitive files through the connector.

### M6C — Approval and controlled execution

- approval requests bound to immutable payload hashes;
- execution-time revalidation of grants, constraints, resource status, and budget;
- approval rejection, expiry, and invalidation;
- one-shot execution and replay prevention;
- revocation blocking already approved but unexecuted actions;
- deterministic action batches and dependency ordering;
- stop-on-failure behavior for required dependencies;
- simulated resource identifiers and real-resource resolution;
- local tamper-evident audit hash chain;
- extension of existing usage and cost accounting with connector and action dimensions;
- hard-budget denial and soft-budget warning events.

Exit criteria:

- high-risk actions cannot execute without approval;
- modified payloads and replay attempts are rejected;
- the exact simulated and approved payload is the only payload executed;
- audit-chain integrity can be validated;
- existing cost, budget, and audit models are extended rather than duplicated.

### M6D — Agent runtime integration

- controlled-action gateway exposed to agent executors;
- no direct filesystem or infrastructure adapter dependency in agent runtime;
- scheduling returns run and action identifiers without blocking the daemon command FIFO;
- action status and approval state available through daemon-backed CLI commands;
- crash-recovery queries for pending approvals and interrupted executions;
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

- global roles and patterns;
- project pattern adoption;
- lesson extraction;
- validation and deprecation;
- cross-project search.

## M8 — Code intelligence

- incremental file indexing;
- TypeScript symbol extraction;
- import and call edges;
- FTS5;
- change-impact query;
- optional embeddings.

## M9 — Productization

- web UI;
- plugin SDK;
- MCP server;
- packaged binaries;
- backup/export/import;
- security review and deployment hardening.
