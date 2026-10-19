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
   (input contract in invariant 5). The skill uses them for a task whose
   delivery run was created at preflight.
3. Keep the skill usable without a Runtime. For a task on the offline path (no delivery run, no creation-pending marker and no creation stop),
   the skill keeps the file handoff packet of
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
  `.task-delivery.yaml`. The skill reads it today
  (`scripts/skills/task-delivery-config.ts`) and the planned
  `delivery:validate` (not implemented) is to validate it.
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
  snapshot of the profile and gate configuration (invariant 3). The
  `delivery:setup:*` keys are not part of that snapshot and keep resolving live.
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
     profile name. It also records whether an external review command is
     configured, as a presence flag and not its text. Later changes to
     `.task-delivery.yaml` or to the resolved profile never alter the run;
     adopting them is outside this ADR. An external review requested by an
     authorizer is a dynamic addition, recorded like a floor addition.
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
   - A floor addition is made durable in the file store before the skill acts
     on it, and only then registered on the run. It is identified by the
     delivery run, gate, target form, trigger and head, and that identity is its
     whole content, so registering it again is harmless and there is no
     conflicting content. Entries are append-only and survive restarts: a
     successful registration marks an entry registered and never deletes it, so
     a later context can still read every addition while the Runtime is
     unreachable. An entry not yet marked registered is pending.
   - A reset or handoff carries the floor additions: the handoff packet lists
     each pending entry, and any creation-pending marker, by its identity in a
     fixed, validated field, encoded so
     that listing floor entries never pins or unpins a checkpoint under the
     retention rule that matches checkpoint identifiers in the packet, and the
     next context reads the entries from the file store. A failed
     registration therefore cannot make a required full-form gate be
     forgotten. If a floor evaluation is due and the addition is neither
     registered nor durably pending, the skill does not start or pass any
     further gate.
   - Failure modes: if registration fails, the entry stays pending and is
     reconciled later in recording order; a missing registration never means
     the floor does not apply, and `delivery:next` says so. An authorizer's
     attempt to lower the effective gate set below the recorded or pending
     additions is refused by the skill, and no command removes or rewrites a
     recorded addition; setup configuration itself is not refused.
   - Runtime path. A delivery run is created at the start of preflight, before
     its floor evaluation and before the first checkpoint, and a task has at
     most one delivery run, which ends in a terminal state; restarting a task's
     delivery is outside this ADR. Once the run exists the task stays on the
     Runtime path: an outage leaves entries pending and never switches the task
     to offline rules. Before sending a creation request the skill makes a
     creation-pending marker durable in the file store. The marker holds the
     canonical complete creation payload of invariant 5 (project, task, the
     resolved configuration and its snapshot hash, and the pipeline run
     reference or its absence), not only a flag, so that the request can be
     replayed exactly after a restart whatever the configuration or the
     pipeline link has become since. It also records the identity of the
     Runtime the request was addressed to (a stable identity, defined in the
     implementation plan), which is not part of the idempotency key. A retry
     is sent only to a Runtime with that identity, and an answer from any
     other Runtime is refused and keeps the marker: a replacement Runtime that
     lacks the original creation must not resolve the old authority's marker
     (a change of Runtime is a separate rebind decision, see Question A).
     - If the Runtime is confirmed unreachable and no request was sent, the
       marker is cleared, the task proceeds on the offline path for its whole
       life, and the skill reports it.
     - A typed rejection of the request (validation, not found, which
       includes ownership failures per invariant 1, or conflict) is a stop
       condition: the skill first writes a durable creation-stop record (marker
       identity, payload hash and rejection type) and only then clears the
       marker, so a restart or a handoff still finds the stop and the task does
       not proceed offline. The stop record is listed in the handoff packet like
       the marker. For validation and not found, the input is corrected and
       creation is retried. A conflict at creation or at the retry is a dead
       end in this proposal: a task has one run, a corrected payload conflicts
       again, and restarting delivery is outside this ADR. The task stops
       there (see Known limitations and Open questions).
     - If the outcome is uncertain (the request may have committed, the reply
       was lost, or the skill exited), the marker stays. The skill publishes no
       checkpoint and passes no gate, offline or otherwise, until an
       idempotent retry (invariant 5) shows whether a run exists. The retry
       replays exactly the payload stored in the marker and never one
       recomputed from the current configuration or pipeline link; only its
       answer clears the marker. If the Runtime is still unreachable, the
       marker stays and the task neither proceeds offline nor creates a run;
       no command abandons a marker in this proposal (see Known limitations
       and Open questions).

     A task on the offline path (no delivery run, no creation-pending marker and no creation stop) keeps the existing offline rules unchanged.
     This ADR does not migrate a task already under way offline onto a
     Runtime run, because the offline handoff packet records no floor
     determinations to inherit; such a migration is a separate decision.
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
     cleared only after a successful registration, including an idempotent
     re-registration during reconciliation, and never otherwise.
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
   - "Client" here means the skill acting through the CLI; the CLI only
     resolves paths and relays structured data, and the obligations on local
     state below are the skill's.
   - The creation command takes the project, the task, the resolved
     configuration as structured data (schema version, profile, each selected
     gate with its form, and whether an external review command is
     configured), and optionally the pipeline run reference of invariant 1. It
     carries no path and no floor additions: a run is created at preflight,
     before any exist (invariant 3), and the first determinations are recorded
     afterwards through the normal path. Its name is left to the
     implementation plan; this contract is what binds.
   - The skill creates a run only at preflight. It does not create one for a
     task that already has checkpoints, floor determinations or a handoff
     packet, and reports why. Replaying an existing creation-pending marker and
     retrying creation after a recoverable creation stop (validation or not
     found, once the input is corrected) are not creations for this rule, even
     though the handoff packet lists that marker or stop record. A conflict
     stop is not recoverable by retry (Question B).
     The Runtime cannot read that local state, so it
     cannot enforce this; like the snapshot, it is a client obligation.
   - The Runtime re-validates the data against the schema and the cross-key
     rules (for example, the accepted stage keys, and that `review` and `qa`
     are not both off without an external review command). It never reads
     `.task-delivery.yaml` or any caller-local file for creation and never
     infers the caller's working directory, as `AGENTS.md` requires.
   - The snapshot is recorded as claimed by the client, with its schema version
     and a hash of its canonical form (a specified canonical encoding, so the
     hash is comparable across clients), and is not verified against the
     repository, consistent with the head-commit decision above.
   - Failure modes: invalid or unsupported configuration fails with a typed
     validation error and no run is created; a task that is not in the project
     fails as in invariant 1. Creation is idempotent on the complete creation
     payload (project, task, snapshot hash and pipeline run reference, or its
     absence): the same payload returns the existing run, so a retry after a
     lost reply is safe, and any different payload for a task that already has
     a run is a typed conflict. A pipeline run reference is validated as in
     invariant 1 whenever it is supplied, and is never added through a creation
     retry. The comparison is against the immutable creation payload recorded with the run, not the run's current pipeline link, so an exact replay of a stored marker still returns the run after a reference was set later. An exact match returns the existing run before the payload is re-validated, so a stricter later validation cannot turn a replay into a dead end.

