# Operational dashboard

Task rows include progress across explicitly linked requirements. The query
adapter groups all relevant links by task and requirement status, so exact
counts do not depend on presentation limits or require per-row queries. Empty
relations report zero counts; task status and milestone semantics remain
independent. This uses the existing version-1 `available` requirement-summary
contract; clients still accept the unavailable response from older hosts.

The dashboard is a local, read-only operations console. It answers the questions
an operator asks between commands: what projects exist, what is being worked on,
which pipeline stage each run is in, which agent is doing what, what is waiting
for a human, what failed, and what happened recently.

## Usage

The daemon must already be running; the dashboard never starts it implicitly.

```bash
ai-office daemon        # in one terminal
ai-office dashboard     # in another
```

```text
AI Office dashboard
http://127.0.0.1:4278/?token=1f0c…
Read-only. Local same-user surface; the link carries this session's token.
```

The command holds the terminal and stops on Ctrl-C, releasing the port with it.
Options:

| Option                      | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `--port <port>`             | Loopback port; `0` asks the OS for a free one        |
| `--host <address>`          | Loopback address only; anything else is refused      |
| `--no-open`                 | Do not open a browser                                |
| `--await-runtime <seconds>` | Wait that long for the Runtime socket before failing |

If the daemon is stopped, the command reports the same actionable error as any
other daemon-backed command and exits `1`.

`--await-runtime` defaults to `0`, which is that immediate failure. A supervised
dashboard uses a non-zero bound instead, because no startup-ordering primitive
proves the Runtime socket is already accepting connections: systemd `After=`
orders starts, and launchd has no dependency contract at all. The host itself
already tolerates a Runtime that disappears later — `/api/*` answers `503`
`DAEMON_UNAVAILABLE` and recovers on the next request — so the bounded wait is
only about the first connection. It is a retry, not a sleep; when the bound
expires the command exits and the service manager restarts it.

`ai-office service install` installs this command as a per-user service with
`--host 127.0.0.1 --port 4278 --no-open --await-runtime 60`. See
[Native service management](service-management.md).

## Architecture

```text
apps/dashboard
      |
      v
daemon query API  (GET /api/*, on the existing Unix socket)
      |
      v
application query service
      |
      v
operational read models / projections
      |
      v
repository ports
      |
      v
SQLite adapters
```

### Source of truth

The dashboard does not infer operational state from raw SQLite records. It
consumes authoritative application read models. There is one computation of a
task's operational status, one derivation of an agent's activity, and one
projection of a pipeline run; the browser renders them and adds no
interpretation of its own.

HTTP handlers parse, validate, and serialize. They contain no SQL and no domain
logic, so a CLI query command or an MCP tool can consume the same read models
without going through HTTP.

### Contract

Query responses carry `queryApiVersion`, versioned independently of
`daemonProtocolVersion`. Timestamps are ISO-8601 UTC strings.

#### Bounded evidence never decides authoritative state

This is the rule the whole read side is built around:

> A result may be bounded, but bounded evidence must never silently change an
> authoritative count, status, attention decision, or relationship.

Every query on this surface is exactly one of four things, and only the first two
may be truncated:

| Kind                           | Truncated?                   | Example                                                  |
| ------------------------------ | ---------------------------- | -------------------------------------------------------- |
| Presentation sample            | yes, beside a total          | the active runs shown on the overview                    |
| Pagination page                | yes, with a cursor or offset | activity and filtered tasks                              |
| Authoritative aggregate        | never                        | `activeAgentRuns`, `pendingReviews`, `attentionRequired` |
| Authoritative projection input | never omits a relevant fact  | a task's own in-flight and latest run                    |

Samples are published as `{ total, items, truncated }`. `total` covers every
matching row, using SQL aggregates or an exhaustive application projection for
filtered operational status; `items` is what fits in the limit. A client
that reads `items.length` as a count is reading the wrong field, and the shape
makes that visible.

Projection inputs are bounded only by the entities being projected. A task's
operational status is computed from _that task's_ in-flight run, latest run,
active pipeline run, and pending-review count — never from a "latest N runs of
the project" window, which would change the task's status as unrelated history
accumulated. The same holds for agent state.

Attention works the same way: `attentionRequired` and the totals come from exact
counts across the whole project, so a blocked task on page four of the task list
still raises attention on page one.

