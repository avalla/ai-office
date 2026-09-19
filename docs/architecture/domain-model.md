# Domain model

## Implemented model

The current domain and application model includes:

- projects, project profiles, and tasks;
- immutable virtual-office manifest revisions, roles, and default task pipelines;
- pinned pipeline runs, stage runs, assignments, workflow gates, and overrides;
- roles, agents, agent runs, and task locks;
- pricing versions, budgets, reservations, normalized usage, and costs;
- milestones, requirements, architecture-decision records, governance reviews, and governance decisions;
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

For future non-software verticals, the more general traceability problem is:

```text
source -> evidence / claim -> work item -> run -> artifact -> review -> approval
```

That generalized chain does not replace the current software chain. It defines
the provenance requirement a future vertical layer must satisfy without
inventing evidence or collapsing domain-specific decisions into one generic
status.

## Artifact Review & Approval Workflow

The long-term core treats reviewable output as a generic capability rather than
as a software-development concept. An **Artifact** is a verifiable output of a
task or execution. It may be an AI Office record or a reference to an external
resource, and it is not necessarily a file. A logical artifact may have several
immutable versions; each version has a stable identity/fingerprint, metadata,
and provenance to the `AgentRun` or operator that produced it.

The conceptual shape is intentionally a domain-neutral contract, not a runtime
schema:

```text
Artifact
  - id / logical identity
  - task reference
  - artifact type
  - version identity
  - fingerprint
  - producer AgentRun or operator
  - domain metadata
```

Review is a separate relation to an artifact version. A `ReviewRequest` names
the exact `artifactId` and `artifactFingerprint`, optionally pins a review
policy, and declares reviewer requirements. A `ReviewResult` records one
reviewer's verdict (`approved`, `changes_requested`, or `rejected`), findings,
reviewer identity and provenance, timestamp, and the exact fingerprint reviewed.
The reviewer may be a human, an LLM, a deterministic policy/rules checker, CI or
other automated verification, an external system, or a domain-specific verifier.
These are adapters/providers; the core does not assume that a reviewer is an
LLM.

`ReviewPolicy` is the deterministic policy layer for zero, one, or multiple
reviewers; required versus optional reviewers; quorum; artifact-type and
risk-based routing; domain constraints; and mandatory human approval. It may
permit fully automated approval for a low-risk workflow, but review remains
separate from authorization of a final external action.

The workflow is therefore:

```text
Task -> AgentRun -> Artifact version -> ReviewRequest -> ReviewResult
     -> approved / changes_requested / rejected
     -> Approval -> Authoritative Execution / Publish / Release -> Task completion
```

`changes_requested` starts a correction loop. The same task may own multiple
AgentRuns and artifact versions without creating a new task for each iteration:

```text
Agent -> Artifact v1 -> Review -> changes_requested
      -> Agent -> Artifact v2 -> v1 review is stale -> new Review -> approved
```

The following are core invariants for the future capability:

- `AgentRun` completed is not `Task` completed when review or approval is still required;
- an artifact produced is not an artifact approved, and an approved artifact is
  not an external effect executed;
- every review and approval identifies exactly one artifact version/fingerprint;
- changing an artifact does not delete history, but makes earlier review/approval
  stale or non-current unless an explicit policy says otherwise;
- review history, reviewer identity and producer provenance are append-only and
  auditable;
- an agent cannot self-assert approval unless policy explicitly permits that
  subject and independence rules still allow it;
- recovery and replay never silently turn stale approval into current approval;
- human review is a first-class workflow state, not an LLM action in disguise;
- domain adapters cannot weaken these invariants.

The conceptual lifecycle may be projected as `pending -> running ->
artifact_ready -> awaiting_review -> changes_requested -> running ->
artifact_ready -> awaiting_review -> approved -> completed`. These are pipeline,
artifact, review and read-model conditions, not a decision to add all of these
values to the current `TaskStatus`. The current `Task` and `AgentRun` aggregates
remain authoritative for their own states until an implementation assessment
selects a compatible composition.

