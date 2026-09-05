# Agent runtime

`run:tick --json` returns schema version 1 with a result for every processed run,
including its status, sanitized execution/cleanup errors and action references.
Capacity is bounded to 1–100. An empty batch or entirely successful execution
returns exit code 0; failures, cancellations or cleanup failures return 1.
An interrupted state write returns `interrupted` with a typed persistence error
and retains its lock for recovery. This is an execution outcome, not a new
persisted AgentRun status.
Action `approval_pending` means the intent was processed, not that its mutation
executed. Executor exception text is not exposed or persisted as a run error.

M3 loads `agents/*/agent.yaml` with Bun's native YAML parser and validates every field before persistence. `agent:sync` upserts stable project-scoped role and agent identities.

`run:schedule` validates project, runnable task, and enabled agent, creates a queued run,
and acquires the task lock in one short transaction. It can persist one immutable
controlled-action intent containing resource, operation, and canonical JSON
arguments. Lock acquisition is a conditional SQLite upsert: a live lock is never
removed, while a lock with `expires_at <= now` is replaced atomically. A second
active run for the same task fails with a typed error. The repository also
exposes owner-only lock renewal for a future heartbeat. Scheduling refuses a
second non-terminal run even if its previous lease expired: expiration alone
does not prove the old work stopped.

`run:tick` processes queued runs with bounded capacity outside the daemon's
global command FIFO. Runs with an action intent use the M6D-lite executor gateway;
admission atomically checks fresh task, agent, pipeline and lease facts, records
the claiming Runtime instance, and prevents concurrent ticks claiming one run
twice. Blocked/terminal tasks and stale authority cannot dispatch work;
runs without one use the simulated fallback. The gateway returns only action
identity, outcome, and status to the runtime. Connector output and implementation
objects do not cross that boundary. Execution returns an explicit `completed`,
`failed`, or `cancelled` result. A worktree cleanup error is reported separately
and never hides the primary execution error. Lock release is attempted only
after a terminal state was persisted; interrupted writes retain recovery evidence.

The state sequence is `queued -> preparing -> running -> reviewing -> completed`. Errors finish as `failed`; cancellation support is present in the domain and executor boundary. Each persisted transition appends exactly one immutable event in the same short transaction as the current-state update.

At restart, `preparing`, `running`, and `reviewing` runs are discoverable through
`run:reconcile`. `run:cancel` requests stopping live work or cancels queued work;
approved reconciliation resolves orphaned execution without replay or task
status changes. Ambiguous effects remain blocked. See [run recovery](run-recovery.md).
No subprocess, Git mutation, LLM call, or long-running transaction is used by the simulator.

The worktree manager and the fallback executor remain deterministic simulations;
real subprocess and Git integration are not implemented. M6D-lite supplies the
replaceable controlled-action boundary, not an autonomous LLM tool loop. A
mutation requested by a run remains simulated until separately approved and
executed. Recoverable runs and `executing` or `execution_unknown` actions remain
observable and are never replayed automatically.
