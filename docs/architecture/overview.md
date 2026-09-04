# Architecture overview

## Product boundary

AI Office presents one logical local office to the user. The **AI Office
Runtime** is the single application authority for stateful and persistent
operations. `install`, `status`, `next`, and `uninstall` are the user-facing
repository lifecycle; a repository-scoped skill is the primary conversational
interface when project-specific reasoning or office revision is needed. The
lower-level CLI remains the stable machine interface used by lifecycle, skills,
and automation. Future Web, GitHub, API, or MCP adapters must reach the same
Runtime authority rather than duplicate application rules or open SQLite
directly.

```text
Codex / Claude / CLI / future Web, GitHub, API, or MCP adapters
                              |
                        RuntimeClient
                              |
                    local IPC (current transport)
                              |
                 persistent daemon (current host)
                              |
                       AI Office Runtime
          +-------------------+-------------------+
          |                   |                   |
  application services   policy/pipelines   workers/schedulers
          |                   |                   |
          +---------- controlled actions --------+
                              |
                  connectors / audit / SQLite
```

External coding clients use a separate application port. AI Office compiles a
tool-independent operating policy and project instruction contract into the
shared derived `AI-OFFICE.md` guide inside the explicitly supplied integration
root. Codex uses a minimal `AGENTS.md` pointer plus a repository skill; Claude
uses a managed import bridge plus its repository skill wrapper. Detection and
filesystem/configuration knowledge remain in
infrastructure adapters. The integration root may differ from both the daemon
runtime root and the repository scanned by `project:import`. Client integration
does not grant runtime capabilities or move host reasoning into runtime
authority.

Repository identity uses another narrow application port backed by
`.ai-office/project.json` in the managed repository. The strict binding stores
only schema version, AI Office ownership, and portable repository ID. It
contains no path, secret, client detection, capability, or authoritative state.
The selected runtime maps that ID to its own project ID and canonical checkout
paths in `project.sqlite` before composing existing import, office, and client
services. See ADR-0008.

Portable backup uses that identity without making the repository artifact
authoritative. The daemon-backed portability service captures a referentially
closed semantic snapshot through a storage port only when excluded execution
authority is quiescent, records an immutable AI Office state observation, and
writes a strict checksummed `.aioffice` envelope through a local archive
adapter. Task lifecycle values remain semantic and portable; non-terminal
agent runs, active pipelines, and unexpired locks are the blockers. Restore
creates a new runtime-local project ID or attaches an identical verified
checkout; it replays governance decisions through existing constraints and
never trusts another machine's absolute path or overwrites different local
state. SQLite remains an adapter detail rather than the transfer format.

Project handover is the organizational transfer of a repository to the virtual
office. `packages/domain` owns the pure readiness model: handover states,
readiness dimensions, the repository-maturity heuristic, the review fingerprint
projection, and the recommended-action catalogue. `AssessProjectHandover` in
the application layer reads lifecycle status, project profile evidence, the
current office manifest, governance records, tasks, and open project questions,
maps them onto that domain input, and returns a schema-versioned handover
report. The CLI only renders it: the welcome banner, contextual status
guidance, and `ai-office next` share one deterministic assessment.

Handover keeps four concepts separate: deterministic discovery from the
repository scan, an agent's repository review, the user's confirmation of that
review, and the approved organizational model in the office manifest. The
manifest records mission, goals, constraints, preferences, roles, and pipelines
and therefore never certifies repository understanding. Only an explicit
confirmation does, recorded by `ConfirmRepositoryUnderstanding` as a
user-origin project profile entry (`handover` / `repository_review`) holding
the review summary, the scan it was bound to, and a fingerprint of the material
repository facts. Reusing the existing profile entry table keeps the evidence
portable in `.aioffice` snapshots, survives repository re-imports, and requires
no migration; the existing `superseded_at` column supersedes an earlier
confirmation instead of accumulating duplicates. A structural change to the
repository invalidates the fingerprint, so a completed handover degrades to a
stale review rather than a permanent false readiness.

