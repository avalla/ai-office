# M23 — AI Office Coordination Bridge

Status: planned on 2026-10-15, revised after owner review the same day; the
architecture and protocol are proposed by CB-01 in
[ADR-0036](../adr/ADR-0036-coordination-bridge-boundary-protocol-trust.md),
[architecture](../architecture/coordination-bridge.md) and the
[protocol](coordination-protocol.md). Nothing in this document is implemented.
The milestone, fourteen requirements (CB-R01–CB-R14) and the tasks of section 4
are registered in the Runtime. Milestone, requirement and task status is owned
by the Runtime and the [roadmap](roadmap.md); this document owns the gap
analysis, the intended architecture, the dependency graph, the acceptance
criteria and the delivery order. Baseline: `main` at `375c928`.
Project milestone ID: `57eacda4-5539-4b44-a8aa-27bafc48073b`.

M21 and M22 were already registered (Multi-Agent Execution & Collaboration;
Complete PostgreSQL Project Authority), so this milestone takes the next free
identifier, M23. It was requested as "M21".

## 1. Objective and invariants

Let users and external AI assistants (ChatGPT, Claude Code, Codex) inspect the
real roadmap, analyse it, propose structured planning changes, request owner
decisions and receive verifiable confirmation of what was applied, without
direct access to the Runtime database. Two complementary channels share one
application layer:

- a **remote read-only MCP server** (Streamable HTTP behind an HTTPS reverse
  proxy) for synchronous access to authoritative planning data;
- a **GitHub Issues bridge** to a dedicated private repository for asynchronous,
  persistent communication: snapshots, proposals, decision requests, receipts.

Invariants:

1. The Runtime is the only authority on planning state. GitHub and MCP are
   communication channels, never a second task tracker.
2. Everything received from a transport is untrusted data. No comment text,
   label, reaction or MCP argument is an authorization or a command.
3. Authoritative changes go only through existing application services, with an
   approval bound to the evaluated plan, precondition checks and audit.
4. Every bridge component is optional and separately supervised. Disabling the
   MCP service or the GitHub bridge leaves the Runtime, the dashboard and
   existing workflows unchanged; the core never imports GitHub or an MCP SDK.
5. The Runtime and its database are never publicly reachable. Only a reverse
   proxy vhost is, and it is a deployment component, not part of the Runtime.
6. Remote approval or application of changes does not exist until an
   authenticated principal model has its own accepted ADR.
7. Provider-, client- and domain-neutral protocol and application layers.
8. Migrations additive and forward-only on SQLite; no PostgreSQL parity claim
   until demonstrated (risk R3). Credentials stay in the protected host
   credential boundary and never reach agents, payloads, audit or logs.

## 2. Gap analysis

"Exists" means merged on `main`; "planned" means Runtime records or
documentation only.

