# Task lifecycle reconciliation — assessment

Status: complete. Written before any schema or behaviour change, from the code at
`6c8b863`.

## Reported symptom

A project board shows five tasks. `AUC-03` and `AUC-05` are finished work whose
requirements are already terminal, yet `task:list` still prints `pending` for
both. The standing explanation has been:

> The CLI has no `task:set-status`; requirement status is the real state and the
> task list should be read as a reminder of opened work.

That explanation is wrong about the architecture, and this assessment shows why.

## 1. Which aggregate owns operational work state?

`Task` (`packages/domain/src/task/task.ts`). It carries a real `TaskStatus`
lifecycle, semantic transitions, and a persisted status column constrained by
SQL:

```sql
status TEXT NOT NULL CHECK (status IN (
  'pending','assigned','running','blocked',
  'waiting_review','completed','failed','cancelled'))
```
— `migrations/project/0001_initial.sql:13`

The pipeline service already treats it as authoritative: `pipeline:start` calls
`task.start(now)` (`manage-pipeline-runs.ts:85`) and a terminal pipeline calls
`task.complete()` or `task.cancel()` (`:373-374`). Both writes are inside the
same transaction as the pipeline write.

The operational read model published to the dashboard also treats it as
authoritative — `TaskOperationalState.recordedStatus` is `task.status`, and a
divergence between it and observed execution is reported as a defect signal, not
smoothed over (`read-models/operational-projection.ts`).

**Conclusion: `task.status` is operational state, not decoration.** The standing
explanation contradicts the code.

## 2. Which aggregate owns acceptance/specification state?

`Requirement` (`packages/domain/src/governance/governance.ts`). Its lifecycle —
`proposed → accepted → implemented → verified` (or `rejected`) — is acceptance
and verification state, governed by an explicit transition table
(`governanceTransitions.requirement`). It answers *what must be true*, not *what
the office is doing*.

`Milestone` groups requirements. `Review`/`Approval` are append-only governance
decisions over a subject (`task`, `agent_run`, `requirement`, `adr`,
`milestone`). `PipelineRun` is one orchestration attempt for one task.
`AgentRun` is one execution attempt inside it.

## 3. Which lifecycle transitions already exist?

Domain methods on `Task`:

| Method | From | To |
| --- | --- | --- |
| `Task.create` | — | `pending` |
| `start(now)` | `pending`, `assigned` | `running` |
| `complete(now)` | `running`, `waiting_review` | `completed` |
| `cancel(now)` | any non-terminal | `cancelled` |

Everything else in `TaskStatus` — `assigned`, `blocked`, `waiting_review`,
`failed` — has **no transition into it**. `complete()` already accepts
`waiting_review`, so that guard is currently dead code.

## 4. Which transitions are unreachable from the CLI?

**All of them.** The CLI exposes exactly `task:create` and `task:list`
(`apps/cli/src/cli.ts:276-277`). `start`, `complete`, and `cancel` are reachable
only as a side effect of the pipeline commands.

A grep for writers of the remaining statuses returns nothing outside type
declarations, portability enums, and read-model vocabularies:

```
assigned        never written
blocked         never written
waiting_review  never written
failed          never written
```

They are reachable only through restore of an archive that already contains them.

## 5. Under which paths can a task remain permanently stale?

1. **Work done without a pipeline.** Nothing outside `ManagePipelineRuns` moves a
   task. A task worked by hand, by a bare `run:schedule`, or by an external
   agent stays `pending` forever. **This is the reported case.**
2. **Work tracked only through requirements.** Marking requirements `verified`
   never touches a task; there is no relation to traverse (see §6).
3. **Interrupted pipeline start.** `pipeline:start` writes task and pipeline in
   one transaction, so this is safe today — but a *cancelled* pipeline whose task
   was already terminal makes `task.cancel()` throw
   (`InvalidTaskTransitionError`), aborting the transaction.
4. **`assigned` / `blocked` / `waiting_review` / `failed` restored from an
   archive.** Once a task is in one of these states, no code path can move it:
   `start()` accepts `assigned` but is only called by `pipeline:start`; nothing
   accepts `blocked` or `failed` at all.
5. **Agent runs.** `run:schedule` / `run:tick` never transition the task. The
   read model already records this as
   `agent_run_active_without_task_transition`.

## 6. Is there an explicit Task ↔ Requirement relation?

**No.** `requirement` carries `project_id` and `milestone_id`; `task` carries
neither. There is no join table. `TaskOperationalState.requirements` is published
as `{ availability: "unavailable", reason: "task_requirement_link_not_modelled" }`
precisely because the relation does not exist.

The only accidental correspondence is naming convention (`AUC-03` the task title
vs `AUC-03` the requirement key). Inferring linkage from string matching would be
a silent, unverifiable heuristic and must not be persisted.

