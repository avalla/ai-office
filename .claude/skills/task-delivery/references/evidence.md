# Evidence

Evidence is something another person can check without trusting you.

## What counts

- A command with its exit code and the relevant lines of output.
- A commit hash, a pull request link, a file path with a line number.
- A test name that fails without the change and passes with it.
- A reviewer's findings list and the response to each finding.
- An observation from really exercising the change.

## What does not count

- "Tests pass", "looks good", "should work", or any claim without an artifact.
- Output from a different commit than the one being judged.
- A result obtained only after retrying a failing check.
- The implementer's summary offered in place of an independent review.

## Rules

- Bind evidence to a commit. Any commit added after a gate invalidates that
  gate's evidence: run the gate again. A repeated review may read only the new
  diff; a repeated verification always covers the whole head.
- Report failures as plainly as successes, with their output.
- Say what was skipped and why. A skipped gate is reported as skipped, never as
  passed.
- Keep secrets, credentials, and personal data out of evidence.
- Record whether review and verification ran in an independent context.

## Gate summary

Use this shape when declaring READY FOR MERGE or DONE:

```text
Task:            <id and title>
Head commit:     <hash>
Pull request:    <link>
Base:            <branch> (stacked on: <branch or none>)
Task depends on: <tasks or none>
Verification:    <command> -> <result> on <hash>
Review:          <n findings: fixed / rejected / open> by <independent | not independent>
Second review:   <result>
QA:              <PASS | FAIL> on <hash>
External review: <result | not available - skipped>
Limitations:     <known limits>
Follow-ups:      <deferred items>
State:           <READY FOR MERGE | DONE>
```