| Area                          | State                                                                                                                                                                                                                                                                | Consequence for M23                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priority change               | Exists: `UpdateTask` sets one integer `priority`, audited as `task.priority_updated` with from/to (`packages/application/src/commands/update-task.ts`).                                                                                                              | `set_priority` reuses it; no second priority hierarchy.                                                                                                                               |
| Dependency edit               | Exists: `ManageTaskDependencies.link/unlink/readiness` with cycle check, project ownership, audit; editable only while the task is `pending` or `blocked` with no execution history.                                                                                 | `add/remove_dependency` reuse it; the edit restriction is a first-class conflict in impact analysis (CB-06).                                                                          |
| Atomic multi-op apply         | Missing: each service opens its own transaction and `TransactionRunner.run` rejects nesting (`TransactionAlreadyActiveError`).                                                                                                                                       | A multi-operation plan is not atomic by composition; CB-08 needs a composing use case, a one-operation limit or an explicit partial-execution contract (D5 detail, decided in CB-01). |
| Optimistic concurrency        | Missing: no revision counter on tasks or edges, only `updatedAt`.                                                                                                                                                                                                    | Per-scope content digests of the affected tasks and edges, not a global counter (CB-02, CB-07).                                                                                       |
| Plan-hash approval            | Exists as a pattern (`update --approve <planHash>`, `knowledge:plan/admit`).                                                                                                                                                                                         | CB-07 follows the same plan, hash, approve, apply shape.                                                                                                                              |
| Approval identity             | Trusted-local by design: the Runtime does not authenticate human presence; a same-UID process can call the same CLI (AGENTS.md, ADR-0003, task "M10 — harden approval presence if approved").                                                                        | "Verified approver" is as strong as existing approvals until M10 (D6). Stated openly, not hidden.                                                                                     |
| Review aggregate              | Subjects are `task`, `agent_run`, `requirement`, `adr`, `milestone`; M11.6 (ADR-0021) is accepted but unimplemented.                                                                                                                                                 | No plan subject exists; autonomous aggregate (D4), no dependency on M11.6.                                                                                                            |
| GitHub infrastructure         | None: only the `github_repository` resource-type string and the generic capability/grant model.                                                                                                                                                                      | CB-03 builds the transport; nothing to reuse yet.                                                                                                                                     |
| Connector mutation rule       | `connector-registry.ts` rejects an executable mutation operation that does not require approval.                                                                                                                                                                     | A GitHub publication cannot be modelled as an approval-free connector mutation without weakening a global invariant; see D7.                                                          |
| Capability model              | Exists: resources with `credentialRef`, grants with principal, actions, constraints, `expiresAt`, `revokedAt`, `grantedBy`, reason; policy decisions `allow`, `deny`, `allow_with_approval`.                                                                         | Reusable vocabulary for a scoped, revocable, auditable publication authorization.                                                                                                     |
| Runtime access paths          | Two on the daemon Unix socket: the command protocol (`RuntimeClient.execute(args)`, whole CLI surface including mutations) and a separate read-only query protocol (`/api/...`, GET only, `queryApiVersion` 1) consumed by the dashboard, itself a separate process. | The MCP service must use the read-only path so read-only is structural; see D9.                                                                                                       |
| `RuntimeClient` location      | The port is in `application`; its only implementation `IpcRuntimeClient` is in `apps/cli`.                                                                                                                                                                           | An out-of-process service cannot import `apps/cli`; the transport is extracted into a shared package first (CB-11B).                                                                  |
| Query API read model          | Covers projects, tasks, graph, pipelines, agents, runs, reviews, approvals, activity, status; no milestone/requirement/dependency planning route.                                                                                                                    | The planning read model of CB-02 is exposed through a new read-only route by CB-10.                                                                                                   |
| Service management            | Exists: launchd and systemd user services for Runtime and dashboard; the dashboard binds loopback only and waits for the Runtime.                                                                                                                                    | An MCP service is a third managed program (CB-11D); non-loopback bind is refused.                                                                                                     |
| Credential boundary           | Exists (ADR-0020): `<AI_OFFICE_HOME>/credentials/`, 0700/0600, strict loader, only names declared by registered descriptors, "not a general secret store".                                                                                                           | Coordination credentials (the GitHub token) need a declared extension: an ADR amendment decided in CB-01.                                                                             |
| MCP                           | No MCP server in the repository (only the Claude worker's `--strict-mcp-config` flag). Planned: roadmap M9 bullet "MCP server" and task "M9 — expose selected Runtime tools over MCP" (requirement M9-MCP), blocked by its assessment.                               | Overlap in the plan, not in code; see section 6 for the resolution.                                                                                                                   |
| M13 GitHub connector          | Planned, none started.                                                                                                                                                                                                                                               | Overlap limited to credentials and external identity; no dependency (D7 note).                                                                                                        |
| Existing coordination feature | None.                                                                                                                                                                                                                                                                | No duplicate work found.                                                                                                                                                              |

No existing task covers part of M23. "Planning — assess native milestone
dependencies" and "Planning — assess native task/milestone ownership" concern
native planning model design and stay independent.

## 3. Intended architecture

Four separately supervised programs, one authority:

```text
 ChatGPT / Claude / Codex / human
     |  HTTPS (MCP, Streamable HTTP)        |  GitHub Issues (async, untrusted text)
     v                                       v
 Tunnel or reverse proxy (deployment       Dedicated private GitHub repository
 component): TLS, vhost, limits               ^   |
     |  loopback HTTP                          |   |  bounded poll, cursor
     v                                         |   v
 MCP server program                        GitHub bridge program
 (read-only tools, OAuth bearer)            (fine-grained token, outbox)
     |  GET-only query client                  |  typed ingest client
     |  + dedicated health query               |  (fixed coordination commands)
     +-------------------+---------------------+
                         v  Unix socket, no network
                 Runtime (daemon)  — sole authority
        Coordination application API (read facade first)
        CB-02 planning read model | proposal lifecycle aggregate
        existing services: UpdateTask, ManageTaskDependencies, audit
                         |
                       SQLite
```

Dependency direction stays `apps/adapters → application → domain`. The MCP and
bridge programs are apps that depend only on application ports and shared
protocol packages. `apps/daemon` never imports them and they never import
`apps/cli`.

### 3.1 Principals

Recorded separately by the protocol; none may be inferred from another.

| Principal            | Meaning                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proposal author      | Claimed originator named inside the payload. Untrusted claim.                                                                                                      |
| Transport account    | GitHub account that posted, or the verified MCP principal (issuer and subject), as reported by the transport. Provenance only.                                     |
| Authorized operator  | A local operator who may approve or apply, established by the Runtime, never by transport content.                                                                 |
| Runtime identity     | The Runtime instance and project issuing snapshots and receipts.                                                                                                   |
| Agent identity       | An AI agent or worker, when the author is one.                                                                                                                     |
| Approving subject    | The principal recorded on an approval; today a trusted-local operator label.                                                                                       |
| MCP client principal | A principal authenticated by the external authorization server and enabled by the owner for specific scopes and projects. It can read; it cannot approve or apply. |

### 3.2 Trust model

Transport content is data. A request becomes actionable only after schema
validation, project-scope check and an assessed plan, and an operation changes
state only after a local approval bound to the plan digest. Approval strength
equals existing controlled-action approvals (trusted-local, single user); it
does not defend against a hostile same-UID process. The remote MCP surface
adds a different exposure: authoritative planning data leaves the machine, so
read-only is enforced structurally (read-only Runtime path, no mutating tool),
authenticated, scoped, minimized, rate limited and revocable.

### 3.3 Remote read-only MCP service

- **Transport.** Streamable HTTP, stateless (read-only tools need no session).
  The official TypeScript SDK provides a Web Standard transport that runs on
  Bun, a bearer gate with required scopes and expected resource, and host and
  origin validation helpers against DNS rebinding (verified against the SDK
  documentation on 2026-10-15; the SDK has v1.x and v2.x lines, the version is
  pinned in CB-11B). The service binds loopback only; the proxy is the sole
  public endpoint.
- **Runtime access.** A dedicated read-only Runtime listener serving the query
  protocol in a `coordination` profile, reached through a GET-only
  `RuntimeQueryClient`; a dedicated health query. No command client (D9).
- **Tools** (final names and schemas in CB-11A), all read-only, prefixed
  `ai_office_`: `ai_office_get_milestones` (priority success criterion),
  `get_milestone`, `get_tasks`, `get_task`, `get_requirements`,
  `get_dependencies`, `get_planning_blockers`, `get_runnable_tasks` and
  `get_planning_status`. They are views of the CB-02 read model through the
  shared coordination API. Runs, agents and activity are not tools in M23: the
  initial scope `planning:read` carries identifiers, titles, statuses,
  priorities and relationships. No tool creates, approves, applies or mutates.
- **Minimization.** Data classes P and T only; descriptions need the unissued
  `planning:detail` scope; agent output, knowledge and credentials are never
  exposed (D11).
- **Authentication.** OAuth 2.1 resource server with an external authorization
  server, scope `planning:read`, a replaceable verifier and a principal
  allowlist (D10). The first client is ChatGPT Pro.
- **Disablement.** Stop or uninstall the service, disable the principal, revoke
  at the authorization server, or remove the proxy vhost. None of these touches
  the Runtime or the dashboard.

### 3.4 HTTPS exposure and capability isolation

Owner decisions of 2026-10-15. The preferred initial deployment on macOS is
Cloudflare Tunnel (`cloudflared` opens outbound-only connections, no inbound
port); Nginx is the supported alternative reverse proxy; Caddy is permitted but
not required. The MCP program binds only the private interface the deployment
designates and a tunnel or proxy never replaces OAuth 2.1 and scope checks. With
a tunnel TLS terminates at the provider's edge, which then sees P and T planning
data in clear text; the owner accepts that trade-off explicitly.

A publicly exposed MCP program must not be able to reach the main Runtime
socket even if its process is compromised: isolation by a separate operating
system identity with verifiable permissions, or by a container or sandbox with
exclusive access to the read listener; public deployment fails closed when
isolation cannot be verified; the startup probe is a further check, not the
mechanism; drift of permissions, mounts and configuration is re-checked; the
non-isolated mode is for local development without a public endpoint. The
existing user-level service adapters cannot provide this (a launchd LaunchAgent
runs in the user's own domain and `UserName` applies only to system-domain
services; the systemd adapter drives `systemctl --user` only), so CB-11D adds a
system-level profile or a container recipe. CB-11E ships tested templates for
the tunnel and for Nginx. CB-11F verifies both the working read path and the
refused access to the authoritative socket with arbitrary code executed in the
MCP context. These are scope changes to CB-11D, CB-11E and CB-11F, registered
in the Runtime.

## 4. Requirements and tasks

| Phase          | Task                                            | Requirement            | Depends on     | Priority |
| -------------- | ----------------------------------------------- | ---------------------- | -------------- | -------- |
| V1 Foundation  | CB-01 Architecture boundary and protocol ADR    | CB-R01                 | none           | 3        |
| V1 Foundation  | CB-02 Planning snapshot and read model          | CB-R02                 | CB-01          | 3        |
| V1 Foundation  | CB-10 Shared coordination application API       | CB-R10                 | CB-02          | 3        |
| V1 Remote Read | CB-11A MCP tool contract                        | CB-R11                 | CB-10, CB-01   | 3        |
| V1 Remote Read | CB-11B Streamable HTTP read-only MCP server     | CB-R11                 | CB-11A         | 3        |
| V1 Remote Read | CB-11C MCP security and authentication          | CB-R13                 | CB-11A         | 3        |
| V1 Remote Read | CB-11D MCP service management                   | CB-R14                 | CB-11B         | 3        |
| V1 Remote Read | CB-11E Reverse proxy and deployment             | CB-R14                 | CB-11C, CB-11D | 3        |
| V1 Remote Read | CB-11F Remote MCP end-to-end acceptance         | CB-R11, CB-R13, CB-R14 | CB-11E         | 3        |
| V1 GitHub      | CB-03 GitHub Issue transport adapter            | CB-R03                 | CB-10          | 2        |
| V1 GitHub      | CB-04 Proposal inbox and read-only review       | CB-R04                 | CB-03          | 2        |
| V2             | CB-05 Planning change contract                  | CB-R05                 | CB-01          | 1        |
| V2             | CB-06 Dependency and priority impact analysis   | CB-R06                 | CB-05, CB-02   | 1        |
| V2             | CB-07 Approval and optimistic concurrency       | CB-R07                 | CB-06, CB-04   | 1        |
| V2             | CB-08 Authoritative apply and receipt           | CB-R08                 | CB-07          | 1        |
| V2             | CB-09 Reconciliation and drift detection        | CB-R09                 | CB-08          | 1        |
| V3             | CB-12 Owner coordination view and documentation | CB-R12                 | CB-09, CB-10   | 0        |

The original CB-11 "Optional MCP server" was cancelled as superseded by
CB-11A–CB-11F before it was ever started; it carried no work. Changes against
the first version of this plan:

- CB-10 moved from "after CB-08" to "after CB-02". The shared API is built as a
  read facade first so that both adapters consume it from the start; write-side
  operations are added to the same layer by CB-04, CB-06, CB-07 and CB-08.
- CB-03 now depends on CB-10 (publishing a snapshot goes through the shared
  API) instead of CB-02 directly.
- CB-11 was split into six tasks as proposed: contract, server, security,
  service management, reverse proxy and deployment, end-to-end.
- Two requirements were added: CB-R13 (remote authentication, authorization and
  credential handling) and CB-R14 (service management and reverse-proxy
  deployment). CB-R11 now means the remote read-only tool contract and server.
- The M9 MCP task was given a dependency on CB-11B and a note that it extends
  the single MCP server (section 6).

Acceptance criteria for every requirement are stored in the Runtime requirement
description (`requirement:list`) and are the contract; this document does not
restate them. Requirements stay `proposed` until a task's evidence verifies
them. CB-R11, CB-R13 and CB-R14 are verified only by the CB-11F evidence.
Creating this document verifies nothing.

### 4.1 Dependency graph

```text
CB-01 ── CB-02 ── CB-10 ──┬── CB-11A ──┬── CB-11B ── CB-11D ──┐
  │        │              │            └── CB-11C ───────────┴── CB-11E ── CB-11F
  │        │              ├── CB-03 ── CB-04 ─────────────┐         [Remote Read Gate]
  │        │              │                                │
  │        │              └──────────────────────┐         │
  ├── CB-05 ── CB-06 ◄─── CB-02                   │         │
  │             └────────────────────────── CB-07 ◄─────────┘
  │                                          │
  └── (CB-11A also needs CB-01)            CB-08 ── CB-09 ──┐
                                                  CB-10 ────┴── CB-12
```

Reading aid for the less obvious edges: CB-07 needs CB-04 and CB-06 (the
proposal inbox shape and the plan shape; its first step is the V1/V2 protocol
compatibility review); CB-12 needs CB-09 and CB-10; CB-06 needs CB-02 because
impact analysis runs against the planning read model; `M9 — expose selected
Runtime tools over MCP` needs CB-11B.

### 4.2 Delivery order and the two-initiative limit

M11 and M15 are the active milestones and the PostgreSQL authority line (M22)
is in flight; CB-01 was authorized on 2026-10-15 and is the only M23 work in
progress; the rest waits for ADR-0036 to be accepted. Once it runs, M23 uses at
most two concurrent initiatives:

1. **Slot 1, always the priority line.** CB-01 → CB-02 → CB-10 (foundation,
   strictly serial), then CB-11A → CB-11B ‖ CB-11C → CB-11D → CB-11E → CB-11F.
   Priority 3 on all of these makes the remote read-only MCP result the first
   verifiable outcome, ahead of any write capability.
2. **Slot 2, opened after CB-10 lands:** the GitHub line CB-03 → CB-04
   (V1 gate). It needs the shared API, so it cannot start earlier. CB-05
   (a pure contract task needing only CB-01) is the only work that could fill
   slot 2 sooner and is optional.
3. **V2 write path** CB-05 → … → CB-09 starts only when a slot is free, after
   the Remote Read Gate or the V1 gate. CB-12 closes the milestone.

CB-11B and CB-11C may run in parallel inside slot 1 only as two pull requests of
one initiative; public exposure (CB-11E) requires CB-11C. Technical precedence
is not merge order.

### 4.3 Exit gates

- **Remote Read Gate (CB-11F).** From a remote, authenticated MCP client over
  HTTPS, `ai_office_get_milestones` returns authoritative Runtime data with no
  manual export; unauthenticated, expired, revoked and wrong-scope requests are
  refused; stopping the MCP service leaves Runtime and dashboard unaffected; access to the authoritative Runtime socket is refused from the MCP context, also with arbitrary code executed there; no mutating tool exists.
- **V1 gate (CB-04).** AI Office → GitHub → ChatGPT → GitHub → AI Office with a
  published snapshot, a received proposal and a returned assessment, and no
  authoritative mutation.
- **V2 gate (CB-09).** One real priority change and one real dependency change
  through proposal → preview → owner approval → apply → GitHub receipt, plus an
  unauthorized proposal that fails without changing the project.
- **V3 (CB-12).** The owner understands bridge state without reading GitHub
  threads; adapter parity holds across CLI, GitHub bridge and MCP.

## 5. Owner decisions

| #   | Status                                | Decision                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Accepted                              | Dedicated private GitHub repository, used only for communication, proposals, decision requests and receipts; never a task-tracker mirror.                                                                                                                                                                                 |
| D2  | Approved                              | Fine-grained GitHub token for the first release, in the protected host credential boundary.                                                                                                                                                                                                                               |
| D3  | Approved                              | Bounded polling with a persisted cursor; no webhook.                                                                                                                                                                                                                                                                      |
| D4  | Approved                              | Autonomous aggregate limited to the proposal lifecycle.                                                                                                                                                                                                                                                                   |
| D5  | Approved                              | Write scope limited to task priority and dependencies.                                                                                                                                                                                                                                                                    |
| D6  | Approved                              | Local approval bound to the digest, trusted-local limits documented.                                                                                                                                                                                                                                                      |
| D7  | Binding constraint, design in the ADR | A specific external-publication class: scoped, revocable, no approval per report, strictly limited content, destinations and operations, persistent intent, idempotency, audit and receipt; it does not weaken the controlled-action gateway or allow generic mutation. Authoritative changes keep the approval workflow. |
| D8  | Revised                               | MCP is not limited to stdio; the first deliverable is a remote read-only server over Streamable HTTP.                                                                                                                                                                                                                     |
| D9  | Binding                               | The MCP server uses the Runtime Query Protocol extended through application read models; no access to the command client or mutating dispatchers; read-only guaranteed by interface and process capabilities; a dedicated health query.                                                                                   |
| D10 | Binding                               | ChatGPT Pro first; OAuth 2.1 per the MCP authorization specification; initial scope `planning:read`; replaceable verifier; established external authorization server; CB-11C documents and verifies discovery, PKCE, audience binding, expiry and renewal, revocation and principal handling.                             |
| D11 | Binding                               | Per-project scope, field allowlist, pagination and size limits, minimization rules; readable does not mean exposable.                                                                                                                                                                                                     |

The mechanisms are specified in ADR-0036 (Decisions 5 to 8) and summarized
here. The owner decided on 2026-10-15 that capability isolation is mandatory for
any public exposure (section 3.4). Points the ADR still asks the owner to
approve: the restricted bridge ingest surface, the transaction-body refactor of
two existing services (CB-08), the authorization-server product (CB-11C
preflight), the MCP SDK dependency (CB-11B), the new persistence (CB-03, CB-04
design reviews), the audit actor type, Cloudflare as a TLS-terminating third
party and administrator rights for the system-level service install on macOS,
and optionally an evaluation of OpenAI's Secure MCP Tunnel.

- **D7 mechanism.** Publication authorization shaped like a capability grant
  (repository, operations, content classes, size, rate, expiry, revocation); a
  closed operation set; Runtime-generated content only; persisted intent before
  the side effect, one attempt, outcome and receipt after, ambiguity reconciled
  by marker lookup. The connector rule that executable mutations require
  approval is untouched and the `coordination` namespace is reserved.
- **D9 mechanism.** A second Unix socket mounting the query API in a
  `coordination` route profile (read routes under `/api/coordination/v1` and
  a minimal health route, no `/commands`, no dashboard routes), a GET-only
  `RuntimeQueryClient` over the transport extracted from `apps/cli`, and a
  mandatory capability-isolated deployment for public exposure that gives the
  MCP program access to that socket only. A same-user deployment is a code and
  configuration restriction and exists for local development only.
- **D10 mechanism.** Resource-server role only: protected-resource metadata,
  401 and 403 challenges, local JWT validation of issuer, audience, expiry and
  scope, introspection behind the same verifier port, a host-configuration
  principal allowlist for instant revocation. ChatGPT does not accept static API
  keys, so a bearer-token scheme is not an option for the first client.
- **D11 mechanism.** Data classes P, T, D and A, an exposure registry, explicit
  mappers, field-set contract tests, scope per project, limits (page 50 and 200,
  256 KiB, 256-character strings) and a scrubber.

## 6. M9 verification

No MCP server exists in the repository. The roadmap M9 section lists "MCP
server" and the Runtime has one task, "M9 — expose selected Runtime tools over
MCP" (requirement M9-MCP: allowlisted Runtime client surface, no direct
storage), blocked by its own assessment. Both are unimplemented, so there is no
duplicate code, but the plan would have produced two servers. Resolution
applied to the Runtime records: the M23 CB-11A–CB-11F series is the single MCP
server, transport and authentication path; the M9 task now states that it
extends that server with further tool families and takes a dependency on
CB-11B. It stays blocked by its M9 assessment and keeps its priority. If the
owner prefers M9 to own the server, the dependency can be reversed before any
code exists.

