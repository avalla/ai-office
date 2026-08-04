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

## Rust migration path

A future Rust daemon may implement the same application protocol.

TypeScript remains suitable for providers, prompts, plugins and UI.
