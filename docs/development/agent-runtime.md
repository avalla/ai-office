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

The [bundled profile guide](../../agents/README.md) describes four core delivery
profiles in `agents/` and fourteen opt-in specialists in `agent-catalog/`.
Normal synchronization of `agents/` registers and enables the core set only;
the separate catalog or a selected subset must be deliberately synchronized.
Each synchronized agent is enabled and can be scheduled outside an active
pipeline without an office revision. A revision is required for pipeline routing.
Sync upserts definitions: it neither removes nor disables previously synchronized
specialists when only the core set is synchronized again. It does not grant
controlled-action authority or change the office manifest or default pipelines.
Companion `system.md` files describe each role's method, handoff, and boundaries;
they are not loaded, persisted, versioned, or injected by the Runtime. Repository
contract tests validate their presence and sections without making them execution
inputs. See the profile guide for synchronization commands and the pre-existing
manifest role ID versus Runtime role key compatibility limitation.

`run:schedule` validates project, runnable task, and enabled agent, creates a queued run,
and acquires the task lock in one short transaction. It can persist one immutable
controlled-action intent containing resource, operation, and canonical JSON
arguments. Lock acquisition is a conditional SQLite upsert: a live lock is never
removed, while a lock with `expires_at <= now` is replaced atomically. A second
active run for the same task fails with a typed error. The repository also
exposes owner-only lock renewal, used by real worker execution. Scheduling refuses a
second non-terminal run even if its previous lease expired: expiration alone
does not prove the old work stopped.

`run:tick` processes queued runs with bounded capacity outside the daemon's
global command FIFO. Runs with an action intent use the M6D-lite executor gateway.
The CLI and daemon allow its response to outlive short-command transport
deadlines. Worker deadlines belong to role limits; state/cancellation requests
remain responsive. Each persisted execution transition invalidates the dashboard
before the batch finishes, so live progress does not wait for command completion.
Admission atomically checks fresh task, agent, pipeline and lease facts, records
the claiming Runtime instance, and prevents concurrent ticks claiming one run
twice. Blocked/terminal tasks and stale authority cannot dispatch work;
runs without one require an explicit worker or simulation selection. Without
either selection, a batch containing normal queued tasks fails before dispatch
and leaves the queue unchanged. The gateway returns only action
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

The retained worktree manager is a deterministic test implementation; current
worker, simulation and controlled-action executors do not allocate fake paths.
Git worktree integration and an autonomous LLM tool loop remain future. A
mutation requested by a run remains simulated until separately approved and
executed. Recoverable runs and `executing` or `execution_unknown` actions remain
observable and are never replayed automatically.

## Real worker operation

After scheduling a task, choose the executor explicitly:

```bash
ai-office run:tick --project <project-id> --worker claude
ai-office run:tick --project <project-id> --worker claude --worker-model <model>
ai-office run:show --project <project-id> --run <run-id>
```

Use `--simulate` for a deterministic test instead. Selection applies to normal
tasks in that tick's batch; controlled-action intents always use their gateway.
When the Runtime supplies a configured default executor, it is accepted only
if its prepared execution provides validated worker provenance and an
acceptance fence. An execute-only adapter fails closed before `running`; direct
calls to the authoritative wrapper's `execute()` also fail closed. The
legacy `execute()` method remains available for internal compatibility but is
not an authoritative `run:tick` dispatch contract. For the built-in Claude
worker, AI Office owns the SQLite authority/completion fence and rejects stale
task, agent, role, pipeline or lease facts before `reviewing`. For configured
adapters, AI Office validates the provenance shape and requires `accept()`, but
the adapter is trusted code: the Runtime cannot prove that its implementation
is equivalent to the built-in fence.
The daemon needs Claude Code `2.1.259` or newer on its PATH and a working
client login. The adapter checks only the semantic version before dispatch; it
does not infer security capabilities from `claude --help`, whose output is not
complete. The baseline invocation deterministically includes `--safe-mode`,
`--restricted`, `--tools ""`, `--disallowedTools "mcp__*"`, strict empty MCP
configuration, empty ordinary setting sources, disabled slash commands,
`--permission-mode dontAsk`, `--permission-prompts none`, no session
persistence, JSON output/schema, and bounded turns/budget. This is model-visible
tool isolation, not process-level isolation. `--restricted` is not a sandbox
against same-UID code, administrators, or managed-host policy; managed policy
hooks may still run. Operators requiring process-level isolation must add an
OS/container policy outside this adapter's guarantee. A host started before a
PATH/login change may need to be restarted explicitly.

The first real worker produces **analysis and drafted content**. It receives
task title/description, synchronized agent/role identity and version, and the
active pinned stage's objective/checks when present. That data is sent to the
selected external client; operators must choose task content accordingly.
It receives no repository path, resource tools, role source files, skills or
`system.md` prompt. Tool declarations in a role do not grant tools to this
adapter. Filesystem reads/writes, shell tests, commits and connectors are not
part of this worker contract.

The application pins adapter/version and the SHA-256 of this bounded context
before dispatch, renews the task lease and checks authority while running.
The final bounded result, session/model identifiers when reported, and usage
are persisted in the run. The CLI and dashboard run detail show the result.
The dashboard identifies simulation, controlled action, real worker and unknown
historical execution separately. Task history links to each run's events/output.
Historical provenance is never guessed from a result's prose.

The role's timeout and iteration limit become process deadline and client turn
limit. For Claude, `maxCostMicros` denotes millionths of a USD client cost
estimate per run. This client-side estimate limit is separate from gateway
budgets and actual billing; subscription cost is unknown. Reported input tokens
exclude cache-read/cache-creation counts. Missing estimates or tokens remain
unknown. `--worker-model` overrides client model selection; the role's generic
`modelPolicy` is not a provider model selector in this first adapter.

Cancellation or deadline stops and reaps the whole worker process group on
POSIX before the execution returns. The real Claude worker is unsupported on
Windows until a tested Job Object or equivalent process-tree ownership boundary
exists; simulation and controlled actions are not disabled. Controlled action
invocation receives the assigned role timeout and propagates its AbortSignal.
A connector that ignores cancellation is not detached: the runtime waits for
its call to return, leaving the operation observable until an explicit result
or reconciliation. This means graceful shutdown is not bounded for a
non-cooperative in-process connector in the current lifecycle architecture;
adding a timeout would create a detached promise or falsely close storage.
It must not be reported as a definite failure when an external side effect
could be ambiguous; the separately executed mutation path retains the existing
`execution_unknown` reconciliation model.
If the host crashes, the new host cannot attest that the old external process
stopped: recovery reports `externalWorkerUnobserved`. Inspect the installed
client/process before explicitly reconciling that record; reconciliation does
not resume execution. A completed run means its generated output was collected,
not that the task or stage is accepted. Pipeline advancement, independent review
and all protected mutation approvals remain explicit separate operations.

See [ADR-0017](../adr/ADR-0017-bounded-external-worker.md) for the boundary and
remaining autonomous-delivery work.

## Dashboard filtered-page cost

Filtered task pages intentionally evaluate the authoritative operational-status
projection in application code rather than introducing a second SQL status
engine. The regression benchmark in
`tests/integration/operational-queries.test.ts` seeds 10,000 tasks and asserts
100 status-projection batches at the current page batch size of 100; a second
live-refresh query repeats the same bounded linear work. This is acceptable for
the current local target, so no cache or materialized status table is added
until measurements show that the single-source projection is no longer within
the target latency.
