# Coordination protocol v1

Status: proposed with [ADR-0036](../adr/ADR-0036-coordination-bridge-boundary-protocol-trust.md);
nothing in this document is implemented. It is the contract CB-02, CB-04,
CB-05, CB-06, CB-07 and CB-08 build against. The ADR owns the decisions; this
document owns the wire shapes and the planning-change semantics. Field and code
names are normative for review and may be refined only through the task that
implements them, with the change recorded here.

## 1. Principles

- Transport content is data. A message is never a command and never an
  authorization; only the Runtime decides, and only a local approval changes
  authoritative state.
- The Runtime validates every inbound envelope itself. A transport adapter
  supplies provenance, but is trusted no further than the adapter.
- Objects are closed: an unknown field is rejected. The one exception is an
  optional `extensions` map that is size-limited, ignored and never interpreted.
- Free text exists only as display text (`rationale`, `note`) with a hard size
  limit. It never selects an operation, a target or an approval.
- Minimization applies in both directions: Runtime-originated messages carry
  only fields classified for the destination (ADR-0036 Decision 7).

## 2. Envelope

```json
{
  "protocol": { "name": "ai-office.coordination", "version": 1 },
  "kind": "planning_proposal",
  "requestId": "01J9Z7K3Q8W4X2V6B5N1M0TRCP",
  "correlationId": "01J9Z7K0E2R8T4Y6U1I3O5PASD",
  "inReplyTo": "snapshot:sha256:9f2c…",
  "project": { "identity": "repo:sha256:…" },
  "createdAt": "2026-10-15T19:00:00Z",
  "author": { "kind": "agent", "claimedId": "chatgpt", "label": "ChatGPT" },
  "payload": {}
}
```

| Field                               | Required           | Meaning                                                                                   |
| ----------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `protocol.name`, `protocol.version` | yes                | Exactly `ai-office.coordination` and a supported integer major version                    |
| `kind`                              | yes                | One of the six kinds of section 3                                                         |
| `requestId`                         | yes                | Sender-generated unique identifier (ULID or UUID), the idempotency key                    |
| `correlationId`                     | yes                | Groups one conversation (a snapshot, its proposals, feedback and receipts)                |
| `inReplyTo`                         | no                 | A `requestId`, `snapshot:<digest>` or `plan:<digest>` this message answers                |
| `project.identity`                  | yes                | The portable repository identity, never a runtime-local project UUID                      |
| `createdAt`                         | yes                | Sender clock, ISO-8601 UTC, informational; ordering uses Runtime receipt time             |
| `author`                            | for external kinds | A claim: `kind` is `human`, `agent` or `system`; `claimedId` and `label` are display only |
| `payload`                           | yes                | Kind-specific closed object                                                               |

Transport provenance is not part of the sender's envelope. The adapter attaches
it beside the envelope when handing it to the Runtime:

```json
{
  "transport": {
    "type": "github_issue_comment",
    "locator": {
      "repository": "owner/coordination",
      "issue": 12,
      "comment": 3456
    },
    "account": { "id": "1234567", "login": "someone" },
    "receivedAt": "2026-10-15T19:00:03Z",
    "contentDigest": "sha256:…"
  }
}
```

`account.id` is the immutable numeric account identifier; `login` is display
only. The pair (`transport.type`, `transport.locator`, `contentDigest`) makes a
received message traceable. The Runtime records `author` (claim), `transport`
(provenance) and the local operator (authority) as three different things.

For a remote MCP caller the provenance is the verified principal
(`issuer`, `subject`) and scope, recorded the same way; an MCP caller can read
only and sends no envelope.

## 3. Message kinds

| Kind                  | Direction          | Creates Runtime state  | Purpose                                           |
| --------------------- | ------------------ | ---------------------- | ------------------------------------------------- |
| `status_snapshot`     | Runtime → external | no                     | Minimized planning snapshot                       |
| `review_request`      | Runtime → external | no                     | Asks an assistant to analyse a snapshot or plan   |
| `planning_proposal`   | external → Runtime | a proposal record only | Typed planning changes                            |
| `decision_request`    | either direction   | a record only          | A question the owner must answer locally          |
| `proposal_feedback`   | both               | notes only             | Assessment (Runtime) or advisory notes (external) |
| `application_receipt` | Runtime → external | no                     | Outcome of an applied or refused plan             |

Only `planning_proposal` can lead, through the workflow of section 8, to a
change of planning state. No kind changes a task, requirement, milestone or
dependency by itself.

