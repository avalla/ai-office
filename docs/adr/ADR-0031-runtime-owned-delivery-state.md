# ADR-0031: Runtime-owned delivery state for task delivery

- Status: Proposed
- Date: 2026-10-07
- Scope: task-delivery profiles, handoff, and delivery state

## Context

The `task-delivery` skill coordinates a gated lifecycle (preflight through
post-merge). Its state, which gates passed on which head commit with which
evidence, lives only in the executor's context and in prose reports. A reset
or a new session loses it, evidence cannot be audited, and the handoff is
written by hand.

The Runtime already owns task state (`task:*`), pipeline definitions with
guidance and enforced modes
([ADR-0013](ADR-0013-pipeline-constraints-intersect-action-authorization.md)),
audit, and durable queues. The skill's gates and the Runtime's pipeline stages
are two descriptions of one process and are only related by a prose mapping.

The skill is also deliberately independent of the Runtime
([ADR-0012](ADR-0012-shared-project-guide-and-repository-skills.md) concerns
the separate `ai-office` skill; `skills/README.md` states the independence of
`task-delivery`).

## Decision (proposed)

1. Add a delivery run as Runtime-owned, non-authoritative-for-security state:
   profile, selected gates, per-gate result, and evidence references bound to
   a head commit, recorded through application commands behind the existing
   Runtime IPC. It records and reports; it authorizes nothing. Merge,
   approvals, and controlled actions keep their existing authority.
2. Expose it as `delivery:next` (what the profile requires now, derived from
   the recorded state) and `delivery:record` (record a gate result with
   evidence). The skill uses them when a Runtime is available.
3. Keep the skill usable without a Runtime. Without one, the skill keeps the
   file handoff packet of step 1 and the same gate semantics.
4. A delivery profile selects gates; it does not replace an enforced
   pipeline. When an enforced pipeline governs the task, the pipeline remains
   authoritative and the delivery run is subordinate evidence.

## Alternatives considered

- **Keep everything in the skill and files.** No architectural change, but no
  audit, no cross-session truth, and the handoff stays a convention.
- **Model gates as an enforced pipeline.** One source of truth, but it binds
  runs to assigned performers and ties a portable workflow to the Runtime.
- **Store state in Git (a tracked file).** Portable and reviewable, but it
  pollutes diffs and invalidates the head-bound evidence it records.

## Consequences

- A persistence change: a forward SQL migration, fresh and upgrade tests, and
  an application service and port.
- Daemon and CLI end-to-end coverage through the Unix-socket protocol.
- Two run records (pipeline run and delivery run) must not drift; the relation
  and any deduplication must be settled before implementation.
- The CLI never falls back to an embedded writer. Step 1's `delivery:validate` is a Runtime-routed read that adds no offline path; that is an owner decision and an existing `AGENTS.md` invariant, not a consequence of this ADR, and it stands if this ADR is rejected.
- Any caller-local path argument is resolved by the CLI against its own working directory and sent as an absolute path, as `AGENTS.md` already requires; the Runtime rejects relative paths and never infers the caller's working directory.

## Owner decisions on the open questions (2026-10-15)

The owner agreed to the following answers. The ADR itself remains Proposed
until it is explicitly accepted.

- **Aggregate.** A delivery run is a new aggregate with an optional reference
  to a pipeline run. It does not extend a task or a pipeline run: extending the
  pipeline run would bind the portable workflow to enforced pipelines (the
  rejected alternative above), and a task is not the right owner of gate
  results. When a delivery run is linked to a pipeline run, its gate state is
  read from the pipeline instead of copied, so the two records cannot drift.
- **Evidence.** Only a reference and a content hash are stored, never the
  evidence itself, consistent with the gate evidence references of the
  file-based checkpoints.
- **Head commit.** `delivery:record` does not reject a head commit the Runtime
  cannot see. The Runtime does not infer client-local repository context, and
  recording authorizes nothing. It validates the commit identifier format and
  records the head as claimed by the client, not verified.

## Relation to existing delivery state

Two pieces of delivery state already exist and predate this decision:

- Task-delivery setup is stored by the Runtime (migration
  `0050_task_delivery_setup`, `delivery:setup:show` and `delivery:setup:set`;
  M19-T4).
- Checkpoints are stored in a local file store with atomic, immutable
  publication (M19-T2). Per point 3 above the skill keeps working without a
  Runtime, so that store stays as the offline path.

## Open questions

- Does the delivery run extend the existing `delivery:setup:*` storage or sit
  beside it as a separate aggregate?
- When a Runtime is available, does the delivery run replace the file-based
  checkpoint store or complement it (for example, a checkpoint is published
  to the file store and its reference is recorded on the delivery run)?
