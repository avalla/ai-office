# Agent client integration first-slice plan

- Date: 2026-08-20
- Source: `agent-client-integration-assessment.md`

## 1. Canonical contract and compiler

- Define a strict schema-version `1` tool-independent operating policy and
  project instruction contract in the domain.
- Validate fields without adding a general schema framework to the domain.
- Compile the contract deterministically into a managed canonical `AGENTS.md`
  document in the application layer.
- Test validation, stable ordering, escaping-independent Markdown rendering, and
  deterministic output.

## 2. Application boundary

- Define client IDs, detection/inspection/plan/validation results, generic file
  operations, ownership states, and the `AgentClientAdapter` port.
- Add use cases for list/detect, inspect, plan, approved apply, and validate.
- Hash the canonical plan in the application layer.
- During apply, recompute the plan and reject missing or stale approval hashes
  before invoking filesystem mutation.

## 3. Infrastructure adapters

- Add one package containing a registry plus Codex and Claude adapters.
- Search an injected PATH for `codex` and `claude` without launching either CLI.
- Resolve and validate target roots and inspect only regular instruction files.
- Plan canonical `AGENTS.md` creation/update only when absent or AI Office-owned;
  preserve user-owned canonical files and report them as unmanaged with an
  actionable reconciliation warning.
- For Claude, create or maintain one managed `@AGENTS.md` bridge while preserving
  all unrelated `CLAUDE.md` content.
- Apply operations atomically with file-hash preconditions and clean temporary
  files after failures.
- Validate native Codex loading prerequisites and Claude import state while
  keeping operational wiring distinct from AI Office contract management.

## 4. CLI vertical slice

- Register daemon-backed `client:detect`, `client:inspect`, `client:plan`,
  `client:apply`, and `client:validate` commands.
- Use JSON output for stable machine consumption.
- Require `--contract <file>` for plan/apply and `--approve <plan-hash>` for
  apply. Contract files must be regular, bounded JSON files inside the target
  root.
- Keep these commands separate from `project:onboard` and passive import.

## 5. Repository instruction migration and docs

- Promote `AGENTS.md` as the canonical repository operating contract.
- Reduce `CODEX.md` to a compatibility pointer and add a minimal importing
  `CLAUDE.md`.
- Add ADR-0007 for authority, adapter, ownership, and approval decisions.
- Update README, documentation index, architecture overview, roadmap, testing,
  and add current client-integration guidance.

## 6. Verification

- Unit-test contract validation/compiler and adapter edge cases.
- Integration-test detection, passive inspection, plans, ownership, conflicts,
  unmanaged canonical instructions, idempotence, stale hashes, atomic failure
  cleanup, and validation semantics.
- E2E-test the daemon CLI plan/hash/apply flow in isolated HOME/project roots.
- Run skill validation, strict typecheck, lint, full tests, formatting/diff
  checks, and review dependency direction manually.
