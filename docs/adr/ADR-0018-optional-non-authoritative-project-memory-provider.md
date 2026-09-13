# ADR-0018: Optional, non-authoritative project memory provider

Status: accepted, 2026-09-13.

## Context

Workers benefit from durable context about a repository that outlives one run:
earlier decisions, conventions, pitfalls. AI Office already has three storage
categories with distinct authority: authoritative `project.sqlite`, durable
reusable global memory in `global.sqlite` (M7), and the future regenerable
`index.sqlite` (M8). [CairnKeep](https://github.com/cairnkeep/cairnkeep) is an
external, harness-agnostic memory layer with its own MCP stdio server, AgentFS
storage, capability model, playbooks, artifacts, work evidence and evaluations.

Adopting CairnKeep as a store of record, or copying its authority systems, would
create a second source of truth beside the Runtime and bypass the capability,
pipeline and approval boundaries that define AI Office. A worker with a generic
MCP client could also call CairnKeep mutation tools directly.

CairnKeep's stdio server resolves its `project` scope to
`<cwd>/.agentfs/project.db`. Using that scope would bind memory to one checkout,
so worktrees and clones of one repository would each get unrelated memory.

## Decision

1. **AI Office remains authoritative.** Projects, repository identity, tasks,
   requirements, milestones, ADRs, pipelines, agent runs, policy, capabilities,
   approvals, AI Office artifacts and evidence, audit, and execution authority
   stay in the Runtime and `project.sqlite`. CairnKeep remembers; AI Office
   decides.
2. **CairnKeep is optional contextual memory.** It is a fourth, external,
   non-authoritative category: durable contextual memory used as locators and
   context, never truth. Current repository contents, tests, requirements, ADRs,
   pipeline policy and explicit user instructions override it. Conflicts are not
   resolved by mutating memory.
3. **`global.sqlite` is unchanged** and remains AI Office's global reusable
   memory. No AI Office memory moves into CairnKeep or AgentFS.
4. **Identity derives from the portable `repositoryId`.** The memory identity is
   `aio-` + the first 32 hex characters of
   `SHA-256("ai-office-project-memory-identity-v1" || 0x00 || repositoryId)`. It
   is deterministic, bounded (36 characters), valid for CairnKeep scope and
   project-ID patterns, non-secret, and independent of cwd, checkout, worktree,
   runtime home, host and the runtime-local project ID. The adapter uses it as a
   CairnKeep **named scope**, which CairnKeep stores at
   `${CAIRN_AGENTFS_BASE_DIR:-~/.cairnkeep}/<identity>.db`, instead of the
   cwd-bound `project` scope. Because each retrieval runs CairnKeep in a fresh
   private cwd, the Runtime host normalizes `CAIRN_AGENTFS_BASE_DIR` before
   spawn: unset stays unset, an absolute path is lexically normalized, `~/…`
   expands against the host's absolute `HOME`, and any relative or malformed
   value makes the provider `misconfigured`. The raw value is never forwarded
   and the path is never persisted.
5. **Integration is through a provider port.** The application layer defines a
   read-only `ProjectMemoryProvider` port and a single `RunContextAssembler`
   that performs at most one bounded search per worker run. MCP, CairnKeep,
   child processes and configuration live only in the
   `packages/cairnkeep-memory` infrastructure adapter, composed by the Runtime
   host. A different provider can replace it without application changes.
6. **The initial integration is read-only.** The adapter starts
   `cairn memory-server` with `CAIRN_MCP_TOOL_PROFILE=custom` and
   `CAIRN_MCP_ALLOWED_TOOLS=memory_search`. The server does not register other
   tools under that profile. The adapter additionally refuses any server whose
   `tools/list` is not exactly `memory_search`, because an annotation or profile
   claim alone is not an authorization boundary. Workers never receive a
   provider, command, MCP client, tool, database path, AgentFS access or
   credentials, only bounded excerpts pinned into their context digest.
7. **CairnKeep's capability, playbook, artifact, work-evidence, evaluation,
   trajectory and skill systems are not adopted.** AI Office's own capability,
   pipeline, approval, provenance and audit semantics are the only ones that
   apply.
8. **AgentFS remains an implementation detail of CairnKeep.** AI Office has no
   AgentFS dependency and never opens CairnKeep databases.
9. **Absence or failure never blocks normal operation.** The provider is
   disabled by default. Not installed, unavailable, timed out, incompatible,
   malformed, oversized or empty results all degrade to "no project memory", are
   recorded as provenance, and never fail a run or project health. Only an
   explicit misconfiguration produces a status warning.
10. **Future memory writes must be reviewed and approved explicitly.** Durable
    promotion of AgentRun outcomes into memory requires a separate, explicitly
    approved AI Office workflow and port; the read-only port is never widened
    into autonomous writes.

### Bounds and determinism

The query is the whitespace-normalized task title (or pinned stage objective),
bounded to 200 characters at a word boundary. Because CairnKeep's default search
matches the whole query as one literal substring, the adapter sends the longest
non-stop-word term. The application therefore owns the _context query_ and the
adapter owns the _provider query_, the exact string sent; the adapter reports
that string's SHA-256 in its search result, and a missing or malformed digest
makes the search an invalid response. At most 5 results are accepted; each
excerpt is at most 1,200 characters and all excerpts at most 4,000 characters,
applied in rank order after the adapter sorts by score and key. The serialized block is at most
16 KiB and never more than the worker context has left; with less than 1 KiB
available no search runs. Control and format characters in excerpts are
replaced. A provider message is at most 512 KiB. The whole retrieval, including
process start and handshake, has a 5 second default deadline (100 ms–30 s). No
model call participates.

The child runs in a private empty directory in its own process group with an
allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `USER`, `LOGNAME`, `LANG`,
`LC_ALL`, plus the normalized absolute `CAIRN_AGENTFS_BASE_DIR` when set).
Embedding keys, `MCP_HTTP_PORT` and other secrets are not forwarded, which also
keeps retrieval in CairnKeep's deterministic substring mode. stdout must be pure bounded JSON-RPC; stderr is
counted and discarded. Timeout, cancellation and completion terminate the whole
process group with bounded waits before the retrieval returns. At most two
provider sessions run concurrently.

