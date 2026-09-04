# Project consolidation and first real worker plan

- Status: proposed; no product changes implemented by this document.
- Date: 2026-09-05
- Origin: project, architecture, and roadmap review requested by the maintainer.
- Roadmap authority: [development roadmap](../development/roadmap.md).

## Objective and scope

Deliver two independently verifiable outcomes:

1. Development cannot accidentally select personal state; run admission,
   results, recovery, and operational queries are consistent and actionable.
2. One task can produce a real change, test evidence, independent review, and
   an explicit human decision through the authoritative Runtime.

The first outcome is ready for implementation planning. The second needs a
worker/authority assessment before selecting an adapter. This proposal does not
mark future milestones active, accept a new ADR, or authorize live worker calls.

Keep Bun, strict TypeScript, SQLite, application ports, and the existing
controlled-action model. Do not introduce another orchestration framework,
embedded CLI writer, generic status setter, or automatic side-effect replay.

## Review evidence

The review's `bun run check` passed typecheck, lint, skill validation, and 874
tests in 83 files. This is a baseline from the review, not validation of future
changes or a claim of complete behavioral coverage.

| Finding | Evidence | Planned response |
| --- | --- | --- |
| Development global memory defaults to the personal home; the source bin selects user mode | `packages/runtime-paths/src/runtime-paths.ts`, `bin/ai-office.ts` | PR 1 |
| Scheduling and ticking a run succeeds after cancelling its task | Reproduced through an isolated daemon; `commands/schedule-agent-run.ts` | PR 3 |
| A failed run produces exit code 0 and no error from `run:tick` | Reproduced through an isolated daemon using a missing resource; Runtime `commands/run.ts` | PR 2 |
| Interrupted runs are discoverable but lack an application recovery command; they also block snapshots | `listRecoverableRuns`, `findPortabilityBlockers`, current command catalogue | PR 4 |
| Operational queries always report task/requirement linkage as unmodelled | `read-models/operational-projection.ts`, despite M7.9 linkage | PR 5 |
| Real worker dispatch and worktrees remain absent | `packages/agent-runtime/src/executor.ts`, `worktree.ts` | Delivery B |

Paths abbreviated to `commands/` and `read-models/` refer to
`packages/application/src/` unless labelled Runtime.

## Delivery A: consolidation

### PR 1 — Complete development runtime isolation

Scope: M7.10's runtime-selection problem, including global memory.

- Default development global memory to the selected development runtime home.
  Preserve explicit overrides and the installed user's stable runtime.
- Provide an explicit development CLI entry point paired with the development
  daemon; retain existing development aliases with equivalent selection rules.
- Show the selected runtime path on diagnostics/stderr so JSON stdout remains
  parseable. Report explicit global-memory overrides as a separate path.
- Require deliberate opt-in when source-distribution execution targets a user
  runtime. Account for the current supported `bun link` installation workflow:
  document its opt-in and recovery path rather than breaking it silently.
- Use an explicit distribution/mode contract for the guard. Do not infer intent
  from cwd, the presence of `.git`, or whether `.git` is a directory: linked
  worktrees and source-installed users must be handled deliberately.
- Keep caller-local paths resolved by clients. A daemon never guesses cwd.
- Use a persistent checkout-local development runtime as the minimal default;
  temporary test fixtures remain explicitly created and cleaned by tests.

Primary surfaces: `packages/runtime-paths`, `bin/ai-office.ts`, CLI/daemon entry
points, `package.json`, runtime-path and caller-path tests, README and storage
guidance. No database migration is expected.

Acceptance:

- Project and global-memory commands through the development daemon write only
  to the isolated paths, including from linked worktrees and descendants.
- An ambient personal-runtime setting cannot silently defeat development mode.
- Source/user mode without opt-in is refused before database access or IPC;
  intentional source-installed operation still works with documented opt-in.
- Tests use a fake personal home with sentinel data; no verification touches
  the developer's actual home or relies on local client configuration.

