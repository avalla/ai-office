# Branch and dependency policy

## Two different dependencies

A **task dependency** is logical: task B needs behavior, a decision, or a
contract that task A delivers. A **Git branch dependency** is physical: branch B
is created from branch A, so B's diff only makes sense on top of A.

They are independent. Decide each explicitly and write both in the pull request.

| Task B depends on A | A is merged | Base for B                                                                                                                               |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| No                  | -           | Integration branch, unless the authorizer approved stacking the run.                                                                     |
| Yes                 | Yes         | Integration branch, updated to include A, unless a stacked run applies.                                                                  |
| Yes                 | No          | Wait for A, or stack B on A's head if the project allows stacked work; in an approved stacked run, the run chain, whose base contains A. |

## Rules

- Default base is the integration branch. Stacking is the exception: it needs
  the authorizer's approval and a reason stated in the pull request. For a run
  over several tasks where the project allows stacked work, run-wide stacking is
  proposed by default and the authorizer may approve it once for the whole run;
  the reason stated in each pull request is then that the task is part of an
  approved stacked run.
- In a stacked run the first task starts from the integration branch and each
  later task's branch starts from the branch of the task before it while that
  task is unmerged; once it is merged, the next branch starts from the updated
  integration branch. A separately approved Git branch dependency takes
  precedence over the run chain for its task.
- Declining run-wide stacking leaves separately approved Git branch
  dependencies unchanged; every other task starts from the integration branch
  unless another separately approved Git branch dependency applies. A go-ahead
  that does not answer the stacking offer declines it. A task starts
  only on a base that contains the work of each of its prerequisites: the branch
  of each unmerged prerequisite beneath it on the stack, and the merged work of
  each prerequisite that is DONE. A prerequisite beneath the task in an approved
  stacked run counts as an approved Git branch dependency on it; otherwise the
  task waits, or needs a separately approved Git branch dependency on the
  prerequisite.
- When a task in a stacked run stops or is postponed, the tasks whose branches are stacked on it stop too, and so does every later task of the chain that is not yet started; the authorizer decides how their branches are rebuilt, and the changed plan is shown and approved before any of them starts. If the stop is resolved without changing the plan, the authorizer's go-ahead is enough to resume them. Never rewrite reviewed history to do so.
- A stacked pull request targets the branch it is stacked on, and says so. Its
  review covers only its own diff. An external review command is run against
  that branch, not against the integration branch.
- Do not declare a stacked task READY FOR MERGE while the branch beneath it has
  an open blocking finding.
- When the lower branch changes, merge it into the upper branch and re-run
  verification; earlier evidence no longer applies to the new head.
- After the lower branch merges, retarget the upper pull request to the
  integration branch. Retargeting alone is enough when the upper branch then
  applies cleanly and shows only its own diff.
- When the upper branch also needs commits from the integration branch - new
  work, or the merged form of the lower branch - merge the integration branch
  into it. Do not rewrite the upper branch to get there.
- Any change of base or merge-in invalidates earlier verification evidence: run
  verification again on the resulting head. Review evidence stays valid for
  commits that did not change; conflict resolutions are new changes and need
  review. This exception does not cover a required external review, which
  always runs on the current head.
- A satisfied Git dependency does not satisfy a task dependency: being stacked
  on A's branch does not mean A's task is accepted.
- An unrelated task must not inherit another task's unmerged commits, except
  in a run the authorizer approved as stacked.

## Working copy

- One task, one branch. Use an isolated workspace when the project requires it
  or when another task is in progress in the same checkout.
- Never rewrite history that others may have fetched. After review has started,
  add commits instead of amending, so the hardening diff stays readable.
- A rebase is allowed only on a branch that has not been shared, whose review
  has not started, and that no other branch is stacked on. In every other
  case, merge. Rewriting shared or
  reviewed history is a [stop condition](stop-conditions.md), not a judgment
  call.
- Never push to the integration branch directly.