## Known limitations

- The file store is local. Losing it loses the checkpoints it held and the floor
  entries not yet registered, and resume on
  another host without the original files is not supported. Cross-machine
  portability would need shared or replicated checkpoint storage, which is a
  separate decision and outside this ADR.
- Pending checkpoints are not bounded in this proposal, so a long outage grows
  the local store. This is preferred to losing an unregistered checkpoint.
- A task has one delivery run, created at preflight, which ends in a terminal
  state. A task already under way offline is not migrated onto a Runtime run, a
  changed configuration is not adopted mid-task, and restarting a task's
  delivery is not covered; each needs a separate decision, because the offline
  handoff packet records no floor determinations to inherit.
- A creation-pending marker stays until an idempotent retry is answered. If the
  Runtime never becomes reachable again, the skill cannot prove that no request
  was sent, so the task stays blocked: it neither proceeds offline nor creates
  a run. No abandon step exists in this proposal.
- A creation conflict (the task already has a run and the payload differs) is
  a dead end for the skill: it cannot adopt the existing run, correct the
  payload, or restart delivery. The task stops.

## Open questions

The ADR stays Proposed until explicitly accepted. Two questions are open for
the owner; neither is decided here. Each is presented with the constraints any
answer must meet and a recommendation, so the owner can decide without further
design work. Neither blocks the rest of the ADR, and neither adds a command in
this ADR.

### Question A: abandoning a creation-pending marker

What the proposal documents today: an uncertain creation outcome keeps the
marker; the skill passes no gate, offline or otherwise, until an idempotent
retry of the stored canonical payload is answered by the Runtime; no command
abandons a marker.

Constraint. A human approval does not prove that no delivery run exists: the
request may have committed and the reply been lost. An abandon that clears the
marker on approval alone would turn an uncertain outcome into an offline path
for a task that may already have a Runtime run, and the two records would then
diverge. So an abandon must never be a local approval that clears the marker and
releases the offline rules.

