# Architecture overview

## Context

AI Office is a local virtual office that coordinates multiple software agents while exposing one logical instance to the user.

## Core model

```text
CLI / Web / IDE / MCP
          |
          v
     Local daemon
          |
  +-------+---------+----------------+
  |                 |                |
Scheduler       Memory service    LLM gateway
  |                 |                |
Agent runtime     SQLite          Providers
  |
Git worktrees / subprocesses
```

## Architectural boundaries

```text
apps -> application -> domain
              ^
              |
       infrastructure adapters
```

The domain must not depend on SQLite, Bun, HTTP, MCP, Git or provider SDKs.

## Storage

Three databases are used:

- global database for reusable knowledge;
- project database for authoritative project state;
- index database for regenerable code intelligence.

## Write model

All project writes go through command handlers or application services.

Agents never receive raw SQL access.

## Concurrency

SQLite uses WAL mode. Long-running work happens outside transactions.

The daemon serializes or batches short write transactions.

The current TypeScript daemon exposes a versioned HTTP protocol over a Unix
domain socket. The CLI does not open SQLite directly in production; it submits
commands to a FIFO queue owned by the daemon.

Agent definitions are validated from YAML and synchronized into project storage. Agent runs acquire a task lock before entering the queue, use a worktree port, and persist every state transition. M3 executes only through a deterministic simulator.

The LLM gateway separates providers from metering. Pricing versions, normalized usage, reservations, and actual cost events retain their accounting dimensions. The OpenAI Responses adapter is opt-in and the test suite never performs provider calls.

Governance records (milestones, requirements, ADRs, reviews, and approvals) are stored as structured data. Markdown remains a one-way, deterministic projection.

## Rust migration path

A future Rust daemon may implement the same application protocol.

TypeScript remains suitable for providers, prompts, plugins and UI.
