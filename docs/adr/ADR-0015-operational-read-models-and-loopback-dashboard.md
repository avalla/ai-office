# ADR-0015: Operational read models and a loopback dashboard host

Status: accepted

## Context

AI Office persists project, task, requirement, milestone, pipeline, agent-run,
review, approval, and audit state, and the CLI exposes parts of it one command
at a time. Answering an operational question — what is being worked on, what is
waiting for a human, where is a run in its pipeline — required reading several
commands and joining them by eye.

Two facts about the current model constrain any observability surface:

1. Persisted records do not always express their operational meaning.
   `ScheduleAgentRun` deliberately does not transition the task it schedules, so
   a task legitimately reads `pending` while a run for it is already executing.
   Only pipeline start and completion transition a task.
2. Some relationships a human would expect are not modelled at all. Requirements
   belong to projects and milestones; no task/requirement association is
   persisted, and the task record carries no milestone reference.

A dashboard that re-derived meaning in its own code would produce a second,
divergent interpretation of state — and would encode the two gaps above as
guesses.

Separately, the daemon serves protocol version 1 as HTTP over
`<runtime-home>/daemon.sock` with owner-only permissions and opens no TCP
listener. A browser cannot connect to a Unix socket.

## Decision

### An authoritative read-model layer, not a UI feature

Operational state is computed once, in the application layer, and published as
explicit read models (`packages/application/src/read-models/`). The daemon
exposes them over a read-only query surface; the dashboard, and any future CLI
query command or MCP tool, consume the same models.

```text
apps/dashboard -> daemon query API -> application query service
               -> operational read models -> repository ports -> SQLite
```

HTTP handlers parse, validate, and serialize. They contain no SQL and no domain
logic. Read models use ISO-8601 strings so a read model is also its own wire
representation, and the query contract is versioned (`queryApiVersion`)
independently of `daemonProtocolVersion`, because the two change for different
reasons.

The read side owns its own port. `OperationalReadRepository` groups its methods
by the guarantee they carry, because that guarantee is the point:

> A result may be bounded, but bounded evidence must never silently change an
> authoritative count, status, attention decision, or relationship.

- **Authoritative aggregates** are exact SQL counts over every matching row.
  Every total, every status count, and `attentionRequired` come only from these.
- **Scoped projection inputs** are restricted to the exact entities being
  projected and return their current or latest facts — a task's own in-flight
  run, an agent's own active stage. They are bounded by the size of the page
  being rendered, never by a generic window, so the bound cannot omit a fact
  relevant to the entity it describes.
- **Bounded samples and pages** are the only truncatable results. Samples travel
  as `{ total, items, truncated }`; activity travels with an opaque keyset
  cursor.

The command-side repositories stay the command side's. In particular the
dashboard does not reuse `PipelineRunRepository.listByProject`, which returns
whole aggregates oldest-first and unbounded: correct for its consumers, but
slicing it in memory would show a dashboard the project's first runs forever.

### Divergence and unavailability are reported, never hidden

`TaskOperationalState` carries both the persisted `recordedStatus` and a derived
`operationalStatus` in a distinct vocabulary, plus `divergenceReasons` naming
the persisted fact the task record does not reflect. The two unmodelled
relationships are published as `{ availability: "unavailable", reason }` rather
than as an invented or defaulted value.

### Invalidation hints, not a second event store

An in-memory bus publishes topics after a command settles — succeeded _or_
failed. A failed command is not a command that changed nothing: it appended
audit rows, and it may have committed part of its work before failing, so the
failure path publishes the same conservative topic set once its audit event has
landed. Topics carry no state, so the stream cannot become a competing source of
truth: a subscriber that misses an event is stale until the next one or until it
reconnects, and can never be wrong. Nothing new is persisted.

Because there is no replay, a client must treat *establishing a connection* as
its own reason to re-query. Restoring a stream while state changed during the
outage would otherwise leave a healthy-looking connection displaying stale data.
The browser shell therefore refreshes the current route on every newly
established stream, and reports `live` only once that refresh has succeeded; a
connected-but-unsynchronized view reads `syncing`. The rule is expressed as a
sync token pairing the connection epoch with the route key, and the reconnect
refresh reuses the same single-flight-plus-debounce path as invalidations so
reconnect storms, invalidate bursts, and navigation cannot race.

### One definition of a working agent, and concurrency reported as it is

