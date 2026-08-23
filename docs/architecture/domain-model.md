# Domain model

## Implemented model

The current domain and application model includes:

- projects, project profiles, and tasks;
- immutable virtual-office manifest revisions, roles, and default task pipelines;
- roles, agents, agent runs, and task locks;
- pricing versions, budgets, reservations, normalized usage, and costs;
- milestones, requirements, architecture-decision records, reviews, and governance decisions;
- resources, capability grants, action requests, simulation artifacts, action approvals, and action executions;
- versioned global roles and reusable patterns, lessons, and project memory references;
- append-only audit and agent-run events.

Code-index entities and fully assembled task context remain future M8–M8.5
concerns. Global memory is durable reusable knowledge, not project authority:
project adoption records in `project.sqlite` reference one exact global pattern
version without copying its definition or granting capabilities.

A global role `key` is its trimmed, case-sensitive stable logical identity.
Every role revision keeps the same role ID and is addressed by `(id, version)`;
only a strictly newer version can be created, and historical revisions are
never overwritten or deleted. Deprecation changes the status of one exact
revision, so reconstructing the role configuration used by earlier work remains
possible.

Global pattern and lesson `sourceProjectId` / `sourceTaskId` values are
historical provenance identifiers. The application validates them against the
current project authority when writing, but the domain does not model them as
permanent cross-database references: durable global memory may outlive or be
shared independently of the originating runtime database.

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

Project profiles and office manifests have different authority. The project
profile is the knowledge/evidence layer: detected or imported facts, onboarding
answers, inferences, provenance, and historical atomic user knowledge.
`GetProjectProfile` exposes that evidence; it is not necessarily the current
organizational configuration.

The latest office manifest is the approved current office configuration for
mission, goals, constraints, preferences, permission preferences, roles, and
pipelines. Applying a manifest creates a new immutable revision without copying,
rewriting, or deleting profile entries. A profile goal and a current manifest
goal may therefore conflict legitimately. `office:context` returns both with
distinct semantics instead of resolving the conflict. A future context builder
may consume both only while preserving their separate provenance.

## Planned pipeline execution model

M11 is intended to evolve the current descriptive pipeline configuration into a
durable execution model. The following names communicate aggregate
responsibilities; they do not yet define stable TypeScript APIs or SQLite tables:

- `Pipeline` is a versioned declarative workflow definition;
- `PipelineStage` defines one responsibility boundary, its inputs, outputs,
  dependencies, conditions, policy gates, and failure behavior;
- `PipelineRun` binds a task to one effective pipeline definition and records
  end-to-end state and provenance;
- `StageRun` records an assigned agent identity, attempt, effective inputs,
  produced artifacts, outcome, and transition evidence.

A pipeline run must not reinterpret a role or a stage declaration as an
authorization grant. The assigned agent still needs effective capabilities for
every protected operation, and the controlled-action lifecycle remains the only
authority for those effects. Pipeline approval, M5 governance review, and M6
action approval remain different concepts.

Separation of duties is a future policy invariant over stable identities and
run provenance. For example, a developer's `StageRun` must be linkable to the
artifact or pull request it produced so policy can reject that same agent as an
independent reviewer, approver, or merger when the pipeline requires distinct
actors. Different role labels or separate runtime processes are not sufficient
proof of independence.

Stage outputs may include structured artifacts. A provisional review result
could have this shape:

```json
{
  "decision": "changes_requested",
  "findings": [
    {
      "severity": "high",
      "category": "security",
      "file": "src/example.ts",
      "line": 42,
      "message": "...",
      "suggestion": "..."
    }
  ]
}
```

This shape is illustrative, not a stable contract. A future design must decide
artifact versioning, validation, diff anchoring, provenance, redaction, and how
structured findings relate to existing governance reviews and external GitHub
comments.

The future design must also reconcile pipeline, task, agent-run,
controlled-action, and governance lifecycles rather than create competing
sources of truth.
In particular, a `StageRun` may coordinate one or more agent runs and controlled
actions, but cannot collapse their independent replay, approval, cost, and audit
semantics into one status field.

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
