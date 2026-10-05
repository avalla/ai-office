# Stop conditions

When a stop condition holds, stop the affected task, report what was found with
evidence, propose options with a recommendation, and wait. Work that does not
depend on the answer may continue.

## Always stop

- **Unauthorized architectural decision.** The change needs a new or altered
  architectural boundary, public contract, persistence format, dependency, or
  security rule that nobody authorized.
- **Merge without authorization.** Any step that would merge, enable automatic
  merge, or push to the integration branch without explicit authorization.
- **Destructive or irreversible action.** Rewriting shared history, deleting
  branches or data you did not create, force-pushing a shared branch.
- **Unclear acceptance criteria.** The task cannot be judged complete as
  written.
- **Scope growth.** Satisfying the task would require work clearly outside its
  stated scope.
- **Unsatisfied logical dependency.** The task needs behavior that is neither
  merged nor available on the chosen base.
- **Red baseline.** The full verification fails on the untouched base.
- **Missing access.** A credential, permission, or environment needed for a
  gate is unavailable. Never work around a deliberate restriction.
- **Secrets.** A credential or other secret appears in the diff, logs, or
  evidence.

## Stop after bounded effort

- **Non-converging loop.** The task has returned to Hardening twice - from
  review, verification, or external review - and a blocking finding or failure
  is still open.
- **Unexplained failure.** A verification failure that cannot be reproduced or
  explained after a focused investigation. Do not retry until green.
- **Flaky verification.** A check that passes only on retry. Report it; a
  retried pass is not evidence.
- **Reviewer and implementer disagree** on a blocking finding. Escalate to the
  authorizer instead of overruling the reviewer.

## Never a reason to stop

- Ordinary errors, timeouts, or tool failures that can be diagnosed and fixed
  within scope.
- Minor findings that are fixed or recorded as follow-ups.
- The absence of an external reviewer: skip that stage and say so.