#### Pagination

`GET /api/activity` takes an opaque `cursor` and returns `nextCursor`. The cursor
encodes `(occurredAt, id)`, and the SQL predicate uses the same tuple as the
ordering:

```sql
ORDER BY occurred_at DESC, id DESC
WHERE occurred_at < ? OR (occurred_at = ? AND id < ?)
```

A timestamp-only cursor would permanently skip every event sharing an instant
with the row that ended a page — audit rows written in the same millisecond are
ordinary, so that is a real loss, not a theoretical one. The tie breaker is the
audit event id; the SQLite `rowid` is deliberately not part of the contract.

| Route                                 | Returns                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `GET /api/dashboard`                  | Cross-project overview, attention, active runs                  |
| `GET /api/memory`                     | Global roles, patterns, and lessons                             |
| `GET /api/projects`                   | Project summaries                                               |
| `GET /api/projects/:id`               | Project detail: tasks, pipelines, agents, runs                  |
| `GET /api/projects/:id/tasks`         | Task operational state                                          |
| `GET /api/projects/:id/tasks/:taskId` | Task detail, active assignment, run history and scoped activity |
| `GET /api/projects/:id/pipelines`     | Pipeline runs (`?active=true`)                                  |
| `GET /api/projects/:id/agents`        | Agent activity                                                  |
| `GET /api/runs`                       | Agent runs (`?project=`, `?active=true`)                        |
| `GET /api/runs/:id`                   | Run detail: events, actions, pipeline, reviews                  |
| `GET /api/reviews`                    | Reviews (`?pending=true`)                                       |
| `GET /api/approvals`                  | Decided reviews                                                 |
| `GET /api/activity`                   | Sanitized audit activity (`?cursor=`, `?limit=`)                |
| `GET /api/events`                     | Server-sent invalidation stream                                 |

The surface is read-only: any method other than `GET` returns `405`.

The dashboard's Memory page reads the same global-memory authority used by the
Runtime's `memory:*` commands. Codex and Claude Code do not open `global.sqlite`
or receive raw SQL access; their project integrations point to the derived
`AI-OFFICE.md` guidance and repository-local skill, while Runtime-backed work
can select reusable memory through the application boundary.

### Task search, filters, and pages

The project task table searches title, description, and task ID with literal,
case-insensitive matching. Status means the application's operational status;
priority is the persisted integer, including zero and negative values. Agent
matches any active run or current assignment in an active pipeline, and
"No current agent" matches neither. Historical run agents are excluded.
Status, priority, and agent choices come from the project's actual tasks.

The browser requests `GET /api/projects/:id?taskView=paged`, with optional
`search`, `status`, `priority`, `agent`, `unassigned=true`, and `offset` parameters.
Malformed filters return `400`; selecting both an agent and unassigned tasks is
invalid. The response adds `taskPage` with applied filters, offset, page limit,
and project-wide choices. Existing callers without `taskView=paged` retain the
presentation-sample contract. The limit uses the existing `taskLimit` policy.

Matching totals cover all tasks, including records beyond the initial sample.
The application projects bounded batches through the existing operational-state
function, then filters and retains the requested page. Exact task/agent pairs
are read separately so an agent outside the displayed active-run sample still
matches. This reuses the authoritative status rules without a second SQL status
engine or a schema change. Query work grows with project task count; batching
bounds intermediate data, not total work.

Pages retain repository ordering: priority descending, creation time ascending,
then task ID ascending. Filters and offset survive reloads and task-detail
round trips in the hash URL. Applying filters resets the page; live refreshes
preserve drafts and keyboard focus. Pagination reads current state rather than
a frozen snapshot, so concurrent changes can move tasks between pages.
Project summaries, attention, and charts always cover the whole project.

### Task details and progress charts

Task titles open a dedicated route, `#/projects/:id/tasks/:taskId`, from the
project table, agent table, task attention entries, and run detail. The query
service finds the task by both project and task identity before projecting it
through the same operational-state function used by task lists. A task outside
the project's presentation sample remains directly accessible; missing or
cross-project task IDs return `404`.

