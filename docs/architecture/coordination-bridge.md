# Coordination Bridge architecture (proposed)

Status: proposed with [ADR-0036](../adr/ADR-0036-coordination-bridge-boundary-protocol-trust.md)
and not current architecture. [overview.md](overview.md) describes what
exists today; nothing here is implemented, and no part of it becomes a
requirement before the ADR is accepted and the tasks of
[M23](../development/coordination-bridge.md) deliver it. The wire contract is in
the [coordination protocol](../development/coordination-protocol.md).

## 1. Programs and boundaries

```text
 ChatGPT (first client) / other MCP clients            GitHub (dedicated private repository)
        |  HTTPS, OAuth 2.1 bearer                             ^   |  issues and comments
        v                                                      |   v  (bounded polling, cursor)
 Reverse proxy (Caddy, deployment component)           Coordination bridge program (CB-03)
   TLS, vhost, size and rate limits                      GitHub token in the credential boundary
        |  loopback HTTP, Streamable HTTP                 executes Runtime-issued publication orders
        v                                                      |  restricted ingest surface (5b)
 MCP server program (CB-11B)                                   |
   OAuth resource server, scope planning:read                  |
   read-only tools, explicit field mappers                     |
        |  read-only query client (GET only)                   |
        v                                                      v
 +--------------------------------- Runtime (daemon) ---------------------------------+
 |  coordination read listener     main socket (0600)      ingest listener (5b)       |
 |  /api/coordination/v1 + health  /commands, /api, health  fixed coordination cmds   |
 |                                                                                    |
 |  coordination application API (read facade first; write operations added by tasks) |
 |  planning read model (CB-02) | proposal aggregate (CB-04) | publication outbox      |
 |  existing services: UpdateTask, ManageTaskDependencies, audit, command queue       |
 +------------------------------------------ SQLite ----------------------------------+
        ^
        |  query protocol, unprofiled (loopback)
 Dashboard program (existing)       CLI (existing, main socket)
```

| Program             | Status               | Surface it receives                                     | Network                    |
| ------------------- | -------------------- | ------------------------------------------------------- | -------------------------- |
| Runtime daemon      | exists               | itself                                                  | Unix sockets only          |
| Dashboard           | exists               | `GET /api/...` (unprofiled; holds the main socket path) | loopback                   |
| CLI                 | exists               | main socket, command and query protocols                | none                       |
| MCP server          | new, optional        | coordination read listener only                         | loopback, behind the proxy |
| Coordination bridge | new, optional        | ingest surface (5b), otherwise none                     | outbound HTTPS to GitHub   |
| Reverse proxy       | deployment component | none; forwards to the MCP loopback port                 | public HTTPS               |

Rules enforced by tests, not conventions:

- The MCP and bridge programs import only application ports, pure protocol
  modules, the extracted runtime-client package and their own libraries. They do
  not import `apps/*`, storage, `runtime-host`, domain mutators or the command
  operation of `RuntimeClient`; `apps/daemon` does not import them.
- The MCP program receives one socket path, the read listener, and no
  configuration for the main socket.
- Every exposed response is produced by an explicit mapper over classified
  fields.

## 2. Trust zones

| Zone                                  | Trust                                   | Controls                                                                                                                              |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Public internet and remote MCP client | none                                    | TLS and limits at the proxy; OAuth bearer on every request; audience, scope and principal allowlist; sanitized errors                 |
| GitHub content                        | none, untrusted data                    | numeric-account allowlist as an acceptance filter, closed-grammar parsing, size limits, Runtime-side validation, no command semantics |
| MCP and bridge programs               | low, internet-facing or text-processing | least Runtime surface, separate supervision, no storage, no credentials beyond their own, kill switch                                 |
| Runtime                               | authority                               | validation, preconditions, approval check, audit, single-writer command queue                                                         |
| Operator on the local machine         | trusted-local                           | approve and apply commands; identity recorded, presence not authenticated                                                             |
| Same-user local process               | trusted-local, not a boundary           | acknowledged in ADR-0014 and ADR-0003; M10 owns the remedy                                                                            |

The Runtime read listener serves only the projects and data classes the owner
enabled, as P and T projections built Runtime-side, so a compromised MCP program
can read every enabled project at P and T and nothing else through that
listener. Per-principal project scope inside that set is an MCP-side check.

