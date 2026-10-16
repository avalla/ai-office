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
2. Expose it as `delivery:next` (the gates the recorded state requires, never
   labelled effective; see invariant 3), `delivery:record` (record a gate
   result with evidence) and an explicit creation command that opens a run
   (input contract in invariant 5). The skill uses them when a Runtime is
   available.
3. Keep the skill usable without a Runtime. Without one, the skill keeps the
   file handoff packet of
   [step 1 of the task-delivery profiles plan](../development/task-delivery-profiles.md)
   and the same gate semantics.
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
  is settled by invariants 1 and 2 below.
- The CLI never falls back to an embedded writer. The `delivery:validate` of
  [step 1 of the task-delivery profiles plan](../development/task-delivery-profiles.md) is a Runtime-routed read that adds no offline path; that is an owner decision and an existing `AGENTS.md` invariant, not a consequence of this ADR, and it stands if this ADR is rejected.
- Any caller-local path argument is resolved by the CLI against its own working directory and sent as an absolute path, as `AGENTS.md` already requires; the Runtime rejects relative paths and never infers the caller's working directory.

## Owner decisions on the open questions (2026-10-15)

The owner agreed to the following answers. The ADR itself remains Proposed
until it is explicitly accepted.

- **Aggregate.** A delivery run is a new aggregate with an optional reference
  to a pipeline run. It does not extend a task or a pipeline run: extending the
  pipeline run would bind the portable workflow to enforced pipelines (the
  rejected alternative above), and a task is not the right owner of gate
  results. The reference is provenance only; drift between the two records is
  prevented by invariants 1 and 2 below.
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
  M19-T4). It holds checkpoint, handoff and similar settings, not the delivery
  profile or the gate selection, which live in the caller-local
  `.task-delivery.yaml` that `delivery:validate` consumes.
- Checkpoints are stored in a local file store with atomic, immutable
  publication (M19-T2). Per point 3 above the skill keeps working without a
  Runtime, so that store stays as the offline path.

## Proposed answers to the remaining questions

These are proposed answers, pending the owner's acceptance of the ADR. They
were reviewed independently before being proposed, which is not an approval.

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
failure is a typed error at the application boundary. Errors carry no foreign
run identifiers, no paths beyond what the caller supplied, and no stack traces.

1. **A linked pipeline run must belong to the same project and task.**
   - A delivery run belongs to a project and a task. At creation the service
     verifies that the task exists in that project; otherwise it fails with the
     not-found error below.
   - A pipeline run reference is accepted only when the pipeline run's project
     and task both equal the delivery run's. The application service validates
     this wherever a reference is set; a foreign key to the run identifier alone
     cannot enforce ownership and is only a backstop, as the cross-project rule
     in `AGENTS.md` requires.
   - The reference may be set at creation or once afterwards. A second set is a
     typed conflict and the reference is never repointed.
   - Failure modes: a pipeline run of another task or project, or one that does
     not exist, is rejected with the same typed not-found error, so a caller
     cannot probe another project's runs. The ownership check reads only the
     pipeline run's project and task; on failure nothing is linked and no
     pipeline state is returned.
2. **Delivery gates and pipeline stages are independent.**
   - Delivery gates come from the delivery catalog. Pipeline stage identifiers
     are open strings declared by the office manifest. The ADR defines no mapping
     between them and a consumer must not infer one by name.
   - The link is provenance only. `delivery:next` reports delivery gates from
     the delivery run's own records and, separately, the stage state of the
     linked pipeline run read from the pipeline. Neither is copied into the
     other, and neither marks the other passed.
   - Whether an enforced pipeline governs the task is determined independently
     of the link. `delivery:next` reports it, and says so when the linked run
     is not the governing one or when no run is linked. It never reports
     readiness without that check.
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
     moment: its schema version, the resolved profile and each selected gate
     with its form (full or reduced, review rounds, independence), not only a
     profile name. Later setup changes never alter the run; adopting them needs
     a new run.
   - The floor is not part of the snapshot and does not constrain setup: it
     applies on top of whatever is configured and depends on the task, the diff
     and the head commit, which the commands do not receive. The skill
     evaluates it where the profiles design says (at preflight, before
     `implementation` ends, before `ready_for_merge`, and when a new commit can
     change the classification) and it only moves up.
   - The effective gate set is the snapshot's selected gates plus the floor
     additions. The run records each floor addition, with its trigger and the
     head it was determined on, as an append-only entry. An addition may add a
     gate or raise the form of an already selected one (for example reduced to
     full), and is recorded as such. The recorded set never shrinks within a
     run: a later head that no longer triggers the floor does not remove it. A
     gate that ran in a reduced form and was then raised is run again in its
     full form, and the reduced evidence does not cover it.
   - `delivery:next` reports the snapshot plus the recorded floor additions,
     is never labelled effective, and states that unrecorded additions may
     exist. It does not evaluate the floor itself.
   - A floor addition is made durable in the file store as a pending entry
     before the skill acts on it, and only then registered on the run. The
     entry carries the identity (delivery run, gate, target form, trigger and
     head) and the content the Runtime needs. Registering the same identity
     with the same content again is harmless; the same identity with different
     content is an explicit conflict, never an overwrite. The entry is cleared
     only after a successful registration, and it survives restarts.
   - A reset or handoff carries the pending floor additions: the handoff packet
     references them machine-readably, and the next context reads them from the
     file store, so a failed registration cannot make a required full-form
     gate be forgotten. If a floor evaluation is due and the addition is neither
     registered nor durably pending, the skill does not leave that stage.
   - Failure modes: if registration fails, the pending entry stays and is
     reconciled later in recording order; a missing registration never means
     the floor does not apply, and `delivery:next` says so. As with
     checkpoints, this applies only to a task with a Runtime delivery run; the
     offline path keeps the existing handoff packet rules. An authorizer's
     attempt to lower the effective gate set below the recorded or pending
     floor additions is refused, as the profiles design requires; setup
     configuration itself is not refused.
