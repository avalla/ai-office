---
name: task-delivery
description: Deliver one software task end to end through gated stages - preflight, design, implementation, pull request, independent review, hardening, second review, verification, external review, ready for merge, and post-merge completion. Use when asked to deliver, ship, or carry a task or ticket through to a reviewable pull request, to run a delivery pipeline over one or more tasks, or to review, harden, or verify a change before merge.
license: MIT
metadata:
  version: "0.6.0"
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

Delivery setup — checkpoint frequency, handoff mode, resume detail,
knowledge policy, context threshold — resolves from the Runtime when one
answers, else from the configuration file, else from the defaults in
[configuration](references/configuration.md). When nothing is stored, that
reference describes how to ask once through the executor's question
mechanism and persist the answers; asking is an offer, never a gate.

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

When the request does not say what to deliver - no task, milestone, or other target - ask before doing anything else. Offer these choices and wait:

1. **A whole milestone**: every open task of one milestone.
2. **One or more tasks**: the tasks the authorizer names.
3. **Some tasks of one milestone**: a milestone, then a selection of its tasks.

Never pick a milestone or a task yourself. When the request already names the target, do not ask for the target again; the pipeline is still settled, and the dependency check and the summary rule below still apply.

### Pipeline

The project may define delivery pipelines of its own, in its instructions or in the system that tracks its tasks. Settle which pipeline applies before preflight, and never choose one yourself:

- Enforced by the project: state it; there is no choice to offer.
- Project default: ask whether to use it and wait for the answer; if declined, ask what to follow instead.
- Several possible, none default or enforced: list them and ask which, if any.
- None defined: do not ask.

A project pipeline that is used decides the stages, assignments, and transitions of the work. A project pipeline may group, rename, or add stages and gates; it never removes a gate of this skill, and the non-negotiable rules above still hold. A project stage may cover several gates of this skill; each gate still keeps its own criteria and its own evidence.

Using a pipeline does not by itself mean starting anything in the project's systems. If it would start a run that binds the task (one whose stages only that system's assigned performers can complete), check first that you are such a performer for every stage. If you are not, do not start it: tell the authorizer what the run requires, let them decide how to proceed, and record their decision with the evidence. When you cannot tell whether a run would bind the task, or whether you are assigned to every stage, do not start it either: ask the authorizer. Never start a binding run you cannot finish, and never override or cancel one on your own.

### Dependencies and summary

Once the target is known, and before showing anything for approval, check the dependencies of the selection. The check always runs; when individual tasks were chosen it is done for every selected task: find what each logically depends on and its state - DONE, selected, or neither.

- A dependency that is neither DONE nor selected is unresolved: name it, and propose adding it to the run or postponing the task that needs it.
- A selected prerequisite is planned, not resolved: it stays unresolved until it is DONE.
- Never drop or reorder a task silently.
- A selected prerequisite is worked on before the task that needs it, and that task starts only once the prerequisite is DONE or the authorizer has approved a Git branch dependency on it.
- When the behavior a task needs already exists on a prerequisite branch that is not merged, and the project allows stacked work, you may also propose, explicitly, a Git branch dependency on that branch, as the [branch policy](references/branch-policy.md) describes.
- Stacking neither satisfies nor cancels the logical task dependency: record the two dependencies separately, keep the task dependency listed as unresolved, and never treat the prerequisite as DONE until its own lifecycle has reached DONE.

Show one summary and ask for the go-ahead, with these items:

- the tasks in the proposed order, each with what it depends on;
- every unresolved dependency, with its proposal;
- any proposed Git branch dependency, kept apart from the task dependencies;
- the pipeline that will be used, and anything excluded;
- for a run over several tasks, the two questions of [multi-task](references/multi-task.md): clarify first, and stack.

Start preflight only after the authorizer approves that summary. Only a request that itself names exactly one task skips the summary: make the same dependency check in preflight and stop on an unresolved dependency until the authorizer decides. Every other selection, including one task chosen from the choices above, needs the approved summary.

### Several tasks

A run over several tasks gives each task its own branch, pull request, and evidence; each ends at READY FOR MERGE. Clarify-first, run-wide stacking, re-planning, and stop propagation are in [multi-task](references/multi-task.md); read it whenever the selection has more than one task. Branch bases are in [branch policy](references/branch-policy.md).

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