## 7. Are tasks created from requirements, independently, or both?

**Independently only.** `CreateTask` takes `projectId`, `title`, `description`,
`priority` — no requirement input. `ManageGovernance.createRequirement` creates
no task. There is no generator in either direction.

## 8. Can one task reasonably implement multiple requirements?

Yes. Requirements are fine-grained acceptance statements
(`UNIQUE(project_id, requirement_key)`) while tasks are units of executable work
sized for a pipeline. One task delivering `AUC-03-R1` and `AUC-03-R2` together is
ordinary.

## 9. Can one requirement reasonably require multiple tasks?

Yes. A requirement may need a schema task, an application task, and a
documentation task. Nothing in the schema or domain restricts it.

**Therefore the relation is many-to-many** and neither side can be a foreign key
on the other.

## 10. What backup/restore assumptions would linkage affect?

`project-snapshot.ts` defines a strict, checksummed portable format:

- `portableProjectStateShape` is a `z.strictObject` — unknown keys are rejected;
- `portableProjectManifestSchema.contents` is a fixed `z.tuple` of seven literals;
- `parsePortableProjectArchive` recomputes the state checksum over the **Zod
  output**, so *any* added key changes the checksum of every existing archive;
- `superRefine` enforces referential closure (a review's subject, a run's task
  and agent, a requirement's milestone must all be inside the snapshot);
- `SqliteProjectStateRepository.restorePortableState` reloads the state after
  restore and compares `canonicalStringify` against the input — restore must be
  exactly round-trippable;
- `canonicalStringify` **throws** on `undefined`, so an always-present-but-empty
  field is not free.

Consequences for this work:

- a required or `.default([])` field would break every existing v1 archive,
  because the recomputed checksum would no longer match the stored one;
- an **`.optional()` field that is omitted when empty** leaves archives without
  links byte-identical to today's, so v1 archives keep validating and a project
  with no links exports identically;
- an archive that *does* carry links is correctly rejected by older binaries
  (unknown key in a strict object) — refusing beats restoring a project with its
  linkage silently dropped;
- `contents` must not gain an entry, or old manifests stop parsing. The link is
  the requirement-side association, so it belongs inside the existing
  `governance` section, which `contents` already declares;
- referential closure must be extended: no link may reference a task or
  requirement outside the snapshot.

## 11. Which transitions are terminal, and which may be reversed?

Terminal: `completed`, `failed`, `cancelled`. `cancel()` already refuses to run
from any of them, and no method leaves them. **No terminal state may be
reversed** — doing so would let a board fabricate project history.

Safely reversible: `blocked` is the only non-terminal state that needs a way out.
Because `Task` stores no previous status, an unblock can only return to a
well-defined starting point (`pending`), from which `start()` works again.

## 12. Which existing behaviour must stay authoritative rather than be duplicated?

- **Pipeline-driven transitions.** `ManagePipelineRuns.start` and
  `syncTaskTerminal` own `→ running` and `→ completed`/`→ cancelled` for
  pipeline-managed tasks, inside the pipeline transaction. New CLI commands must
  call the same domain methods, never re-implement the mapping.
- **Governance transitions.** `ManageGovernance.setStatus` owns requirement
  status with its own table and optimistic concurrency check. Task commands must
  not write requirement status, and vice versa.
- **`isGovernanceTransitionAllowed`.** The declarative transition table plus a
  predicate is the established pattern; the task lifecycle should mirror it
  rather than invent a second style.
- **Approval-by-plan-hash.** `client:apply` and `runtime:purge` already use
  "print a plan, re-run with `--approve <hash>`". A repair mode must reuse it.
- **Audit.** `RecordAuditEvent` writes to an append-only table whose
  `event_type` is free-form, so new task events need no migration.
- **Cross-project ownership triggers.** `requirement_milestone_ownership_insert`
  / `_update` are the precedent for enforcing project boundaries on a reference.

## Root cause

`task.status` is designed as authoritative operational state and is written by
exactly one subsystem — the pipeline. Every other way work reaches completion
leaves it untouched, and no CLI surface can correct it. The lifecycle is not
wrong; it is **unreachable**. The board is stale because the model was never
finished, not because task status is meaningless.

## Direction adopted

1. Complete the lifecycle as a declarative transition table in the domain, and
   expose semantic commands for each transition — never a generic
   `set-status`.
2. Add an explicit many-to-many `task_requirement` link, project-scoped by
   trigger, portable and closure-checked.
3. Do **not** auto-complete tasks from requirement state: §8 and §9 show the
   inference is unsound in both directions.
4. Add read-only reconciliation that reports contradictions, with a narrow,
   plan-approved `--fix` limited to the one repair whose correct outcome is
   already defined by existing code.
5. Show requirement progress beside — never instead of — task status, and flag
   the contradiction rather than hiding it.