The detail shows description, recorded and operational status with divergence
reasons, linked requirement counts, dates, the active pipeline and its current
stage assignment, active run agents and their lease validity, and run history.
There is no permanent task assignee in the domain. A stage's assigned agent and
the agents executing runs are shown separately, including unassigned stages and
concurrent runs. Historical agents never imply current assignment.

Run history is filtered by project and task in SQL and is published beside its
exact total. Task activity includes audit events for the task and all its
persisted agent runs and pipeline runs, including historical runs. Relations and
project ownership are resolved in SQL before the activity limit, independently
of the displayed run sample. Raw execution events remain available through each
run's detail. The empty state explains that task creation alone currently emits
no audit event; missing historical events are never fabricated. Both histories
disclose their presentation limits.

Charts use existing exact aggregates: recorded task status from
`ProjectSummary.tasks.byStatus`, completed/all tasks across projects, and active
run versus assigned-stage counts from each `AgentState`. They never count the
displayed task or run samples. The status chart is explicitly labelled as
recorded status, not operational status; the workload chart is not a capacity
or execution-authority claim. Counts remain visible as text, and SVG bars use
numeric attributes compatible with the existing CSP. No chart dependency or
build step is added.

Zero-count status bars and agents with no current work are omitted from charts;
the agent table still lists all agents. Empty operational sections and the
duplicate divergent-task table are omitted. Task activity keeps an explicit
empty state so absent audit history is distinguishable from a hidden section.
Divergence remains visible in the
task row and task detail.

Run detail filters activity by the run's own aggregate ids **in SQL, before the
limit**, so a run whose events are older than the latest project window still
reports them. `audit_event_aggregate_idx` serves that access path.

Pipeline history is ordered and limited in SQL, newest first. The command-side
`PipelineRunRepository` returns whole aggregates oldest-first and unbounded,
which is right for its consumers; the read side has its own query rather than
loading that history and discarding most of it.

### Live updates

`GET /api/events` streams invalidation topics — `project.updated`,
`task.updated`, `run.updated`, `pipeline.updated`, `review.updated`,
`approval.updated`, `activity.created` — after a command completes. The stream
carries topics only, never state, so it cannot become a second source of truth:
a client that misses an event is stale until the next one or until it
reconnects, never wrong.

The mapping from command to topics is deliberately coarse. It may invalidate
more than a command changed; it never claims a change did not happen. Nothing
new is persisted, subscribers are bounded, a listener that throws is dropped
without affecting the others, and disconnecting releases both the listener and
its heartbeat timer.

**Every new connection re-establishes the query baseline.** Because the stream
carries hints and has no replay, restoring the _connection_ does not restore the
_view_:

```text
state A displayed -> stream drops -> a command changes A to B ->
the invalidate event is missed -> stream reconnects -> nothing is replayed
```

So the browser shell treats a newly established stream exactly like an
invalidation, and the connection badge distinguishes the two things a naive
client conflates:

| Badge          | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `connecting`   | no stream has been established yet                          |
| `syncing`      | a stream is up; the displayed route has not been re-queried |
| `live`         | connected, and this route was queried under this connection |
| `reconnecting` | the stream dropped; `EventSource` is retrying               |

The invariant is: **once the dashboard says `live`, the current route has been
re-queried after the most recent stream connection was established.** It is
expressed as a sync token pairing the connection epoch with the route key — a
new connection bumps the epoch, a navigation changes the route key, and a
refresh adopts the token it started under only when it _succeeds_. A failed
query therefore never reads as `live`.

The reconnect refresh reuses the same single-flight-plus-debounce path as
invalidations, so a reconnect storm, an invalidate burst, a hash-route change,
and a reconnect arriving mid-refresh all coalesce instead of racing. The state
machine lives in `apps/dashboard/src/ui/sync-controller.ts` with its timers,
fetch, and route accessor injected, and is unit tested in
`tests/unit/dashboard-sync-controller.test.ts` — no headless browser needed.

**Failed commands publish too.** A command that fails is not a command that
changed nothing: it appended audit rows, and it may have committed part of its
work before failing. The daemon publishes the same conservative topic set on the
failure path, after the `command.failed` audit event has landed, so a connected
dashboard refreshes immediately instead of waiting for the next successful
command.

## What the read models say, and what they refuse to say

### Stored status versus operational status