MCP protocol compatibility is explicit and fail-closed. The bounded client
implements exactly MCP `2025-06-18`, requests it, and accepts an `initialize`
answer only with that version. A missing, older, newer or malformed version is
`PROJECT_MEMORY_INCOMPATIBLE`, and no `notifications/initialized`, `tools/list`
or `tools/call` follows. Supporting another revision is a deliberate adapter
change, never implicit negotiation.

### Provenance

Migration `0028` adds append-only `agent_run_memory_retrieval` (one row per run)
and `agent_run_memory_reference` (rank, reference key, content digest, scope,
injected, truncated). They record provider, server version, memory identity,
outcome (`retrieved`, `empty`, `failed`, `skipped`), typed error code, query
digests, counts and time. Migration `0029` makes query provenance exact with two
lowercase SHA-256 digests: `context_query_sha256` of the bounded task-derived
query AI Office handed to the port (the column `0028` recorded, renamed), and
`provider_query_sha256` of the exact query the adapter sent, as the adapter
reported it. A completed search must carry both, a skip carries no provider
digest, and a failure has none because no validated report exists; rows written
before `0029` keep it null. They never store memory bodies, either query text,
prompts, paths, environment or credentials. CairnKeep search results carry no
digest, so the adapter records `sha256:` of the complete remembered value.
Provenance is written before injection; if it cannot be written the run
continues without project memory. The rows are runtime-local evidence like
`execution_json`, excluded from portable snapshots, and describe influence
rather than authority.

A run's project memory context is prepared at most once. Admission moves only
`queued` runs to `preparing`, and recovery reconciles an interrupted
`preparing` run to a terminal state without replaying it. The assembler also
refuses, as `WORKER_CONTEXT_INVALID` and before any provider call, to prepare a
run that already has retrieval provenance, including when another preparation
records it first. Recorded provenance therefore always describes the only
context that run can dispatch.

## Alternatives

- **Read CairnKeep SQLite/AgentFS directly:** couples AI Office to private
  storage and bypasses CairnKeep's own boundary. Rejected.
- **Use the MCP SDK:** a large dependency tree for four JSON-RPC methods. A
  small validated stdio client confined to the adapter is easier to bound and
  audit. The SDK can replace it inside the adapter without port changes.
- **Remote CairnKeep HTTP with `X-Cairn-Project`:** would honor project IDs, but
  adds network, token and service lifecycle scope. Deferred.
- **A persistent provider daemon:** a second always-running service is not
  justified for one short read per run; per-retrieval sessions cost roughly 0.4
  s against CairnKeep 2.17.3 and leave nothing running.
- **Worker-side MCP access:** would expose mutation tools and bypass
  capabilities. Rejected.

## Consequences

- Memories written by coding clients into a checkout-local CairnKeep `project`
  scope are not visible to AI Office. Memory under the derived named scope must
  be written deliberately until reviewed promotion exists.
- Substring retrieval with one term has modest recall; semantic retrieval would
  require forwarding embedding configuration and is deferred.
- Configuration is environment-only on the Runtime host. Generated OS service
  definitions do not carry these variables yet.
- Provenance is visible in `run:show`, `status` and `project-memory:status`; the
  dashboard does not render it yet.

See [project memory](../development/project-memory.md) and the
[roadmap](../development/roadmap.md).
