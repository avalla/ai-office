# Historical project memory (CairnKeep)

The CairnKeep integration was retired in AK-08. AI Office no longer starts its
MCP server, reads its named scopes, exposes `project-memory:status`, or accepts
new legacy imports. The AK-06 import workflow is closed. Earlier behavior and
bounds are recorded in [ADR-0018](../adr/ADR-0018-optional-non-authoritative-project-memory-provider.md)
and the [roadmap](roadmap.md); those records are historical, not setup guidance.

Records imported during AK-06 remain in the optional native SurrealDB knowledge
store. They keep their original source scope, key and content digest and have no
invented run, task or agent provenance. They remain available to bounded native
retrieval and `knowledge:trace` when the store is connected. Historical
CairnKeep retrieval rows also remain readable through `run:show` in the
Runtime's project database. No migration deletes or rewrites these records.

External CairnKeep databases are outside AI Office's authority and are never
purged by AI Office. If a named scope was not imported before AK-08, retain and
review that source separately. New agent knowledge uses the reviewed
`knowledge:plan` and `knowledge:admit` workflow described in
[native agent knowledge](agent-knowledge.md).
