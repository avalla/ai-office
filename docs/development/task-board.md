# Task board, lifecycle, and reconciliation

`task:list` is an **operational board**. It is not a list of reminders, and its
`STATUS` column is not decoration: `task.status` is the authoritative record of
what the office is doing with a unit of work.

## Three kinds of state

| Aggregate | Represents | Status means |
| --- | --- | --- |
| **Requirement** | what must be true, accepted, and verified | specification and acceptance state |
| **Task** | a unit of work the office is expected to execute | operational progress |
| **PipelineRun** | one concrete orchestration attempt for a task | execution state |

Review and approval are governance over work or artifacts. A review may
contribute to a decision to complete a task; it never silently overwrites task
state.

None of these derives another. In particular, **verified requirements do not
complete a task**, and a completed task does not verify a requirement.

## The task lifecycle

```text
pending        -> running | blocked | cancelled
assigned       -> running | blocked | cancelled
running        -> waiting_review | completed | blocked | failed | cancelled
blocked        -> pending | failed | cancelled
waiting_review -> completed | blocked | failed | cancelled
completed      -> (terminal)
failed         -> (terminal)
cancelled      -> (terminal)
```

The table lives in `packages/domain/src/task/task.ts` and is the single
definition. The aggregate's methods validate against it, the CLI reads it for
preflight, and reconciliation reads it before proposing a repair — so a change
to the lifecycle cannot leave one of them out of date.

**Terminal states are final.** Nothing reverses `completed`, `failed`, or
`cancelled`. That is an invariant, not a policy: a board that can reopen
finished work can fabricate project history.

### Commands

| Command | Transition |
| --- | --- |
| `task:start` | `pending`/`assigned` → `running` |
| `task:submit-review` | `running` → `waiting_review` |
| `task:complete` | `running`/`waiting_review` → `completed` |
| `task:block --reason <text>` | non-terminal → `blocked` |
| `task:unblock` | `blocked` → `pending` |
| `task:fail --reason <text>` | `running`/`waiting_review`/`blocked` → `failed` |
| `task:cancel [--reason <text>]` | any non-terminal → `cancelled` |

```bash
ai-office task:start --project <project-id> --task <task-id>
ai-office task:complete --project <project-id> --task <task-id>
```

Every transition validates the current state, refuses an impossible one with an
error naming what *is* allowed, runs in one transaction with its audit event,
moves `updated_at`, and never writes the status column directly. Transitions are
deliberately **not idempotent**: repeating one is either an operator mistake or a
stale plan, and both deserve an error rather than silence.

**There is no `task:set-status`.** An unrestricted terminal-state write is the
escape hatch that makes a lifecycle meaningless; the same danger was identified
while probing `requirement:set-status`.

`--reason` is mandatory for `block` and `fail` and optional for `cancel`. It is
validated at the application boundary, not merely required at the CLI: a blank
or whitespace-only reason is refused, and the text is trimmed and bounded at
2000 characters before anything is written. The reason is recorded on the audit
event rather than on the aggregate: `task` has no column for it, and adding one
is a schema decision this lifecycle does not need.

### Recording work completed outside the lifecycle

`pending → completed` is not in the table, and it is not going to be. A task
that never started cannot be completed by the lifecycle, because the lifecycle
describes execution AI Office observed.

Work that happened before AI Office tracked it is a different statement, so it
has its own command:

```bash
# 1. read-only preflight; prints the evidence, the consequence, and a plan hash
ai-office task:record-completion --project <id> --task <id> --reason <text>

# 2. apply exactly that attestation
ai-office task:record-completion --project <id> --task <id> --reason <text> \
  --approve <planHash>
```

```text
AUC-03  Deliver the audit slice
  status: pending
  linked requirements: 2/2 verified (0 open)

  operation: historical correction, not a lifecycle transition
  resulting status: completed
  rationale (required): delivered in the M4 release before the board tracked it

  This records that the work was already completed outside the lifecycle
  AI Office holds. No task:start is emitted and no execution is claimed.
```

It means exactly one thing: *the operator attests that this work was already
completed outside the lifecycle AI Office currently represents, and is recording
that fact now.*

