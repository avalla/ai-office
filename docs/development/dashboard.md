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
`daemonProtocolVersion`. Timestamps are ISO-8601 UTC strings. Unbounded
collections take an explicit, clamped `limit`; activity additionally supports a
`before` keyset cursor.

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
| `GET /api/activity`               | Sanitized audit activity (`?before=`, `?limit=`) |
| `GET /api/events`                 | Server-sent invalidation stream                  |

The surface is read-only: any method other than `GET` returns `405`.

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

Agent activity is `disabled`, `idle`, `working`, `awaiting_approval`, or
`last_run_failed`. There is no heartbeat, so "unreachable" or "stalled" are not
derivable and are not invented. Pipeline runs have no `failed` status — a
rejected stage cancels the run — and the read model says so.

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
- **A per-process session token.** A loopback TCP port is reachable by every
  local Unix account, unlike a 0600 socket. The token — printed to the starting
  terminal, never written to disk — restores that separation. It is exchanged
  once for an `HttpOnly; SameSite=Strict` host-only cookie so it does not linger
  in history or a referrer.
- **A `Host` allowlist.** This blocks DNS rebinding, where a page the user
  visits resolves an attacker-controlled name to 127.0.0.1 and reads responses
  as same-origin.
- **A strict Content-Security-Policy** on served documents: no inline script, no
  external origin, no framing.

The token is a capability, not an identity. It is worth having because it
excludes other local users and hostile web pages; it is not, and must not be
presented as, authentication.

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