`ScheduleAgentRun` does not transition the task it schedules — only pipeline
start and completion do. A task therefore reads `pending` while a run for it is
already executing. Rather than papering over that, `TaskOperationalState`
carries both:

- `recordedStatus` — exactly what `task.status` holds;
- `operationalStatus` — the authoritative interpretation, in a distinct
  vocabulary (`not_started`, `scheduled`, `in_progress`, `awaiting_review`,
  `blocked`, `failed`, `completed`, `cancelled`);
- `divergenceReasons` — the persisted fact the task record does not reflect.

The project page lists divergent tasks in their own section, so the mismatch is
visible rather than silently resolved.

### A task may have several active runs, and the lease says which one owns it

`task_lock` is a **lease**, not a mutex. `acquireTaskLock` deliberately lets an
expired lease be taken over —
`ON CONFLICT(task_id) DO UPDATE ... WHERE task_lock.expires_at <= excluded.acquired_at`
— and taking it over does not terminate the previous run. `ExecuteAgentRun`
never renews the lease while it runs; it releases it during final cleanup. So
this is ordinary persisted state:

```text
run-A running, lease -> run-A
lease expires
run-B queued,  lease -> run-B
run-A is still running
```

Two active runs, one task, and nothing wrong with the write model. The read
model therefore carries a list:

| Field                        | Guarantee                                                               |
| ---------------------------- | ----------------------------------------------------------------------- |
| `activeAgentRuns`            | `{ total, items, truncated }`; `total` is the exact active run count    |
| `primaryAgentRun`            | `activeAgentRuns.items[0]` — a _representative_, not a uniqueness claim |
| `lease`                      | the persisted `task_lock` row, or `null` when none exists               |
| `runsWithoutValidLeaseCount` | exact number of active runs without valid execution authority           |

Items are ordered by `updated_at` descending, ties broken by run id descending.
Each `TaskActiveRunReference` carries its own agent and pipeline linkage,
because concurrent runs may belong to different agents — a single
`assignedAgent` cannot describe them all, and it is documented as the
representative's agent.

### Owning the lease row is not holding the lease

These are two different facts and the read model keeps them apart:

```text
ownsLeaseRecord = lease.ownerRunId === run.id
hasValidLease   = ownsLeaseRecord AND lease.expiresAt > evaluationTime
```

A lease **row** is evidence of persisted ownership. A **non-expired** lease is
evidence of current exclusivity. `acquireTaskLock` takes a task over the moment
`task_lock.expires_at <= excluded.acquired_at`, so once `expiresAt` has passed
the previous owner still names the row and holds nothing. `hasValidLease` is the
only field that means execution authority; `ownsLeaseRecord` never does.

The boundary uses `<=`, matching the writer: a lease at exactly its expiry
instant is already takeable.

**`TaskLeaseState`** reports `ownerRunId`, `acquiredAt`, `expiresAt`, `expired`,
and `ownerRunStatus`. It is `null` when no lease row exists rather than a guess,
and the read side never writes it.

### Operational status under concurrent runs

`operationalStatus` is derived from **exact task-scoped counts**, never from the
representative:

```text
task.status terminal (cancelled / failed / completed)  -> that status
task.status blocked                                    -> blocked
pending review or stage awaiting approval              -> awaiting_review
task.status waiting_review                             -> awaiting_review
activeRunCount > 0 and executingRunCount > 0           -> in_progress
activeRunCount > 0                                     -> scheduled
no active run, latest run failed, no active stage      -> failed
task.status running                                    -> in_progress
otherwise                                              -> not_started
```

`executingRunCount` counts active runs whose status is `running` or `reviewing`.
So `queued` + `running` is `in_progress` and `queued` + `preparing` is
`scheduled` regardless of which run happens to sort first, and truncating the
sample cannot change either. The review and approval precedence above the run
rules is unchanged and deliberate: a task waiting on a human reads as waiting
even while an agent run is still in flight. Terminal recorded task status keeps
its existing precedence over everything.

### Which lease conditions are actionable

Concurrency itself is **not** an error, because lease takeover is intentionally
supported. Missing _valid_ execution authority is, and it produces one attention
item per affected task:

