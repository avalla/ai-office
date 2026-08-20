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

The TypeScript daemon exposes protocol version 1 as HTTP over `.ai-office/daemon.sock`; it does not open a TCP listener. The production CLI sends stateful commands to that socket. Help is rendered locally so it remains available while the daemon is stopped.

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

## Storage responsibilities and implementation status

The architecture distinguishes three databases by authority and rebuildability:

| Database                                 | Responsibility                                                                                                                                                   | Current implementation                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `<repository>/.ai-office/project.sqlite` | Authoritative project state: projects, office-manifest revisions, onboarding, tasks, agents/runs, costs, governance, capabilities, controlled actions, and audit | Implemented, opened and migrated by the daemon and project migration command |
| `~/.ai-office/global.sqlite`             | Global reusable memory: roles, patterns, playbooks, and lessons shared across projects                                                                           | Initial schema only; not opened or managed by the daemon                     |
| `<repository>/.ai-office/index.sqlite`   | Regenerable code index: files, symbols, edges, chunks, FTS, and later embeddings                                                                                 | Initial schema only; indexing and daemon integration are future work         |

`project.sqlite` is authoritative and must be preserved and upgraded. The code index is derived data that may be rebuilt from source and project metadata. Global memory is durable reusable knowledge but is not project authority.

## Current trust model

M6C-lite is a trusted-local, single-user boundary. It protects against accidental or unauthorized agent access, traversal and path escape, sensitive paths, stale simulation or authorization, replay, and mutation without approval.

It does not defend against a hostile process with the same Unix credentials concurrently renaming or unlinking entries in the same filesystem namespace. Approval uses a caller-supplied audit identity rather than cryptographic user presence. The Rust/`openat2` spike, authenticated approval research, tamper-evident audit, and stronger crash reconciliation are preserved as M10 hardening baselines and are not linked into production.

## Evolution boundaries

The daemon protocol and application ports keep future interface, provider, storage, and native-security changes replaceable. TypeScript remains the production implementation. A future Rust boundary is justified only for scoped hardening work accepted by the roadmap and ADR process; the existing native filesystem spike is research, not a production adapter.