Indicative audit events such as `artifact.created`, `review.requested`,
`review.completed`, `review.stale`, `artifact.approved` and `artifact.released`
must reuse the existing append-only audit/event model where possible. They are
not yet implemented event names. Any persisted event must carry the artifact
identity, version/fingerprint, review/approval identity, producer/reviewer
provenance and the plan/policy hash needed for deterministic recovery.

Software Pull Requests, patches, commits and release candidates are one adapter
family. A `PullRequestArtifact` may add repository, branch, base branch, PR
number/URL and `headSha`; a review of `abc123` must never authorize `def456`.
Manufacturing proposals, legal drafts, accounting reports and compliance
documents use the same generic semantics with their own domain types and
policies. GitHub and other external systems remain connector/adapter concerns.

This capability is planned, not implemented by the current domain model. It
extends the existing M5 governance review, M6 controlled-action approval,
pipeline approval and Runtime audit concepts without creating a competing
review or authority engine. See [ADR-0021](../adr/ADR-0021-artifact-review-and-approval-workflow.md).

## Virtual office manifests

Schema-versioned office manifests describe project mission, goals, constraints,
preferences, virtual roles, and default pipelines for feature, bugfix,
maintenance, research, and release work. Pipeline stage role references and
default routing are validated before persistence. Every apply creates a new
immutable revision.

The manifest is organizational configuration, not execution authority by
itself. Existing definitions default to guidance-only. An explicitly enforced
definition becomes authoritative only when an operator starts a durable run.
Permission preferences do not create capability grants, and pipeline approval
gates do not replace controlled-action approval. Stage capabilities narrow
ordinary policy grants. The runtime persists ordered stage progress, assignment,
approval, cancellation, and reasoned overrides for active enforced runs.

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

## Pipeline execution model

The initial M11 enforcement foundation uses these responsibilities:

- `OfficePipeline` is a declarative workflow definition pinned from an immutable
  manifest revision;
- an office pipeline stage defines one role boundary, allowed capability
  operations, sequential position, approval gate, and separation constraints;
- `PipelineRun` binds a task to one effective pipeline definition and records
  end-to-end state and provenance;
- stage-run state records an assigned stable agent identity, status, approval
  evidence, and transition timestamps.

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

Stage outputs may include structured artifacts. The following provisional review
result shape is illustrative only; a future implementation must additionally bind
it to one Artifact version/fingerprint and preserve reviewer provenance:

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

`task.status` is **authoritative operational state**, not a reminder. The status
type recognizes `pending`, `assigned`, `running`, `blocked`, `waiting_review`,
`completed`, `failed`, and `cancelled`, and the domain declares the lifecycle
once, as a table:

```text
pending        -> running | blocked | cancelled
assigned       -> running | blocked | cancelled
running        -> waiting_review | completed | blocked | failed | cancelled
blocked        -> pending | failed | cancelled
waiting_review -> completed | blocked | failed | cancelled
completed      -> (terminal)
failed         -> (terminal)
cancelled      -> (terminal)
```

`allowedTaskTransitions`, `isTaskTransitionAllowed`, and `terminalTaskStatuses`
read that table; the aggregate's `start`, `submitForReview`, `complete`,
`block`, `unblock`, `fail`, and `cancel` methods are the only writers, and each
validates against it. **No terminal status can be left** — a board able to
reverse one could fabricate project history.

`assigned` deliberately has no transition into it: the `Task` aggregate stores
no assignee, so the state could not say who it is assigned to. It remains a
status a restored archive may carry, and `start` still accepts it.

`unblock` returns to `pending` rather than to whatever preceded the block: the
aggregate keeps no previous status, and guessing one would invent history.

The CLI exposes one semantic command per transition — `task:start`,
`task:submit-review`, `task:complete`, `task:block`, `task:unblock`,
`task:fail`, `task:cancel` — plus the read-only `task:transitions` preflight.
There is deliberately **no** generic `task:set-status`: an unrestricted terminal
write is the escape hatch that makes a lifecycle meaningless.

