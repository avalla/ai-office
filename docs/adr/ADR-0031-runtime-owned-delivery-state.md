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
  results. The reference is provenance only; the relation is bounded by
  invariants 1 and 2 below, so the two records cannot drift.
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

## Proposed answers to the remaining questions

These two questions were put to an independent reviewer and are marked resolved
in this proposal. Accepting the ADR accepts them.

- **Setup storage.** The delivery run is a separate aggregate with its own
  persistence and repository port, beside `delivery:setup:*`; it does not extend
  the key-value JSON storage. Setup is mutable configuration resolved by scope;
  a run is a history with identity, transitions and evidence references that
  needs explicit constraints. A forward-only migration introduces it without
  changing `0050_task_delivery_setup`. At creation the run fixes an immutable
  snapshot of the configuration (invariant 3).
- **Checkpoint store.** The delivery run complements the file-based checkpoint
  store and does not replace it. The file store remains the source of truth for
  a checkpoint's content, validity and resume; the delivery run is the Runtime
  register of the reference, its hash, and its association with the run, gate
  and head commit. The delivery run can name a candidate checkpoint but cannot
  declare it valid for resume, and a checkpoint's existence never implies that a
  gate passed or is authorized. Registration follows the protocol in invariant
  4.

## Invariants and failure modes

These are constraints on a future implementation, not an implementation. Each
failure is a typed error at the application boundary.

1. **A linked pipeline run must belong to the same project and task.**
   - A delivery run has a project and a task from creation. A pipeline run
     reference is accepted only when the pipeline run's project and task both
     equal the delivery run's. The application service validates this at
     creation and in every command that supplies or changes the reference; a
     foreign key to the run identifier alone cannot enforce ownership and is
     only a backstop, as the cross-project rule in `AGENTS.md` requires.
   - The reference is set at most once and is never repointed.
   - Failure modes: a pipeline run of another task or project, or one that does
     not exist, is rejected with the same typed not-found error, so a caller
     cannot probe another project's runs; nothing is linked and no pipeline
     state is read.
2. **Delivery gates and pipeline stages are independent.**
   - Delivery gates come from the delivery catalog. Pipeline stage identifiers
     are open strings declared by the office manifest. The ADR defines no mapping
     between them and a consumer must not infer one by name.
   - The link is provenance only. `delivery:next` reports delivery gates from
     the delivery run's own records and, separately, the stage state of the
     linked pipeline run read from the pipeline. Neither is copied into the
     other, and neither marks the other passed.
   - Readiness stays the conjunction already defined in
     [task-delivery profiles](../development/task-delivery-profiles.md): the
     selected and floor-required gates, a required external review, and the
     stages of an enforced pipeline, which stay authoritative whatever the
     profile selects.
   - Failure modes: a linked pipeline run that is absent, terminal or in an
     ambiguous state is reported as such next to the delivery gates and never
     turned into a delivery gate result. A future mapping needs its own ADR with
     a pinned, versioned mapping.
3. **The configuration snapshot is immutable and the floor is dynamic.**
   - At creation the run fixes the configuration effectively resolved at that
     moment: its schema version, the resolved profile and the selected gates,
     not only a profile name. Later setup changes never alter the run; adopting
     them needs a new run.
   - The floor is not part of the snapshot. It depends on the task, the diff
     and the head commit, which the command does not receive, so the skill
     evaluates it where the profiles design says (at preflight, before
     `implementation` ends, before `ready_for_merge`, and when a new commit can
     change the classification) and it only moves up.
   - The effective gate set is the snapshot's selected gates plus the gates the
     floor made required. The run records each floor-required gate, with its
     trigger and the head it was determined on, as an append-only addition. The
     recorded set never shrinks within a run: a later head that no longer
     triggers the floor does not remove it. A floor-required gate that ran in a
     reduced form is run again in its full form, and the reduced evidence does
     not cover it.
   - Failure modes: if recording a floor addition fails, the skill still applies
     the floor locally and the record is reconciled later; a missing record
     never means the floor does not apply. `delivery:next` states that it does
     not evaluate the floor itself, and a setup lowered below the computed floor
     is refused, as the profiles design already requires.
4. **Checkpoint registration is idempotent, conflict-explicit and pinned until
   registered.**
   - The file publication and `delivery:record` cannot share a transaction, so
     the order is: publish the immutable checkpoint atomically to the file
     store, then register its reference and hash on the delivery run.
   - Registering the same checkpoint with the same hash again is harmless. A
     reference already registered with a different hash is an explicit conflict,
     never an overwrite.
   - A published checkpoint whose registration has not succeeded is pending.
     The file store keeps a durable pending marker next to it. Retention pruning
     never deletes a pending checkpoint, in addition to the latest and the
     handoff-cited ones it already keeps. The marker is cleared only after a
     successful registration or an explicit idempotent reconciliation, and it
     survives process restarts.
   - Reconciliation registers pending checkpoints in publication order, and
     resume validates the file, hash, version and association to the run. A
     missing or invalid checkpoint makes resume from it fail explicitly; the
     system does not silently fall back to a possibly inconsistent state.
   - Failure modes: during a Runtime outage or repeated registration failures,
     pending checkpoints accumulate beyond the retention cap rather than being
     pruned. The skill reports the pending count when it is non-zero. Pruning of
     a registered checkpoint follows the existing retention rules only.
     Capping the pending set, if ever needed, is a separate explicit decision
     that must never delete an unregistered checkpoint silently.

## Known limitations

- The file store is local. Losing it loses the checkpoints it held, and resume on
  another host without the original files is not supported. Cross-machine
  portability would need shared or replicated checkpoint storage, which is a
  separate decision and outside this ADR.
- Pending checkpoints are not bounded in this proposal, so a long outage grows
  the local store. This is preferred to losing an unregistered checkpoint.

## Open questions

None remain in this proposal. The ADR stays Proposed until explicitly accepted.
