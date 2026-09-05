# Agent run cancellation and recovery

Run execution belongs to the persistent Runtime. Each atomic queued-run claim
records the owning Runtime instance ID in the immutable `preparing` event.
The Runtime keeps cancellation handles from admission until execution and
cleanup finish. These handles are liveness evidence, not resource authority.
Legacy events have no owner ID and remain readable without a migration.

The single-host invariant and shutdown draining are essential: a graceful stop
refuses new Runtime work, requests cancellation and waits for outstanding command
work before releasing its socket. This also covers work continuing after an IPC
response timeout. An executor which does not acknowledge stopping cannot be
reported as stopped; forcibly terminating the process leaves persisted recovery
evidence for the next host.

## Operator commands

```text
run:cancel --project <id> --run <id> --reason <text> [--json]
run:reconcile --project <id> --run <id> --reason <text> [--json]
run:reconcile --project <id> --run <id> --reason <text> --approve <planHash> [--json]
```

Both commands publish schema-version 1 JSON. Cancellation of queued work records
its terminal state and audit together and releases only that run's lock. A live
run returns `cancellation_requested` only when its cancellation handle accepts
the abort signal; this is delivery, not acknowledgement. The historical audit
event name `run.cancellation_requested` records operator intent before signalling
and alone does not prove delivery. If the handle disappears during that audit
write, cancellation re-reads evidence: a clean terminal run returns
`already_terminal`, orphaned or terminal-cleanup work requires approved
reconciliation, ambiguous effects stay blocked, and inconsistent evidence fails
closed. This refines schema-version 1 behavior without adding or renaming result
statuses or audit events. No recovery or lock release occurs on this fallback.
Only execution reaching and persisting `cancelled` acknowledges stopping.
Repeating cancellation of a terminal run is a
read-only no-op. `task:cancel` additionally cancels queued runs and requests
stopping live runs after committing the task transition. Task, run, pipeline and
controlled-action states remain distinct; task cancellation does not claim that
an existing filesystem effect was rolled back. If subsequent run cancellation
fails, task cancellation is already committed and the operator must inspect the
run. New work on that task remains denied.

Reconciliation without approval never writes. Its report distinguishes queued,
live, orphaned, terminal, terminal-cleanup and ambiguous work. The plan hash binds
project/run identity, status, update timestamp, owner, lock, action/execution
states and the operator's reason. Applying the exact plan rechecks this evidence
in a short transaction and records the repair with its audit.

- An orphaned run becomes cancelled, never completed or replayed.
- A terminal run with its own leftover lock may release that lock without
  changing the terminal result or emitting a new run transition.
- Live work, stale plans and ambiguous `executing`/`execution_unknown` effects
  cannot be repaired through this command. Action records and attempts remain
  unchanged; action reconciliation beyond this boundary remains future work.
- No repair deletes a worktree, changes task status, cancels a pipeline, grants
  authority, or releases another run's lock.

After a safe repair, backup readiness is evaluated normally: remaining active
pipelines, runs or unexpired locks can still block the snapshot. Automatic
retry, worker heartbeat/deadline policies, subprocess isolation and durable
filesystem reconciliation remain outside this consolidation slice.
