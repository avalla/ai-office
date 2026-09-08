# First real worker assessment

Status: implementation assessment, 2026-09-07. This document does not mark M12
or M14 delivered. The roadmap remains authoritative.

## Problem

At assessment start, `ControlledActionAgentExecutor` fell back to `SimulatedAgentExecutor` when a
run has no controlled-action intent. `run:tick` then persisted a successful run,
although no model or coding worker executed the task. The dashboard describes
persisted liveness without identifying the executor. Companion agent `system.md`
files are not execution inputs today.

## Smallest useful delivery

Introduce an explicitly selected real worker for bounded task context and
structured output. Simulation must be explicit. An unavailable worker must fail
with an actionable typed error, never silently fall back to simulation.

This first path delivers generated work for inspection. It does not claim
repository inspection, implementation, test execution, independent review, or
pipeline completion merely because a worker returned text. Full software
delivery remains the separate B2 acceptance in the consolidation/worker plan.

## Alternatives

| Path | Useful property | Constraint |
| --- | --- | --- |
| External CLI with repository tools | Existing coding capabilities and login | Direct filesystem and shell access bypass current controlled-resource boundaries; requires a concrete restricted environment |
| External CLI with tools disabled | Real execution using an installed client; explicit input/output | No repository access or test execution; external usage and billing need honest reporting |
| Gateway-backed executor | Existing provider boundary and metering | Requires provider configuration; a coding tool loop and output contracts are still new work |

Local inspection found Codex and Claude Code installed. Claude Code's CLI
exposes explicit tool removal and structured output. A first adapter can use a
tool-free mode in a fresh, private temporary directory, with hooks, skills,
project configuration, and external MCP discovery disabled. Capability policy
still owns every protected read or mutation performed by AI Office.

The worker is a trusted local client implementation. CLI flags do not establish
a hostile same-user process boundary. A general coding adapter remains blocked
until its resource-access contract can be enforced independently of prompts.

## Required contracts

- A worker port belongs to application. Client flags, subprocess management,
  authentication, and stream parsing belong to an infrastructure adapter.
- The selected executor is pinned to the run. Unknown historical execution
  remains unknown; prose such as "Simulated execution completed" is not a
  provenance parser.
- Persist authority and dispatch identity before worker execution. Include
  adapter/version, agent and stage identity, and bounded input provenance.
- Build context from authoritative task, role, and pinned pipeline facts.
  Never infer that a `system.md` path is a persisted/versioned prompt.
- Preserve the existing exclusive admission, cancellation, and recovery path.
  Deadline/cancellation must stop and reap the child before claiming it stopped.
  Lost ownership or uncertain termination must remain recoverable.
- Parse only supported output envelopes. Bound stdout/stderr. Do not persist
  hidden reasoning, credentials, or raw subprocess failures.
- A generated result is an artifact for inspection, not an automatic approval
  or proof that a file changed. Task and pipeline lifecycle remain explicit.
- Report worker usage separately from billed cost; missing values are unknown.
  Do not advertise hard cost enforcement unsupported by the adapter.
- No secret copying, login changes, paid-provider calls, or real-worker calls
  belong in standard tests.

## Implementation sequence

1. Make simulation explicit and persist executor provenance without rewriting
   historical runs.
2. Add the application worker port and one bounded adapter, with deterministic
   subprocess tests for success, malformed output, timeout, and cancellation.
3. Connect task context, admission, dispatch, result persistence, and recovery.
4. Publish executor evidence and the inspectable result in CLI/query/dashboard.
5. Verify the complete path through an isolated daemon. Separately validate one
   live worker on synthetic task data before claiming real execution delivered.

## Evidence

- `packages/agent-runtime/src/executor.ts` and `worktree.ts`: current simulations.
- `packages/runtime-host/src/commands/run.ts`: current composition and ticking.
- ADR-0016: admission, owner evidence, cancellation, and recovery invariants.
- `project-consolidation-and-worker-plan.md`: B1 authority assessment and the
  larger B2 software-delivery acceptance.
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode):
  structured events, explicit sandbox settings, and saved CLI authentication.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference):
  explicit tool removal, customization controls and structured output.
- Local `codex exec --help` and Claude Code 2.1.236 `--help`: installed command
  contracts. Installed options must be verified against the adapter's supported
  contract; detection alone never grants execution authority.

## Verification evidence

The isolated live smoke on 2026-09-07 invoked installed Claude Code 2.1.236
through a temporary daemon and the production `run:tick --worker claude` path.
A synthetic Italian arithmetic-explanation task returned structured content,
five persisted run events, session/model evidence and a context digest. The
reported model was `claude-haiku-4-5-20251001`; execution took 10.558 seconds.
The client reported 1,359 uncached input tokens, 662 output tokens and an
estimated USD cost of 0.005867 under a 0.10 USD per-run CLI estimate limit.
This establishes one real text-worker execution, not autonomous code delivery.

The live check also exposed a ten-second IPC wait cutoff. Validated `run:tick`
requests now use role-governed execution deadlines rather than short-command
or socket idle deadlines. A regression test crosses the actual ten-second idle
boundary while health stays responsive. Each persisted execution transition
also publishes a query invalidation before batch completion.

Deterministic coverage includes subprocess errors/output bounds/cancellation,
missing worker selection, role budgets, lease loss, authority changes, pinned
stage context without automatic approval, legacy migration, immutable dispatch
metadata and escaped dashboard output. Standard tests use process doubles and
never installed-client authentication or provider calls. Desktop/mobile browser
checks use a separate synthetic database.

Final automated validation: skill contracts, typecheck and lint passed. All
1,004 tests in 98 files passed with
`bun run test --maxWorkers=2 --testTimeout=15000`. Standard `bun run check`
attempts encountered intermittent five-second timeouts in existing Git update
tests; the final invocation changed only local runner limits, not assertions or
repository test configuration. `git diff --check` passed.
