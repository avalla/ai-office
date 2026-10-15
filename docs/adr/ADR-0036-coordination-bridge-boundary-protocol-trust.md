# ADR-0036: Coordination Bridge — boundary, protocol and trust model

- Status: Proposed
- Date: 2026-10-15
- Scope: M23 — AI Office Coordination Bridge (CB-R01–CB-R14), delivered by CB-01
- Owner decisions recorded: D1–D6 approved 2026-10-15; D8 revised and D7, D9,
  D10, D11 confirmed as binding design constraints the same day (see the
  matrix below). Decision 5 point 4 (capability isolation) and the HTTPS exposure choice of Decision 10 were decided by the owner on 2026-10-15.

Companion documents: [architecture](../architecture/coordination-bridge.md),
[protocol and planning-change semantics](../development/coordination-protocol.md),
[M23 plan](../development/coordination-bridge.md).

## Context

M23 lets external AI assistants and the owner read the real roadmap, propose
planning changes, request decisions and receive receipts, without access to the
Runtime database. Two channels share one application layer: a remote read-only
MCP server over Streamable HTTP, first for ChatGPT Pro, and an asynchronous
GitHub Issues bridge to a dedicated private repository.

The repository constrains the design:

- The daemon serves one Unix socket (mode 0600) whose single route table holds
  the command protocol (`POST /commands`, the whole CLI surface), the read-only
  query protocol (`GET /api/...`, used by the dashboard, itself a separate
  loopback process) and `GET /health`. A process that can reach the socket can
  reach all three. IPC routing and TTY ownership do not authenticate callers
  ([ADR-0014](ADR-0014-runtime-authority-and-persistent-daemon-host.md)).
- `RuntimeClient.execute(args)` accepts any command. Its only implementation,
  `IpcRuntimeClient`, lives in `apps/cli`, which other programs may not import.
- The existing query routes are built for the dashboard and return full
  descriptions, agents, runs, run output, activity and global memory.
- A task priority change and a dependency edit already exist as audited
  application services, but each opens its own transaction and
  `TransactionRunner.run` rejects nesting. Tasks and edges carry no revision
  counter.
- The connector registry refuses an executable mutation that does not require
  approval, so a GitHub publication cannot be a connector mutation without
  per-report approval or a global rule change.
- Approval is trusted-local: the Runtime does not authenticate human presence
  ([ADR-0003](ADR-0003-authenticate-controlled-action-approvals.md)).
- Provider credentials are host files under a strict loader that reads only
  names declared by registered descriptors
  ([ADR-0020](ADR-0020-managed-provider-credential-boundary.md)).