| Condition                                  | `hasValidLease` | Attention                     |
| ------------------------------------------ | --------------- | ----------------------------- |
| Lease valid, owned by this active run      | `true`          | none — this run has authority |
| Lease valid, owned by another run          | `false`         | `task_run_without_lease`      |
| Lease expired, nobody took it over         | `false`         | `task_lease_expired`          |
| Lease outlived a terminal or missing owner | `false`         | `task_run_without_lease`      |
| No lease row at all                        | `false`         | `task_run_without_lease`      |

`task_lease_expired` is a deliberate policy choice, not an oversight.
`ExecuteAgentRun` never renews the lease, so a long run reaches expiry
routinely — but common is not the same as valid: the task is takeable _right
now_ while the old run may still be executing. Surfacing it exposes the
underlying scheduling weakness without changing write-side behaviour. Renewing
the lease, or cancelling a run that loses it, is runtime work and deliberately
**not** done in this change.

`ExecuteAgentRun` reaches the same conclusion independently: releasing a lease
it no longer owns raises `TASK_LOCK_RELEASE_FAILED` during cleanup.

**An active run with no lease row is an integrity/recovery anomaly**, not an
ordinary lifecycle state. `ExecuteAgentRun` persists the run's terminal status
_before_ its `finally` releases the lock, and a crash before finalization skips
the `finally` entirely — leaving the lock row behind rather than removing it. So
this shape comes from corrupted, manually altered, or partially restored state.
The defensive handling stays: an observability surface must describe
inconsistent state honestly rather than assume it away.

Both reasons are counted per **task** by the exact aggregate
`countTasksWithoutValidRunLease` and sampled by `listTasksWithoutValidRunLease`
— same unit on both sides, so one attention item means one affected task and
`attention.total` stays exact. A run without valid authority is **never
discarded**: it stays in `activeAgentRuns`, in its total, and in every run
aggregate.

### One condition, one `since`

`taskLeaseAttention` is the single derivation of `kind`, `subject`, `summary`,
and `since`, shared by the per-task projection and the project-wide sample, so
the same persisted condition reads identically from
`TaskOperationalState.attentionReasons`, `ProjectSummary.attention`, and the
overview.

| Case                              | `since`                                     |
| --------------------------------- | ------------------------------------------- |
| Lease expired                     | `lease.expiresAt` — when exclusivity lapsed |
| Lease valid, owned by another run | `lease.acquiredAt` — when ownership moved   |
| No lease row                      | `task.updatedAt` — the documented fallback  |

It is never a run's `updated_at`: a run that keeps working after losing the
lease must not push the anomaly's start time forward.

### Lease validity is evaluated at the application clock

`countTasksWithoutValidRunLease` and `listTasksWithoutValidRunLease` take the
evaluation instant as a parameter; neither uses a SQLite wall-clock function.
One `clock.now()` per query snapshot is threaded into the aggregate, its sample,
and every task projection, so the exact total and the per-task state cannot
disagree and tests stay deterministic against the injected `Clock`. The SQL
predicate is the semantic definition, verbatim:

```sql
lock.run_id IS NULL OR lock.run_id <> run.id OR lock.expires_at <= :now
```

**Deliberately not changed:** no write-side one-run-per-task restriction was
added. Whether a run that loses its lease should stop executing is a scheduling
and concurrency decision for the runtime, not something a dashboard should force
by narrowing a read model. The read side names the distinction between a
persisted `running` status and lost execution ownership; it does not resolve it.

### What each run count counts

| Count                                        | Counts                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `ProjectSummary.activeAgentRuns`             | persisted runs whose status is non-terminal, project-wide                     |
| `DashboardOverview.totals.activeAgentRuns`   | the sum of the above across projects                                          |
| `TaskOperationalState.activeAgentRuns.total` | the same predicate scoped to one task                                         |
| `AgentState.activeRuns.total`                | the same predicate scoped to one agent                                        |
| `ProjectSummary.agentsWorking`               | distinct **enabled agents** holding at least one such run — never a run count |

Every run count uses definition **A**: _persisted liveness_. None of them means
"runs that still hold valid execution authority" — a run whose lease was taken
over, or whose lease merely expired, keeps its non-terminal status and stays
counted. Execution authority is a separate, explicitly named concept:
`TaskActiveRunReference.hasValidLease` and `runsWithoutValidLeaseCount`, never
`ownsLeaseRecord`. The dashboard never switches between the two meanings
silently.

