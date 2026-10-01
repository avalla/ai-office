# Native agent knowledge retrieval

AK-01 defines `AgentKnowledgeStore` as a secondary, non-authoritative
application port. AK-02 implements its SurrealDB read behavior and the
CairnKeep-compatible search term. AK-03 composes it independently into the
Runtime when explicitly enabled. AK-04 uses the connected store for worker
context and run retrieval provenance.
SurrealDB does not store project, task, run, approval, or audit authority.
CairnKeep integration was removed in AK-08. Existing imported records and
historical run retrieval provenance remain readable; new knowledge is admitted
only through `AgentKnowledgeStore`.

## Runtime composition (AK-03)

The host reads `AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER` once at bootstrap. Unset,
empty, or `none` disables native knowledge. `surrealdb` requires these host-only
values: `AI_OFFICE_SURREALDB_URL` (`ws://` for loopback only or `wss://`),
`AI_OFFICE_SURREALDB_NAMESPACE`, `AI_OFFICE_SURREALDB_DATABASE`,
`AI_OFFICE_SURREALDB_USERNAME`, and `AI_OFFICE_SURREALDB_PASSWORD`. Namespace
and database are simple identifiers. A SQLite Runtime additionally requires
`AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID`; a PostgreSQL Runtime binds knowledge to
its trusted storage tenant instead. The portable `repositoryId` will be added
by the application caller in AK-04, never inferred from a checkout path.

Configuration remains outside project state, snapshots, generated Markdown,
and SQLite/PostgreSQL authority. The foreground host must receive these
environment variables when it starts; generated managed-service definitions
do not carry them. Credentials and endpoint values are never returned in
health or errors. The five-second deadline bounds how long Runtime bootstrap
waits for the connection. The SurrealDB client has no abort-signal API: on
timeout the host requests a disconnect, disables reconnects, and closes any
handle that arrives later. A client operation that never settles cannot be
guaranteed to finish. Invalid configuration or a failed connection leaves the
authoritative Runtime running without a knowledge store. The connected store
is closed when the host stops. Connection setup may initialize the existing
AK-02 schema, but AK-03 does not create or change knowledge records.
`/health` reports `knowledge.provider` and
`knowledge.startup` (`disabled`, `misconfigured`, `connected`, or `unavailable`)
as the **startup observation**, not a live database probe. Restart to retry
after a failure or configuration change. AK-03 introduced no knowledge mutation command; AK-05 later added reviewed admission.

## Retrieval contract

- A trusted caller supplies tenant and portable `repositoryId` on every call.
  The adapter rejects invalid scope and never derives it from a checkout path,
  Runtime-local project ID, or model output.
- `findKnowledge` searches one literal substring after default Unicode
  lowercasing of both the supplied text and stored text. This is not accent
  normalization or full Unicode case folding. It accepts at most 200 Unicode
  code points in the supplied query and returns at most five hits.
  It excludes superseded decisions. An optional agent ID narrows the result.
- The caller can derive that literal from a task query with
  `knowledgeCompatibilitySearchTerm`. It uses CairnKeep's existing rule: the
  longest word of at least three Unicode code points after excluding function
  words and generic task verbs, earliest on ties. The helper retains
  deterministic JavaScript default lowercase, matching the SurrealDB adapter.
  If no term
  qualifies, it keeps the whole query. This preserves the current modest
  recall; it does not make multiword, semantic, or vector search equivalent.
- Results are ordered by creation time descending, then kind and ID ascending.
  There is no score or relevance ranking. A missing match returns `[]`.
- Returned rows must have a valid scoped record ID, scope, fields, optional
  agent filter, and literal match. Duplicate, over-limit, or malformed rows
  fail with `KNOWLEDGE_INVALID_RESULT`; database query failures become
  `KNOWLEDGE_QUERY_FAILED`. Neither error includes backend details.

The compatibility term is selected outside the SurrealDB adapter so the port
continues to mean exactly the literal text supplied by its caller. The term
selection remains stable after removal of the former adapter.

## Worker retrieval and provenance (AK-04)

`WorkerAgentExecutor.prepare` validates the task, agent, role and pipeline
before `RunContextAssembler` retrieves knowledge. Only the Runtime-composed
tenant and the authoritative portable repository binding form the store scope;
a missing repository binding skips retrieval. The assembler normalizes the task
title (or uses the stage objective), limits it to 200 code points, selects one
compatibility term, and asks for at most five scoped hits. A 5-second deadline
bounds the wait for a search. The store operation itself has no abort API, so a
timed-out operation may still finish later without influencing that run.

