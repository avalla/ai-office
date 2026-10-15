# Pipeline enforcement

Office manifests may describe guidance-only or enforced pipelines. Omitted
`enforcement` means `guidance`; historical manifests and generated guidance do
not silently become runtime policy. An enforced pipeline becomes authoritative
only after an operator starts a run for an existing task.

Each enforced stage declares capability operation names. The effective action
decision is the intersection of base policy/grants and the active stage: a
pipeline can restrict an agent, but cannot grant missing authority. Agent
actions derive their pipeline context from the persisted `AgentRun`, including
its project, task, agent, and assigned stage; a caller-supplied run identifier
cannot replace that provenance. Direct operator actions are intentionally
outside an AgentRun and do not infer enforcement from unrelated task runs.
Authorization is evaluated at request time and again before connector
invocation or mutation execution.

The runtime pins the office-manifest revision and pipeline definition. It
persists the current and completed stages, task binding, assigned registered
agent, role requirement, approval state, and timestamps. Assignment checks the
runtime role key against the stage role and applies `requiresDifferentAgentFrom`
to stable agent identities. A stage advances only through an explicit runtime
completion event. Approval stages wait for an operator decision;
`requiresIndependentApproval` prevents the assigned stage agent from deciding
that gate when configured.

Use `ai-office pipeline:start`, `ai-office pipeline:status`,
`ai-office pipeline:assign`, `ai-office pipeline:transition`, and
`ai-office pipeline:override`; `ai-office --help` is the syntax authority.
Project `status` distinguishes guidance-only configuration,
enforcement without a run, active runs, pending approval, missing assignment,
and a run pinned to an older manifest revision.

Overrides are not an untracked force flag. They require the application
operator principal and a non-empty reason, are persisted immutably, and are
audited. The legacy `--actor` option is retained only as an audit label;
changing it cannot grant authority within the application layer. An override
never creates a capability grant and cannot turn a base policy denial into
authority.

Pipeline stage approval and controlled-action approval have different binding
semantics. A stage approval authorizes one workflow transition. An action
approval remains bound to one exact simulated side effect and is still required
when its connector descriptor requires it. Neither substitutes for the other.

The future Artifact Review & Approval capability adds a third distinction:
artifact review evaluates one exact Artifact version/fingerprint, while stage
approval authorizes a pipeline transition and controlled-action approval
authorizes one exact side effect. A completed AgentRun or stage does not imply
that its Artifact is approved or that the Task is complete. The capability is
planned under M11.6 and must reuse these boundaries rather than introduce a
second approval authority.

Migrations `0020_pipeline_enforcement.sql` and
`0021_agent_action_provenance.sql` add the run, stage, override, and immutable
AgentRun/action-request binding state. Existing rows receive null bindings,
existing databases upgrade forward, and projects with no active enforced run
keep their previous authorization behavior.

The engine is intentionally sequential, with queue-backed stage orchestration
now available when `AI_OFFICE_QUEUE_PROVIDER=bullmq` is configured. SQLite remains
the authority: BullMQ delivers disposable wake-up jobs, and every worker reloads
and validates the project, pipeline, stage, assignment, run, model, and lease
before acting. The transactional outbox makes state changes and delivery intent
one commit. Duplicate delivery is harmless; stale or forged jobs do nothing.
Branching, typed artifacts, GitHub-specific gates, and cryptographic operator
identity remain deferred. Retryable delivery/provider failures are bounded;
ambiguous effects, stale fences, validation failures, and approval decisions are
not automatically retried.

AI Office is still trusted-local and single-user rather than cryptographically
authenticated. The local daemon cannot distinguish a same-user worker from the
operator, so operator administration is not strongly isolated in this release.
Worker-mediated actions and AgentRun transitions remain runtime-enforced.
Authenticated human presence, worker sandboxing, and remote multi-user identity
remain future hardening work.

## Provisional stage result contract (M11-1)

`@ai-office/domain/pipeline/stage-result.ts` defines a versioned, internal
envelope for the structured outcome of one stage attempt:
`version`, `outcome` (`succeeded` | `failed`), `summary`, `producer` (an
AgentRun id or an operator label), optional bounded canonical-JSON `data`, and
a typed `error` that is required exactly when the outcome is `failed`.
`assessStageResultDelivery` in the application layer classifies a delivery as
`accepted`, `duplicate` (same canonical result), `stale` (AgentRun no longer
bound to the stage) or `conflict` (a different result already recorded). It is
a pure decision: it never retries, overwrites or grants anything.

Limits: summary 2000 bytes, error message 500 bytes, data 16384 bytes,
identifiers 128 bytes. Unknown versions, unknown fields, sensitive field names
and control characters are rejected, and rejection messages never echo the
rejected value.

Compatibility is provisional: this is not a stable public schema and may change
with a new `version`. It is run evidence only and is not yet wired into the
AgentRun-to-stage completion path. Not in this contract: a persisted
Artifact/ArtifactVersion aggregate, review lifecycle, ReviewRequest/ReviewResult
or approval semantics (M11.6), and automated worker dispatch (M12). M11-2
consumes the envelope fields in conditions; M12 and M11.6 are the explicit
consumers of this contract.