### 3.1 `status_snapshot`

`payload`: `snapshotId` (`snapshot:sha256:<digest of the minimized projection>`),
`generatedAt`, `schemaVersion`, `scope` (project, optional milestone filter),
`classes` (the data classes included, normally `P` and optionally `T`),
`page` (`offset`, `limit`, `total`, `truncated`), `milestones`, `tasks`
(id, title if `T`, recorded and operational status, priority, milestone ids,
prerequisite ids, `ready`, `waiting`), `requirements` (id, key, status,
milestone id, task ids), `blockers`, `runnable`, `inconsistencies` (typed
codes), and `derived` (analysis kept apart from authoritative fields). The
identifier is deterministic: the same state yields the same snapshot bytes.
There is no revision counter; the digest is the revision.

### 3.2 `review_request`

`payload`: `subject` (`snapshotId` or `planId`), `questions` (a closed set:
`consistency`, `priorities`, `blockers`, `dependencies`), `deadline` optional.
Runtime generated only; contains no agent-authored text.

### 3.3 `planning_proposal`

`payload`:

```json
{
  "expectedSnapshot": "snapshot:sha256:9f2c…",
  "supersedes": "01J9Z7…",
  "operations": [
    {
      "op": "set_priority",
      "taskId": "…",
      "priority": 90,
      "expectedPriority": 50
    },
    { "op": "add_dependency", "taskId": "…", "dependsOnTaskId": "…" },
    { "op": "remove_dependency", "taskId": "…", "dependsOnTaskId": "…" }
  ],
  "rationale": "display text, at most 2048 bytes"
}
```

`operations` has between 1 and 20 entries. Advisory operations
(`suggest_scope_change`, `suggest_requirement_change`, `suggest_milestone_change`)
may appear alone or with typed ones, carry identifiers and a closed reason code,
and are recorded for the owner but never enter a plan. `priority` is an integer
in the existing task range. `expectedSnapshot` is advisory: a mismatch is a
warning at assessment, because the preconditions of section 8.2 are the guard.
`supersedes` withdraws an earlier request that is not yet applied.

### 3.4 `decision_request`

`payload`: `question` (Runtime-generated or at most 512 bytes of display text),
`options` (2 to 5 `{ id, label }`), `subject` (snapshot, plan or task id),
`deadline`. It is a question, not a vote: the answer is recorded by a local
operator command. A reply posted on the transport is a `proposal_feedback` note
and is not an answer.

### 3.5 `proposal_feedback`

From the Runtime: `requestId` of the proposal, `state` (`received`, `validated`,
`assessed`, `rejected`, `superseded`, `expired`), `findings` (code, severity
`error` or `warning`, target ids), and for an assessed proposal a `preview`
(human summary) and `planDigest`. From an external party: `notes`, display only,
stored against the proposal, never part of a plan.

### 3.6 `application_receipt`

From the Runtime only: `planId`, `planDigest`, `outcome` (`applied`, `refused`),
for `applied` the effective changes per operation (`from`, `to`, audit event
identifier), `scopeDigestBefore`, `scopeDigestAfter`, `appliedAt`, `approver`
(principal, trusted-local level), and for `refused` the typed sanitized cause
(for example `STALE_PLAN`, `PLAN_EXPIRED`, `NOT_APPROVED`). Receipt content
contains identifiers, never secrets or internal traces.

## 4. Identity, idempotency and correlation

- Idempotency key: `requestId`, unique per project and source. The Runtime
  stores the content digest of the first acceptance.
- Replay: the same `requestId` with the same digest returns the original
  outcome without side effects (`DUPLICATE_REQUEST`, informational). The same
  `requestId` with a different digest is `DUPLICATE_REQUEST_CONFLICT` and is
  rejected; the sender uses a new `requestId` and `supersedes`.
- Outbound messages derive their identifier from their content digest so a
  republication after a crash is recognizable as the same message.
- `correlationId` ties a conversation; `inReplyTo` names the specific message.
  Neither grants any authority.
- Ordering is by Runtime receipt time and the persisted transport cursor, not by
  sender clocks.

## 5. Versioning and compatibility

- The protocol version is an integer major. A reader accepts exactly the majors
  it supports and answers `UNSUPPORTED_VERSION` with the supported list.
- Within a major, evolution is additive only, through new optional payload
  fields that a reader of the same major ignores, or through `extensions`. A
  field that changes meaning, becomes required or changes a limit needs a new
  major.
- A new major is supported alongside the previous one for at least two
  releases before the older is removed.
