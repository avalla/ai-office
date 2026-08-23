# Architecture overview

## Product boundary

AI Office presents one logical local office to the user. A repository-scoped
skill is the primary conversational interface in supported agent hosts. The CLI
is the stable machine interface used by that skill and automation. Web and MCP
may use the same daemon protocol in future milestones.

```text
Codex / compatible host
          |
          v
 repository-scoped skill       Web / MCP (targets)
          |                           |
          +------ CLI / protocol -----+
                      |
                      v
                local daemon
                    |
                    v
          application services
       +------------+-------------+
       |            |             |
 agent runtime    office      LLM gateway
                  manifests
       |                          |
       v                          v
controlled actions            providers
       |
       v
capability policy
       |
       v
connector registry
       |
       v
resource adapters
```

External coding clients use a separate application port. AI Office compiles a
tool-independent operating policy and project instruction contract into the
canonical `AGENTS.md` artifact inside the explicitly supplied integration root;
Codex consumes it natively and Claude uses a minimal managed import bridge in
that same root. Detection and filesystem/configuration knowledge remain in
infrastructure adapters. The integration root may differ from both the daemon
runtime root and the repository scanned by `project:import`. Client integration
does not grant runtime capabilities or move host reasoning into runtime
authority.

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

Application services orchestrate use cases through ports. Composition roots in the daemon and CLI supply SQLite repositories, clocks, IDs, the LLM gateway, connector registry, and other adapters. All authoritative project writes pass through these application boundaries.

## Local daemon and concurrency

The TypeScript daemon exposes protocol version 1 as HTTP over
`.ai-office/daemon.sock`; it does not open a TCP listener. The production CLI
sends stateful product commands to that socket. Help and the explicitly offline
`runtime:purge` lifecycle command are local; purge refuses to run while a
healthy daemon is reachable and requires approval of its exact plan hash.

Short commands enter a FIFO queue. Long-running run execution is dispatched outside that global queue. SQLite runs in WAL mode, and transactions remain short: repository scans, prompts, LLM calls, simulated agent work, and filesystem mutations happen outside open transactions.

Daemon lifecycle and sanitized command outcomes are appended to `audit_event`. Agent-run transitions have their own append-only event stream. Generated project and governance Markdown views are deterministic projections and are not read back as authoritative state.

## Runtime, gateway, and governance

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

The optional LLM gateway separates provider invocation from pricing and
accounting. A registry resolves prefixed model references into the normalized
provider port; the default infrastructure adapter uses LangChain for OpenAI and
Anthropic compatibility, while the native OpenAI Responses adapter remains
available. It supports headless workflows but is not required for interactive
skill-first onboarding. LangChain does not cross into application/domain code
or own orchestration.

Governance stores milestones, requirements, ADRs, reviews, and approval decisions as structured project state. This M5 governance approval model is separate from M6C-lite `ActionApproval`, which binds a controlled filesystem mutation to its authorization and simulation artifact.

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

| Database                                   | Responsibility                                                                                                                                                           | Current implementation                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `<runtime-root>/.ai-office/project.sqlite` | Authoritative state for the projects known to that daemon runtime: office manifests, onboarding, tasks, agents/runs, costs, governance, capabilities, actions, and audit | Implemented, opened and migrated by the daemon and project migration command |
| `~/.ai-office/global.sqlite`               | Durable global roles, versioned patterns, and lessons shared across runtimes                                                                                             | Implemented and migrated lazily by daemon-backed `memory:*` commands         |
| `<runtime-root>/.ai-office/index.sqlite`   | Regenerable code index: files, symbols, edges, chunks, FTS, and later embeddings                                                                                         | Initial schema only; indexing and daemon integration are future work         |

`project.sqlite` is authoritative and must be preserved and upgraded. The code index is derived data that may be rebuilt from source and project metadata. Global memory is durable reusable knowledge but is not project authority.

The production daemon derives `runtime-root` from its current working directory;
there is no public data-directory option. The source/import root is the
repository path passed to `project:import`; importing stores scan state in the
current daemon's database rather than creating a database under that repository.
The independently supplied `client:* --root` is the integration root containing
the instruction contract and any managed `AGENTS.md` or `CLAUDE.md`. These three
roots may coincide but do not have to. See the [storage design](storage.md) and
the README's
[local storage guide](../../README.md#local-storage-and-state).

## Current trust model

M6C-lite is a trusted-local, single-user boundary. It protects against accidental or unauthorized agent access, traversal and path escape, sensitive paths, stale simulation or authorization, replay, and mutation without approval.

It does not defend against a hostile process with the same Unix credentials concurrently renaming or unlinking entries in the same filesystem namespace. Approval uses a caller-supplied audit identity rather than cryptographic user presence. The Rust/`openat2` spike, authenticated approval research, tamper-evident audit, and stronger crash reconciliation are preserved as M10 hardening baselines and are not linked into production.

## Evolution boundaries

The daemon protocol and application ports keep future interface, provider, storage, and native-security changes replaceable. TypeScript remains the production implementation. A future Rust boundary is justified only for scoped hardening work accepted by the roadmap and ADR process; the existing native filesystem spike is research, not a production adapter.

## Planned virtual engineering organization

The post-M10 roadmap extends the current virtual-office configuration into an
auditable engineering organization. This is a planned boundary, not a claim
about the current runtime: M6E stores and resolves ordered pipeline definitions,
but the active host still follows those stages and no durable multi-stage
pipeline executor exists.

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

This future worker-runtime port is distinct from both existing provider and
client-integration boundaries:

- the LLM gateway normalizes provider calls, usage, pricing, and budgets;
- M6F client adapters configure how external tools consume project instructions;
- worker adapters execute assigned pipeline stages and return normalized results.

Detecting or configuring a client does not authenticate it as a pipeline worker
and does not grant it capabilities.

### Generic pipeline authority

The future Agent Pipeline Engine belongs to the domain/application side of AI
Office. Conceptual `Pipeline`, `PipelineStage`, `PipelineRun`, and `StageRun`
models describe versioned definitions, responsible roles, agent assignments,
inputs, artifacts, dependencies, conditions, branching, retry and failure
semantics, workflow approvals, and bounded cycles such as review/fix/review.
Their exact API and persistence shape remain open until M11 assessment.

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