Capability gap, open owner decision (ADR-0036 Decision 5, point 4): the main
socket path is fixed (`<runtime home>/daemon.sock`) and today's service
management installs per-user services only. In a same-user deployment a
compromised MCP program can therefore open the main socket and post any command,
including approval and apply. Interface restrictions alone do not close this.
The recommended option makes capability isolation (a dedicated operating-system
user or a container or sandbox that mounts only the read socket) a verified
precondition of enabling the public vhost; it needs system-level launchd and
systemd adapters or a container recipe that do not exist today.

## 3. Data exposure

Data classes: **P** identifiers, keys, statuses, priorities, relationships,
counts, timestamps; **T** titles; **D** descriptions and long text; **A**
agents, runs, run output, activity, audit, knowledge, memory, credentials,
paths and anything an agent produced. Existing read models contain D and A
fields (for example `RequirementSummary.description`), so none is passed
through.

| Channel            | Initial classes           | Gate                                            |
| ------------------ | ------------------------- | ----------------------------------------------- |
| Remote MCP         | P, T                      | scope `planning:read` and per-project allowlist |
| MCP detail         | D                         | scope `planning:detail`, not issued in M23      |
| GitHub publication | P by default, T if listed | publication authorization `contentClasses`      |
| Any channel        | A                         | never in M23                                    |

Limits: page default 50, maximum 200; response at most 256 KiB; strings at most
256 characters with a truncation flag; arguments at most 4 KiB; per-principal
rate limit and concurrency cap in the program and a second limit at the proxy; a
best-effort scrubber on exposed strings. Unclassified fields are not exposed.

## 4. Flows

### 4.1 Remote read (Remote Read Gate)

```text
ChatGPT                Proxy            MCP server               Runtime (read listener)
  | POST /mcp (no token)  |                 |                            |
  |---------------------->|---------------->| 401 + resource_metadata    |
  |<--------------------------------------- |                            |
  | GET /.well-known/oauth-protected-resource -> issuer, scopes_supported |
  | discovery of the authorization server, PKCE S256, resource=<canonical URI>
  |===== user signs in at the external authorization server ============> access token (aud, scope, exp)
  | POST /mcp  Authorization: Bearer <token>  tools/call ai_office_get_milestones
  |---------------------->|---------------->| verify issuer, aud, exp, scope;
  |                       |                 | principal (iss,sub) enabled; project allowed; rate limit
  |                       |                 |-- GET /api/coordination/v1/milestones?project=… -->|
  |                       |                 |<-- P,T projection built Runtime-side ----------------|
  |                       |                 | per-principal project scope; paginate; bound size
  |<----------------------|<----------------| result (read-only annotated)
```

Failure behavior: missing or invalid token → 401 with `WWW-Authenticate`;
wrong audience, disabled principal or unauthorized project → 401 or 403 without
detail; insufficient scope → 403 `insufficient_scope`; Runtime unreachable →
a sanitized tool error, no stack, no path; the Runtime and dashboard are
unaffected by any of these.

### 4.2 Asynchronous GitHub coordination

```text
Runtime                          Bridge                         GitHub (private repo)
  | publication order (intent persisted: key, destination, digest)
  |-- claim + lease ------------->|
  |                               |-- create issue / comment ---->|
  |                               |<-- external reference --------|
  |<-- outcome (published) -------|   (failed: terminal; not_sent: retry; error after send: ambiguous -> marker lookup)
  | receipt + audit recorded      |
  |                               |<-- poll comments (cursor, conditional) -- external proposal
  |<-- submit envelope + provenance (restricted surface)
  | validate, assess, store proposal (state: assessed), no planning change
  | feedback message enqueued as a publication order
```

### 4.3 Governed change (V2)

```text
proposal (assessed) -> plan {operations, preconditions, digest} -> preview
   -> local operator approve (digest, expiry) -> apply:
        one transaction: recheck preconditions -> UpdateTask / ManageTaskDependencies
        -> plan applied + receipt + audit
   -> receipt publication order -> GitHub
on any mismatch: refuse the whole plan as stale, no change
```

## 5. Deployment

- The MCP program is a managed service (launchd on macOS, systemd on Linux)
  generated by the existing service management, which today renders per-user
  services for the Runtime and a loopback dashboard; the MCP service binds
  loopback only, waits for the Runtime, and installs, stops and uninstalls
  independently. A capability-isolated profile (system-level service under a
  dedicated user, or a container) is required before the public vhost is enabled
  if Decision 5 point 4 is accepted as recommended.