Handover carries no authority: it never creates a capability grant, approves a
controlled action, changes pipeline enforcement, or starts an agent run. The
client-neutral handover workflow has a single definition in the application
layer, which the projected repository skill embeds and the checked-in
distribution skill is validated against.

The M6D-lite bridge routes a structured action intent from an agent run through
an executor-facing gateway. The agent-runtime package depends on the gateway
contract, not filesystem, connector, SQLite, or daemon implementations. Runs
without an intent retain the deterministic simulator; autonomous LLM tool
selection is future work.

## Application and domain boundaries

```text
apps and infrastructure adapters
              |
              v
         application
              |
              v
            domain
```

The domain owns entities, value objects, policies, and state transitions. It does not depend on Bun, SQLite, HTTP, Git, MCP, connector implementations, LLM providers, or provider SDKs.

Application services orchestrate use cases through ports. The Runtime
composition supplies SQLite repositories, clocks, IDs, connector registry, and
other adapters. The current daemon bootstrap is the only authoritative
composition root; the CLI is a client adapter and does not compose an embedded
writer when IPC is unavailable. All authoritative project writes pass through
these application boundaries.

## Runtime authority and persistent daemon host

`AiOfficeRuntime` is the application execution boundary. It receives command
semantics and returns command outcomes without transport request IDs, protocol
versions, socket paths, process IDs, or host lifecycle. The current
`PersistentRuntimeHost` maps the version-1 daemon protocol to this boundary.
The current command-shaped API deliberately reuses the stable machine contract;
it does not create a parallel implementation of every application use case.

`RuntimeClient` is the client-side boundary. Its current implementation uses
HTTP over a Unix domain socket. Codex, Claude, the CLI, and future clients must
route authoritative operations through the selected Runtime. They do not need
or receive direct SQLite access.

There is exactly one authoritative Runtime owner for mutable state. Runtime
unavailability never causes a stateful command to open SQLite locally or start
an embedded writer. A future embedded deployment mode would need explicit,
exclusive ownership for its whole lifecycle; it cannot be an availability
fallback.

The persistent host owns responsibilities that must outlive one client command:
concurrent admission and serialization, workers, queued jobs, schedulers,
retries, pipeline continuation, asynchronous connector work, event processing,
and lifecycle audit. Some are current foundations and some remain roadmap work,
but none belongs to CLI process lifetime.

## Local daemon transport and concurrency

The TypeScript daemon host exposes protocol version 1 as HTTP over
`<runtime-home>/daemon.sock`; it does not open a TCP listener. The production CLI
sends stateful product commands to that socket through `RuntimeClient`. Help,
explicit `status --offline`, and the explicitly offline `runtime:purge`
lifecycle command are local; purge refuses to run while a healthy host is
reachable and requires approval of its exact plan hash. Ordinary `status`
retains compatible read-only degradation when the host is unavailable, but
labels authoritative state unavailable and its Runtime association unverified.

The same socket carries a second, separately versioned contract: a read-only
query surface under `/api`. Commands and queries are distinct sides of the same
daemon, and the query side adds no mutation path.

```text
                  AI OFFICE DAEMON
                         |
        +----------------+----------------+
        |                |                |
     Commands          Queries          Events
        |                |                |
       CLI          Dashboard/API    invalidation
      Agents          Humans            stream
```

Short commands enter a FIFO queue. Long-running run execution is dispatched outside that global queue. SQLite runs in WAL mode, and transactions remain short: repository scans, prompts, LLM calls, simulated agent work, and filesystem mutations happen outside open transactions.

Daemon lifecycle and sanitized command outcomes are appended to `audit_event`. Agent-run transitions have their own append-only event stream. Generated project and governance Markdown views are deterministic projections and are not read back as authoritative state.

Project backup/restore also remains inside the Runtime command boundary.
Snapshot reads and revision writes use short transactions. Repository scanning
and archive file I/O occur outside those transactions; binding reconciliation
uses the established atomic file adapter and reports the narrow
database/filesystem partial case explicitly.

## Agent execution, gateway, and governance