`ProjectSummary.agentsWorking` counts distinct enabled agents holding at least
one active `AgentRun`. `AgentActivityState.working` uses exactly that predicate,
so the aggregate and the per-agent state cannot contradict each other. A stage
assigned before any run is scheduled is a distinct state, `assigned`, rather
than a second meaning of "working".

Neither the schema nor the scheduler enforces one active run or one active stage
assignment per agent: the task lock is per task, and pipeline assignment does
not reject an agent another active stage already names. Adding such a write-side
restriction to make a read model convenient would be a scheduling and
concurrency product decision, not a dashboard one. So `AgentState` publishes
`activeRuns` and `activeStages` as bounded lists with exact totals, plus
deterministically selected `primaryRun` and `primaryStage` representatives. The
derived state reads only the exact counts, so a truncated sample never changes
it, and no concurrent work disappears silently.

### Activity is paged by a real keyset cursor

Activity pages on `(occurred_at, id)`, with the SQL predicate and the ordering
describing the same tuple. Filtering on the timestamp alone skips every event
sharing an instant with the row that ended a page, and audit rows written in the
same millisecond are ordinary. The cursor is opaque so clients cannot depend on
its internals, and the tie breaker is the audit event id rather than the SQLite
`rowid`, which is not a public contract.

### The daemon keeps its socket; the dashboard host owns the TCP port

The daemon does not open a TCP listener. `ai-office dashboard` runs a foreground
loopback host that serves the static bundle and forwards `/api/*` to the daemon
socket. TCP exposure is explicit, user-initiated, and dies with the command.

## Consequences

### Security

This changes no authorization. The query surface is read-only, adds no mutation
endpoint, and introduces no operator marker, trusted header, or caller-selected
privilege. Daemon command authorization is untouched.

The loopback host does introduce one exposure the Unix socket did not have: a
TCP port on 127.0.0.1 is reachable by every local Unix account, whereas a 0600
socket is not. Two measures narrow it:

- a `Host` allowlist blocks DNS rebinding, where a page the user visits resolves
  an attacker-controlled name to 127.0.0.1 and reads responses as same-origin;
- a per-process session token, generated in memory and never written to disk,
  gates every route. Nothing reaches the query surface without it, so a process
  that merely finds the open port — or a page that guesses it — gets nothing.

The token is a **capability against accidental and blind access, not a secret**.
`ai-office dashboard` hands the complete URL to the platform opener, so the
token appears in that process's arguments, and the browser records it in
history. Whether another local account can read either is platform-dependent.
This decision therefore does not claim the token keeps project state secret from
other local users; it claims only that the port is not usable by something that
has never seen the URL. `--no-open` keeps the token out of opener arguments but
cannot keep it out of browser history.

Neither measure authenticates a human, and neither separates same-UID processes.
Any process running as this user can read the terminal or talk to the daemon
socket directly. That is the same limit already recorded in the current trust
model, and this surface does not change it. The dashboard running in a browser
is not authentication and must never be described as such.

A stronger bootstrap is available if that exposure ever matters: put a
single-use, short-lived handoff code in the URL instead of the session token, so
a code recovered later from argv or history is already dead. It was not adopted
here because it breaks reopening the printed link, and the accurate narrower
claim above is the smaller change.

Audit payloads reaching the browser are sanitized at the publication boundary:
only scalars survive, sensitive key names are dropped, strings are truncated,
and anything removed is reported through `detailTruncated`. Run results and
errors are never republished raw — only `hasResult`/`hasError`, a bounded
`{ code, message }` failure summary, and the known controlled-action outcome
shape. Action-intent argument _names_ are published; argument values are not.

### Future command-side operations

A Human Approval Inbox or an authorized control plane would add a command-side
path beside the query surface, not inside it. Those writes go through the
existing application commands, capability policy, approval binding, and audit
model; the dashboard would call them the way the CLI does. Because the current
UI reads models and holds no domain logic, adding that path does not require
rewriting it. Nothing in this decision permits a future client to mutate SQLite
directly.

### Deliberate limits

- The dashboard is a read surface. It cannot start, stop, retry, approve,
  assign, or cancel anything.
- One index was added: `audit_event_aggregate_idx`, for the run-scoped activity
  query. Every other query reuses an existing access path, and no speculative
  index was introduced.
- Invalidation is coarse: a completed command may invalidate more than it
  changed. It never claims a change did not happen.