- Snapshot and tool schemas carry their own `schemaVersion` and follow the same
  rule; compatibility is tested against recorded fixtures.

## 6. Errors

Typed, sanitized, stable codes. Messages never include secrets, stack traces,
filesystem paths or internal identifiers beyond the ones the caller sent.

| Code                         | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `UNSUPPORTED_VERSION`        | Major version not supported                                   |
| `SCHEMA_INVALID`             | Envelope or payload violates the closed schema                |
| `PAYLOAD_TOO_LARGE`          | Above a limit of section 7                                    |
| `KIND_NOT_ALLOWED`           | Kind not accepted from this direction or source               |
| `SOURCE_NOT_ALLOWED`         | Transport account not on the owner allowlist                  |
| `PROJECT_SCOPE_MISMATCH`     | Project identity does not match the bound project             |
| `DUPLICATE_REQUEST`          | Replay of an accepted message (informational)                 |
| `DUPLICATE_REQUEST_CONFLICT` | Same id, different content                                    |
| `UNKNOWN_TARGET`             | A referenced task does not exist in the project               |
| `OPERATION_NOT_ALLOWED`      | Operation not in the closed set for the current phase         |
| `OPERATION_INVALID`          | Fails the operation rules (for example priority out of range) |
| `CYCLE_DETECTED`             | Adding the dependency would create a cycle                    |
| `NOT_EDITABLE`               | The task can no longer change prerequisites                   |
| `STALE_PLAN`                 | A precondition no longer holds                                |
| `PLAN_EXPIRED`               | Approval expired                                              |
| `NOT_APPROVED`               | Plan has no valid approval                                    |
| `DIGEST_MISMATCH`            | Approval digest differs from the plan digest                  |
| `RATE_LIMITED`               | Limit reached                                                 |
| `INTERNAL_ERROR`             | Anything else, without detail                                 |

Assessment distinguishes errors (the plan cannot be applied) from warnings
(redundant operation, advisory mismatch, overlap with another plan).

## 7. Limits

Envelope at most 32 KiB; at most 20 operations; `rationale` at most 2 KiB;
identifier and label strings at most 256 bytes; `extensions` at most 2 KiB;
snapshot page default 50 and maximum 200 items; one published message at most
64 KiB. A limit failure is `PAYLOAD_TOO_LARGE` before parsing the payload.

## 8. Planning changes: plans, approval, apply and revision conflicts

### 8.1 Plan

An assessed proposal yields a plan: the ordered typed operations, the
preconditions of 8.2 with the values observed at assessment time, a
machine-readable impact (cycles, blocked and unblocked tasks, milestone impact,
redundancy, conflicts) and a human preview. The plan digest is
`sha256` over the canonical JSON (sorted keys, no insignificant whitespace,
UTF-8) of the protocol version, project identity, ordered operations and
preconditions. It excludes time, the approver and the transport. Preview never
touches the graph.

### 8.2 Preconditions and the scope digest

There is no global revision counter and none is introduced. Preconditions are
recorded per operation and checked again at apply time:

| Operation           | Preconditions                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `set_priority`      | task exists in the project; recorded priority equals `expectedPriority`; task is not terminal                                             |
| `add_dependency`    | both tasks exist in the project; edge absent; task is editable (`pending` or `blocked`, no execution history); adding it creates no cycle |
| `remove_dependency` | both tasks exist; edge present; task is editable                                                                                          |

The scope digest is the `sha256` of: for each task referenced by any operation,
its recorded status, priority and editability, and the sorted edge set inside
the prerequisite closure of each dependency target. Unrelated edits elsewhere in
the project do not change it, so they do not cause false conflicts. A
redundant operation (an edge already present, a priority already equal) is a
warning at assessment and a refusal at apply only if the stored preconditions no
longer hold.

### 8.3 Approval

`coordination:approve --plan <planId> --digest <planDigest> --actor <operator>`
records an approval: plan identity, digest, approving principal (type
`operator`, level `trusted-local`), `approvedAt` and `expiresAt` (default 24
hours, maximum 72, configurable) and an optional rationale. An approval binds
exactly one digest; it cannot be edited. A plan that changes produces a new
digest and needs a new approval. A GitHub comment, reaction or label, or an MCP
call, never approves. The trusted-local limit applies in full: the Runtime
records the label it is given and does not authenticate presence.

### 8.4 Apply

Apply is one transaction, run through a composing use case that reuses the
existing services' transactional bodies, so no service is bypassed or
duplicated:

