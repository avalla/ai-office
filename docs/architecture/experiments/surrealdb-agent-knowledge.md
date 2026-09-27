# Experimental SurrealDB AgentKnowledgeStore

Status: experimental evaluation; not an accepted storage-authority decision.

> SurrealDB is experimental and is NOT an AI Office transactional authority.
> This PR evaluates SurrealDB only as an `AgentKnowledgeStore`.

This experiment asks whether SurrealDB is useful for project-scoped agent knowledge with explicit graph provenance while all existing authority remains in place. It does not claim ProjectStorage parity or make a database selection recommendation.

## Boundaries

- `packages/application/src/ports/agent-knowledge-store.port.ts` defines a provider-neutral port for provenance-backed memories and decisions, scoped retrieval, explicit graph queries, and deterministic project cleanup.
- `packages/storage-surrealdb` owns the SurrealDB 2.0.8 JavaScript SDK, all SurrealQL, versioned schema initialization, and the adapter implementation.
- The adapter is not composed into Runtime bootstrap and cannot be selected as a Runtime storage provider.
- PostgreSQL behavior is unchanged. SQLite behavior is unchanged. Runtime bootstrap is unchanged. `ProjectStorage` is unchanged.

## Graph model

The experiment stores `Agent`, `Run`, and `Task` context snapshots alongside `Memory`, `Decision`, and `SourceReference` knowledge records. These snapshots carry the caller-supplied identifiers; they do not establish that an authoritative Agent/Run/Task currently exists or replace the owning repository. There is no generic `Artifact` node. Material outside those existing concepts is represented by `SourceReference` with a typed source kind and optional locator.

The schema defines these tested relationships:

- `Agent -> EXECUTED -> Run`
- `Run -> FOR_TASK -> Task`
- `Memory -> DERIVED_FROM -> SourceReference`
- `SourceReference -> IN_CONTEXT_OF -> Run`
- `Decision -> BASED_ON -> SourceReference`
- `Decision -> AFFECTS -> Task`
- `Decision -> SUPERSEDES -> Decision`
- `Task -> DEPENDS_ON -> Task`

Every record and relationship is stamped with tenant and project IDs. Record keys include both IDs, and adapter queries require an explicit `KnowledgeScope`. Retrieval and provenance queries also filter both IDs. Knowledge writes reject empty tenant/project, agent, run, task, source identity, source label, text/knowledge identity, or invalid creation time. A provenance trace returns no result unless the stored source and all expected graph edges are present and agree with the memory/decision context.

This is adapter-level isolation only. It is NOT equivalent to PostgreSQL RLS: the same adapter credential can query any tenant in its database, and caller context is trusted input rather than an authenticated principal enforced by the database. Production authorization and tenant binding remain outside this experiment.

## Retrieval and lifecycle

Retrieval is deterministic, case-insensitive substring matching over stored knowledge text, scoped by tenant and project and optionally filtered by agent. Decision search omits superseded decisions. `findCurrentDecisions` traverses the `AFFECTS` relationship, and `listTaskDependencies` traverses `DEPENDS_ON`. Memory and decision provenance APIs recover source, run, task, and agent context. No embedding provider, vector index, semantic retrieval, RAG framework, or external service is used.

Project cleanup removes the experiment's records and relationships for exactly one explicit tenant/project scope in one database transaction. `recordMemory` and `recordDecision` use deterministic scoped record IDs and remain idempotent for an exact logical retry. Knowledge IDs are immutable: a retry must match scope, text/title, agent, run, task, source fields, and `createdAt`; changing any of them fails inside the write transaction. Source IDs are also immutable within a tenant/project, including source kind, label, locator, run, task, and agent context. A rejected write leaves the original node and graph edges intact. Text/title edits require a new knowledge ID.

Decision supersession is allowed only when both decisions affect the same task. Self-supersession and direct or transitive cycles are rejected by recursive SurrealQL path checks before the edge write, within the same transaction. Task dependency writes use the same recursive graph check and reject self-links and direct or transitive cycles; the transaction leaves prior edges unchanged on rejection. SurrealQL recursion is capped at 256 hops, so the adapter also fails closed when a candidate path reaches that depth.

The provenance trace uses one graph-native SurrealQL query to walk `Memory -> DERIVED_FROM -> SourceReference -> IN_CONTEXT_OF -> Run`, then `Run -> FOR_TASK -> Task` and `Agent -> EXECUTED -> Run`. The query filters every edge by tenant/project and the adapter verifies those values on every returned node plus the expected external identifiers and context. This removed the previous separate edge and node lookups and made this fixed provenance path materially simpler; it does not establish general graph query ergonomics.

## Schema and operations

Schema version 1 is declared as `AGENT_KNOWLEDGE_SCHEMA_VERSION` in `packages/storage-surrealdb/src/schema.ts`, with schemafull records, enforced typed relation tables, unique indexes for scoped memory/decision IDs, and unique relationship endpoints. Record IDs encode tenant, project, record kind, and external ID; separate unique indexes for agent, run, task, or source identity would duplicate this keying and are not added. The schema does not enforce immutable field values, source/run context agreement, same-task supersession, acyclic edges, or tenant/project agreement across relation endpoints. Those invariants are enforced by adapter transactions and scoped record IDs. This remains adapter-level isolation, not database-enforced RLS.

Initialization uses repeatable `DEFINE ... IF NOT EXISTS` statements. The integration test runs against a local SurrealDB server and the isolated CI workflow pins `surrealdb/surrealdb:v3.3.0`. The server runs in memory for tests. No Surreal Cloud account is required; local tests use a test-only root credential. The application adapter depends on the official JavaScript SDK `surrealdb@2.0.8`, which documents support for SurrealDB 3.x.

For local tests, start the pinned image with Docker:

```sh
docker run --rm --name ai-office-surreal-test \
  -p 8000:8000 surrealdb/surrealdb:v3.3.0 \
  start --user root --pass root memory --bind 0.0.0.0:8000
```

In another terminal:

```sh
AI_OFFICE_TEST_SURREALDB_URL=ws://127.0.0.1:8000 \
  bunx --bun vitest run tests/integration/agent-knowledge-surrealdb.test.ts
```

The adapter is currently an opt-in experimental package, with no daemon lifecycle, production credentials, deployment persistence, backup/restore, metrics, or migration compatibility contract. The in-memory CI/test server is ephemeral; production-like durability and operations have not been evaluated.

## Known limitations

- Agent/run/task identifiers and their context are assertions supplied to this secondary adapter; it does not validate them against SQLite/PostgreSQL.
- Tenant/project predicates and cross-scope edge prevention are adapter checks, not database row-level security or a same-credential security boundary.
- Text retrieval is lexical substring search only. Vector search was not tested and no embedding model or index is included.
- Cycle validation runs transactionally against the graph observed by each write. Concurrent-writer isolation, fencing, and conflict behavior have not been evaluated.
- No PostgreSQL/SQLite comparison or operational durability evaluation was performed. Findings here remain preliminary and do not make a storage recommendation.

## References

- [Official SurrealDB JavaScript SDK reference](https://surrealdb.com/docs/reference/javascript)
- [Official SurrealDB JavaScript SDK releases](https://github.com/surrealdb/surrealdb.js/releases)
- [Official SurrealDB server image](https://hub.docker.com/r/surrealdb/surrealdb)
