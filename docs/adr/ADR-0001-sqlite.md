# ADR-0001: Use SQLite for the local office

- Status: Accepted
- Date: 2026-08-05

## Context

AI Office initially runs as one logical local instance. Most operations are reads and short structured writes. The system must be easy to install, copy and rebuild.

## Decision

Use SQLite with WAL mode.

Use separate databases for global memory, project state and regenerable code indexes.

## Consequences

Positive:

- no database server;
- single-file portability;
- native integration with Bun;
- low operational overhead;
- sufficient concurrency for a coordinated local daemon.

Negative:

- one writer per database;
- unsuitable for direct shared access over a network;
- a future distributed service may require PostgreSQL.

## Guardrails

- agents do not open database files directly;
- transactions remain short;
- no LLM call or subprocess runs inside a transaction;
- adapters implement application ports.
