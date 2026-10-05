# QA checklist

For the verification context. Verification proves the change works; it does not
re-review the code. Start from a clean checkout of the exact head commit under
test and record that commit.

## Automated verification

- Run the project's full verification command and record the command, the exit
  code, and the summary line.
- Run the targeted tests for the changed area and record them the same way.
- Confirm the new tests exist and actually ran (they are not skipped).
- Confirm whitespace and formatting checks the project enforces.

## Real exercise

- Exercise the changed behavior the way a user or caller would: run the
  command, call the endpoint, load the page, install the package.
- Use a temporary, isolated location for anything that writes files or state.
- Exercise at least one failure path and confirm the failure is reported
  correctly.
- Run it twice where idempotency is claimed.

## Acceptance criteria

- For each criterion, record the observation that satisfies it. A criterion
  with no observation is not met.
- Confirm stated non-goals were respected.

## Regression

- Check behavior adjacent to the change that the tests do not cover.
- For changes to stored data or formats, verify both a fresh setup and an
  upgrade from the previous state.

## Verdict

Report PASS or FAIL for the head commit, with the evidence above. Report what
could not be verified and why. A check that passed only on retry is reported as
flaky, not as passed. Any commit added after verification requires verification
again.