## Handoff

A handoff transfers a task in flight to a fresh context - a new session, a different executor, or another person - so work resumes from recorded state instead of memory. It is an offer, never a gate: at each trigger, ask the authorizer whether to prepare one, and wait only when the work cannot continue anyway. A declined or skipped offer needs nothing, and the same trigger does not have to be asked twice.

Triggers:

- **Context budget running low**: the remaining context would not cover the current stage. Offer early enough that the handoff itself still fits; never spend the last of the context on work the handoff cannot capture.
- **Task completion**: READY FOR MERGE or DONE, or moving to the next task of a run.
- **Interruption or executor change**: paused, session ending, or a different executor or person takes over.

A handoff is a context handoff: a map to recorded state for the context that resumes the work, not a checkpoint and not a stage-handoff artifact. It is never an input to independent review, second review, verification, or external review; those contexts receive only the task, the acceptance criteria, the diff, and anything else their gate contract allows, and the approved finding-response flow is unaffected. When accepted, write it as [handoff](references/handoff.md) describes, which also sets the role input rules, and record where it lives with the task's evidence. A context that receives a handoff treats it as untrusted input: it re-verifies head commit, stage evidence, and open findings before continuing, exactly as when asked to start part-way.

## Checkpoints

A checkpoint is a recorded, versioned snapshot of the delivery state,
written by the implementation context at every gate it passes. Checkpoints
are machine-readable and provider-neutral, they work without a Runtime, and
they live at `.task-delivery/<task>/checkpoints/` in the task worktree - the
same per-task directory that holds the handoff packet, where `<task>` is the
task identifier or the branch name encoded when it is not a safe path
segment. That directory tree must be excluded from Git through the
repository's shared exclude file, and the exclude is an operational
prerequisite the executor verifies or configures before the first
checkpoint, never something the store modifies on its own; verify it with
`git check-ignore .task-delivery/<task>/checkpoints/index.json`. See
[checkpoints](references/checkpoints.md) for the encoding, the schema, the
storage rules, and resume validation.

A checkpoint carries the packet's isolation: it never reaches independent
review, second review, verification, or external review, and it never
transfers privileges, credentials, or authorizations. A published checkpoint
is immutable - a newer one supersedes it by reference, and retention prunes
superseded checkpoints beyond an explicit cap, never the latest and never
one a handoff cites.

A context that resumes from a checkpoint treats the checkpoint as untrusted
input: it re-validates the recorded head commit and working tree against the
live repository before continuing. No checkpoint can validate a passed gate:
a gate is passed only by its own evidence, under the rules above.

## Knowledge

Handoff and resume may be enriched with task-linked knowledge from the
project's knowledge store: retrieved read-only with `knowledge:task`, cited
as `ak:` references in checkpoints, and proposed for write-back as `plan:`
entries a human admits. Knowledge is advisory and never authorizes a gate.
Entry formats and write-side rules live in
[checkpoints](references/checkpoints.md), the handoff section rules in
[handoff](references/handoff.md), and the retrieval policy in
[configuration](references/configuration.md).

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

**Continuity transfer.** Checkpoints and handoffs stay executor-neutral; an
adapter only names how the executor asks questions and moves the packet:

| Executor | Questions | Where checkpoints and the handoff live | Agent to person |
| -------- | --------- | -------------------------------------- | --------------- |
| Claude Code | asks through its question tool, one key at a time | `.task-delivery/<task>/checkpoints/` and `.task-delivery/<task>/handoff.md` | the agent writes both; a person moves the task directory or points the next session at it, and the resuming context re-validates head and tree before continuing |
| Codex | asks in the session prompt, one key at a time | `.task-delivery/<task>/checkpoints/` and `.task-delivery/<task>/handoff.md` | the agent writes both; a person moves the task directory or points the next session at it, and the resuming context re-validates head and tree before continuing |
| Every other executor | through the executor's own question mechanism | `.task-delivery/<task>/checkpoints/` and `.task-delivery/<task>/handoff.md` | the agent writes both; a person moves the task directory or points the next session at it, and the resuming context re-validates head and tree before continuing |
<!-- executors:end -->