Agent definitions are validated from YAML and synchronized into project storage.
Scheduling validates project, task, and agent, acquires a task lock, persists a
queued run and optional immutable action intent, and records state transitions.
The controlled-action executor invokes only its gateway contract and persists
the returned action ID and status in the run result. The fallback executor and
worktree manager remain deterministic simulations.

The host skill owns interactive onboarding synthesis and uses the host's existing
authenticated model session. It submits a strict versioned manifest to the
daemon, which validates role references and default task routing before storing
an immutable revision. No host model may grant capabilities or bypass controlled
actions.

Project profile state remains evidence and structured project knowledge.
The latest office manifest is the approved current organizational model.
`office:context` exposes both and labels those semantics; applying a manifest
does not synchronize overlapping goals, constraints, preferences, or permission
knowledge back into the profile.

The LLM gateway remains a provider-neutral, metered infrastructure boundary for
explicit future execution consumers. Its registry and OpenAI/Anthropic adapters
are not composed into project onboarding or normal daemon commands. Codex or
Claude generates onboarding questions in the host session; only the accepted
manifest crosses into the daemon. LangChain does not cross into
application/domain code or own orchestration.

Governance stores milestones, requirements, ADRs, reviews, and approval decisions as structured project state. This M5 governance approval model is separate from M6C-lite `ActionApproval`, which binds a controlled filesystem mutation to its authorization and simulation artifact.

## Operational read models

Operational state is computed once, in the application layer, and published as
explicit read models. Every observability surface consumes those models rather
than re-deriving semantics from persisted rows.

```text
apps/dashboard -> daemon query API -> application query service
               -> operational read models -> repository ports -> SQLite
```

HTTP query handlers parse, validate, and serialize; they hold no SQL and no
domain logic, so a future CLI query command or MCP tool can consume the same
models without HTTP. Query responses carry `queryApiVersion`, versioned
independently of `daemonProtocolVersion`.

Persisted records do not always express their operational meaning, and the read
models say so rather than guessing. `ScheduleAgentRun` deliberately does not
transition the task it schedules, so a task legitimately reads `pending` while a
run for it executes; `TaskOperationalState` therefore reports the persisted
`recordedStatus`, the derived `operationalStatus`, and the reasons they differ.
Relationships the domain does not model — task to requirement, task to milestone
— are published as explicitly unavailable rather than defaulted.

An in-memory bus publishes invalidation topics after a command completes. Topics
carry no state and nothing new is persisted, so the stream cannot become a
competing source of truth. See the
[operational dashboard](../development/dashboard.md) and
[ADR-0015](../adr/ADR-0015-operational-read-models-and-loopback-dashboard.md).

## Controlled resources and side effects

Agents do not directly access protected local or external resources. Side effects go through controlled application and connector boundaries:

1. the resource registry identifies a project-scoped connector resource;
2. capability policy authorizes a principal, operation, normalized arguments, and effective constraints;
3. the connector descriptor defines risk, simulation, execution, and approval requirements;
4. mutations are simulated and persisted for inspection;
5. local approval binds the immutable action and simulation;
6. execution performs fresh authorization and precondition checks before one execution attempt;
7. state and sanitized audit events record the outcome.

The filesystem connector implements scoped list/read/search plus simulated and trusted-local create/write/move/delete. Every filesystem v2 mutation requires approval. Simulation never mutates the target. Revoked or expired grants, disabled resources, changed preconditions, stale artifacts, and replay attempts fail closed.

The M6D-lite gateway implements `agent runtime -> controlled actions` without a
direct filesystem or infrastructure dependency in the runtime. Mutation intents
stop at `approval_pending`; the existing approval and execution commands retain
authority. Directly wiring the runtime to filesystem or infrastructure adapters
would violate this boundary.

Owner-invoked client configuration is not an agent controlled action. Its safety
boundary is passive inspection, a deterministic plan, explicit approval of the
exact plan hash, file-hash preconditions, ownership-aware updates, and atomic
writes. No database transaction spans those filesystem operations.

## Storage responsibilities and implementation status

The architecture distinguishes three databases by authority and rebuildability:

