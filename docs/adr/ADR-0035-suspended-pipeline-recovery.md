# ADR-0035: Suspended pipeline recovery via durable orchestration replay

- Status: Accepted (owner authorized the design on 2026-10-15, before implementation)
- Date: 2026-10-15
- Scope: pipeline orchestration, review-ready prerequisite follow-up (RRD-01)

## Context

Since PR #147 (merge `64a93d6`), a prerequisite in `waiting_review` admits
dependent work, but completion stays stricter: a dependent pipeline's final
stage cannot close while any prerequisite is not `completed`. When the guard
refuses, the stage-completion transaction rolls back and leaves a durable
artifact: the agent run is `completed`, the stage and the pipeline run stay
`active`, and the task stays `running`.

Nothing deliberately resumed that artifact. The daemon's outbox replay —
designed as crash repair — matched suspended stages and re-ran
`pipeline:orchestrate` every dispatch interval, so each replay ended in the
typed `TaskPrerequisiteIncompleteError`, surfaced as a queue command failure,
and was retried a few times per second for as long as the suspension lasted.
When the prerequisites finally completed, the resume happened through that
same error path, with no audit record linking it to the completion that
enabled it.

## Decision (accepted)

1. Treat the suspended stage as a first-class waiting state, not an error.
   The replay of a stage whose prerequisites are still incomplete is a quiet
   no-op; the same holds for a replay that loses the race to another trigger.
2. Recover through one application service, `RecoverSuspendedPipelines`,
   which scans for exactly the suspended artifact (active run, active current
   stage, completed bound agent run) and resumes through the existing
   `completeStageFromAgentRun`. The resume therefore keeps the existing
   authority: the version check, the stage-binding revalidation, and — on
   PostgreSQL — the project graph-edit advisory lock taken by the guarded
   writes. Concurrent or repeated triggers lose with typed refusals instead
   of duplicate effects.
3. Trigger the same scan from every place the precondition can change or be
   re-observed: the orchestration replay (automatic and restart-safe), a
   recovery sweep at the end of `run:tick`, and a post-commit hook on
   `task:complete`. No new outbox job type: the durable
   `orchestrate_pipeline` intent already names the suspended stage.
4. Record provenance on the resume itself: a `pipeline.resumed` audit event,
   committed in the same transaction as the stage completion, carrying the
   trigger, the triggering task completion when there is one, and the
   prerequisite list read authoritatively inside the transaction.
5. Recovery never touches terminal pipelines or terminal tasks, never
   schedules new runs, and never forces a prerequisite: a regression between
   the scan and the write is refused again inside the resume transaction and
   the pipeline stays suspended.

## Alternatives considered

- Resume synchronously inside the completing transaction: rejected. It
  lengthens the completion transaction, can cascade dependent pipeline
  completions into one transaction, and conflicts with the short-transaction
  invariant.
- A dedicated `recover_pipeline` outbox job type: rejected. It duplicates the
  durable intent `orchestrate_pipeline` already carries, and would require
  queue, dispatch, and replayable-query changes in both storages for no new
  guarantee.
- Keep the status quo and document it: rejected. The error loop and the
  missing provenance fail the requirement.

## Consequences

- A suspended pipeline resumes automatically within one dispatch interval of
  its last prerequisite completing, and immediately when the completion goes
  through `task:complete`; suspension no longer produces repeated command
  failures.
- The resume is exactly once: repeated ticks, daemon restarts, and concurrent
  triggers are idempotent no-ops, and a stale holder cannot complete a stage
  that another trigger already closed.
- Every resume is auditable as a resume, linked to the prerequisite
  completion that caused it.
- Reconciliation of dependents whose prerequisite left review towards a
  terminal non-completed state remains a separate concern (RRD-02); recovery
  reports those tasks as superseded and changes nothing for them.

## Audit semantics

A `pipeline.resumed` event with trigger `orchestration_replay` records that a
stage was completed via an automatic replay trigger. That covers both the
review-ready suspension and plain crash repairs of runs whose task has
prerequisites: both leave the same durable artifact, and both resume through
the same replay. The event therefore proves the resume was automatic and
replay-driven, not that a prerequisite refusal preceded it — an accepted
widening of the audit signal.

## Known limitations

- A genuine binding corruption on the replay path (a
  `PipelineActorUnauthorizedError` from a stage/agent binding that no longer
  matches) is a quiet no-op in the replay; it is visible only through the tick
  sweep's `superseded` outcome.
- SQLite single-writer collisions (`TransactionAlreadyActiveError`) on the
  automatic write paths are pre-existing: the affected trigger fails once and
  self-heals on the next replay or sweep.
- A `superseded` artifact is re-reported on every sweep until the RRD-02
  reconciliation work lands.
