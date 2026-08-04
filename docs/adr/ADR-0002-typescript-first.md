# ADR-0002: Start with TypeScript and preserve a Rust boundary

- Status: Accepted
- Date: 2026-08-05

## Context

The domain and product model are still evolving. AI integrations and MCP tooling have stronger TypeScript ergonomics, while Rust could later improve daemon robustness and process supervision.

## Decision

Implement the first working version with Bun and strict TypeScript.

Define stable ports and a local protocol so the daemon, storage or runner can later move to Rust without changing clients and agent definitions.

## Consequences

- faster product iteration;
- one language for the MVP;
- runtime overhead accepted because LLM and tool latency dominate;
- extraction to Rust is postponed until justified by profiling or distribution needs.
