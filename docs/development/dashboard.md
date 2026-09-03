# Operational dashboard

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

| Option             | Meaning                                         |
| ------------------ | ----------------------------------------------- |
| `--port <port>`    | Loopback port; `0` asks the OS for a free one   |
| `--host <address>` | Loopback address only; anything else is refused |
| `--no-open`        | Do not open a browser                           |

If the daemon is stopped, the command reports the same actionable error as any
other daemon-backed command and exits `1`.

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

| Kind                           | Truncated?                  | Example                                                  |
| ------------------------------ | --------------------------- | -------------------------------------------------------- |
| Presentation sample            | yes, beside a total         | the active runs shown on the overview                    |
| Pagination page                | yes, with a cursor          | `GET /api/activity`                                      |
| Authoritative aggregate        | never                       | `activeAgentRuns`, `pendingReviews`, `attentionRequired` |
| Authoritative projection input | never omits a relevant fact | a task's own in-flight and latest run                    |

Samples are published as `{ total, items, truncated }`. `total` comes from a SQL
aggregate over every matching row; `items` is what fits in the limit. A client
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

| Route                             | Returns                                          |
| --------------------------------- | ------------------------------------------------ |
| `GET /api/dashboard`              | Cross-project overview, attention, active runs   |
| `GET /api/projects`               | Project summaries                                |
| `GET /api/projects/:id`           | Project detail: tasks, pipelines, agents, runs   |
| `GET /api/projects/:id/tasks`     | Task operational state                           |
| `GET /api/projects/:id/pipelines` | Pipeline runs (`?active=true`)                   |
| `GET /api/projects/:id/agents`    | Agent activity                                   |
| `GET /api/runs`                   | Agent runs (`?project=`, `?active=true`)         |
| `GET /api/runs/:id`               | Run detail: events, actions, pipeline, reviews   |
| `GET /api/reviews`                | Reviews (`?pending=true`)                        |
| `GET /api/approvals`              | Decided reviews                                  |
| `GET /api/activity`               | Sanitized audit activity (`?cursor=`, `?limit=`) |
| `GET /api/events`                 | Server-sent invalidation stream                  |

The surface is read-only: any method other than `GET` returns `405`.

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
carries hints and has no replay, restoring the *connection* does not restore the
*view*:

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
| `syncing`      | a stream is up; the displayed route has not been re-queried  |
| `live`         | connected, and this route was queried under this connection  |
| `reconnecting` | the stream dropped; `EventSource` is retrying                |

The invariant is: **once the dashboard says `live`, the current route has been
re-queried after the most recent stream connection was established.** It is
expressed as a sync token pairing the connection epoch with the route key — a
new connection bumps the epoch, a navigation changes the route key, and a
refresh adopts the token it started under only when it *succeeds*. A failed
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

### Relationships the domain does not model

Two things a dashboard would like to show do not exist in the current schema:

- requirements belong to projects and milestones; no task/requirement
  association is persisted;
- the task record carries no milestone reference.

Both are published as `{ availability: "unavailable", reason, explanation }`
rather than as an invented value. When the domain models them, the field becomes
`{ availability: "available", value }` without a change to the surrounding
contract.

### Derived states are limited to persisted facts

There is no heartbeat, so "unreachable" or "stalled" are not derivable and are
not invented. Pipeline runs have no `failed` status — a rejected stage cancels
the run — and the read model says so.

Agent activity has exactly one value, chosen by this precedence:

| State              | Exact definition                                                                  |
| ------------------ | --------------------------------------------------------------------------------- |
| `disabled`         | `agent.enabled` is false. Nothing else can override it.                            |
| `working`          | at least one active `AgentRun` (`queued`, `preparing`, `running`, `reviewing`).     |
| `awaiting_approval`| no active run, and at least one assigned active stage is `awaiting_approval`.       |
| `assigned`         | no active run, and at least one active pipeline stage is assigned to this agent.    |
| `last_run_failed`  | no active run and no active stage, and the most recently updated run failed.        |
| `idle`             | none of the above.                                                                  |

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
is per *task* — and pipeline assignment does not reject an agent merely because
another active stage already names it. Both are valid persisted facts, and
inventing a write-side one-job-per-agent rule to simplify a read model would be
a scheduling decision, not a dashboard decision.

So `AgentState` carries lists rather than a single `currentRun`/`currentStage`
that would silently drop real work:

| Field                 | Guarantee                                                        |
| --------------------- | ---------------------------------------------------------------- |
| `activeRuns`          | `{ total, items, truncated }`; `total` is the exact active count  |
| `activeStages`        | `{ total, items, truncated }`; `total` is the exact active count  |
| `primaryRun`          | `activeRuns.items[0]` — a *representative*, not a uniqueness claim |
| `primaryStage`        | `activeStages.items[0]` — likewise                                |

Selection is deterministic: active runs are ordered by `updated_at` descending
with ties broken by run id descending; active stages by their pipeline run's
`updated_at` descending with ties broken by pipeline run id ascending. The
derived state itself reads only the *exact counts* — including a separate exact
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
- `ui/app.ts` — the browser shell: fetch, the invalidation stream, and the
  single DOM write.

The first two are unit tested directly. There is no headless-browser test: the
repository has no browser test tooling, and adding one was out of scope. The
shell is kept small enough that its untested surface is a fetch, a stream
subscription, and an assignment.

Pipeline stages are rendered from the persisted run definition — stage names and
order come from the manifest revision the run pinned. No role vocabulary is
hardcoded.