4. **Checkpoint registration is idempotent, conflict-explicit and pinned until
   registered.**
   - A registration names an opaque, client-claimed identity: the delivery run,
     the task directory key, the checkpoint sequence number and checkpoint
     identifier, together with the SHA-256 of the published bytes. The Runtime
     stores it and never dereferences it, so no client-local path is sent.
   - The file publication and `delivery:record` cannot share a transaction, so
     the order is: make the pending marker durable, publish the immutable
     checkpoint atomically to the file store, then register the checkpoint.
   - Registering the same identity with the same hash again is harmless. An
     identity already registered with a different hash is an explicit conflict,
     never an overwrite.
   - Pending applies only to checkpoints published for a Runtime delivery run;
     the marker names that run. A checkpoint published with no delivery run,
     including every checkpoint of the offline path, keeps the existing
     retention rules unchanged.
   - The marker is durable in the file store and is made durable before, or
     atomically with, the publication that makes the checkpoint visible to
     pruning, and it survives process restarts. Retention pruning never deletes
     a pending checkpoint, in addition to the latest and the handoff-cited ones
     it already keeps. Without that ordering a crash between publication and
     marking would leave an unregistered checkpoint prunable. The marker is
     cleared only after a successful registration or an explicit idempotent
     reconciliation.
   - Reconciliation registers pending checkpoints in publication order. A
     conflict stops reconciliation at that checkpoint, keeps it and the later
     ones pending, and is reported.
   - Resume validates the file, hash, version and association to the run. A
     missing or invalid checkpoint makes resume from it fail explicitly; the
     system does not silently fall back to a possibly inconsistent state.
   - Failure modes: during a Runtime outage or repeated registration failures,
     pending checkpoints accumulate beyond the retention cap rather than being
     pruned, and the skill reports the pending count when it is non-zero. A
     registered checkpoint whose file was pruned under the existing retention
     rules stays on the run but is reported as unavailable, never as a
     candidate. Capping the pending set, if ever needed, is a separate explicit
     decision that must never delete an unregistered checkpoint silently.

5. **Creation takes the resolved configuration from the client and never reads
   caller-local files.**
   - The profile and the gate selection are not held by `delivery:setup:*`.
     The client resolves each key in the skill's existing order (Runtime setup
     where it holds the key, then `.task-delivery.yaml`, then defaults) and
     validates the result with the rules `delivery:validate` applies.
   - The creation command takes the project, the task, the resolved
     configuration as structured data (schema version, profile, and each
     selected gate with its form), and optionally the pipeline run reference of
     invariant 1. It carries no path.
   - The Runtime re-validates the data against the schema and the cross-key
     rules (for example, the accepted stage keys, and that `review` and `qa`
     are not both off without an external review command). It never reads
     `.task-delivery.yaml` or any caller-local file for creation and never
     infers the caller's working directory, as `AGENTS.md` requires.
   - The snapshot is recorded as claimed by the client, with its schema version
     and a hash of its canonical form, and is not verified against the
     repository, consistent with the head-commit decision above.
   - Failure modes: invalid or unsupported configuration fails with a typed
     validation error and no run is created; a task that is not in the project
     fails as in invariant 1.

## Known limitations

- The file store is local. Losing it loses the checkpoints it held, and resume on
  another host without the original files is not supported. Cross-machine
  portability would need shared or replicated checkpoint storage, which is a
  separate decision and outside this ADR.
- Pending checkpoints are not bounded in this proposal, so a long outage grows
  the local store. This is preferred to losing an unregistered checkpoint.

## Open questions

None remain in this proposal. The ADR stays Proposed until explicitly accepted.
