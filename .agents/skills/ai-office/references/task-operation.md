# Task operation

Use the configured pipeline as a responsibility and quality-gate contract, not as authority to perform side effects.

1. Read `ai-office office:context --project <id>` and resolve the task-kind pipeline with `ai-office office:pipeline --project <id> --task-kind <kind>`.
2. Create the task with `ai-office task:create`, then use `ai-office agent:sync` and `ai-office agent:list` when runtime agents need reconciliation.
3. If the definition is enforced, start a runtime run, assign only a registered agent whose runtime role matches the active stage, and inspect `pipeline:status`. If it is guidance-only, keep following the described sequence without claiming runtime enforcement.
4. Schedule and inspect agent runs with `ai-office run:schedule`, `run:tick`, `run:list`, and `run:show`. An enforced task inherits its pipeline binding. A structured action intent must flow through the controlled-action gateway.
5. When a controlled action reaches `approval_pending`, inspect it with `ai-office action:show`, show the proposed operation, and wait for explicit approval before `ai-office action:approve` and `ai-office action:execute`.
6. Run each stage's checks and report failures before issuing the explicit stage-completion transition.
7. Treat `requiresApproval` as a workflow checkpoint and use the pipeline transition command for its operator decision. It does not approve a controlled action or grant a capability.

An enforced runtime run persists stage-by-stage progress and is authoritative for assignments, stage capabilities, approvals, and transitions. Guidance-only definitions remain host-followed instructions.