### Relationships the domain does not model

The task record carries no milestone reference; a milestone is not inferred
from linked requirements. It is published as
`{ availability: "unavailable", reason, explanation }` rather than an invented
value. Task/requirement links are now explicit and their exact counts are
available; the contract still accepts unavailable summaries from older hosts.

### Derived states are limited to persisted facts

There is no heartbeat, so "unreachable" or "stalled" are not derivable and are
not invented. Pipeline runs have no `failed` status — a rejected stage cancels
the run — and the read model says so.

Agent activity has exactly one value, chosen by this precedence:

| State               | Exact definition                                                                 |
| ------------------- | -------------------------------------------------------------------------------- |
| `disabled`          | `agent.enabled` is false. Nothing else can override it.                          |
| `working`           | at least one active `AgentRun` (`queued`, `preparing`, `running`, `reviewing`).  |
| `awaiting_approval` | no active run, and at least one assigned active stage is `awaiting_approval`.    |
| `assigned`          | no active run, and at least one active pipeline stage is assigned to this agent. |
| `last_run_failed`   | no active run and no active stage, and the most recently updated run failed.     |
| `idle`              | none of the above.                                                               |

`assigned` exists because a pipeline stage can legitimately be assigned before
any `AgentRun` is scheduled. Calling that state `working` is what used to make
the project summary contradict the agent row.

`working` outranks `awaiting_approval` so that one definition of "working"
holds everywhere:

```text
ProjectSummary.agentsWorking
  = COUNT(DISTINCT agent_run.agent_id)
    WHERE agent_run.status IN (queued, preparing, running, reviewing)
      AND agent.enabled = 1
  = the number of enabled AgentState values whose state is `working`
```

Both sides are the same predicate, so they cannot disagree. A pending approval
on an agent that is also running something is not lost: it stays in that agent's
`activeStages` and in the project's attention list.

### Concurrency is reported, not assumed away

Nothing in the persisted model enforces one active run per agent — the task lock
is per _task_ — and pipeline assignment does not reject an agent merely because
another active stage already names it. Both are valid persisted facts, and
inventing a write-side one-job-per-agent rule to simplify a read model would be
a scheduling decision, not a dashboard decision.

So `AgentState` carries lists rather than a single `currentRun`/`currentStage`
that would silently drop real work:

| Field          | Guarantee                                                          |
| -------------- | ------------------------------------------------------------------ |
| `activeRuns`   | `{ total, items, truncated }`; `total` is the exact active count   |
| `activeStages` | `{ total, items, truncated }`; `total` is the exact active count   |
| `primaryRun`   | `activeRuns.items[0]` — a _representative_, not a uniqueness claim |
| `primaryStage` | `activeStages.items[0]` — likewise                                 |

Selection is deterministic: active runs are ordered by `updated_at` descending
with ties broken by run id descending; active stages by their pipeline run's
`updated_at` descending with ties broken by pipeline run id ascending. The
derived state itself reads only the _exact counts_ — including a separate exact
count of assignments awaiting approval — so a truncated sample can never change
it. The agent table renders the representative plus `+N more`, computed from
`total`.

The read port mirrors this: `listAgentRunFacts` returns `activeRuns` with an
exact `activeRunCount`, and `listActiveStagesForAgents` returns `stages` with an
exact `stageCount` and `awaitingApprovalCount`, one record per agent. Keying a
map by `agentId` over raw rows — which would keep only the last row per agent —
is exactly the collapse these shapes prevent.

There is no aggregate "health score". Attention is a list of reasons, each
backed by a persisted fact: a pending review, a stage awaiting approval, a stage
with no assigned agent, a failed run, a blocked task, a failed task.

No token or cost metric is exposed. That data is not reliably persisted for
these flows, so it is not shown.

## Threat model

The dashboard is a **local, same-user observability surface**. It introduces no
new authenticated human or operator boundary.

What it does not do:

- it does not authenticate a human; nobody proves who they are;
- it does not separate same-UID processes. Any process running as this user can
  read the terminal, the environment, or talk to the daemon socket directly.
  That is the limit already recorded in the current trust model, unchanged here;
- it does not weaken daemon command authorization, bypass capability or
  controlled-action authorization, or add any mutation endpoint;
