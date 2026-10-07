---
name: task-delivery
description: Deliver one software task end to end through gated stages - preflight, design, implementation, pull request, independent review, hardening, second review, verification, external review, ready for merge, and post-merge completion. Use when asked to deliver, ship, or carry a task or ticket through to a reviewable pull request, to run a delivery pipeline over one or more tasks, or to review, harden, or verify a change before merge.
license: MIT
metadata:
  version: "0.3.0"
---

# Task Delivery

Carry one task from an accepted request to a merged, verified change. The
workflow is a sequence of gates: a stage is passed only when its exit evidence
exists. It is written for any executor - a coding agent, several agents, or a
human - and names roles, never tools.

## Roles

- **Implementation context**: designs and writes the change.
- **Independent reviewer**: reviews the diff without having written it.
- **Verification context**: proves the change works, without trusting the
  implementer's claims.
- **External reviewer**: a second, differently built reviewer - required when
  the project configures one or the authorizer asks for one, best effort
  otherwise.
- **Authorizer**: the person who owns scope, architecture, and merge decisions.

Implementation, review, and verification must run in independent contexts
whenever the executor supports it. An independent context starts from the task
statement, the acceptance criteria, and the diff - not from the implementer's
reasoning or conclusions. When independence is impossible, perform the stage
anyway, re-reading the diff from scratch, and record in the evidence that it
was not independent.

## Non-negotiable rules

1. **Never merge without explicit authorization.** The merge belongs to the
   authorizer. Perform it yourself only when the authorizer explicitly asks you
   to merge that specific pull request; authorization for one pull request does
   not extend to the next one.
2. **READY FOR MERGE != DONE.** A task is DONE only after it is merged and the
   post-merge verification has passed.
3. **Task dependency != Git branch dependency.** A task may logically depend on
   another without its branch being stacked on it, and the reverse. Decide each
   one separately; see [branch policy](references/branch-policy.md).
4. **Stop on any unauthorized architectural decision.** Surface it with
   options and a recommendation, then wait for the authorizer.
5. **No stage and no task is concluded without evidence.** A claim without a
   command, an output, a link, or a file reference is not evidence; see
   [evidence](references/evidence.md).
6. **Stay in scope.** Deliver the task's acceptance criteria and nothing else.
   Record anything else you find as a follow-up instead of fixing it.

## Before you start

Read the repository's own instructions first; they override this skill where
they are stricter. Then load the optional project configuration described in
[configuration](references/configuration.md). Without it, use the defaults
listed there and ask only when a default cannot be derived. A configuration
file that is present but breaks its contract is a stop condition: never guess
around it.

## Task state

The project tracks task state when its configuration enables that or
configures a command for it, or when its own instructions describe a system
that holds its tasks. Only a configuration that switches it off explicitly
says otherwise. When you cannot tell, ask in preflight instead of skipping it.

Where task state is tracked, keep it true as the work moves. Mark the task
started in preflight, before the first change. Mark it in review when its pull
request is open. Mark it done only after stage 11. Use the commands the
project configures for this; without them, use the project's own documented
way of changing task state, and only where there is none report each
transition for someone else to apply. Check the task's current state first: a
task already in the state you would set needs nothing; when you do not know
how the tracker identifies the task, ask. A transition the tracker refuses is
a stop condition: report what it said, and never work around it. A transition
that would itself start a binding run falls under the rule on binding runs
below. See [configuration](references/configuration.md).

## What to deliver

When the request does not say what to deliver - the skill was started with no
task, milestone, or other target - ask before doing anything else. Offer these
choices and wait for the answer:

1. **A whole milestone**: every open task of one milestone.
2. **One or more tasks**: the tasks the authorizer names.
3. **Some tasks of one milestone**: a milestone, then a selection of its tasks.

The project may define delivery pipelines of its own, in its instructions or
in the system that tracks its tasks. Settle which pipeline applies before
preflight, and never choose one yourself:

- When the project enforces a pipeline, state which one applies; there is no
  choice to offer.
- When the project defines a default pipeline, ask whether to use it and wait
  for the answer. If it is declined, ask what to follow instead.
- When one or more pipelines could apply and none is the default or enforced,
  list them and ask the authorizer which one to use, if any.
- When the project defines no pipeline, do not ask.

A project pipeline that is used decides the stages, assignments, and
transitions of the work. Its mapping to this skill's lifecycle need not be one
to one: a project stage may cover several gates of this skill, and each gate
still keeps its own criteria and its own evidence. A project pipeline may
group, rename, or add stages and gates; it never removes a gate of this skill,
and the non-negotiable rules above still hold.

Following a project pipeline does not by itself mean starting anything in the
project's systems. Where using it would start a run that binds the task - one
whose stages only that system's own assigned performers can complete - check
first that you are such a performer for every stage. If you are not, do not
start it: tell the authorizer what the run requires, let them decide how to
proceed, and record their decision with the evidence. When you cannot tell
whether a run would bind the task, or whether you are assigned to every stage,
do not start it either: ask the authorizer. Never start a binding run you
cannot finish, and never override or cancel one on your own.