External facts verified on 2026-10-15 (MCP authorization specification,
revision 2026-07-28, and OpenAI's MCP plugin documentation): an MCP server over
an HTTP transport acts as an OAuth 2.1 resource server and must publish OAuth
protected resource metadata (RFC 9728); clients must send the RFC 8707
`resource` parameter and servers must accept only tokens issued for them as
audience; authorization servers publish RFC 8414 or OpenID discovery metadata,
and clients register through Client ID Metadata Documents, pre-registration or
dynamic registration. ChatGPT adds custom MCP servers at a public HTTPS
Streamable HTTP endpoint (typically `/mcp`), uses authorization code with PKCE
S256, supports CIMD and DCR, checks RFC 9207 `iss`, and does not support custom
API keys, machine-to-machine grants or customer-supplied mTLS certificates.
OpenAI also publishes a client certificate chain and egress IP ranges usable as
transport-level defence in depth, and a Secure MCP Tunnel for private servers.
Whether a ChatGPT Pro account may add a custom MCP server is subject to account
and workspace policy and is verified in CB-11F, not assumed here.

## Owner decision matrix

| #   | Owner decision                                                                                                                    | Where it lands                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| D1  | Dedicated private GitHub repository for communication, proposals and receipts only; never a task-tracker mirror                   | Decision 8, protocol content classes |
| D2  | Fine-grained token for the first release                                                                                          | Decision 11                          |
| D3  | Bounded polling with persisted cursor                                                                                             | Decision 8                           |
| D4  | Autonomous aggregate limited to the proposal lifecycle                                                                            | Decision 2                           |
| D5  | Write scope limited to priority and dependencies                                                                                  | Decisions 2, 9                       |
| D6  | Local approval bound to the digest, with trusted-local limits documented                                                          | Decisions 3, 9                       |
| D7  | Scoped, revocable external publication class without per-report approval                                                          | Decision 8                           |
| D8  | MCP not limited to stdio; remote read-only first                                                                                  | Decisions 1, 5, 10                   |
| D9  | MCP uses the Runtime Query Protocol, never general command access; dedicated health query                                         | Decision 5                           |
| D10 | ChatGPT Pro first; OAuth 2.1 per the MCP authorization spec; `planning:read`; replaceable verifier; external authorization server | Decision 6                           |
| D11 | Per-project scope, field allowlist, pagination and size limits; readable is not exposable                                         | Decision 7                           |

## Decision (proposed)

### Decision 1 — Topology and dependency rules

The Runtime remains the only authority and is never exposed publicly. Two new,
optional, separately supervised programs sit beside it and the existing
dashboard; each is a Runtime client with the narrowest surface it needs.

| Program                     | Role                                                 | Runtime surface                                                                   | Exposure                                            |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| Runtime (daemon)            | Authority: state, validation, approval, apply, audit | itself                                                                            | none; Unix sockets only                             |
| Dashboard (existing)        | Operations console                                   | query protocol, unprofiled (new profiles apply to the coordination listener only) | loopback                                            |
| MCP server (CB-11B)         | Remote read-only tools                               | coordination read listener only (Decision 5)                                      | private interface, behind a tunnel or reverse proxy |
| Coordination bridge (CB-03) | GitHub transport                                     | coordination ingest surface (Decision 5b)                                         | outbound only                                       |

Dependency direction stays `apps/adapters → application → domain`. The new
programs depend only on application ports and pure protocol modules, on the
extracted runtime-client package, and on their own infrastructure libraries.
They never import `apps/*`, storage packages, `runtime-host`, the mutating
`RuntimeClient` operation or domain mutators; `apps/daemon` never imports them.
CB-11B and CB-03 enforce this with an import-boundary test. HTTPS exposure (Cloudflare Tunnel first, Nginx as the alternative, Caddy optional) is a deployment component documented and templated by CB-11E; no general-purpose proxy is embedded in the Runtime.

### Decision 2 — Authority, write scope and aggregate

No transport, tool or comment mutates planning state. The first mutable
operations are `set_priority`, `add_dependency` and `remove_dependency`,
applied only through `UpdateTask` and `ManageTaskDependencies`. Scope, requirement
and milestone changes are advisory proposals without an apply path. A new
autonomous coordination aggregate owns only the proposal lifecycle: request,
assessment, plan, approval, apply outcome and receipt references. It holds no
principal registry, token, transport cursor or publication state; MCP principals are a separate Runtime-owned record (Decision 6). Decision
requests and advisory notes are entries attached to the lifecycle of a proposal;
none exists without one. State machine:
`received → validated → assessed`, terminal `rejected`, `superseded`, `expired`;
a plan adds `approved → applied` and `stale`. Final state names are fixed by
CB-04 and CB-07 against the domain model.

### Decision 3 — Principals, provenance and trust

Six principals are distinct and recorded separately: proposal author (claim),
transport account (provenance), authorized operator, Runtime identity, agent
identity and approving subject; remote MCP callers are a seventh, read-only
class. No principal is inferred from another, and no string in a comment, label,
reaction, tool argument or payload is an authorization. Approval strength equals
existing approvals: it records an operator label and does not authenticate
presence; the stronger boundary remains M10. A shell-capable same-user process
can run the approve command; this ADR does not claim otherwise. A remote MCP
caller can never approve or apply, and that stays out of scope until a separate
accepted ADR defines an authenticated principal model with its own approval
boundary; no later task may add a remote write path without it.

### Decision 4 — Protocol v1

A versioned, closed-grammar envelope carries six message kinds
(`status_snapshot`, `review_request`, `planning_proposal`, `decision_request`,
`proposal_feedback`, `application_receipt`) with identity, provenance,
idempotency, correlation, compatibility rules and typed sanitized errors, fully
specified in the protocol document. Objects are closed: unknown fields are
rejected, ignorable data travels only in `extensions`, and any other addition
needs a new major version. Only `planning_proposal` creates Runtime state, and
only a proposal record, to which decision requests and notes attach;
`application_receipt` flows from the Runtime only. Free text is display-only and never interpreted as a command. Transport
content is untrusted input validated by the Runtime itself; the bridge's
provenance assertion is trusted no further than the bridge.

### Decision 5 — Runtime access path (D9)

The MCP server uses the Runtime Query Protocol, extended through application
read models, and has no access to `RuntimeClient.execute` or any command
dispatcher. Read-only is guaranteed by the interface and by the capabilities
given to the process, not by tool names.

1. **Dedicated read-only listener.** The host serves a second Unix socket,
   disabled by default and enabled explicitly by the owner, that mounts the
   query API in a new `coordination` route profile: only
   `/api/coordination/v1/...` GET routes and a dedicated health query. It has no
   `/commands` route, no dashboard routes (memory, runs, run output, activity,
   agents, events) and no wildcard. The existing query API has no route profiles
   today and the dashboard, which also holds the main socket path, is
   unchanged; the profile is new. The MCP program is configured with the path
   of this socket only. CB-10 delivers the listener, the profile, the routes and
   the Runtime-side mappers; CB-11B delivers the client extraction and the
   query client.
2. **Interface.** A narrow `RuntimeQueryClient` port (GET to a typed route set,
   no arbitrary path, no body) implemented over the same Unix-socket transport,
   extracted from `apps/cli` into a shared runtime-client package without
   behavior change. The MCP program imports only the query client.
3. **Dedicated health.** `GET /api/coordination/v1/health` returns only the
   contract version, `status` and `startedAt`; it omits queue, knowledge, path
   and version detail.
4. **Process capability — decided 2026-10-15: isolation is mandatory for public
   exposure.** The main socket path is fixed (`<runtime home>/daemon.sock`). The
   existing launchd adapter bootstraps LaunchAgents into the caller's own
   `gui/<uid>` domain, and the launchd manual states that `UserName` and
   `GroupName` apply only to services loaded into the privileged system domain;
   the systemd adapter drives `systemctl --user` only. Neither can give a
   service another identity, so with today's service management a public MCP
   program would run as the Runtime user and a remote-code-execution flaw in it
   or in its SDK dependency would be full Runtime authority, approval and apply
   included. The owner's decision, binding for CB-10, CB-11D, CB-11E and CB-11F:
   a. A publicly exposed MCP program must not be able to reach the main socket,
   even if its process is compromised. The Runtime query client is an
   interface, not a barrier against code execution, and is not sufficient.
   b. Isolation is provided by a separate operating-system identity with
   verifiable permissions, or by a container or sandbox with exclusive access
   to the read-only listener.
   c. Fail closed: if isolation cannot be verified, public deployment is refused.
   There is no silent fallback to same-user mode.
   d. CB-11D delivers the isolated deployment. CB-11F verifies that the read
   socket works and that access to the authoritative socket is refused, also
   with arbitrary code executed in the MCP context.
   e. The startup probe is an additional check, not the isolation mechanism.
   Protection against later changes of permissions, mounts and configuration
   is documented and tested: the installer sets and audits ownership and
   modes, the preconditions are re-checked at every start, on detected
   configuration or permission change and periodically, and the service
   stops on failure.
   f. A non-isolated mode exists only for local development: no public endpoint,
   no tunnel or proxy enabled, loopback bind, with its limitations printed.
   g. The mode is enforced by the program, because exposure happens through tools
   AI Office does not install or watch (a tunnel route, a proxy). In
   non-isolated mode the canonical protected-resource URI must be a loopback
   URL, so a token issued for any public resource fails audience binding; the
   program rejects requests whose `Host` or `Origin` is not loopback and any
   request carrying forwarding headers (`Forwarded`, `X-Forwarded-*`,
   `Cf-Connecting-IP`, `CF-Ray` and similar); and it refuses to start with a
   public resource URI unless the isolation verification passes. CB-11F tests that a request through the supported tunnel and Nginx templates (which forward `Host` and forwarding headers) to a non-isolated instance is refused. This is defence in depth, not a guarantee: a proxy deliberately configured to rewrite `Host` and strip forwarding headers passes the header checks, and the loopback-resource audience binding holds only if the client validates the RFC 9728 `resource` value and the authorization server will not issue a token for a loopback resource. That configuration is outside the guarantee, documented as such and adequate only for a deliberate development mode; on a public endpoint the isolation requirement, not this check, is the protection.
   Platform assessment, made in CB-01: on macOS this cannot be achieved with
   LaunchAgents; it needs a system-domain LaunchDaemon with a dedicated
   `UserName` and `GroupName` (administrator rights at install, a group-owned
   read-socket directory, the Runtime home closed to that user) or a container or
   virtual machine with access to the read listener only. Sharing a host Unix
   socket into the Linux virtual machine of common macOS container runtimes is
   not generally available, so the container path may need the read listener
   reachable on a private interface. That would add a network read listener, which conflicts with this ADR's Unix-socket-only Runtime surfaces and would be reachable by local users or containers on that network, so it needs an ADR amendment and a transport authentication design before CB-10 implements it; it is a design point for CB-10 and CB-11D, to be verified. On Linux it needs a system unit with `User=` and sandboxing
   options, or the user manager of a dedicated user, or a container. The
   existing user-level adapters remain for the non-isolated development mode.
5. **Runtime-side minimization.** The coordination route profile returns only
   classified P and T projections built by Runtime-side mappers, so D and A data
   can never leave the listener. The owner enables the listener per project and
   per data class in Runtime configuration; a project not enabled there is not
   served at all. Per-principal scope inside the enabled set is checked by the
   MCP program, so a compromised MCP program can read every enabled project at
   P and T, not more.

**Decision 5b (proposed, needs approval).** The bridge cannot be read-only: it
submits proposals and reports publication outcomes. It receives a third,
equally dedicated surface limited to a fixed set of coordination commands
(submit proposal, claim and complete publication) rather than the full command
dispatcher, through a typed, narrow ingest client over that surface; the bridge
never receives the general command client. If 5b is declined, CB-03 is blocked
until another narrow design is approved; it is not degraded to general command
access.

### Decision 6 — Remote authentication (D10)

The MCP server is an OAuth 2.1 resource server per the MCP authorization
specification (target revision 2026-07-28, compatible with 2025-11-25). It does
not issue tokens and is not an identity provider.

- **Authorization server.** An established external one, never a bespoke
  identity provider. Required of it: RFC 8414 or OpenID discovery, S256 PKCE,
  CIMD (preferred) or DCR with the ChatGPT redirect handling, RFC 8707 resource
  binding into the access token audience, RFC 9207 `iss`, token lifetimes
  short enough for revocation to matter, refresh-token revocation, a
  single-user realm with open registration disabled. Preference: a hosted
  established provider, then a self-hosted established open-source one, because
  an authorization server run on the owner's machine adds an identity system to
  the attack surface. The product choice is an owner approval gate at CB-11C
  preflight, verified against live provider documentation.
- **Metadata.** The MCP program serves RFC 9728 protected-resource metadata and
  answers 401 with `WWW-Authenticate: Bearer resource_metadata=…, scope=…`,
  403 with `insufficient_scope` for step-up.
- **Verification.** A replaceable verifier port: local JWT validation against
  the issuer's published keys (pinned issuer, audience equal to the canonical
  resource URI, `exp`, `nbf`, bounded clock skew, required scope) with an
  RFC 7662 introspection implementation behind the same port. It is compatible
  with the SDK's bearer gate and never accepts a token not issued for this
  resource.