- The reverse proxy is a documented deployment component; Caddy is the preferred
  and templated choice (vhost, automatic TLS, `reverse_proxy` to the loopback
  port, request-body size limit, optional rate limit, optional client-IP or mTLS
  restriction). Streaming behavior and header forwarding are exercised by the
  end-to-end test, not assumed.
- Optional defence in depth for ChatGPT: verify the OpenAI-managed client
  certificate chain at the proxy and, or, allowlist the published egress ranges.
  Neither replaces OAuth.
- Kill switch, in order of speed: disable the principal, revoke at the
  authorization server, stop the MCP service, remove the vhost.
- Disabling any bridge component leaves the Runtime and dashboard unchanged.

## 6. Verification of the contract against the existing code

Checked on `main` at 375c928 (2026-10-15).

| Claim used by the design                                                                    | Evidence                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One socket serves health, query and command routes; the socket is mode 0600                 | `apps/daemon/src/office-daemon.ts` (`Bun.serve({ unix })`, `chmodSync(…, 0o600)`, `route()` order: `/health`, `queryApi.handle`, `/commands`)               |
| The query API accepts only GET and is separate from the command protocol                    | `apps/daemon/src/query-api.ts` (`handle`: 405 for non-GET); `packages/application/src/protocol/query-protocol.ts` header                                    |
| Query routes expose descriptions, runs, activity and global memory                          | `query-api.ts` `route()` (`/api/memory`, `/api/runs/:id`, `/api/activity`, project detail); `operational-read-models.ts` (`RequirementSummary.description`) |
| `RuntimeClient.execute` takes any command                                                   | `packages/application/src/runtime/runtime-client.port.ts`; `apps/cli/src/daemon-client.ts` (`execute(args)` posts to `/commands`)                           |
| The IPC transport lives in `apps/cli`                                                       | `apps/cli/src/daemon-client.ts`                                                                                                                             |
| The dashboard is a separate loopback process proxying GET to the query API                  | `apps/dashboard/src/dashboard-host.ts` (`loopbackHostnames`, `proxy`)                                                                                       |
| A task graph read model exists with nodes, edges, ready and waiting                         | `operational-read-models.ts` (`TaskGraph`, `TaskGraphNode`, `TaskGraphEdge`)                                                                                |
| Priority change is audited with from and to                                                 | `packages/application/src/commands/update-task.ts` (`task.priority_updated`)                                                                                |
| Dependency link is idempotent, cycle-checked, editable only before execution                | `packages/application/src/commands/manage-task-dependencies.ts` (`link`, `assertEditable`)                                                                  |
| Transactions do not nest                                                                    | `packages/application/src/ports/transaction-runner.port.ts` (`TransactionAlreadyActiveError`)                                                               |
| Daemon-queue commands are serialized, but `run:tick` and the queue runtime bypass the queue | `office-daemon.ts` (`enqueue`, and the `run:tick` branch that calls `execute()` directly); `apps/daemon/src/queue-runtime.ts` (`runtime.execute`)           |
| SQLite transactions start `BEGIN IMMEDIATE` and reject nesting by throwing                  | `packages/storage-sqlite/src/database/sqlite-transaction-runner.ts`                                                                                         |
| An executable connector mutation must require approval                                      | `packages/connector-sdk/src/connector-registry.ts` (`freezeDefinition`)                                                                                     |
| Grant shape available for the publication authorization                                     | `packages/domain/src/capability/capability.ts` (`CapabilityGrant`)                                                                                          |
| Service management is loopback-only for the dashboard                                       | `packages/service-management/src/service-plan.ts` (`validateOfficeServicePlan`)                                                                             |
| Credential files are strict and declared                                                    | ADR-0020                                                                                                                                                    |
| Audit actor type is a closed union                                                          | `packages/application/src/commands/record-audit-event.ts`                                                                                                   |

Out-of-scope inconsistencies found: none that block this design. The
`apps/cli` location of the IPC transport is the one structural dependency this
work must change (CB-11B).

## 7. Reuse and non-duplication

Reused: `UpdateTask` and `ManageTaskDependencies` (their transactional
bodies are exposed by a behavior-preserving refactor in CB-08), audit, the command
queue, the task graph read model, service management, the capability grant
vocabulary and the credential boundary pattern. New: the coordination
application API and read listener, the proposal aggregate and plan workflow, the
publication authorization and outbox, the MCP and bridge programs. Not built: an
identity provider, a second task tracker, a second MCP server, a proxy in the
Runtime, a connector mutation without approval.
