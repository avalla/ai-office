# Agent runtime

M3 loads `agents/*/agent.yaml` with Bun's native YAML parser and validates every field before persistence. `agent:sync` upserts stable project-scoped role and agent identities.

`run:schedule` validates project, task, and enabled agent, creates a queued run, and acquires the task lock in one short transaction. A second run for the same task fails with a typed error. `run:tick` processes queued runs with bounded capacity through the simulated executor and worktree abstraction.

The state sequence is `queued -> preparing -> running -> reviewing -> completed`. Errors finish as `failed`; cancellation support is present in the domain and executor boundary. No subprocess, Git mutation, LLM call, or long-running transaction is used by the simulator.
