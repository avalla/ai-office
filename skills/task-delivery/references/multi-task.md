# Several tasks in one run

Applies when the selection has more than one task. Each task keeps its own branch, pull request, gates, and evidence. The run may continue with another selected task only if that task has no unresolved prerequisite that blocks execution, or if the authorizer has approved the required Git branch dependency, separately or by accepting run-wide stacking. The run never merges a pull request merely to unblock a later selected task. A stacked branch does not make the prerequisite task DONE and does not resolve the logical dependency. Where task state is tracked, the tracker may refuse to start a task whose prerequisite is not DONE even on an approved Git branch dependency; that refusal stands, and the task waits.

## 1. Questions in the summary

Ask both in the same summary as the go-ahead, with a recommendation:

- Clarify every task before development starts? (default: yes)
- Where the project allows stacked work, stack each task on the one before it? (default: proposed)

## 2. Clarify first

Take the selected tasks one at a time, in the approved order, before any development branch is created or any code is written.

- Read the task with its requirements and acceptance criteria.
- Ask together every question whose answer would change what is built.
- Record the answers where the project keeps its tasks and requirements, through its own way of changing them, and show what changed. With no such place, report the clarified task instead.
- Where tasks and requirements live in Git, use the project's normal route for such changes, with its own branch and review, apart from the development branches. Such a change counts as recorded only once it is in effect on the integration branch, merged with the authorizer's authorization, or the authorizer has accepted the open change as the reference; until then wait.
- Reviewers judge the work against the clarified version.

With clarify-first, development starts only when no selected task has an open question. A question that only comes up later is still a stop condition.

## 3. Re-plan after clarifying

Once every selected task is clarified and its answers are recorded, run the dependency check again over the whole selection and recompute the order and the Git branch plan. Compare the result with the approved summary.

- If the selection, the order, a task dependency, a Git branch dependency, the pipeline, or the exclusions changed materially, show a new summary and ask for a new approval, and start neither preflight nor development before it is given.
- Any difference in these items is material, except a base that changes only because a task was merged, as the approved plan anticipated.
- If nothing changed materially, say so and do not ask a second time.
- A task added to the selection this way is clarified the same way; repeat the check and comparison until a pass changes nothing materially.
- An answer recorded later, while a task is in progress, goes through the same recheck and comparison before work resumes.
- The new summary repeats the stacking offer with the recomputed bases; an earlier answer does not carry over. The repeated offer applies only to tasks not yet started: a base already created under an accepted stacking answer stays approved, and only an explicit decision of the authorizer changes it.

## 4. Run-wide stacking

Proposed by default where the project allows stacked work: each task's branch starts from the branch of the task before it while that task is unmerged, and from the updated integration branch once it is merged. The summary lists every task's base with and without run-wide stacking, and says that each stacked task carries the unmerged commits of the tasks beneath it.

- An answer that accepts the stacking offer approves these Git branch dependencies for the run.
- A go-ahead that does not answer the stacking offer declines it; the plan then uses the bases without run-wide stacking.
- Declining run-wide stacking leaves separately approved Git branch dependencies unchanged. Every other task starts from the integration branch unless another separately approved Git branch dependency applies.
- A separately approved Git branch dependency takes precedence over the run chain for its task.
- A task starts only on a base that contains the work of each of its prerequisites: the branch of each unmerged prerequisite beneath it on the stack, and the merged work of each prerequisite that is DONE. A prerequisite beneath the task in an approved stacked run counts as an approved Git branch dependency on it; otherwise the task waits, or needs a separately approved Git branch dependency on the prerequisite.
- When a prerequisite is under review, the dependent task may start before it is DONE only if its starting head contains that prerequisite's current review head. If several prerequisites are under review, the starting head must contain every one of their current review heads. Verify this before marking the task started, and record the heads in the task's delivery evidence.
- The logical dependencies remain unresolved until their tasks are DONE.
- Stacking the run changes where branches start and how a stop spreads along the stack, and nothing else: every task keeps its own pull request and gates, and its task dependencies stay as they were.

## 5. Stops along the stack

When a task in a stacked run stops or is postponed, the tasks whose branches are stacked on it, directly or through other tasks, stop too, and so does every later task of the chain that is not yet started; the authorizer decides how their branches are rebuilt, and the changed plan is shown and approved before any of them starts. If the stop is resolved without changing the plan, the authorizer's go-ahead is enough to resume them.