## 7. CB-01 — delivered scope, in review

CB-01 was authorized by the owner on 2026-10-15 and is documentation only: no
production code, no migration, no dependency. Its deliverables are:

1. [ADR-0036](../adr/ADR-0036-coordination-bridge-boundary-protocol-trust.md),
   status Proposed: topology and dependency rules, authority and aggregate,
   principals and trust, protocol, Runtime access path, remote authentication,
   data exposure, Coordination Publication, plan atomicity and revision
   conflicts, deployment, credential boundary amendment, alternatives,
   consequences and the list of further approvals.
2. [Architecture](../architecture/coordination-bridge.md): programs, trust
   zones, data exposure, flow diagrams, deployment and the verification of the
   contract against the existing code.
3. [Protocol](coordination-protocol.md): envelope, the six message kinds,
   identity, idempotency, correlation, compatibility, errors, limits, plans,
   approval, apply, revision conflicts and the GitHub wire format.
4. This plan, the roadmap section and the documentation index, aligned with the
   owner's decisions.

Definition of done: independent review, hardening, verification, a pull request
that stops at READY FOR MERGE, and owner acceptance of the ADR. The ADR is not
accepted until the owner says so, and CB-02 does not start before then.

## 8. Risks

- R1 Prompt injection through issue text or tool arguments: closed-grammar
  envelope parsing, size bounds, no free text as command, digest-bound approval.