### Historical correction

`pending -> completed` is absent from the table on purpose, and stays absent.
Recording work that was completed outside the lifecycle AI Office holds is a
different statement from progressing through it, so it is a separate aggregate
operation — `recordHistoricalCompletion` — behind a separate command,
`task:record-completion`.

Its guard is stricter than the lifecycle's, and derived from the same table
rather than restated beside it: it applies only where the status is non-terminal
*and* `completed` is not already reachable, which is exactly `pending`,
`assigned`, and `blocked`. Terminal states remain irreversible. Where
`task:complete` works, the correction refuses and names it.

It does not call `start`. Walking a task through `running` to reach `completed`
would enter a moment at which work began that nobody observed, in order to
record work that happened outside the record. The audit event is
`task.completion_recorded`, carrying `correction: true`, the mandatory
rationale, and the evidence the operator was shown — never `task.status_changed`,
so no fabricated `start` can appear in the trail.

## Agent-run states

```text
queued -> preparing -> running -> reviewing -> completed
   |         |           |           |
   +---------+-----------+-----------+-> cancelled
             +-----------+-----------+-> failed
```

Every transition is checked by the domain model and projected into the append-only `agent_run_event` table. A task lock is acquired when a run is queued and released after completion, failure, or cancellation. The current executor and worktree manager are deterministic simulations.

## Task, requirement, and pipeline ownership

Three aggregates hold three different kinds of state, and none of them derives
another's:

| Aggregate | Owns | Answers |
| --- | --- | --- |
| `Requirement` | acceptance / specification state | what must be true and verified |
| `Task` | operational work state | what the office is doing |
| `PipelineRun` | execution / orchestration state | one concrete attempt at a task |

`Task` and `Requirement` are linked explicitly and **many-to-many**
(`task_requirement`): one task can deliver several requirements, and one
requirement can need several tasks, so neither side can be a column on the
other. Linkage is never inferred — matching a task title against a requirement
key would be an unverifiable heuristic — and a link may never cross a project
boundary.

Verified requirements therefore do **not** complete a task automatically. The
inference is unsound in both directions, and implementation frequently finishes
before governance verification. Reconciliation surfaces the mismatch and an
operator decides.

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

## Current model and future vertical generalization

The implemented model is deliberately software-development-first. `Project`
currently means the AI Office project aggregate and is coupled to repository
import, portable repository identity, software governance records, and coding
client integration in several current use cases. It is not silently redefined as
a generic `Matter`, `Case`, or `Workspace`.

The long-term product direction may generalize professional work above or beside
that aggregate, but such a change must preserve current project identity,
portable snapshots, task lifecycle semantics, capability boundaries, and audit
history. A documentation analogy such as `Project -> legal matter` is therefore
useful for product exploration but is not an implemented schema alias.

The reusable core is expected to remain centered on semantics that are already
domain-independent or can become so without losing authority:

```text
organization / roles
        |
work container
        |
tasks / obligations / requirements
        |
pipeline and stage runs
        |
sources -> evidence / claims -> artifacts
        |
reviews / approvals
        |
controlled actions
        |
audit / provenance
```

Verticals may define stronger vocabulary and structured records around these
concepts. For example, software development may add repositories, ADRs, code
review findings, branches and pull requests; a future legal vertical may add
matters, parties, facts, source documents, legal issues, deadlines, citations
and filing artifacts. These additions must not create parallel orchestration,
authorization, approval, or audit engines.

In particular, a future evidence/claim model must distinguish a model-generated
assertion from verified source evidence. Confidence is metadata, never
authority. Source location, revision, extraction provenance, producing run, and
review/approval state must remain separately inspectable when a vertical relies
on them.

See [Professional-work verticals](../development/professional-work-verticals.md)
and roadmap M15.
