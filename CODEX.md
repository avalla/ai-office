# Operating instructions for Codex

## Mission

Turn this blueprint into a working AI Office MVP.

AI Office is a single local daemon that coordinates software agents, stores structured memory in SQLite, tracks costs, and generates Markdown views.

## Constraints

- Runtime: Bun.
- Language: strict TypeScript.
- Avoid `any`.
- Prefer classes and interfaces for application boundaries.
- DRY, KISS, YAGNI.
- No ORM in the first milestone.
- Use explicit SQL and versioned migrations.
- All writes must pass through the application layer.
- The domain must not import Bun, SQLite, HTTP, LLM providers, or Git.
- Transactions must not remain open during LLM calls or long-running subprocesses.
- Every change must include relevant tests.
- Do not introduce Rust in the first milestone, but keep protocols and ports extractable.

## Work sequence

### Milestone 1 — Vertical slice

Implement:

1. opening `project.sqlite`;
2. migration runner;
3. `Project` and `Task` entities;
4. SQLite repositories;
5. `CreateProject`, `CreateTask`, and `ListTasks` use cases;
6. working CLI;
7. unit and integration tests;
8. updated README.

### Milestone 2 — Daemon

Implement:

1. local HTTP server or Unix socket;
2. CLI as a daemon client;
3. lifecycle and graceful shutdown;
4. health endpoint;
5. event log;
6. command serialization.

### Milestone 3 — Agents and runs

Implement:

1. `Role`, `Agent`, `AgentRun`;
2. run state machine;
3. scheduler;
4. simulated executor;
5. agent definitions loaded from YAML;
6. complete audit trail.

### Milestone 4 — LLM gateway and costs

Implement:

1. provider interface;
2. provider mock;
3. model usage;
4. versioned pricing catalog;
5. cost event;
6. budgets and reservations;
7. aggregations by task, agent, and project.

### Milestone 5 — Memory

Implement:

1. ADRs, milestones, requirements, and patterns;
2. global memory;
3. export Markdown;
4. FTS5;
5. regenerable code index;
6. initial hybrid retrieval.

## Commit rules

- one coherent change per commit;
- Conventional Commits messages;
- do not mix broad refactors with new features;
- report executed tests and remaining limitations in the summary.

## Definition of done

A task is complete when:

- acceptance criteria are satisfied;
- tests pass;
- migrations are idempotent with respect to the tracking table;
- errors are typed;
- logs contain no secrets;
- documentation is up to date;
- no critical TODO is hidden.