Recommended answer: no abandon command. The marker is resolved only by a
Runtime answer, and a Runtime that is permanently lost is an authority change,
decided separately.

- **Reachable Runtime.** The idempotent retry already resolves the marker, with
  no new command. Its answer is one of: a run exists for the task with the same
  payload (the marker is cleared and the run is used); a run exists with a
  different payload (typed conflict, Question B); or no run exists (the stored
  payload creates it). The retry replays the stored payload exactly, so it is
  idempotent and safe to repeat after any timeout, lost reply or restart.
- **Runtime unreachable for a long time.** The task stays blocked. This is the
  cost of not guessing, and the skill reports it with the marker identity.
- **Runtime replaced or lost for good.** This is a change of the authority the
  task is bound to, not a marker operation. A new Runtime cannot know whether
  the old one held a run, so it cannot answer for it. It needs its own decision
  (a rebind of the task to a Runtime, recorded and approved) and is not part of
  this ADR. Until then the marker stays.

If the owner nevertheless wants an abandon step, it must satisfy all of these,
and anything less is refused:

1. It is a Runtime operation, not a file-store edit. The Runtime must be
   reachable and must answer that no delivery run exists for (project, task);
   that answer, bound to the marker's payload hash, is the only thing that
   permits clearing. An approval is required in addition, never instead.
2. It is idempotent: the same abandon, identified by the marker identity and
   payload hash, returns the same result however often it is sent, and abandoning
   an already-resolved marker is a typed no-op that reveals no other state.
3. It is audited: the audit record carries the marker identity, payload hash,
   the Runtime answer, the approver and the time, and is written in the same
   transaction as any Runtime state change it causes.
4. It is authority-checked: the caller must hold a project-scoped authorization (none exists today and it is to be defined) for
   that project; a run, task or marker of another project answers like a missing
   one.
5. It never opens the offline path. After an abandon the task either creates its
   run through the Runtime or stays blocked; it does not proceed on offline
   rules.
6. It cannot race a late creation: the Runtime refuses a later creation request
   carrying an abandoned marker's payload hash unless the skill issues a fresh
   marker, so a delayed or duplicated original request cannot create a run after
   the abandon. The Runtime does not see markers today, so this needs a request
   nonce that changes the idempotency key of invariant 5; that consequence is
   part of the cost of any abandon step.

With a reachable Runtime these conditions reduce to the idempotent retry, which
is why no separate command is recommended.

### Question B: a creation conflict that names the existing run

What the proposal documents today: a different payload for a task that already
has a run is a typed conflict and a dead end; the skill cannot adopt the run.

Constraint. The Runtime looks the run up by (project, task), so a run it finds
always belongs to the same project and task as the request; it never names or
hints at a run of another project, and a task outside the project still answers
as not found (invariant 1). Adoption is a different matter from disclosure: a
run created under another configuration may hold a lower gate floor, a
different snapshot or a terminal state, and the skill must not silently adopt
it.

Recommended answer: the conflict reply identifies the existing run, read-only;
adoption is a separate explicit step, never automatic.

- The typed conflict carries the existing run's identifier, its state, its
  recorded snapshot schema version and hash, its recorded gate set and its
  pipeline run reference or absence, and nothing about any other run or
  project. It is returned only after the Runtime has verified that the run
  belongs to the requested project and task.
- The skill treats the reply as information, not as authority. This amends
  invariant 3: a conflict keeps the marker as a blocking stop until adoption or
  an owner decision, instead of clearing it. The skill does not retry with the
  existing run's values on its own and does not continue the task.
- Adoption, if the owner wants it, is a second explicit operation that the
  operator approves for that run and marker. The Runtime accepts it only when
  the run is not terminal, its recorded gate set is at least the gate set
  required by the marker's stored payload (an adoption never lowers the gate
  floor or the recorded floor additions), its pipeline run reference is
  compatible with the stored payload, and the stored snapshot differs only in
  fields the contract allows to differ. It is idempotent on the run and marker
  identity, audited like Question A, and refused with a typed conflict
  otherwise. The existing run is never edited to match the payload.
- A terminal run, or an incompatible one, stays a dead end for that task, as
  today; restarting delivery remains outside this ADR.

### Consequences of the recommended answers

No new abandon command and one richer typed reply. The marker rules stay as
specified, except that under Question B a conflict keeps the marker (an
amendment to invariant 3 that applies only if B is accepted). The
idempotent retry stay as specified. A permanently lost Runtime and adoption
remain separate decisions, so accepting this ADR does not commit the project to
either.