It is **not** equivalent to `task:start` followed by `task:complete`. That
sequence would enter a moment at which work began that nobody observed, in order
to record work that happened outside the record — the opposite of what a
correction is for. No `task.status_changed` event is written, so no fabricated
`start` exists in the trail.

It is **not** a generic `task:set-status` either. It is narrower than the
lifecycle in every direction:

| | Lifecycle | Historical correction |
| --- | --- | --- |
| target statuses | seven | exactly `completed` |
| source statuses | per the table | only `pending`, `assigned`, `blocked` |
| terminal states | irreversible | irreversible |
| overlap with `task:complete` | — | refused; the preflight names `task:complete` instead |
| rationale | mandatory for `block`/`fail` | always mandatory |
| approval | none | plan hash from a preceding read-only run |

The source set is *derived* from the transition table rather than restated
beside it — it is the non-terminal statuses from which `completed` is not
reachable — so the two can never drift apart. Where `task:complete` works, the
correction is refused and points at it.

The audit event is distinct from ordinary execution:

```json
{
  "eventType": "task.completion_recorded",
  "payload": {
    "operation": "record-completion",
    "from": "pending",
    "to": "completed",
    "reason": "delivered in the M4 release before the board tracked it",
    "correction": true,
    "evidence": { "total": 2, "verified": 2, "terminal": 2, "open": 0 },
    "planHash": "…"
  }
}
```

`evidence` records what the operator was shown, not what the system concluded.
The plan hash covers the task, the status it is corrected from, the rationale,
and that evidence, so an operator can never approve one attestation and execute
another; if any of them changes, the approval is refused and a fresh preflight
is required.

### Preflight

```bash
ai-office task:transitions --project <project-id> --task <task-id> [--json]
```

```text
Current state: running

Allowed transitions:
  waiting_review	task:submit-review
  completed	task:complete
  blocked	task:block
  failed	task:fail
  cancelled	task:cancel

Terminal:
  completed
  failed
  cancelled
```

Discovery **never mutates**. Each allowed transition names the command that
performs it, so an agent can decide before acting.

## Requirement linkage

The relation is explicit and many-to-many:

```bash
ai-office task:link-requirement --project <id> --task <id> --requirement <id>
ai-office task:unlink-requirement --project <id> --task <id> --requirement <id>
```

- one task may deliver several requirements, and one requirement may need
  several tasks, so neither side is a column on the other;
- linking is **idempotent** — unlike a lifecycle transition, a link is a fact
  about a relation, not an event, so asking for one that already holds is not an
  error and emits no second audit record;
- a link may never cross a project boundary. The application checks both ends,
  and `task_requirement_project_ownership_insert`/`_update` refuse it in SQL
  even if a caller bypasses the service;
- deleting a task or requirement cascades the link away, so a dangling
  reference is impossible;
- **nothing is inferred.** A task titled `AUC-03` is not linked to a requirement
  keyed `AUC-03` until an operator says so. Persisting a guess is worse than
  persisting nothing.

## The board

```text
ID       STATUS       REQUIREMENTS   PRIORITY   TITLE
AUC-03   completed    2/2 verified   10         Deliver the auction flow
AUC-04   running      1/3 verified   10         Harden settlement
AUC-05   pending !    1/1 verified   10         Publish the report
```

`STATUS` is always the task's own state. Requirement progress is a separate
column, computed only from **explicitly linked** requirements. Where the two
contradict each other, the row is marked `!` and a warning is written to stderr:

```text
warning: task AUC-05 is pending while all linked requirements are terminal;
run ai-office task:reconcile --project <id> for details
```

The presentation layer never rewrites the status to hide the contradiction.

## Reconciliation

```bash
ai-office task:reconcile --project <project-id> [--json]
```

**The default operation is read-only.** It compares each task against its
pipelines, agent runs, and linked requirements and reports:

| Finding | Severity | Meaning |
| --- | --- | --- |
| `terminal_pipeline_open_task` | inconsistent | a pipeline ended; its task did not follow |
| `active_pipeline_terminal_task` | inconsistent | a pipeline is still running under a finished task |
| `stale_pending_task` | warning | nothing started, yet every linked requirement is terminal |
| `completed_task_open_requirements` | warning | work is done while acceptance is still open |
| `in_flight_task_without_execution` | warning | the board says in flight; no pipeline or agent run is active |

