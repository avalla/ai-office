# ADR-0013: Intersect pipeline constraints with action authorization

Status: accepted

## Context

Office manifests already described roles and ordered task pipelines, but agents
could ignore the generated Markdown because no authoritative stage state
participated in protected-action authorization. Capability grants and connector
policy are deny by default and already own positive authority.

## Decision

An explicitly enforced pipeline run pins one immutable manifest revision and
persists task-bound stage state, assignments, gates, transitions, and overrides.
The application authorization service intersects the current pipeline decision
with the existing capability-policy decision at action request time and during
execution-time revalidation.

Stage capability declarations only narrow ordinary grants. They never create a
grant or bypass connector policy. With no active enforced run, existing action
behavior is unchanged. Markdown remains a deterministic explanatory projection,
not an authorization input.

Pipeline administration receives an operator principal established by the
owner-facing local CLI/daemon boundary. Caller-provided actor text is retained
only as optional audit metadata. Agent stage completion and controlled actions
receive provenance from a persisted AgentRun, which binds the project, task,
agent, and pipeline; a caller-selected pipeline run cannot replace that
binding. This is an application authority boundary within the trusted-local
single-user model, not cryptographic human authentication.

Workflow approval remains a stage-transition decision. Controlled-action
approval remains bound to one exact simulation and side effect; neither is
reused as the other. Separation of duty is configured on assignments and
approval gates rather than imposed on every pipeline. Overrides require an
operator actor and reason, are persisted immutably, and are audited. They can
advance a workflow gate but cannot override a base capability denial.

## Consequences

- Ignoring `AI-OFFICE.md` cannot bypass an active enforced run.
- Action requests carry pipeline run/stage provenance and become stale when the
  stage changes, the run ends, or assignment/approval state no longer permits
  the operation.
- Existing manifests remain guidance-only unless enforcement is explicit.
- The first engine is sequential; generalized workflow execution remains future
  M11 work.