### PR 2 — Make run execution outcomes observable

- Return and render a bounded, versioned result for every run processed by
  `run:tick`: run ID, terminal status, sanitized error, cleanup outcome, and
  controlled-action references.
- Add machine output through `--json`. Preserve successful human output where
  useful while adding an explicit success/failure/cancellation summary.
- Define exit code 0 for an empty queue or entirely successful processing;
  use nonzero for failed/cancelled execution or cleanup failure. Document this
  behavior change for scripts; do not introduce a second daemon protocol.
- Preserve the distinction between run completion and action execution:
  `approval_pending` means the intent was processed, not that a file changed.
- Sanitize errors at the result boundary; never pass arbitrary executor error
  messages or stack traces directly to the CLI or persisted external output.

Primary surfaces: `ExecuteAgentRun`, Runtime `commands/run.ts`, typed application
errors/results, CLI help, agent-runtime documentation and daemon E2E tests.
No migration is expected unless persisting cleanup diagnostics proves necessary.

Acceptance: all-success, empty, failed, cancelled, mixed-batch, and cleanup-failure
outcomes are unambiguous. The missing-resource reproduction returns nonzero and
identifies the failed run. A pending controlled action is never reported as an
executed mutation. Fake secrets in executor failures do not reach output.

### PR 3 — Enforce task eligibility and exclusive run admission

- Define run eligibility once in domain policy. Reject terminal tasks; require
  explicit unblocking before admitting work on a blocked task. Preserve valid
  pending, assigned, running, and review work, subject to agent/pipeline policy.
- Apply the policy during scheduling and immediately before claiming execution.
  Scheduling alone must not transition task status or verify requirements.
- Claim a queued run atomically with fresh task, agent, pipeline-assignment,
  and lock checks. External work starts only after this short transaction commits.
- Exercise concurrent `run:tick` requests: the handler runs outside the FIFO,
  so exclusive execution must follow from persisted admission, not queue timing.
  This is a required invariant check, not a claim that duplicate execution was
  reproduced during the review.
- If a task becomes ineligible before dispatch, close the queued run through a
  legal, audited cancellation with a typed reason. Preserve terminal task state.
- Make expired/lost-lock handling explicit; an expired lease alone never proves
  that an earlier execution stopped or that repeating its work is safe.

Primary surfaces: task/run domain policy, `ScheduleAgentRun`, `ExecuteAgentRun`,
`AgentRuntimeRepository`, SQLite run repository, Runtime run handler.

Acceptance: terminal/blocked admission is denied without partial run/lock state;
cancel-between-schedule-and-tick performs no executor work; concurrent ticks
dispatch a run at most once; stale assignment, disabled agent, lost lease, and
cross-project references fail closed. Audit and state changes are atomic.

Add a forward migration and fresh/upgrade tests only if existing persistence
cannot express the required conditional claim and provenance safely.

### PR 4 — Give operators a safe cancellation and recovery path

Depends on PRs 2 and 3. This is basic operability for existing runs; durable
filesystem journals and hostile-process recovery remain M10 work.

- Add daemon-backed run inspection/reconciliation and cancellation use cases.
  Read-only inspection classifies queued, live, orphaned, and ambiguous work.
- Keep live execution ownership and abort handles in the persistent Runtime
  host lifecycle. Persist the information needed to distinguish a new host
  instance from a previous owner; choose the minimal schema during design.
- Cancel queued work atomically. For active work, request cancellation, prevent
  further dispatch through application boundaries, and report terminal state
  only after the executor has acknowledged stopping.
- Integrate task cancellation with its active/queued work without conflating
  task, pipeline, AgentRun, and controlled-action lifecycles. An effect already
  in progress may require reconciliation; cancellation does not imply rollback.
- On restart, expose orphaned work and an explicit resolution plan bound to
  current evidence. A repair requires an attributed reason and the existing
  exact-plan approval convention; stale plans and live executions are refused.