1. load the plan and its approval; refuse `NOT_APPROVED`, `PLAN_EXPIRED` or
   `DIGEST_MISMATCH` (the digest is recomputed from the stored plan);
2. recompute every precondition and the scope digest; refuse the whole plan as
   `STALE_PLAN` on any mismatch, listing sanitized causes;
3. apply each operation through `UpdateTask` or `ManageTaskDependencies`,
   which keep their own validation and audit events;
4. in the same transaction, set the plan to `applied`, store the receipt (with
   the effective changes and audit event identifiers) and append a plan-level
   audit event carrying the plan, request, digest and approver.

Any failure rolls the whole transaction back: there is no partial application
and no compensating write. The apply command is idempotent: applying an applied
plan returns the stored receipt, applying a stale plan returns the stored
refusal. The daemon's command queue serializes commands, so no other planning
command interleaves, and preconditions, not locks, close the window between
preview and apply.

Receipt publication is a separate side effect through the publication outbox
(ADR-0036 Decision 8); it never runs inside the apply transaction and retries
after a restart.

### 8.5 Conflicts

- **Stale plan.** Any precondition mismatch refuses the entire plan. There is no
  automatic rebase or merge. The proposer submits a new request with `supersedes`.
- **Concurrent plans.** Plans are assessed independently. Plans whose referenced
  tasks overlap are flagged `conflicts_with` at assessment. The first applied
  wins; the later one fails its preconditions and becomes stale.
- **Execution started.** A dependency edit on a task that has started fails the
  `editable` precondition (`NOT_EDITABLE`) at preview and again at apply.
- **Edited or deleted transport content.** Acquired content is immutable. An
  edit of a not-yet-approved request is a new digest and creates a superseding
  revision; an edit of an approved or applied request is ignored and reported as
  drift (CB-09).
- **Multi-operation plans.** Up to 20 operations apply atomically as above.
  If the transaction-body refactor of Decision 9 is declined, plans are limited
  to one operation and all other rules are unchanged.

### 8.6 Proposal lifecycle

```text
received -> validated -> assessed -> approved -> applied
    |           |            |           |
    +-> rejected (schema, source, scope, version)
                 +-> superseded (newer request supersedes)
                              +-> expired (approval or request window)
                                          +-> stale (apply-time precondition failure)
```

`received`, `validated` and `assessed` change no planning state (V1 gate).
`approved` and `applied` exist from CB-07 and CB-08. Terminal states are
`rejected`, `superseded`, `expired`, `stale` and `applied`.

## 9. GitHub wire format

- One dedicated private repository (owner decision D1) holds only coordination
  traffic: snapshots, proposals, decision requests, feedback and receipts. No
  issue represents a task and no status is mirrored.
- Each protocol message is carried by an issue or a comment whose body contains a
  human-readable summary and exactly one fenced block with the info string
  `ai-office-protocol` holding the JSON envelope. The parser reads only the first
  such block, ignores all other text as prose, bounds the body size, treats the
  body as UTF-8 text and never renders or follows HTML or links.
- Inbound messages are accepted only from the numeric account identifiers on the
  owner-configured allowlist; this is an acceptance filter, not an authorization.
- Hidden markers or titles that look like protocol fields are prose. The
  correlation and identity fields come only from the validated envelope.
- The adapter paginates by the persisted cursor with conditional requests,
  honors rate limits with backoff, and treats an outage as a reason to retry,
  never to fail the Runtime.
- Outbound publication follows the publication lifecycle of ADR-0036 Decision 8:
  Runtime-issued order, single attempt, outcome report, ambiguity resolved by
  looking up the idempotency marker in the destination.

## 10. MCP read contract (summary)

The MCP tool contract is defined by CB-11A and derives from the shared
coordination API. Constraints fixed here: tool names carry the `ai_office_`
prefix; every tool is read-only and annotated so; every response is built by an
explicit mapper from classified fields; the initial scope is `planning:read`
and carries data classes P and T; each response states `schemaVersion`,
pagination and truncation. Initial tools: `ai_office_get_milestones`,
`ai_office_get_milestone`, `ai_office_get_tasks`, `ai_office_get_task`,
`ai_office_get_requirements`, `ai_office_get_dependencies`,
`ai_office_get_planning_blockers`, `ai_office_get_runnable_tasks` and
`ai_office_get_planning_status` (counts of ready, waiting, blocked, in progress
and needing attention, derived from the task graph, with no run, agent or
activity content).