Never pick a milestone or a task yourself. Once the answer is in, and before
showing anything for approval, check the dependencies of the selection. The
check always runs; when individual tasks were chosen it is done for every
selected task: find the tasks it logically depends on and their state, and
separate the dependencies that are already DONE, those that are part of the
selection, and those that are neither. A dependency that is neither DONE nor
selected is unresolved: name it, and propose adding it to the run or
postponing the task that needs it. A selected prerequisite is planned,
not resolved: for the task that needs it, it stays unresolved until it is
DONE. Never drop or reorder a task silently to
make the selection work.

When the behavior a task needs already exists on a prerequisite branch that is
not merged, and the project allows stacked work, you may also propose,
explicitly, a Git branch dependency on that branch, as the
[branch policy](references/branch-policy.md) describes. Stacking neither
satisfies nor cancels the logical task dependency: record the two dependencies
separately, keep the task dependency listed as unresolved, and never treat the
prerequisite as DONE until its own lifecycle has reached DONE. A selected
prerequisite is worked on before the task that needs it, and that task starts
only once the prerequisite is DONE or the authorizer has approved a Git branch
dependency on it.

Then show a summary and ask for the go-ahead: the tasks in the order you
propose, what each depends on, every unresolved dependency with the proposal
for it, any Git branch dependency you propose, kept apart from the task
dependencies, the pipeline that will be used, and anything excluded. For a run
that covers several tasks, the summary also asks two things: whether to
clarify every task before development starts, and, where the project allows
stacked work, whether to stack each task on the one before it. Start preflight
only after the authorizer approves that summary.

Clarifying first keeps development from stopping for questions. When the
authorizer chooses it, take the selected tasks one at a time, in the approved
order, before any development branch is created or any code is written. For each task,
read it with its requirements and acceptance criteria, and ask together every
question whose answer would change what is built. Record the answers where the
project keeps its tasks and requirements, through the project's own way of
changing them, and show what was changed; where the project has no such place,
report the clarified task instead. Where the project keeps its tasks and
requirements in Git, record the answers through the project's normal route for
such changes, with its own branch and review, kept apart from the development
branches. Such a change counts as recorded only once it is in effect on the
integration branch, merged with the authorizer's authorization, or the
authorizer has accepted the open change as the reference; until then wait.
Reviewers judge the work against the clarified version. With clarify-first,
development starts only when no selected
task has an open question. A question that only comes up later is still a stop
condition.

Once every selected task is clarified and its answers are recorded, run the
dependency check again over the whole selection and recompute the order and
the Git branch plan. Compare the result with the summary the authorizer
approved. If the selection, the order, a task dependency, a Git branch
dependency, the pipeline, or the exclusions changed materially, show a new
summary and ask for a new approval, and start neither preflight nor
development before it is given. The new summary repeats the stacking offer
with the recomputed bases, and an earlier answer does not carry over. The repeated offer applies only to tasks not yet started: a base already created under an
accepted stacking answer stays approved, and only an explicit decision of the authorizer changes it. Any difference in these items is material, except a base that changes only
because a task was merged, as the approved plan anticipated. If
nothing changed materially, say so and do not ask a second time. A task added
to the selection this way is clarified in the same way, and the check and the
comparison run again until a pass changes nothing materially. An answer
recorded later, while a task is in progress, goes through the same recheck
and comparison before work resumes.

Stacking the run is proposed by default where the project allows stacked work:
each task's branch starts from the branch of the task before it while that
task is unmerged, and from the updated integration branch once it is merged, so
later tasks build on earlier ones without waiting for a merge. The summary
lists the base of every task with run-wide stacking and without it, and says
that each stacked task carries the unmerged commits of the tasks beneath it.
An answer that accepts the stacking offer approves these Git branch
dependencies for the run. A go-ahead that does not answer the stacking offer
declines it, and the plan then uses the bases without run-wide stacking. A task
starts only on a base that contains the work of each of its prerequisites: the
branch of each unmerged prerequisite beneath it on the stack, and the merged
work of each prerequisite that is DONE. A prerequisite beneath the task in an
approved stacked run counts as an approved Git branch dependency on it;
otherwise the task waits, or needs a separately approved Git branch
dependency on the prerequisite.
Declining run-wide stacking leaves separately approved Git branch
dependencies unchanged. Every other task starts from the integration branch
unless another separately approved Git branch dependency applies. A
separately approved Git branch dependency takes precedence over the run chain
for its task. Stacking the run changes where branches start and how a stop spreads along the stack, and nothing else: every task keeps its own pull
request and gates, and its task dependencies stay as they were. When a task in a stacked run stops or is postponed, the tasks whose branches are stacked on it, directly or through other tasks, stop too, and so does every later task of the chain that is not yet started; the authorizer decides how their branches are rebuilt, and the changed plan is shown and approved before any of them starts. If the stop is resolved without changing the plan, the authorizer's go-ahead is enough to resume them.

