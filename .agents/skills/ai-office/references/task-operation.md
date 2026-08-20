# Task operation

Use the configured pipeline as a responsibility and quality-gate contract, not as authority to perform side effects.

1. Read `office:context` and resolve the task-kind pipeline with `office:pipeline`.
2. Create the task through `task:create` and synchronize runtime agents when needed.
3. For each stage, select an available agent that matches the stage role. If none exists, report the missing mapping instead of silently substituting a materially different role.
4. Schedule and inspect runs through the daemon. A structured action intent must flow through the controlled-action gateway.
5. When a controlled action reaches `approval_pending`, show the proposed operation and wait for explicit approval through the existing action commands.
6. Run each stage's checks and report failures before proceeding.
7. Treat `requiresApproval` as a human workflow checkpoint. It does not approve a controlled action or grant a capability.

The current runtime stores the manifest and resolves default pipelines, but does not yet persist stage-by-stage pipeline progress. Maintain the stage sequence in the active host conversation and make this limitation explicit in handoff summaries.