The existing `WorkerContext.projectMemory` field carries bounded advisory
excerpts with `provider: surrealdb`; the field name keeps the worker input
schema stable. Each excerpt is limited to 1,200 code points, all excerpts to
4,000, and the serialized field to 16 KiB or the remaining worker context
budget, whichever is smaller. Knowledge does not grant a capability or change
authoritative project state. A disabled store leaves the field and retrieval
record absent. Unavailable, failed, empty and skipped retrievals leave the
field absent; cancellation also aborts preparation.

Before any excerpt is injected, the assembler appends one run-local retrieval
record and its references atomically. The record contains outcome, typed error,
SHA-256 of both the bounded context query and the exact literal term, the
derived portable memory identity, counts, and each result's kind, ID, injection
and transformation flags. The provider query digest is null before a search
attempt and is retained for failed, cancelled and timed-out attempts. A true
`truncated` flag also marks content sanitized before injection. `sha256:` of
the original title/text pair identifies the stored content version. It stores
no query text, body, endpoint or credential. A
provenance write failure suppresses injection; a competing write for the same
run refuses preparation. `run:show` reports the retrieval. Historical
CairnKeep rows remain readable.

## Governed admission (AK-05)

New memories and decisions are written only through the authoritative Runtime's
`knowledge:plan` and `knowledge:admit` commands while native knowledge is
connected. The operator supplies a project, a completed real worker run, and
the exact text (plus a title for a decision). The application checks the
project, portable repository binding, task, agent, run ownership, completion,
worker execution provenance, and persisted result. Simulation and controlled
action runs cannot be used as knowledge sources.

`knowledge:plan` returns a bounded, reviewable JSON plan with the full proposed
text, source run, deterministic knowledge ID, a digest of the canonical run
result, and an SHA-256 plan hash. It does not write knowledge or audit state.
The operator reviews that output, then passes the exact hash and a reviewer
identity to `knowledge:admit` with the same content. The Runtime recomputes the
plan against current authority; any change invalidates the hash. The current
trusted-local operator model records the supplied reviewer identity but cannot
authenticate human presence from another same-UID process.

Admission first appends an audit event containing the reviewer, plan hash,
scope and run references, never the body. Failure of this approval append
stops before SurrealDB mutation with a bounded error. The service checks the
deterministic ID for an existing, exactly matching record and graph, then
writes an immutable scoped record only when absent. It verifies the graph and
appends a final recorded event. The response reports `recorded` or
`reconciled`; the latter means an explicit same-hash call found the exact
record and skipped a second write.

A failed write may have committed remotely. A failed final audit leaves an
otherwise verified record without a confirmed final audit. Both return typed,
sanitized uncertainty and require an explicit same-hash `knowledge:admit` call
to reconcile. Failure-audit errors cannot replace those typed outcomes or
expose backend details. A mismatched existing record fails closed; changed
content or authority invalidates the reviewed hash. The current trusted-local
reviewer identity is supplied by the caller and is not proof of human presence.
`knowledge:trace` reads the scoped record and verified provenance graph.

The limit is 4,000 Unicode code points and 16 KiB of text, with a 200 code
point decision title. Knowledge remains advisory; approval does not grant a
capability or change task, run, or project authority. This slice admits new
run-sourced records only. Legacy import and its distinct provenance policy
belong to AK-06.

## Historical CairnKeep import (AK-06)

AK-06 provided a bounded, explicit, reviewed import of visible CairnKeep named
scope entries into a separate native legacy-memory table. AK-08 removed the
adapter, `project-memory:status`, `knowledge:legacy-plan`, and
`knowledge:legacy-import`; that workflow is no longer available. Existing
imported entries retain source scope, key, SHA-256 value digest and import time.
They have no invented AI Office run, task, agent or source creation time.
`knowledge:trace` exposes their legacy origin, and bounded native search can
return them. Historical run retrieval provenance remains readable through
`run:show`. Neither the Runtime nor AK-08 deletes the external CairnKeep store.
Unimported scopes must be retained and reviewed separately outside AI Office.
See the [historical project memory record](project-memory.md).