A run that covers several tasks gives each task its own branch, pull request,
and evidence. Each task's pre-merge delivery ends at READY FOR MERGE. The run
may then continue with another selected task only if that task has no
unresolved prerequisite that blocks execution, or if the authorizer has
approved the required Git branch dependency, separately or by accepting
run-wide stacking. The run never merges a
pull request merely to unblock a later selected task. A stacked branch does
not make the prerequisite task DONE and does not resolve the logical
dependency. Where task state is tracked, the tracker may refuse to start a task
whose prerequisite is not DONE even on an approved Git branch dependency; that
refusal stands, and the task waits.

When the request already names the target, do not ask for the target again.
The pipeline is still settled before preflight as described above: an enforced
pipeline is stated, and a default one is stated and confirmed by the
authorizer. The dependency check and the summary still apply whenever the
request covers more than one task. For a single named task, make the same
dependency check in preflight and stop on an unresolved dependency until the
authorizer decides.

## Lifecycle

Run the stages in order. Each stage is detailed, with entry and exit criteria,
in [lifecycle](references/lifecycle.md). At every stage, check the
[stop conditions](references/stop-conditions.md) before continuing.

When asked to start part-way - for example to review or verify an existing
change - first confirm that every earlier stage has evidence for the current
head commit. Treat a stage without evidence as not passed: perform it, or
report it as missing. Never assume it.

### 1. Preflight

Confirm the task is deliverable: acceptance criteria are explicit, logical
dependencies are DONE or the authorizer has decided how to proceed, the
working tree is clean, the base branch is chosen and current, and the full
verification is green on the base commit before you change anything.

### 2. Design

State the objective, the constraints and invariants that apply, the
alternatives considered, and the smallest coherent solution. Anything that
changes architecture needs authorization before implementation starts.

### 3. Implementation

Implement the design in small, coherent commits with tests that prove the new
behavior and its failure modes. Run targeted tests as you go and the full
verification before handing off.

### 4. Pull Request

Open a pull request against the base chosen in preflight, using the
[pull request template](assets/pr-template.md). State scope, non-goals,
dependencies, and the verification already performed.

### 5. Independent Review

An independent reviewer applies the
[review checklist](references/review-checklist.md) to the diff and returns
findings ranked by severity, each with a concrete failure scenario.

### 6. Hardening

The implementation context validates every finding, fixes the valid ones with
tests, and answers the rejected ones with a reason. Hardening never widens
scope.

### 7. Second Review

The independent reviewer re-reviews the hardening diff and confirms each prior
finding is resolved or justifiably rejected. New blocking findings send the
task back to hardening.

### 8. Verification / QA

A verification context applies the [QA checklist](references/qa-checklist.md):
it runs the full verification on the final head, exercises the changed behavior
for real, and checks every acceptance criterion against observed results.

### 9. External Review

An external reviewer is **required** when the project configures one or the
authorizer explicitly asks for one for this task. A required review must
complete successfully: a timeout, a capacity or execution error, or an
unavailable reviewer is a failed gate, and the task cannot become READY FOR
MERGE.

An external reviewer the executor merely offers - neither configured by the
project nor requested by the authorizer - is **best effort**. Run it when it
works. When it cannot complete - a timeout, a capacity or execution error, or
unavailability - record `external reviewer unavailable` with the error as
evidence and continue. Being installed does not make a reviewer required, and
a best-effort reviewer never stands in for a required one. Where a required
reviewer exists, an additional offered one may be run but need not be.

With no external reviewer at all, skip the stage and say so. In every case an
error is never a passed review, and findings are handled like any other
review: validate, harden, re-verify.

### 10. Ready for Merge

Declare READY FOR MERGE only when review, hardening, and verification evidence
all refer to the current head, a required external review has completed
successfully on the current head, and no blocking finding is open. Report and
wait for the authorizer.

### 11. Post-merge verification / completion

After the authorized merge, verify the integration branch at the merge commit,
update dependent branches and task state, and only then declare the task DONE.

## Reporting

At each gate, report in a few lines: stage, result, evidence, open findings,
and the next action. At the end, report the head commit, the pull request, the
verification results, the review results, known limitations, and follow-ups.

<!-- executors:start -->

## Executor mapping

This block is the only executor-specific part of the skill. It translates the
roles above into the primitives each executor offers.

| Executor    | Skill location                 | Invoke                 | Independent context for review and verification                        |
| ----------- | ------------------------------ | ---------------------- | ---------------------------------------------------------------------- |
| Claude Code | `.claude/skills/task-delivery` | `/task-delivery`       | A fresh subagent given the task, acceptance criteria, and diff only    |
| Codex       | `.agents/skills/task-delivery` | `$task-delivery`       | A separate session or non-interactive run started from a clean context |
| Pi          | `.agents/skills/task-delivery` | `/skill:task-delivery` | A separate session started from a clean context                        |
| Other       | wherever the executor reads it | as the executor allows | Another session, another agent, or another person who did not write it |

For any executor: never pass the implementer's conclusions to the reviewer or
verifier, and never let the context that wrote a change approve it.

**External reviewer on Claude Code.** Codex, when present in the session - a
Codex skill or plugin, or the `codex` command - is an available external
reviewer for stage 9. Its presence alone does not make it required: it is best
effort unless the project configures it or the authorizer requests it.

<!-- executors:end -->
