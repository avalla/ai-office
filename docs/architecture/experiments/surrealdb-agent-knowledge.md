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

Project cleanup removes the experiment's records and relationships for exactly one explicit tenant/project scope in one database transaction. `recordMemory` and `recordDecision` use deterministic scoped record IDs and upsert behavior so retrying the same input is idempotent. Reusing an ID with different content replaces its stored fields and can leave prior relationship edges behind when the source identity changes. Callers must choose stable IDs; immutable-record or relationship-replacement semantics need review before broader adoption.

## Schema and operations

Schema version 1 is declared as `AGENT_KNOWLEDGE_SCHEMA_VERSION` in `packages/storage-surrealdb/src/schema.ts`, with schemafull records, enforced typed relation tables, and unique scoped knowledge IDs and relationship endpoints. Initialization uses repeatable `DEFINE ... IF NOT EXISTS` statements. The integration test runs against a local SurrealDB server and the isolated CI workflow pins `surrealdb/surrealdb:v3.3.0`. The server runs in memory for tests. No Surreal Cloud account is required; local tests use a test-only root credential. The application adapter depends on the official JavaScript SDK `surrealdb@2.0.8`, which documents support for SurrealDB 3.x.

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

## Known limitations and questions for hardening

- Agent/run/task identifiers and their context are assertions supplied to this secondary adapter; it does not validate them against SQLite/PostgreSQL.
- Tenant/project predicates are application adapter checks, not database row-level security or a same-credential security boundary.
- Text retrieval is lexical substring search only. Vector search was not tested and no embedding model or index is included.
- Task dependency and decision supersession cycles are not rejected. Supersession does not validate that both decisions affect the same task.
- Stable IDs are a caller responsibility; upserts can replace an existing knowledge record. Cross-process conflict and operational recovery behavior have not been characterized.
- No PostgreSQL/SQLite comparison was performed. Findings here are preliminary observations for the later isolated storage and concurrency experiments.

## References

- [Official SurrealDB JavaScript SDK reference](https://surrealdb.com/docs/reference/javascript)
- [Official SurrealDB JavaScript SDK releases](https://github.com/surrealdb/surrealdb.js/releases)
- [Official SurrealDB server image](https://hub.docker.com/r/surrealdb/surrealdb)
