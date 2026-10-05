---
name: task-delivery
description: Deliver one software task end to end through gated stages - preflight, design, implementation, pull request, independent review, hardening, second review, verification, optional external review, ready for merge, and post-merge completion. Use when asked to deliver, ship, or carry a task or ticket through to a reviewable pull request, to run a delivery pipeline over one or more tasks, or to review, harden, or verify a change before merge.
license: MIT
metadata:
  version: "0.1.0"
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
- **External reviewer, if available**: a second, differently built reviewer.
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
dependencies are satisfied or deliberately deferred, the working tree is clean,
the base branch is chosen and current, and the full verification is green on
the base commit before you change anything.

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

### 9. External Review (optional)

Run when an external reviewer is available: one the project configures, or
one the executor mapping below names for the current executor. Treat its
findings like any other review: validate, harden, re-verify. Skip the stage
only when no external reviewer is available, and say so.

### 10. Ready for Merge

Declare READY FOR MERGE only when review, hardening, and verification evidence
all refer to the current head and no blocking finding is open. Report and wait
for the authorizer.

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

**External reviewer on Claude Code.** When Codex is available in the session -
a Codex skill or plugin, or the `codex` command - stage 9 is not optional: run
a Codex review of the branch as an external reviewer, in addition to the
independent review and to any reviewer the project configures. If Codex is not
installed, use the project-configured reviewer if there is one, otherwise skip
the stage and record why. A Codex that is installed but fails to run is a
failed gate, not a skip: report it.

<!-- executors:end -->