- Preserve action IDs, attempts, and `execution_unknown` evidence. Do not mark
  ambiguous actions successful, grant authority, or automatically retry them.
- Release only the resolved run's lock. A replacement run is a new execution
  whose admission depends on resolved prior work, never a replay of an action.
- Recheck backup readiness after repair. Keep active/ambiguous authority visible;
  never rewrite task status simply to make a snapshot pass.

Primary surfaces: application run lifecycle/ports, domain transitions, Runtime
host composition, daemon lifecycle, SQLite run repository, operational queries,
portability readiness, CLI help and recovery documentation.

Acceptance: queued cancellation; cooperative active cancellation; refusal to
claim an unacknowledged cancellation succeeded; restart reconciliation; stale
approval rejection; foreign-lock preservation; repeated repair; failure during
audit/result persistence; ambiguous controlled effects; and backup after safe
resolution. Use deterministic fake executors and isolated socket/database tests.

### PR 5 — Align task requirement read models

- Extend `OperationalReadRepository` with bounded/batched explicit task linkage
  facts and feed them to the existing application projection.
- Reuse `task-requirement-progress.ts` for shared arithmetic across the CLI
  board, reconciliation, and operational queries; keep rendering free of policy.
- Replace the unconditional unmodelled response with actual linked requirements
  and progress. Represent no links as an available empty relation.
- Preserve recorded task status separately from operational interpretation.
  Requirement verification never implicitly completes a task.
- Do not infer a unique task milestone through a many-to-many relation. Keep
  that field explicitly unavailable until its semantics are separately defined.
- Check query-version compatibility and invalidation topics for link/unlink and
  requirement-status changes. Update architecture text that claims no linkage
  exists. Update dashboard presentation only as needed to expose the facts.

Primary surfaces: operational read port/repository/service/projection,
requirement-progress helper, query protocol, event invalidation, dashboard
consumer, docs. Reuse migration 0026; do not edit it or add redundant storage.

Acceptance: empty, multiple, shared, verified, rejected, and cross-project
requirements; consistent counts across CLI/API; bounded queries without an
N+1 lookup; and refreshed results after link/unlink or requirement changes.

### PR 6 — Reconcile roadmap and current documentation

- Record which consolidation outcomes actually passed acceptance, retaining
  the existing milestone identifiers and historical implementation record.
- Distinguish delivered M11 sequential enforcement from future dispatch,
  branching, retries, and structured artifacts. Remove contradictory language
  saying the already-active foundation has not entered an active milestone.
- Describe dependencies by capability: the first worker needs explicit context,
  not the full M8/M8.5 index and retrieval system. Keep advanced context work.
- Separate project retention/removal design from development isolation.
- Cross-reference current runtime/recovery/query contracts instead of copying
  detailed syntax and status into multiple documents.

The roadmap changes are proposed now and should land with the corresponding
implementation evidence; this document itself does not change milestone status.

## Separate decision: project retention and removal

Prefer an assessment of archival before physical deletion. A useful first
outcome is to hide intentionally retired projects from normal selection while
preserving history and permitting explicit inspection/reactivation. Archival
does not reclaim disk space and is not equivalent to deletion.

Decide handling of installed checkouts, active runs, global-memory references,
portable identity, snapshots, and audit before selecting an operation. Confirm
the desired relationship between append-only history and cascading foreign keys;
do not disable append-only triggers to make deletion convenient. If deletion is
required, plan it as an independently approved lifecycle feature with exact
scope, recoverability, forward migrations, and upgrade coverage.

## Delivery B: one real, controlled software task

Begin adapter implementation after Delivery A's runtime safety criteria pass.
The assessment may proceed earlier using repository evidence.

### B1 — Select the worker and authority contract

- Compare one external coding-worker adapter with a gateway-backed executor.
  Select one first; do not combine provider, client integration, and worker ports.
