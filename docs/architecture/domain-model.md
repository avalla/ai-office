# Domain model

## Implemented model

The current domain and application model includes:

- projects, project profiles, and tasks;
- immutable virtual-office manifest revisions, roles, and default task pipelines;
- roles, agents, agent runs, and task locks;
- pricing versions, budgets, reservations, normalized usage, and costs;
- milestones, requirements, architecture-decision records, reviews, and governance decisions;
- resources, capability grants, action requests, simulation artifacts, action approvals, and action executions;
- append-only audit and agent-run events.

Patterns, lessons, global reusable memory, code-index entities, and fully assembled task context are future M7–M8.5 concerns. Initial global and index schemas do not make those product behaviors implemented.

## Ownership and references

Project-scoped records carry a project identity. Application services validate project ownership and cross-record references before persistence; foreign keys and unique constraints reinforce those rules in SQLite.

The intended long-term traceability chain is:

```text
requirement -> architecture decision -> task -> agent run -> artifact -> review
```

Governance and run records exist today, but every link in this chain is not yet modeled as an automatic end-to-end workflow.

## Virtual office manifests

Schema-versioned office manifests describe project mission, goals, constraints,
preferences, virtual roles, and default pipelines for feature, bugfix,
maintenance, research, and release work. Pipeline stage role references and
default routing are validated before persistence. Every apply creates a new
immutable revision.

The manifest is organizational configuration, not execution authority.
Permission preferences do not create capability grants, and pipeline approval
gates do not replace controlled-action approval. The current runtime resolves a
default pipeline but does not yet persist stage-by-stage pipeline progress.

## Task states

The task status type recognizes `pending`, `assigned`, `running`, `blocked`, `waiting_review`, `completed`, `failed`, and `cancelled`. Current domain methods implement these transitions:

```text
pending | assigned -> running
running | waiting_review -> completed
```

The current CLI creates and lists tasks; it does not expose a general task-transition command.

## Agent-run states

```text
queued -> preparing -> running -> reviewing -> completed
   |         |           |           |
   +---------+-----------+-----------+-> cancelled
             +-----------+-----------+-> failed
```

Every transition is checked by the domain model and projected into the append-only `agent_run_event` table. A task lock is acquired when a run is queued and released after completion, failure, or cancellation. The current executor and worktree manager are deterministic simulations.

## Governance lifecycles

- milestones: `planned -> active -> completed`, with cancellation from planned or active;
- requirements: `proposed -> accepted -> implemented -> verified`, with rejection from proposed or accepted;
- ADR records: `proposed -> accepted -> deprecated | superseded`, or proposed to rejected;
- reviews: `pending -> approved | rejected`, finalized by an immutable governance decision.

Governance review decisions are distinct from controlled-action approvals.

## Controlled-action lifecycle

Capability policy is deny by default. An action request records the resource, agent, operation, normalized arguments, effective grants and constraints, and authorization hash. Reads may execute after authorization. Filesystem mutations require simulation and local approval before execution.

```text
requested
  -> authorized
  -> simulating
  -> simulated
  -> approval_pending
  -> executing
  -> completed | failed | execution_unknown
```

The exact paths vary for denial, read-only operations, rejection, and simulation failures. Every filesystem v2 mutation uses a separate immutable simulation artifact and `ActionApproval`; a separate `ActionExecution` ledger allows at most one execution attempt.
