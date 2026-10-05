# Branch and dependency policy

## Two different dependencies

A **task dependency** is logical: task B needs behavior, a decision, or a
contract that task A delivers. A **Git branch dependency** is physical: branch B
is created from branch A, so B's diff only makes sense on top of A.

They are independent. Decide each explicitly and write both in the pull request.

| Task B depends on A | A is merged | Base for B                                                             |
| ------------------- | ----------- | ---------------------------------------------------------------------- |
| No                  | -           | Integration branch. Never stack on A just because A came first.        |
| Yes                 | Yes         | Integration branch, updated to include A.                              |
| Yes                 | No          | Wait for A, or stack B on A's head if the project allows stacked work. |

## Rules

- Default base is the integration branch. Stacking is the exception and needs a
  reason stated in the pull request.
- A stacked pull request targets the branch it is stacked on, and says so. Its
  review covers only its own diff.
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
- An unrelated task must not inherit another task's unmerged commits.

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