- **Scope.** The only initial scope is `planning:read`. `planning:detail` and
  `operations:read` are reserved and unissued.
- **Principals.** The authorization server authenticates; the owner authorizes.
  The principal registry is authoritative Runtime state, because it decides who
  may read authoritative project data: a small, separate record (not part of the
  proposal aggregate) mapping `(issuer, subject)` to an enabled flag, scopes and
  projects, with a Runtime command to manage it and its audit event committed in
  the same transaction. The MCP program receives it as a minimized read
  projection through the read listener, caches it for at most ten seconds and
  fails closed when the projection is unavailable or stale beyond that interval.
  Disabling an entry therefore cuts access within the cache interval regardless
  of token lifetime. The verified principal itself never crosses into the Runtime
  on a data read.
- **Renewal and revocation.** Short-lived access tokens, refresh handled between
  client and authorization server, immediate local principal disablement,
  authorization-server revocation, and service stop as the kill switch.
- **CB-11C verification matrix.** Discovery metadata (resource and server),
  PKCE S256 and `iss` behavior observed in a real ChatGPT and MCP Inspector
  flow, audience and `resource` binding (wrong audience refused), expiry and
  skew, refresh and re-authorization, revocation of principal and refresh
  token, principal lifecycle, scope step-up, and that missing, invalid, expired
  or revoked credentials never reach a tool.
