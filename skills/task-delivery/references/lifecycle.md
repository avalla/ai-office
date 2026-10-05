# Lifecycle

Each stage has entry criteria, work, and exit evidence. A stage without its exit
evidence is not passed, whatever its apparent state.

| #   | Stage                   | Owner                  | Exit evidence                                                       |
| --- | ----------------------- | ---------------------- | ------------------------------------------------------------------- |
| 1   | Preflight               | Implementation context | Clean tree, base commit, green baseline verification                |
| 2   | Design                  | Implementation context | Written design; authorization for any architectural change          |
| 3   | Implementation          | Implementation context | Commits, tests, green full verification on the branch head          |
| 4   | Pull Request            | Implementation context | Open pull request with scope, dependencies, and verification        |
| 5   | Independent Review      | Independent reviewer   | Findings list, or an explicit statement that none were found        |
| 6   | Hardening               | Implementation context | Each finding fixed with a test, or rejected with a reason           |
| 7   | Second Review           | Independent reviewer   | Each prior finding confirmed resolved; no new blocking finding      |
| 8   | Verification / QA       | Verification context   | Full verification and real exercise of the change on the final head |
| 9   | External Review         | External reviewer      | Findings handled, or "not configured - skipped"                     |
| 10  | Ready for Merge         | Implementation context | Gate summary bound to the current head commit                       |
| 11  | Post-merge / completion | Verification context   | Green verification on the integration branch at the merge commit    |

## 1. Preflight

- Restate the task and its acceptance criteria. If they are missing or
  ambiguous, stop and ask.
- List the task's logical dependencies and their state. Decide the Git base
  separately, following the [branch policy](branch-policy.md).
- Confirm the working tree is clean and isolated as the project requires (for
  example a dedicated worktree).
- Update the base, create the task branch, and run the full verification on the
  untouched base. A red baseline is a stop condition, not something to fix
  inside this task.
- If the project tracks task state, mark the task as started.

## 2. Design

- Read the code and documentation the change touches before proposing anything.
- Write down: objective, constraints and invariants, alternatives with
  trade-offs, chosen approach, test plan, and explicit non-goals.
- Classify the change. If it alters architecture, public contracts, persistence
  formats, or security boundaries beyond what was authorized, stop and ask.

## 3. Implementation

- Follow the design. If reality contradicts it, return to Design instead of
  improvising.
- Keep commits coherent; never mix unrelated refactors into the task.
- Add the narrowest tests that prove the behavior and its failure modes.
- Run targeted tests while iterating and the full verification before handoff.

## 4. Pull Request

- Push the branch and open the pull request against the base chosen in
  preflight, using the [template](../assets/pr-template.md).
- Declare both kinds of dependency: which tasks this one logically needs, and
  which branch this one is based on.
- Do not request merge. Do not enable automatic merge.

## 5. Independent Review

- The reviewer receives the task, the acceptance criteria, and the diff.
- The reviewer applies the [review checklist](review-checklist.md) and reports
  findings ranked blocking / major / minor, each with file, line, and a concrete
  failure scenario.
- A review with no findings must still say what was examined.

## 6. Hardening

- Reproduce or reason through each finding before acting on it.
- Fix valid findings with a test that would have caught them.
- Reject invalid findings with a specific reason; never silently ignore one.
- Re-run the full verification. Push hardening as new commits so the second
  review can read the hardening diff alone.

## 7. Second Review

- The reviewer reads the hardening diff and the responses to each finding.
- Any new blocking finding returns the task to Hardening. Two full
  review-hardening loops without convergence is a stop condition.

## 8. Verification / QA

- The verification context applies the [QA checklist](qa-checklist.md) on the
  final head commit, from a clean checkout of that commit.
- Any failure returns the task to Hardening, followed by a new Second Review of
  whatever changed.

## 9. External Review (optional)

- Run only when the project configures an external reviewer.
- Validate its findings like any others. Changes made in response go through
  Hardening, Second Review, and Verification again.

## 10. Ready for Merge

- Confirm every earlier gate has evidence for the **current** head commit. A
  commit pushed after review or verification invalidates that evidence.
- Report READY FOR MERGE with the gate summary and stop. Do not merge.

## 11. Post-merge verification / completion

- Entered only after the authorizer merges or explicitly authorizes the merge.
- Run the full verification on the integration branch at the merge commit.
- Rebase or retarget branches that were stacked on this one.
- Update task state, record follow-ups, clean up the branch and workspace.
- Only now report DONE. If post-merge verification fails, report it at once and
  propose a revert or a fix; do not declare DONE.
