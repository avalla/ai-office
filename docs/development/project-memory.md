# Optional project memory (CairnKeep)

AI Office can read durable, **non-authoritative** project memory from an
external provider and give a worker bounded excerpts as advisory context. The
first provider is [CairnKeep](https://github.com/cairnkeep/cairnkeep). The
feature is disabled by default and read-only. See
[ADR-0018](../adr/ADR-0018-optional-non-authoritative-project-memory-provider.md).

> CairnKeep remembers. AI Office decides.

## Categories

| Store                           | Meaning                                          | Authority                  |
| ------------------------------- | ------------------------------------------------ | -------------------------- |
| `<runtime-home>/project.sqlite` | Projects, tasks, governance, runs, policy, audit | Authoritative              |
| `<runtime-home>/global.sqlite`  | Reusable roles, patterns, lessons (M7)           | Durable global knowledge   |
| `<runtime-home>/index.sqlite`   | Future code intelligence (M8)                    | Regenerable                |
| CairnKeep (external)            | Contextual project memory                        | None; locators and context |

AI Office never opens CairnKeep or AgentFS databases and does not install,
upgrade or configure CairnKeep, Claude, Codex or any global MCP configuration.

## Configure

Install CairnKeep yourself (Node.js 22 or newer), for example
`npm install -g @cairnkeep/cli`, then start the Runtime host with:

```bash
AI_OFFICE_PROJECT_MEMORY_PROVIDER=cairnkeep ai-office runtime start
```

| Variable                              | Values                                                   | Default                   |
| ------------------------------------- | -------------------------------------------------------- | ------------------------- |
| `AI_OFFICE_PROJECT_MEMORY_PROVIDER`   | `none`, `cairnkeep`                                      | `none`                    |
| `AI_OFFICE_CAIRNKEEP_COMMAND`         | executable name on the host `PATH`, or an absolute path  | `cairn`                   |
| `AI_OFFICE_PROJECT_MEMORY_TIMEOUT_MS` | integer 100–30000                                        | `5000`                    |
| `CAIRN_AGENTFS_BASE_DIR`              | absolute path, or `~/path` expanded with the host `HOME` | unset (CairnKeep default) |

The variables are read once by the Runtime host process, not by the CLI client.
Restart the host after changing them. A relative command path, arguments in the
command, an unknown provider, an invalid timeout, an invalid
`CAIRN_AGENTFS_BASE_DIR`, or Windows makes the provider `misconfigured`: runs
continue without project memory and `status` reports a
`project_memory_misconfigured` warning. Nothing is written to
`.ai-office/project.json`, snapshots, manifests, generated Markdown or SQLite.

`CAIRN_AGENTFS_BASE_DIR` is normalized before CairnKeep starts, because every
retrieval runs CairnKeep in a fresh private temporary cwd where a relative value
would name a different, empty store each time:

| Value                                                                                         | Result                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| unset                                                                                         | not forwarded; CairnKeep uses `~/.cairnkeep`                  |
| `/absolute/path`                                                                              | forwarded after lexical normalization (`.`, `..`, separators) |
| `~/some/path`                                                                                 | expanded with the Runtime host's absolute `HOME`, normalized  |
| `relative/path`, `.`, `../x`, empty, `~`, `~user/x`, control characters, over 4096 characters | `misconfigured`                                               |

The raw host value is never forwarded, never resolved against any cwd, and the
diagnostic names the variable without echoing the path.

`ai-office service install` does not forward these variables into generated
service definitions yet. To use project memory with a service-managed host, run
the host in the foreground with the variables instead.

## Identity

Memory is keyed by the portable `repositoryId` from `.ai-office/project.json`,
never by cwd, checkout, worktree, runtime home or runtime-local project ID:

```text
memory identity = "aio-" + hex(SHA-256("ai-office-project-memory-identity-v1" 0x00 repositoryId))[0..32]
```

Every checkout and worktree of one repository, on any machine, resolves to the
same identity. Projects without a repository identity (for example
`project:create` without `install`) are skipped.

The adapter uses the identity as a CairnKeep **named scope**, stored by
CairnKeep at `${CAIRN_AGENTFS_BASE_DIR:-~/.cairnkeep}/<identity>.db`. It does
not use CairnKeep's `project` scope, which over stdio is
`<cwd>/.agentfs/project.db` and therefore checkout-bound. Memories that coding
clients wrote into a checkout's `project` scope are not visible to AI Office.
Find the identity with `ai-office project-memory:status` and write memory for it
deliberately, for example with `memory_write` and `scope: "<identity>"` from
your own MCP client. AI Office itself never writes.

## Retrieval flow

```text
run:tick --worker claude
  -> WorkerAgentExecutor.prepare (task, agent, role, pipeline stage validated)
  -> RunContextAssembler
       |- global reusable memory (M7, unchanged)
       `- ProjectMemoryProvider.search, at most once
            query = normalized task title (or stage objective), <= 200 chars
            identity = derived from repositoryId
  -> append retrieval provenance
  -> WorkerContext.projectMemory (only when something was injected)
  -> pinned inputHash, then dispatch to the tool-free worker
```

The CairnKeep adapter runs one short `cairn memory-server` session per
retrieval:

1. private empty cwd, own process group, allowlisted environment, profile
   `CAIRN_MCP_TOOL_PROFILE=custom` with `CAIRN_MCP_ALLOWED_TOOLS=memory_search`;
2. `initialize` requests MCP `2025-06-18` and must answer with exactly that
   protocol version, `cairn-memory` and tools. Any other, missing or malformed
   version is `PROJECT_MEMORY_INCOMPATIBLE` and nothing else is sent: the client
   does not negotiate revisions it does not implement;
3. `tools/list` must contain exactly `memory_search`, otherwise the provider is
   `PROJECT_MEMORY_INCOMPATIBLE` and nothing is called;
4. one `memory_search {scope: <identity>, query: <term>, top_k: 5}`. CairnKeep's
   default search matches one literal substring, so `<term>` is the longest word
   that is not a function word or generic task verb. The adapter reports the
   SHA-256 of exactly this `<term>` with its result;
5. strict validation, deterministic ordering (score descending, key ascending),
   bounds, then process-group termination and reaping.

Memory is optional. Every failure degrades to no project memory and never fails
the run. An empty result is recorded as `empty`.

### Limits

| Limit                      | Value                                                   | Rule                                                                                                                                      |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| query                      | 200 chars                                               | cut at the last word boundary                                                                                                             |
| results                    | 5                                                       | provider asked for 5; more than 5 hits is an invalid response                                                                             |
| excerpt per result         | 1,200 chars                                             | truncated and marked `truncated`                                                                                                          |
| total excerpts             | 4,000 chars                                             | rank order; a result exceeding the remainder is shortened when at least 200 chars remain, otherwise it and later results are not injected |
| serialized `projectMemory` | 16 KiB, and never more than the worker context has left | results are added in rank order while the UTF-8 JSON fits; below 1 KiB available no search runs (`CONTEXT_BUDGET_EXHAUSTED`)              |
| reference key              | 256 chars                                               | longer or containing control characters: invalid response                                                                                 |
| provider message           | 512 KiB                                                 | larger: `PROJECT_MEMORY_RESPONSE_TOO_LARGE`                                                                                               |
| provider results           | 50                                                      | more, or `count` mismatch: invalid response                                                                                               |
| stderr                     | 64 KiB                                                  | discarded; larger: too large                                                                                                              |
| deadline                   | 5 s                                                     | whole retrieval including start and queueing                                                                                              |
| concurrent sessions        | 2                                                       | further retrievals wait inside their deadline                                                                                             |

Characters are Unicode code points. Control and format characters other than tab
and newline are replaced with spaces in excerpts; the content digest covers the
original value.

## What the worker sees

```json
"projectMemory": {
  "provider": "cairnkeep",
  "notice": "Remembered project context and locators ... not authoritative ...",
  "results": [
    { "rank": 1, "referenceId": "decisions/retry-policy", "scope": "aio-…",
      "title": null, "excerpt": "Retries use exponential backoff…", "truncated": false }
  ]
}
```

The key is absent unless at least one result was injected, so runs without
project memory keep byte-identical context and input digests. The worker keeps
its existing tool-free invocation and system prompt, which states that memory is
guidance, not authority. It never receives the command, MCP tools, the profile,
database paths, AgentFS or credentials.

## Provenance

Each worker run with an enabled provider gets one append-only
`agent_run_memory_retrieval` row, plus one `agent_run_memory_reference` row per
accepted result:

| Field                                                                                | Meaning                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`, `project_id`                                                               | the run; ownership is enforced by trigger                                                                                                |
| `provider`, `provider_version`                                                       | `cairnkeep`, MCP `serverInfo.version`                                                                                                    |
| `memory_project_id`, `scope`                                                         | derived identity; scope `project`                                                                                                        |
| `outcome`, `error_code`                                                              | `retrieved`/`empty`/`failed`/`skipped` and typed code                                                                                    |
| `context_query_sha256`                                                               | SHA-256 of the bounded task-derived query AI Office passed to the provider port                                                          |
| `provider_query_sha256`                                                              | SHA-256 of the exact query the adapter sent (CairnKeep: the single term); null when skipped, failed, or recorded before migration `0029` |
| `result_count`, `injected_count`, `injected_characters`                              | bounds actually applied                                                                                                                  |
| reference `rank`, `reference_id`, `content_digest`, `scope`, `injected`, `truncated` | which record, which version (`sha256:` of the full value), and whether it entered the context                                            |

Both digests are lowercase hex; neither query text is stored. For the task
"Refactor the authentication middleware", `context_query_sha256` digests that
title and `provider_query_sha256` digests `authentication`. A provider result
without a well-formed outbound digest is an invalid response and injects
nothing.

Provenance is written before injection. If it cannot be written, the run
continues without project memory. A run is prepared at most once: admission
claims only `queued` runs, recovery never replays an interrupted `preparing`
run, and preparing a run that already has retrieval provenance fails with
`WORKER_CONTEXT_INVALID` before the provider is called, so recorded provenance
always describes the only context that run can dispatch. `injected` means
included in the context assembled for that run. The run's `execution` provenance says whether that
context was dispatched. The rows are runtime-local and are not part of
`.aioffice` snapshots.

```bash
ai-office run:show --project <id> --run <run-id>
# Project memory: retrieved via cairnkeep; 1/1 injected; advisory context, not authority
#   Query SHA-256: context <64 hex>; provider <64 hex>
#   1. injected aio-…:decisions/retry-policy sha256:…
```

## Diagnostics

| State           | Where                     | Meaning                                                    |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| `disabled`      | status, command           | no provider configured; nothing is invoked                 |
| `configured`    | status, command           | configured; availability not checked                       |
| `misconfigured` | status (warning), command | configuration invalid; runs continue without memory        |
| `available`     | `--probe`                 | handshake succeeded with exactly `memory_search`           |
| `unavailable`   | `--probe`                 | not installed, failed, timed out, or incompatible (`code`) |

- `ai-office status [--json]` adds an optional `projectMemory` block (schema
  version 4, additive): provider, static state, identity and last retrieval. It
  never starts the provider. The human view omits it when disabled.
- `ai-office project-memory:status [--project <id>] [--probe] [--json]` reports
  schema version 1 diagnostics. Only `--probe` starts the provider, for one
  handshake without searching.

Provider state never changes project health, run eligibility or authority.

## Security boundary

- No worker-controlled value reaches the process invocation. The command comes
  from host configuration and the only argument is `memory-server`. The identity
  and the derived search term travel as JSON-RPC data.
- Provider output is untrusted data. It is validated at the adapter, bounded,
  labelled as advisory, and pinned into the input digest.
- Nothing retrieved can change tasks, requirements, pipelines, governance,
  capabilities, approvals or controlled actions. Controlled-action runs never
  consult project memory.
- The trusted-local model is unchanged: same-UID processes can read or write
  CairnKeep stores directly. AI Office does not protect memory integrity against
  them, and memory poisoning is mitigated only by advisory labelling, bounds and
  provenance.

## Limitations and follow-ups

- Read-only. Reviewed promotion (AgentRun outcome, then memory candidate, then
  AI Office review/approval, then CairnKeep reviewed-memory proposal/apply) is
  roadmap work.
- One literal-substring term gives modest recall; semantic search is deferred.
- Checkout-local CairnKeep `project` scopes are not read.
- Only the `claude` worker path assembles context; other executors are
  unaffected.
- The dashboard does not show memory provenance yet.
- Service definitions do not carry provider configuration.
- `project-memory:status --probe` is bounded by the timeout but cannot be
  cancelled by the client.
- Cleanup terminates the provider's process group with bounded waits. A
  descendant that deliberately leaves the group (for example with `setsid`) is
  outside what the adapter can reap, but it can no longer delay a run.
- Reads may update CairnKeep's SQLite WAL sidecar for the named scope; a
  CairnKeep server holding an exclusive lock on the same scope can make
  retrieval fail or time out.