- **Not supported.** Static bearer keys are not an option for the first client. Transport-level client restrictions (OpenAI's published client certificate chain and egress ranges) are optional defence in depth where TLS terminates at a proxy the owner controls; behind a tunnel that terminates TLS at the provider's edge an end-to-end client certificate cannot be verified at the origin. Neither a tunnel nor a proxy nor any client restriction replaces OAuth 2.1 and scope checks.

### Decision 7 — Data exposure (D11)

Readable by the Runtime does not mean exposable. Exposure is opt-in per field
and per channel; an unclassified field is not exposed.

- **Data classes.** P: identifiers, keys, statuses, priorities, relationships,
  counts, timestamps. T: titles. D: descriptions and long text. A: agents, runs,
  run output, activity, audit, knowledge, memory, credentials, filesystem paths,
  anything produced by an agent. Initially MCP and publication may carry P and
  T only; D needs `planning:detail`; A is never exposed by M23.
- **Mechanism.** An exposure registry classifies each field; responses are built
  in the Runtime application layer by explicit mappers from the read models,
  never by passing or spreading an existing read-model object, so the MCP
  program only ever receives P and T; contract tests assert the exact field
  set per tool and per published message; a best-effort scrubber replaces
  strings that match credential patterns.
- **Scope.** Two layers. The Runtime enables a project and its data classes on
  the read listener. The MCP program restricts each principal to a subset of the
  enabled projects, and a project absent from the principal's allowlist answers
  as not found.
- **Limits.** Pagination default 50, maximum 200 items; response at most
  256 KiB; strings truncated at 256 characters with a flag; request arguments at
  most 4 KiB; per-principal rate limit and concurrency cap, with a second limit
  at the proxy. The MCP program writes a local, sanitized access log (tool,
  principal, project, sizes, outcome; never payload content). It is an operational log, not authoritative Runtime audit; the principal registry is the Runtime's audited state (Decision 6). The read listener appends no audit rows on a read and receives no principal; it serves the principal projection as a read.
- **GitHub.** A publication authorization lists the content classes it allows
  (default P; T only when listed). The same mappers and classes apply.

### Decision 8 — Coordination Publication (D7)

A distinct, closed class of Runtime-originated external action, separate from
the controlled-action gateway, which stays unchanged.

- **Authorization.** A scoped, revocable, expiring record shaped like a
  capability grant: grantor, reason, target repository, allowed operations,
  allowed content classes, maximum payload size, rate limit, `expiresAt`,
  `revokedAt`. Deny by default; no human approval per report.
- **Who enforces what.** The closed operation set and the content limits are
  enforced by Runtime-issued orders and bridge code. The credential's own limit
  is "Issues on one dedicated private repository": a fine-grained token cannot
  stop a compromised bridge from commenting on or editing any issue there.
  Receipts are therefore checkable, not trusted: CB-09 reads published messages
  back and compares their content digest with the Runtime's publication record,
  so an edited or forged receipt is reported as drift. A GitHub App with narrower
  permissions is a possible later tightening, not a substitute.
- **Closed operation set.** `publish_snapshot`, `publish_receipt`,
  `publish_diagnostic`, `create_coordination_issue`, plus reads of coordination
  issues and comments. No other operation exists; no generic mutation, label or
  repository administration, no agent-authored text.
- **Content.** Produced only by Runtime serializers from classified projections.
  The bridge executes Runtime-issued publication orders and cannot compose its
  own content.
- **Lifecycle.** The Runtime persists the intent (intent identifier, destination,
  content digest) before the side effect, the bridge claims a lease (default
  five minutes), attempts once, and reports the outcome with an external
  reference; the Runtime records a receipt and audit events at each step.
  Outcomes: `published`; `failed`, a definitive rejection by GitHub, terminal,
  and a retry needs a new intent; `not_sent`, an error before any request bytes
  left, safely retried under the same intent; `ambiguous`, any error after the
  request may have been delivered. An ambiguous outcome, and an expired lease
  whose result was never reported, are reconciled by looking up the intent marker
  on the destination: found means published, proven absent allows a new
  attempt, otherwise it stays ambiguous for the operator. Nothing is replayed
  blindly. The authorization is re-checked at claim time, so revocation is
  immediate. The intent identifier, not the content, is the idempotency key, so a
  legitimate republication of an unchanged state is a new intent.
- **Boundary.** The connector rule that an executable mutation requires approval
  is untouched. The identifier namespace `coordination` is reserved so no
  connector or grant can reuse it. Changes to authoritative state keep the full
  proposal, preview, digest approval and apply workflow.
- **Repository policy (D1, D3).** Issues in the dedicated repository carry
  snapshots, proposals, decision requests and receipts only; no issue per task,
  no status mirror. Polling is bounded with a persisted cursor and conditional
  requests; no webhooks and no public ingress.

### Decision 9 — Plans, approval, atomicity and revision conflicts

The protocol document specifies the contract; the decisions are:

- A plan is an ordered list of at most 20 typed operations with explicit
  preconditions, identified by a content digest that excludes time and approver.
- **Revision model.** There is no global revision counter. A plan records
  preconditions and a scope digest: the recorded status, priority and
  editability of each referenced task, and the edge set within the prerequisite
  closure of each `dependsOnTaskId` (the tasks reachable by following
  prerequisites from it, which is where a new cycle would appear). Snapshot identity is the digest of the complete, scoped, canonical minimized projection computed before pagination, excluding volatile fields such as `generatedAt`, so it does not change with `offset` or `limit` (each page also carries its own content digest); an expected snapshot is
  advisory.
- **Sequential semantics.** Preconditions on the initial state (targets exist,
  expected priority, scope digest) are checked first. Whether each operation is
  valid is then evaluated in order against the state produced by the earlier
  ones, at assessment by simulation on an in-memory graph and at apply through
  the services themselves. A plan may not repeat an edge or give one task two
  priority changes. So `remove A→B; add B→A` is valid and `add A→B; add B→A`
  fails as a cycle at assessment.
- **Conflicts.** Apply recomputes every precondition; any mismatch refuses the
  whole plan as stale, with sanitized causes. No automatic rebase and no merge of
  concurrent plans: the proposer submits a new request that supersedes the old
  one. Overlapping concurrent plans are flagged at assessment; the first applied
  wins and the others become stale. Correctness rests on the recheck inside the apply transaction, and
  that transaction is atomic only if no other writer can share the connection
  while it is open. `BEGIN IMMEDIATE` excludes other database connections, not
  other asynchronous callers on this connection: `run:tick` and the queue runtime
  bypass the daemon queue and call the Runtime directly, so an apply rollback
  could undo concurrent run state and a commit could commit it. Writer exclusion
  is therefore a precondition of CB-08, not a deferred hazard: before claiming
  atomic apply, CB-08 delivers either serialization of every writer through one
  gate that apply also takes, or connection-level transaction ownership that
  stops unrelated writes from joining. That touches the daemon and is an approval
  point. Apply goes through the command queue and, if it meets a transaction
  already active, returns the retryable `RUNTIME_BUSY` without consuming the
  approval.
- **Atomicity.** All-or-nothing, in one transaction, through a composing apply
  use case that reuses the existing services' transactional bodies. This needs a
  behavior-preserving refactor of `UpdateTask` and `ManageTaskDependencies` to
  expose their bodies without opening a transaction (their public methods keep
  their behavior and tests), delivered in CB-08 and submitted for approval at
  its design review. Plan state, the receipt, the receipt-publication intent and
  audit events commit in the same transaction; a refusal is recorded in its own
  short transaction after the rollback.
  Rejected: sequential calls with compensation, partial execution with
  reconciliation, simulated global transactions. Fallback if the refactor is
  declined: single-operation plans.
- **Approval.** Bound to the plan digest, the approving principal, an expiry
  (default 24 hours, maximum 72, configurable) and the audit trail. A plan that
  is modified, expired or stale cannot be applied; one approval applies once.
- **Idempotency and recovery.** Requests are deduplicated per project and
  source; applying an applied plan returns the stored receipt; a crash leaves
  either nothing or a fully applied plan with its receipt, and receipt
  publication retries from the outbox after restart.
- **Audit.** Operations keep their existing audit events and add provenance
  fields (plan, request, digest, approver) to the payload; the `actorType` union
  is extended or the operator remains `cli` with the provenance payload, decided
  in CB-08.

### Decision 10 — Deployment and one MCP server

Runtime not publicly exposed; MCP server a separate Streamable HTTP program
binding only the private interface the deployment designates (loopback by default, a container-private address when containerized; never a wildcard or public address); HTTPS exposure through Cloudflare Tunnel as the preferred initial deployment on macOS, with Nginx as the supported alternative reverse proxy, both configurable and documented (TLS, request-body limit, rate limit, optional client restriction, health, rollback) and Caddy permitted but not required; launchd on macOS and systemd on Linux through service management, extended with an MCP service and the capability-isolated deployment of Decision 5 point 4 (mandatory when public); MCP read-only
initially and independently disableable without affecting the Runtime or the
dashboard. The CB-11 series delivers the project's single MCP server; the M9 MCP
task extends it and depends on CB-11B. Initial tools use the `ai_office_`
prefix and carry only P and T data under `planning:read`; runs, agents and
activity are not tools in M23. The first Remote Read Gate is
`ai_office_get_milestones` over HTTPS from an authenticated ChatGPT Pro client.

### Decision 11 — Credential boundary amendment (D2)

The ADR-0020 loader generalizes from provider descriptors to a registry of
declared credentials per program. The bridge declares one: the fine-grained
GitHub token (Issues read and write on the coordination repository only), held
in the credential directory with the existing strict checks. The MCP program
holds no secret for JWT validation (public keys); an introspection client secret,
if ever used, is declared the same way. How the managed and foreground
credential-source markers of ADR-0020 apply to a separate bridge program is
settled at CB-03 design. Agents never reach these files by configuration; as in ADR-0020 there is no same-user technical barrier, and
nothing is stored in SQLite, audit, logs or service definitions.

## Alternatives considered

| Topic                  | Rejected alternative                                     | Reason                                                                                                               |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Runtime access for MCP | `RuntimeClient.execute` behind an in-process allowlist   | Read-only would be a convention in a public-facing process; the process would hold mutation capability               |
| Runtime access for MCP | Expose the existing dashboard query API                  | Returns descriptions, run output, activity and global memory                                                         |
| Runtime access for MCP | Embed the MCP server in the daemon                       | Couples availability and attack surface of the authority to a public endpoint                                        |
| Authentication         | Static or owner-issued API tokens                        | Not accepted by the first client; would make this program an identity provider                                       |
| Authentication         | Build an authorization server                            | Unnecessary identity-provider development and risk                                                                   |
| Publication            | Connector mutation with per-report approval              | Defeats unattended reports                                                                                           |
| Publication            | Relax the connector approval rule                        | Global architecture change that also binds M13                                                                       |
| Publication            | Bridge-authored content                                  | Not auditable; unbounded content                                                                                     |
| Atomicity              | Sequential apply with compensation                       | Inverse operations are not always possible once execution starts                                                     |
| Atomicity              | Partial execution with reconciliation                    | Complexity without need at 20 operations                                                                             |
| Revision               | Global revision counter                                  | Schema change and false conflicts on unrelated edits                                                                 |
| Aggregate              | Reuse `Review` or wait for M11.6                         | No plan subject; couples M23 to unfinished work                                                                      |
| Proxy                  | Proxy embedded in the Runtime                            | Explicitly excluded by the owner                                                                                     |
| Isolation              | Same-user MCP program with an interface-only restriction | A code-execution flaw in the public program yields full Runtime authority; rejected for public exposure by the owner |
| Proxy                  | Caddy as the only supported proxy                        | The owner prefers Cloudflare Tunnel on macOS and Nginx as the alternative; no proxy product is mandatory             |

## Consequences

- New persistence is additive and forward-only: the proposal aggregate
  (CB-04), the publication authorization and publication records (CB-03), the MCP principal registry (CB-11C), with
  fresh-migration and upgrade tests; PostgreSQL parity is not promised.
- Runtime changes are limited to: a coordination route profile and read-only
  listener, a bridge ingest surface (if 5b is approved), coordination
  application services, a retryable busy code, writer exclusion for the apply transaction and a behavior-preserving transaction refactor in CB-08.
- A public endpoint on the owner's machine is a new exposure. It is bounded by
  structural read-only access, authentication by an external authorization
  server, per-principal minimization and limits, audit, and a kill switch.
- Residual risks are documented, not removed: same-UID trust (reduced by
  Decision 5 point 4), data disclosure through a compromised
  principal or MCP program bounded by enabled projects, scope and token
  lifetime, and titles that may contain sensitive text.
- Cost: an external identity provider dependency and an MCP SDK dependency,
  each requiring explicit approval when introduced.

## Points that need further approval

1. Acceptance of this ADR as a whole.
2. Decision 5b, the restricted bridge ingest surface.
3. Decision 9: the transaction-body refactor of two existing services and the writer-exclusion mechanism (serialize all writers, or connection-level transaction ownership), at CB-08 design review.
4. The authorization-server product, at CB-11C preflight.
5. The MCP SDK dependency and pinned version, at CB-11B.
6. The new persistence of Decision 8, the proposal aggregate and the MCP principal registry, at CB-03, CB-04 and CB-11C design reviews (migrations).
7. The audit `actorType` handling.
8. Acceptance of Cloudflare as a third party that, when the tunnel is used, terminates TLS, so it sees planning data (P and T), the bearer access tokens and the OAuth and metadata exchanges in clear text and could replay a token within its lifetime, and of administrator rights for the system-level service install on macOS.
9. Optionally, an evaluation of OpenAI's Secure MCP Tunnel as an alternative to a public hostname.

## References

[ADR-0003](ADR-0003-authenticate-controlled-action-approvals.md),
[ADR-0014](ADR-0014-runtime-authority-and-persistent-daemon-host.md),
[ADR-0015](ADR-0015-operational-read-models-and-loopback-dashboard.md),
[ADR-0020](ADR-0020-managed-provider-credential-boundary.md),
[ADR-0021](ADR-0021-artifact-review-and-approval-workflow.md),
[ADR-0026](ADR-0026-core-domain-pack-boundary.md);
MCP authorization specification (modelcontextprotocol.io, revision 2026-07-28);
RFC 9728, RFC 8414, RFC 8707, RFC 9207, RFC 7591, RFC 7662;
OpenAI developer documentation, MCP plugin authentication and testing guides.