- R2 Same-UID process approving its own plan: inherited from the trusted-local
  model; documented, remedy is M10. A coding agent with shell access could run
  the approve command; do not claim otherwise.
- R3 PostgreSQL parity: the proposal aggregate needs the storage contract once
  M22 enables PostgreSQL; CB-04 states its position and tests SQLite first.
- R4 Overlap with M13 and the M9 MCP task: handled in D7 and section 6.
- R5 Stale approval after planning drift: per-scope digests, expiry, conflicts
  in the receipt.
- R6 GitHub rate limits and outages: conditional requests, backoff, cursor
  recovery, bridge isolation.
- R7 Public exposure of a service on the owner's machine: structural
  read-only, OAuth-authenticated scoped principals, minimization, rate limits, short
  access-token lifetimes, audit, kill switch, optional IP or mTLS restriction at the
  proxy, Runtime and database never reachable. The residual risk is data
  disclosure through a leaked token, bounded by scope and expiry.
- R8 IPC transport extraction touches the CLI: done without behavior change
  with the existing CLI tests as the regression gate.
- R9 New MCP SDK dependency: version pinned, supply-chain review in CB-11B.

## 9. Pull request sequence

Each task is one PR (or a small stack) with preflight, risk-proportional
design, targeted tests plus regression, independent review, hardening, full QA
and an evidence handoff. Merges wait for explicit owner authorization.

