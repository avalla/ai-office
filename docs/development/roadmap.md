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

Status: implemented on `feat/agent-runtime`; 57 tests across 14 files.

- role and agent definitions;
- agent runs;
- scheduler;
- mock executor;
- task locking;
- worktree abstraction.

## M4 — LLM gateway and cost control

Status: implemented on `feat/llm-cost-control`; 87 tests across 18 files.

- provider interface;
- provider mock and one real provider;
- usage normalization;
- pricing versions;
- cost events;
- budgets and reservations;
- fallback policy.

## M5 — Governance

Status: implemented on `feat/governance`; 110 tests across 26 files.

- milestones;
- ADR workflows;
- requirements;
- reviews and approvals;
- Markdown export.

## M6 — Reusable memory

- global roles and patterns;
- project pattern adoption;
- lesson extraction;
- validation and deprecation;
- cross-project search.

## M7 — Code intelligence

- incremental file indexing;
- TypeScript symbol extraction;
- import and call edges;
- FTS5;
- change-impact query;
- optional embeddings.

## M8 — Productization

- web UI;
- plugin SDK;
- MCP server;
- packaged binaries;
- backup/export/import;
- security hardening.
