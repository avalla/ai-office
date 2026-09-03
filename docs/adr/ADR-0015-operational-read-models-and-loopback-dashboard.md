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

Where existing per-aggregate repositories can answer a question without a query
per project, they are reused. `OperationalReadRepository` is added only for the
cross-project roll-ups and joins they cannot serve without an N+1 explosion.

### Divergence and unavailability are reported, never hidden

`TaskOperationalState` carries both the persisted `recordedStatus` and a derived
`operationalStatus` in a distinct vocabulary, plus `divergenceReasons` naming
the persisted fact the task record does not reflect. The two unmodelled
relationships are published as `{ availability: "unavailable", reason }` rather
than as an invented or defaulted value.

### Invalidation hints, not a second event store

An in-memory bus publishes topics after a command completes. Topics carry no
state, so the stream cannot become a competing source of truth: a subscriber
that misses an event is stale until the next one or until it reconnects, and can
never be wrong. Nothing new is persisted.

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
socket is not. Two measures address that honestly:

- a per-process session token, printed to the starting terminal and never
  written to disk, restores separation from _other local users_;
- a `Host` allowlist blocks DNS rebinding, where a page the user visits resolves
  an attacker-controlled name to 127.0.0.1 and reads responses as same-origin.

Neither authenticates a human, and neither separates same-UID processes. Any
process running as this user can read the terminal or talk to the daemon socket
directly. That is the same limit already recorded in the current trust model,
and this surface does not change it. The dashboard running in a browser is not
authentication and must never be described as such.

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
- No index was added. These queries reuse existing access paths; speculative
  indexes were not introduced.
- Invalidation is coarse: a completed command may invalidate more than it
  changed. It never claims a change did not happen.