1. CB-01 documentation and ADR.
2. CB-02, CB-10 (foundation), in order.
3. CB-11A, then CB-11B and CB-11C, then CB-11D, CB-11E, CB-11F. Remote Read
   Gate.
4. CB-03, CB-04 when slot 2 opens. V1 gate.
5. CB-05 … CB-09. V2 gate. CB-12.

## 10. Non-goals

A second task tracker or any state owned by GitHub; GitHub as orchestrator;
webhooks and a public webhook ingress; the general GitHub connector (M13);
remote approval, apply or any mutating MCP tool; authenticated operator
presence (M10); a proxy embedded in the Runtime; exposing the Runtime socket or
database; scope, milestone or requirement mutation in V2; PostgreSQL parity
claims; changes to the priority model.

## 11. Registered Runtime records

Milestone `57eacda4-5539-4b44-a8aa-27bafc48073b`, status `planned`.

| Key                           | Task ID                                | Requirement ID                                |
| ----------------------------- | -------------------------------------- | --------------------------------------------- |
| CB-01                         | `11def440-0ad8-4d9d-8f1e-f8614c2410eb` | CB-R01 `7e896638-25ac-4d08-ae98-f0245f823124` |
| CB-02                         | `6844400f-f199-4b11-9c26-e92aaf5e005b` | CB-R02 `8b9d43ac-48bd-4352-a665-672e8f33cf25` |
| CB-03                         | `7111c91b-825b-492a-a8a9-073617b3efe9` | CB-R03 `e4b6cefe-205a-4d8c-a9e5-f91401892498` |
| CB-04                         | `f15b8c00-20b2-436a-bfa1-11b39a4639c6` | CB-R04 `7eccf2c8-b46c-4218-ba50-f677bfc6bc8d` |
| CB-05                         | `0304fbb7-fe6a-4ea7-bb27-9bc5e51c8720` | CB-R05 `6a345350-be99-4d6c-bb1c-b5399fe04d02` |
| CB-06                         | `1a93884b-0820-42a4-9ee6-5a0af633febd` | CB-R06 `5f3fbe35-6cdd-4908-8915-0c3c6ce3b5e1` |
| CB-07                         | `1511abe4-79f7-4a6d-8f52-ac44233bba1a` | CB-R07 `5d7eb76f-24e8-42a4-a8b4-3d4ee4f81141` |
| CB-08                         | `6ac7c340-821f-47d2-951c-52c2bd59cdbd` | CB-R08 `6e755998-d922-4b95-86ea-3ba10f304c9d` |
| CB-09                         | `d9c5f7bf-5f4b-4791-a86c-1a18856312b6` | CB-R09 `137aa652-85c4-4214-99ae-38a1b75eb6d5` |
| CB-10                         | `3a112f30-fc68-4ccd-9d1b-874148287f6c` | CB-R10 `894dceb7-061f-4126-8742-814241b3a01a` |
| CB-11 (cancelled, superseded) | `0dd00ecb-d323-47cd-b8b4-3e08620cd2c4` | —                                             |
| CB-11A                        | `f869e486-88b1-454f-b169-d52218b4cc18` | CB-R11 `cb8f027e-826e-4e41-aa31-88127b3cbe17` |
| CB-11B                        | `07f93057-cb50-42c9-b0cc-642585553af2` | CB-R11                                        |
| CB-11C                        | `00ca4b7a-5136-4371-a71e-92feef571118` | CB-R13 `9b45f2ca-fd31-4b1e-8679-ef35ae7aa2cb` |
| CB-11D                        | `d1ee7276-4e99-4b72-949c-bc7d96cd31f4` | CB-R14 `410f820a-100b-4a6c-8def-27c3dda416e4` |
| CB-11E                        | `672e542e-2a7b-48de-aeb9-306ca5bb9239` | CB-R14                                        |
| CB-11F                        | `17e6c072-01bc-4bdc-a96a-cc40b7f82402` | CB-R11, CB-R13, CB-R14                        |
| CB-12                         | `da6d97cb-6832-4a89-a26a-fe08688708c2` | CB-R12 `1390a20c-29bf-4ba9-bdc9-85cc93f5de22` |

Requirement keys are `CB-R01`–`CB-R14`. Task dependencies are the Runtime edges
of section 4. The M9 task `170a6baf-b423-43d1-acad-003884eda07d` depends on
CB-11B.

Status of work: CB-01 is in review; no other M23 task starts before the owner
accepts ADR-0036.
