# Native agent knowledge retrieval

AK-01 defines `AgentKnowledgeStore` as a secondary, non-authoritative
application port. AK-02 implements its SurrealDB read behavior and the
CairnKeep-compatible search term. AK-03 composes it independently into the
Runtime when explicitly enabled. The Runtime still uses the optional,
read-only CairnKeep provider for worker context; AK-04 owns that cutover.
SurrealDB does not store project, task, run, approval, or audit authority.

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
after a failure or configuration change. AK-03 does not read or write knowledge
for workers, expose a mutation command, or change CairnKeep retrieval.

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
  CairnKeep's existing JavaScript locale-aware lowercase step. If no term
  qualifies, it keeps the whole query. This preserves the current modest
  recall; it does not make multiword, semantic, or vector search equivalent.
- Results are ordered by creation time descending, then kind and ID ascending.
  There is no score or relevance ranking. A missing match returns `[]`.
- Returned rows must have a valid scoped record ID, scope, fields, optional
  agent filter, and literal match. Duplicate, over-limit, or malformed rows
  fail with `KNOWLEDGE_INVALID_RESULT`; database query failures become
  `KNOWLEDGE_QUERY_FAILED`. Neither error includes backend details.

The compatibility term is selected outside the SurrealDB adapter so the port
continues to mean exactly the literal text supplied by its caller. Existing
CairnKeep retrieval now uses the same helper and retains its query digest and
result behavior. Worker context limits, injection, and run provenance remain
the responsibility of the AK-04 cutover.
