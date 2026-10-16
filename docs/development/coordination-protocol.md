# Coordination protocol v1

Status: accepted with [ADR-0036](../adr/ADR-0036-coordination-bridge-boundary-protocol-trust.md);
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
  "project": { "identity": "<portable repository identity>" },
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

A remote MCP caller sends no envelope and creates no Runtime record. Its verified principal (`issuer`, `subject`) is checked against the Runtime-owned principal registry (ADR-0036 Decision 6), served to the MCP program as a read projection; access itself is logged only in the MCP program's local access log (Decision 7), and the read listener receives no principal and appends no audit row on a read.

## 3. Message kinds

| Kind                  | Direction          | Creates Runtime state  | Purpose                                           |
| --------------------- | ------------------ | ---------------------- | ------------------------------------------------- |
| `status_snapshot`     | Runtime → external | no                     | Minimized planning snapshot                       |
| `review_request`      | Runtime → external | no                     | Asks an assistant to analyse a snapshot or plan   |
| `planning_proposal`   | external → Runtime | a proposal record only | Typed planning changes                            |
| `decision_request`    | either direction   | a record on a proposal | A question the owner must answer locally          |
| `proposal_feedback`   | both               | notes only             | Assessment (Runtime) or advisory notes (external) |
| `application_receipt` | Runtime → external | no                     | Outcome of an applied or refused plan             |

Only `planning_proposal` can lead, through the workflow of section 8, to a
change of planning state. No kind changes a task, requirement, milestone or
dependency by itself.

### 3.1 `status_snapshot`

`payload`: `snapshotId` (`snapshot:sha256:<digest of the complete scoped projection>`),
`generatedAt`, `schemaVersion`, `scope` (project, optional milestone filter),
`classes` (the data classes included, normally `P` and optionally `T`),
`page` (`offset`, `limit`, `total`, `truncated`), `milestones`, `tasks`
(id, title if `T`, recorded and operational status, priority, milestone ids,
prerequisite ids, `ready`, `waiting`), `requirements` (id, key, status,
milestone id, task ids), `blockers`, `runnable`, `inconsistencies` (typed
codes), and `derived` (analysis kept apart from authoritative fields). The identifier is the digest of the complete, scoped, canonical projection computed before pagination, without volatile fields: `generatedAt`, the page window (`page`) and the identifier itself are excluded and live in the envelope metadata, so changing `offset` or `limit` over unchanged state yields the same identifier; each page also carries `pageDigest`, the digest of the canonical page response excluding `pageDigest` itself (metadata such as `total`, `truncated` and `counts` included, as well as the items), so no field of a page can change under an unchanged digest. The same planning state
yields the same canonical projection and the same identifier; there is no
revision counter, the digest is the revision.

Every identifier that leaves the Runtime is computed over the exposed
projection, after the exposure mappers (CB-10): text scrubbed and cut at 256
characters, relationship lists cut at 100 entries, requirements ordered by
exposed key, milestones ordered by id (their creation time is not exposed).
Stored states that differ only in scrubbed or cut text (a scrubbed credential,
a cut title tail) or in milestone creation times therefore share one
identifier, so the identifier cannot confirm a guess about hidden text. List
entries past 100 are cut for size only: they are class P identifiers, and
`counts` and derived analysis still reflect the uncut relationships. The
local `planning:snapshot` command keeps the identifier over stored values; it
is not an exposure channel. An `expectedSnapshot` is compared against the
exposed identifier, and it stays advisory: the preconditions of 8.2 are the
guard.

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
`options` (2 to 5 `{ id, label }`), `subject` (a proposal or plan identifier; a decision request always attaches to a proposal),
`deadline`. It is a question, not a vote: the answer is recorded by a local
operator command. A reply posted on the transport is a `proposal_feedback` note
and is not an answer.

### 3.5 `proposal_feedback`

From the Runtime: `requestId` of the proposal, `state` (`received`, `validated`,
`assessed`, `rejected`, `superseded`, `expired`), `findings` (code, severity
`error` or `warning`, target ids). `assessed` has two levels, carried as
`assessmentLevel`: `structural` (V1, CB-04: schema, source, project scope,
allowed operations, target existence) and `impact` (V2, CB-06: simulation, plan,
`preview` and `planDigest`). V1 never returns a plan or digest. From an external
party: `notes`, display only, stored against the proposal, never part of a plan.

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
- An outbound message uses the publication intent identifier as its
  `requestId`, so a retry or crash recovery of the same intent is recognizable as
  the same message, while a deliberate republication of unchanged content is a
  new intent. The content digest is recorded beside it, not used as identity.
- `correlationId` ties a conversation; `inReplyTo` names the specific message.
  Neither grants any authority.
- Ordering is by Runtime receipt time and the persisted transport cursor, not by
  sender clocks.

## 5. Versioning and compatibility

- The protocol version is an integer major. A reader accepts exactly the majors
  it supports and answers `UNSUPPORTED_VERSION` with the supported list.
- Objects are closed, so a reader of a major rejects fields it does not know.
  Within a major the only additive evolution is the `extensions` map, which every
  reader ignores and which may never carry data that could weaken validation,
  authority or a precondition. Any other new field, a new kind or operation, a
  field that changes meaning or becomes required, or a changed limit needs a new
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
| `RUNTIME_BUSY`               | A transaction was already active; retry, nothing was consumed |
| `INTERNAL_ERROR`             | Anything else, without detail                                 |

Warning codes: `TASK_TERMINAL`, `REDUNDANT_OPERATION`, `SNAPSHOT_MISMATCH` and `CONFLICTS_WITH`. Assessment distinguishes errors (the plan cannot be applied) from warnings
(redundant operation, advisory mismatch, overlap with another plan).