| Database                        | Responsibility                                                                                                                                                                                | Current implementation                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `<runtime-home>/project.sqlite` | Authoritative state for the projects known to that daemon runtime: repository mappings, office manifests, onboarding, tasks, agents/runs, costs, governance, capabilities, actions, and audit | Implemented, opened and migrated by the daemon and project migration command |
| `<runtime-home>/global.sqlite`  | Durable versioned global roles and patterns plus lessons; isolated with an explicit `AI_OFFICE_HOME`                                                                                          | Implemented and migrated lazily by Runtime-backed `memory:*` commands        |
| `<runtime-home>/index.sqlite`   | Regenerable code index: files, symbols, edges, chunks, FTS, and later embeddings                                                                                                              | Initial schema only; indexing and daemon integration are future work         |

`project.sqlite` is authoritative and must be preserved and upgraded. The code index is derived data that may be rebuilt from source and project metadata. Global memory is durable reusable knowledge but is not project authority.

`project.sqlite` also stores immutable portable snapshot revisions and one
local head/base record per backed-up or restored project. A revision identifies
AI Office state, not a Git commit. The application-layer remote port defines
head, pull, and compare-and-swap push without selecting a provider; no remote
adapter or push/pull command is implemented yet.

The linkable entry point uses `AI_OFFICE_HOME` or the default stable user home
`~/.ai-office`; program location and current repository do not select authority.
The legacy Bun development scripts explicitly use `<cwd>/.ai-office`. The source/import root is the
repository path passed to `project:import`; importing stores scan state in the
current daemon's database rather than creating a database under that repository.
The independently supplied `client:* --root` is the integration root containing
the optional instruction contract, shared guide, host pointers, and repository
skills. These three roots may coincide but do not have to. See the [storage design](storage.md) and
the README's
[local storage guide](../../README.md#local-storage-and-state).

An installed repository also contains `.ai-office/project.json`. This
committable portable identity is not a fourth database and is not authoritative
state. Discovery canonicalizes the current directory, selects the nearest
same-filesystem ancestor binding, and rejects symlinked or malformed anchors.
Status reports repository identity and runtime association separately. A fresh
runtime can establish its own association through install; conflicting paths or
copied identities fail closed.

## Current trust model

AI Office is trusted-local and single-user. Runtime mediation protects its own
application invariants against accidental or unauthorized agent access,
traversal and path escape, sensitive paths, stale simulation or authorization,
replay, and mutation without approval.

The Runtime is an authority inside AI Office; it is not an authentication or
process-isolation boundary against the local Unix user. An arbitrary same-UID,
shell-capable worker or process can reach the same local administration surface
unless additional isolation or authenticated human presence is introduced.
IPC routing is not authentication. Socket ownership, executable identity, TTY
ownership, and protocol privilege markers are not authentication. Approval uses
a caller-supplied audit identity rather than cryptographic user presence.

The trusted-local path boundary also does not defend against a hostile same-UID
process concurrently renaming or unlinking entries in the same filesystem
namespace.

The dashboard is a local, same-user observability surface and introduces no new
authenticated human or operator boundary. The Runtime host still opens no TCP
listener; `ai-office dashboard` owns a loopback port for as long as the command
runs. A loopback TCP port is reachable by every local Unix account, unlike the
0600 socket, so that host validates the `Host` header and requires a per-process
session token that dies with the command. The token bars accidental and blind
access; it is not a secret, because the command passes the whole URL to the
platform opener and the browser records it in history. It does not authenticate
a human and does not separate same-UID processes. The surface is read-only and
changes no authorization.

The Rust/`openat2` spike, authenticated approval research, tamper-evident audit,
and stronger crash reconciliation are preserved as M10 hardening baselines and
are not linked into production.

## Evolution boundaries

The Runtime contract, daemon protocol, and application ports keep future
client, host, transport, provider, storage, and native-security changes
replaceable. TypeScript remains the production implementation. A future Rust
boundary is justified only for scoped hardening work accepted by the roadmap
and ADR process; the existing native filesystem spike is research, not a
production adapter. See ADR-0014.

## Virtual engineering organization

The runtime now provides the first enforceable pipeline foundation: manifest
definitions may remain guidance-only or opt into enforcement; a started run
pins its definition and persists stage runs, task binding, assignment,
transition, approval, override, and audit state. Advanced branching, retries,
artifacts, and worker-runtime dispatch remain later M11/M12 work.

```text
                         AI Office authority
  +-------------------------------------------------------------+
  | organization -> pipeline engine -> policy/capability gates  |
  |                         |                  |                  |
  |                    stage runs         controlled actions     |
  +-------------------------+------------------+------------------+
                            |                  |
                    worker runtime ports   connector ports
                    /       |       \           |
               Codex   Claude Code   ...      GitHub
```

AI Office owns role definitions, responsibility boundaries, pipeline state,
assignment, transition policy, separation of duties, approval chains, and audit.
Codex, Claude Code, Gemini CLI, OpenCode, local executors, and future runtimes are
replaceable workers behind an application port. A worker does not define what an
architect, developer, reviewer, QA, or security agent is allowed or required to
do.

The future worker-runtime port is distinct from both existing provider and
client-integration boundaries:

- the LLM gateway normalizes provider calls, usage, pricing, and budgets;
- M6F client adapters configure how external tools consume project instructions;
- worker adapters execute assigned pipeline stages and return normalized results.

Detecting or configuring a client does not authenticate it as a pipeline worker
and does not grant it capabilities.

### Generic pipeline authority

The pipeline engine belongs to the domain/application side of AI Office.
Implemented `PipelineRun` and stage-run state pin ordered manifest definitions,
responsible roles, assignments, capability restrictions, approvals, sequential
transitions, cancellation, and attributed overrides. Branching, retry and
failure policies, typed artifacts, and bounded cycles such as review/fix/review
remain deliberately deferred.

Pipeline configuration never creates authority by itself. Before a stage or
transition proceeds, application policy evaluates the assigned principal,
stage/run provenance, effective capabilities, conditions, required independent
actors, approvals, and relevant risk. Separation of duties must be enforced
from stable identities and provenance, not inferred from different role names or
prompts.

External work remains outside SQLite transactions. The engine persists authority
and intent before dispatch, observes the worker or connector through a port, and
records the result afterward. Timeouts, crashes, ambiguous outcomes, retries,
and definition changes must have explicit fail-closed semantics rather than
implicitly replaying side effects.

Workflow gates remain separate from existing approval concepts:

- M5 governance reviews record project governance decisions;
- pipeline approvals allow a workflow transition when its policy is satisfied;
- M6 action approvals authorize one exact protected side effect after simulation
  and revalidation.

No one approval type substitutes for another.

### GitHub connector boundary

GitHub is a protected external system, not an orchestration engine. A future
GitHub App and connector expose project-scoped repository resources plus
authorized operations for issues, branches, commits/push, pull requests,
reviews, comments, checks, and merge. Installation credentials remain behind
infrastructure credential references and are never passed to agents.

Signed webhook ingestion is an inbound infrastructure adapter. It authenticates,
deduplicates, validates ownership, and translates deliveries into application
facts or commands. Neither a webhook nor an outbound connector response chooses
the next stage or makes a merge-policy decision. Those decisions remain in the
Pipeline Engine and Policy Engine.

GitHub Actions may later act as a worker backend, check producer, or integration
point. It is not the authoritative workflow orchestrator. The implementation
assessment must still decide the boundary between local Git/worktree operations,
remote Git transport, and GitHub API operations without exposing raw repository,
shell, network, or credential access to workers.

### Structured outcomes and risk-based policy

Stages may produce typed artifacts in addition to human-readable output. In
particular, a review artifact can carry a decision and structured findings with
severity, category, source location, message, and suggestion. Pipeline policy
can use that data to request fixes, require another reviewer, trigger QA or
security, publish connector comments, or block merge. Free-form review text is
never authorization by itself.

Change-risk routing may eventually select stronger pipeline gates, including
independent review, security review, human approval, or human merge. This must be
designed alongside the existing connector-operation risk model rather than
silently equating the two. Caller-controlled data may not reduce either risk.

The detailed sequencing, dependencies, and open questions are recorded in the
[development roadmap](../development/roadmap.md#long-term-product-direction).