- Define start, observe, cancel, and collect-result behavior in an application
  port. Adapter/product details stay in infrastructure.
- Resolve worker access before launch. A shell-capable same-UID worker can reach
  operator IPC, credentials, and files; a prompt, role label, or socket is not an
  isolation mechanism. If an adapter cannot meet the controlled-resource
  invariant, it is blocked pending a concrete restricted execution boundary.
- Specify worktree ownership, normalized artifact schema/version, revision/hash
  binding, agent/stage provenance, usage reporting, and unsupported operations.
- Keep external-worker usage marked unknown when unavailable. Never fabricate
  zero cost or promise a hard budget that the selected adapter cannot enforce.

Deliverable: focused assessment and an ADR for durable boundary decisions,
including the selected first adapter, compatibility evidence, and acceptance
tests. Verify current provider/worker documentation at that implementation step.

### B2 — Implement the smallest complete vertical slice

Suggested fixed sequence: implement -> test -> independent review -> human gate.
The review targets the exact change tested; any later modification invalidates
the earlier evidence. Configure distinct implementing and reviewing identities.

- Pin the current enforced pipeline and assemble bounded explicit task/file
  context with provenance, using existing controlled reads.
- Implement one real worker adapter and real worktree lifecycle. Expose test/build
  and Git operations through accepted application/connector boundaries with
  explicit constraints. An unrestricted shell shortcut is out of scope.
- Persist dispatch intent before starting work, and persist normalized outcomes
  afterward. Support cancellation, deadlines, lease renewal, crash handling,
  and sanitized results before declaring the worker operational.
- Keep every filesystem v2 mutation's existing simulation and explicit approval
  requirement. A stage approval or final human gate cannot replace it.
- Define whether the deliverable is the approved worktree change or a committed
  local change; if committing is required, include its controlled Git operation
  in scope. GitHub push/PR/merge is not needed for this first local outcome.
- A rejected review stops at an actionable result. Automatic fix loops and
  branching are later M11 extensions rather than prerequisites for this slice.

Acceptance: one small repository fixture produces a real change, captured test
results, independent review bound to the same revision, and a human decision.
Also prove revocation, changed-source rejection, budget/usage semantics, worker
failure, cancellation, restart, and no duplicate execution. Standard checks use
fake workers; live validation is separate, opt-in, isolated, and never part of
credential-free CI. A simulated E2E test alone cannot complete this delivery.

## Sequencing and completion gates

| Order | Delivery | Dependency | Completion evidence |
| --- | --- | --- | --- |
| 1 | PR 1: development isolation | None | Project and global state remain isolated |
| 2 | PR 2: run outcomes | PR 1 for manual verification | Failures observable through IPC and CLI |
| 3 | PR 3: run admission | PR 1 | Ineligible work blocked; exclusive claim proved |
| 4 | PR 4: cancellation/recovery | PRs 2–3 | Restart and ambiguous outcomes handled explicitly |
| 5 | PR 5: requirement read models | PR 1; otherwise independent of PRs 2–4 | CLI/API agree on linked requirement facts |
| 6 | PR 6: documentation/roadmap | Corresponding implemented PRs | Status and dependencies match evidence |
| 7 | B1: worker decision | Can assess during consolidation | Concrete adapter/authority contract |
| 8 | B2: real vertical slice | Delivery A and B1 | Real change, tests, review, human gate |

Split PR 4 or B2 further when their accepted design reveals independently
reviewable storage, host, or connector changes. Keep migrations with their
consumers and upgrade tests; never split away an invariant needed at merge time.

For each implementation PR: run focused tests, then `bun run check`, the
appropriate diff check, and an architectural review of dependencies,
transactions, authority, errors, compatibility, and unrelated changes. A
documentation-only change needs link/content/diff checks, not new behavior tests.

Defer broad code indexing, embeddings, multiple worker adapters, remote sync,
automatic merge, marketplace work, and hardened native filesystem deployment
until this local execution path provides evidence for their requirements.