`in_flight_task_without_execution` is suppressed when
`terminal_pipeline_open_task` already fired for the same task: it is the same
situation described more precisely, and reporting it twice would make one defect
look like two.

## Repair is explicit and narrow

```bash
# 1. read-only; prints the plan and its hash
ai-office task:reconcile --project <id>

# 2. apply exactly that plan
ai-office task:reconcile --project <id> --fix --approve <planHash>
```

`--fix` never runs without `--approve`, following the same convention as
`client:apply` and `runtime:purge`. The hash covers the exact repairs listed, so
a plan that has gone stale is refused rather than reapplied to different state.
Every repair goes through the lifecycle service, so the domain guard and the
audit event are the ones a manual command would produce.

**One approved plan is one transaction.** The plan is re-derived inside that
transaction and the approval checked against it, then every repair is applied
through the lifecycle service without opening a nested transaction. Either all
approved repairs commit or none do: committing a prefix would leave the project
in a state nobody approved, while the plan hash the operator holds went on
claiming otherwise.

**Only one finding is repairable**: `terminal_pipeline_open_task`, whose correct
outcome existing code already defines — it is what `syncTaskTerminal` would have
written had its transaction not been interrupted. Even that is refused when the
evidence is ambiguous: pipelines that ended differently, an active pipeline
alongside a terminal one, or a task whose current status cannot reach the target
in one transition.

Everything else is reported and refused:

```text
AUC-03

Current task state:
  pending

Evidence:
  pipeline: none
  requirements:
    AUC-03-R1 verified
    AUC-03-R2 verified

Automatic repair:
  REFUSED

Reason:
  requirement completion alone is insufficient evidence that operational work
  completed.

Available explicit correction:
  task:record-completion
```

Conservative refusal is deliberate. Requirements may be verified by work done
elsewhere, one requirement may be delivered by several tasks, and implementation
often finishes before governance verification — so "all requirements verified"
does not prove this task executed.

Automatic reconciliation and explicit operator correction are not in tension:

- reconciliation **cannot** complete a pending task from requirement evidence
  alone, because that would be an inference;
- the operator **may** record that already-completed work was omitted from
  operational history, because that is an authoritative statement.

The system never infers the second from the first.

**Every suggestion is executable from the status shown beside it.** A report
never names `task:complete` for a `pending` task: the lifecycle would reject it,
and the only way to force it through would be to fabricate the intermediate
history this board exists to protect. For stale pending work the suggestion is
`task:record-completion`.

## Pipeline integration

Pipeline-driven transitions remain authoritative and unchanged:

- `pipeline:start` drives `pending`/`assigned` → `running`;
- a successful terminal pipeline drives `running`/`waiting_review` →
  `completed`;
- a cancelled or rejected pipeline drives the task to `cancelled`.

Both call the same domain methods the CLI commands call — there is one
authoritative path per transition, not two — and both commit the pipeline write
and the task write in the same transaction, so a failure cannot leave one
without the other.

## Existing projects

Migration `0026` adds the linkage table and links nothing. Historical state is
**not** rewritten: a project upgraded from before this change keeps whatever
statuses it had. After the upgrade, `task:reconcile` identifies questionable
tasks and the operator corrects them explicitly, with an audit record for each
decision.

Portable archives carry the links in **format version 2**. One `formatVersion`
identifies one schema contract:

| | version 1 | version 2 |
| --- | --- | --- |
| `governance.taskRequirements` | absent, and rejected if present | required |
| `manifest.contents` | seven entries | those seven plus `task_requirements` |
| written when | the project has no links | the project has links |
| read by this build | yes | yes |
| restores links | none | all of them |

Version 1 stays frozen where it shipped. A link-free project still exports
version 1, byte-identical to what it exported before version 2 existed, so
existing archives and their checksums remain valid. A project that has links
exports version 2; writing them into a version 1 envelope is refused rather than
silently dropped, so no linkage is ever lost to a downgrade. Checksums are
canonical within each version and validated independently. Referential closure
is enforced in both: a snapshot can never contain a link whose task or
requirement is not inside it.