- it introduces no `operator=true`, no trusted browser header, and no
  caller-selected privileged surface.

What is genuinely enforced:

- **The daemon still opens no TCP listener.** Its owner-only Unix socket is
  unchanged. The TCP port belongs to `ai-office dashboard`, is bound to
  loopback, and is released when the command stops. A non-loopback bind is
  refused outright.
- **A per-process session token.** Generated in memory, never written to disk,
  and dead when the command exits. Every route requires it, so a process that
  merely finds the open port — or a page that guesses it — gets nothing. It is
  exchanged once for an `HttpOnly; SameSite=Strict` host-only cookie so it stops
  travelling on later requests.
- **A `Host` allowlist.** This blocks DNS rebinding, where a page the user
  visits resolves an attacker-controlled name to 127.0.0.1 and reads responses
  as same-origin.
- **A strict Content-Security-Policy** on served documents: no inline script, no
  external origin, no framing.

The token is a capability against accidental and blind access — **not a
secret**. `ai-office dashboard` hands the complete URL to the platform opener,
so the token appears in that process's arguments, and the browser records it in
history; whether another local account can read either is platform-dependent.
So the honest claim is narrow: the port is unusable by anything that has never
seen the URL, and the token dies with the command. It is not claimed to keep
project state secret from other local users, and it is not authentication.

`--no-open` keeps the token out of opener arguments. It cannot keep it out of
browser history. If a machine has local accounts you would not show this data
to, do not run the dashboard there.

### What reaches the browser

- Audit payloads are sanitized at the publication boundary: only scalars
  survive, sensitive key names are dropped, strings are truncated, and anything
  removed is reported through `detailTruncated`. Command arguments and answers
  never enter audit payloads in the first place.
- Run results and errors are never republished raw. The surface exposes
  `hasResult`/`hasError`, a bounded `{ code, message }` failure summary, and the
  known controlled-action outcome shape.
- Action intents publish argument **names**, never argument values.
- Internal failures return a stable error code and no stack trace.

## Adding command-side operations later

A Human Approval Inbox or an authorized control plane would add a command-side
path _beside_ the query surface, not inside it. Concretely:

1. the daemon keeps `/api/*` read-only and `GET`-only;
2. write operations go through the existing daemon command protocol — the same
   path the CLI uses — so capability policy, approval binding, pipeline
   authority, and audit apply unchanged;
3. the dashboard host would forward those as commands, and the browser would
   invoke them through an explicit action module, separate from the render
   layer;
4. an authenticated human boundary would have to be designed first, because the
   session token is not one. Until then, a write surface reachable from the
   browser would be reachable by any same-UID process, which is why this version
   has none.

Because the current UI renders read models and holds no domain logic, adding
that path does not require rewriting it.

## Frontend

There is no frontend framework or build step. The UI is TypeScript bundled by
Bun in memory at host start, split into:

- `ui/view-model.ts` — pure mapping from read models to labels, tones, glyphs,
  and ordering;
- `ui/render.ts` — pure view model to HTML, with every interpolated value
  escaped;
- `ui/charts.ts` — labelled SVG bars over exact aggregates;
- `ui/task-filters.ts` — native filters and page links over the query contract;
- `ui/html.ts` — shared HTML escaping boundary;
- `ui/app.ts` — the browser shell: fetch, the invalidation stream, and the
  single DOM write.

Presentation mapping, escaping, chart totals, task details, and routing are
unit tested directly. Task detail also has SQLite integration and Unix-socket
coverage for ownership, missing records, limits, and read-only behavior. Browser
checks can use a temporary synthetic Runtime fixture without opening personal
project state or adding browser tooling to the production bundle.

Pipeline stages are rendered from the persisted run definition — stage names and
order come from the manifest revision the run pinned. No role vocabulary is
hardcoded.

### Execution evidence and generated output

Run rows and detail identify the recorded executor: simulation, controlled action,
or real worker. Missing historical provenance is explicitly unknown. Agent
liveness is labelled “active run”; it is not proof of model execution. A worker
run detail displays its bounded final output, adapter/version and input digest,
reported model/session and optional usage estimate. Content is escaped as text;
raw client envelopes and hidden reasoning are not projected. Generated output
does not attest to file changes, successful tests, task completion or approval.