## 7. Limits

Envelope at most 32 KiB; at most 20 operations; `rationale` at most 2 KiB;
identifier and label strings at most 256 bytes; `extensions` at most 2 KiB;
snapshot page default 50 and maximum 200 items; one published message at most
64 KiB. A limit failure is `PAYLOAD_TOO_LARGE` before parsing the payload.

## 8. Planning changes: plans, approval, apply and revision conflicts

### 8.1 Plan

From V2 (CB-06 onward) an impact-assessed proposal yields a plan: the ordered
typed operations, the preconditions of 8.2 with the values observed at
assessment time, a
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
| `set_priority`      | task exists in the project; recorded priority equals `expectedPriority` (a terminal task only yields the warning `TASK_TERMINAL`)         |
| `add_dependency`    | both tasks exist in the project; edge absent; task is editable (`pending` or `blocked`, no execution history); adding it creates no cycle |
| `remove_dependency` | both tasks exist; edge present; task is editable                                                                                          |

Two kinds of check apply. **Initial-state preconditions** (targets exist, the
expected priority, the scope digest) are compared with the state before any
operation. **Sequential validity** (edge present or absent, editability, no cycle)
is evaluated operation by operation against the state produced by the earlier
operations, at assessment by simulation on an in-memory graph and at apply by
the services themselves. A plan may not repeat an edge or change one task's
priority twice (`OPERATION_INVALID`). So `remove A→B; add B→A` is valid, and
`add A→B; add B→A` fails as `CYCLE_DETECTED` at assessment.

The scope digest is the `sha256` of: for each task referenced by any operation,
its recorded status, priority and editability, and the sorted edge set inside
the prerequisite closure of each `dependsOnTaskId` (the tasks reachable by
following prerequisites from it, which is where a new cycle would appear). Unrelated edits elsewhere in
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
2. recompute the initial-state preconditions and the scope digest; refuse the
   whole plan as `STALE_PLAN` on any mismatch, listing sanitized causes;
3. apply the operations in order through `UpdateTask` or
   `ManageTaskDependencies`, which keep their own validation and audit events; a
   service failure in the middle maps to `CYCLE_DETECTED`, `NOT_EDITABLE`,
   `UNKNOWN_TARGET` or `OPERATION_INVALID` and rolls everything back;
4. in the same transaction, set the plan to `applied`, store the receipt (with
   the effective changes and audit event identifiers), record the receipt
   publication intent for the outbox and append a plan-level audit event
   carrying the plan, request, digest and approver.

Any failure rolls the whole transaction back: there is no partial application
and no compensating write. A refusal (stale, expired, digest mismatch) is then
recorded in its own short transaction so it can be returned again. The apply
command is idempotent: applying an applied plan returns the stored receipt,
applying a refused plan returns the stored refusal.

Concurrency has two parts. The recheck of the preconditions inside the apply
transaction (`BEGIN IMMEDIATE`) closes the window between preview and apply
against other planning commands. It does not, alone, make the apply atomic:
`BEGIN IMMEDIATE` excludes other database connections, not other asynchronous
callers on the same connection, and `run:tick` and the queue runtime bypass the
daemon queue, call the Runtime directly and change task status on that
connection, so their writes could be committed or rolled back with the plan.
Writer exclusion is therefore a precondition of CB-08 (ADR-0036 Decision 9):
every writer is serialized through one gate that apply also takes, or
connection-level transaction ownership stops unrelated writes from joining, and
this touches the daemon and needs owner approval. Until it holds, and until the transaction-body refactor is delivered (8.5), apply is disabled: even a one-operation apply on the shared connection has the same hazard, so no apply is attempted and a plan stays at its approved state until its expiry. Apply is
submitted through the command queue; if it meets an already active transaction it
returns the retryable `RUNTIME_BUSY` and leaves the approval unconsumed.

Receipt publication is a separate side effect through the publication outbox
(ADR-0036 Decision 8); it never runs inside the apply transaction, is idempotent
through the publication marker, retries after a restart and is converged by
reconciliation (CB-09).

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
- **Multi-operation plans.** Up to 20 operations apply atomically as above, with
  the sequential semantics of 8.2.
- **Apply prerequisites and no degraded mode.** Apply is available only when
  both are delivered and approved: the transaction-body refactor of Decision 9
  (so the operations, the plan state, the receipt, the publication intent and
  the audit events commit in one transaction) and the writer exclusion of 8.4
  (or an alternative that demonstrably gives the same guarantees, including one
  transaction and a recoverable receipt). Both apply to
  every plan, a one-operation plan included. If either is missing, declined or
  not yet delivered, apply fails with no mutation and the plan stays at its
  approved state until it expires. No fallback exists: an apply through a
  service that commits on its own cannot be made all-or-nothing, because a
  crash between that commit and the plan bookkeeping would leave a change
  applied with no recoverable authoritative receipt, and the retry would be
  refused as `STALE_PLAN`.

### 8.6 Proposal lifecycle

```text
received -> validated -> assessed -> approved -> applied
    |           |            |           |
    +-> rejected (schema, source, scope, version)
                 +-> superseded (newer request supersedes)
                              +-> expired (approval or request window)
                                          +-> stale (apply-time precondition failure)
```

`received`, `validated` and a structural `assessed` change no planning state (V1 gate); an impact `assessed` adds the plan and exists from CB-06.
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
  Runtime-issued order, lease, one attempt, outcome `published`, `failed`
  (definitive, terminal), `not_sent` (safe to retry) or `ambiguous` (resolved by
  looking up the intent marker in the destination, never replayed blindly). The
  Runtime later reads published messages back and compares their content digest
  with its record, so an edited or forged message is reported as drift (CB-09).

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
