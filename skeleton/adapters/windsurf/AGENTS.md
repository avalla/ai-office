# AI Office — Base Rules

This project uses the **AI Office framework** with the **Windsurf adapter**.
Read `AI-OFFICE.md` for the host-neutral framework contract.
These rules are always active. Project-specific rules are in `.ai-office/project.config.md`.

---

## Reasoning & Scope Control

- Before making changes, confirm your understanding of the problem.
- If uncertain about an API, library, or function behavior, check docs or read the source first.
- Never invent function signatures, parameters, or APIs that don't exist.
- When debugging, identify the root cause before proposing fixes.
- If a fix touches multiple files, list all affected files first.

**Scope:**
- Only modify files directly related to the current task.
- Don't refactor unrelated code while fixing a bug or adding a feature.
- If you notice an unrelated issue, mention it but don't fix it unless asked.
- Prefer minimal, focused edits: single-line fix > small refactor > rewrite.
- Don't move files or rename exports without checking all usages first.
- Respect existing patterns: if the codebase uses X, don't introduce Y for the same purpose.

**Anti-hallucination:**
- Never use `// rest of code here` or similar placeholders; always write complete implementations.
- Never assume a file, function, or table exists without verifying it.
- If you're unsure about something, say so explicitly.

---

## Code Quality

- Prefer small, reviewable diffs; avoid unrelated refactors during feature or bug work.
- Keep modules small, focused, and composable; avoid "god" files.
- Prefer clear, explicit code over cleverness.
- Apply SOLID principles: Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion.
- DRY with judgment: avoid duplication, but prefer clarity over premature abstraction.
- Favor pure functions and immutable data; minimize shared mutable state.
- Prefer composition over inheritance.
- Validate inputs at all system boundaries (API endpoints, job handlers, webhooks).
- Use descriptive names; avoid abbreviations.
- Keep side effects isolated; document when a function mutates state.
- Add tests for critical logic and invariants; keep tests deterministic.

---

## TypeScript

- Use TypeScript for all code; strict mode must be enabled.
- Prefer interfaces over types for object shapes.
- Avoid `any`; use `unknown` plus type guards when the type is truly dynamic.
- Avoid enums; use `as const` objects or union types instead.
- Avoid type assertions (`as`) unless absolutely necessary; prefer type guards.
- Use `const` over `let`, never `var`.
- Use early returns and guard clauses to reduce nesting.
- Never use `error as Error` in catch blocks; use `instanceof` checks.
- Never swallow errors silently; always log or propagate.
- Write or update tests before implementing features when practical.
- Every bug fix should include a regression test.
- Comments explain *why*, not *what*. Don't add comments unless the logic is non-obvious.

---

## Security

- Never commit secrets, API keys, or credentials to version control.
- Use `.env.example` for template files; load actual secrets from environment or a secret manager.
- Validate and sanitize all inputs at system boundaries.
- Use parameterized queries; never build SQL via string concatenation.
- Never log sensitive data (passwords, tokens, PII).
- Apply least privilege for permissions, RLS, and ACLs.
- Avoid `eval`, `exec`, and shell injection patterns.
- Store and verify webhook signatures; persist raw events for audit and replay.
- Implement idempotency keys for operations with external side effects.
- Log security-relevant events (auth changes, role changes, failed permission checks).
- Pin dependency versions and review security advisories regularly.

---

## Branch Workflow

When `task_isolation_mode` is enabled in `.ai-office/project.config.md`, every task is developed in its own git branch. In `worktree` mode, each task also gets a dedicated linked worktree for code changes.

**Branch naming:** `task/<milestone-id>/T<NNN>-<slug>`
- Examples: `task/M1/T003-fix-upload-timeout`, `task/sprint-2/T001-billing-ui`

**Rules:**
- Create the branch when the task moves to `WIP` (handled automatically by `/office-task-move` when task isolation is enabled).
- Never commit directly to the integration branch while the iteration is open.
- Keep one task per branch; no cross-task commits.
- Squash merge (not rebase, not regular merge) to keep the integration branch history linear and readable.
- Integrate reviewed tasks with `/office-task-integrate`, targeting the configured `task_merge_target` branch for UAT.

**Commit message format for squash merges:**
```
squash(<milestone-id>): <task title> (<task-id>)
```

---

## Git & Commits

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`, `ci:`.
- Keep subject lines under 72 characters; one logical change per commit.
- Write commit messages in English.
- Before committing: ensure linting and type-check pass.
- Never commit: `.env`, `node_modules`, generated files, build artifacts.
- Show a diff summary before committing when asked.
- Use descriptive branch names: `feat/listing-wizard`, `fix/bid-race-condition`.

---

## AI Office Workflow

Source of truth and precedence when conflicts exist:

1. Artifacts in `.ai-office/docs/`
2. Project config in `.ai-office/project.config.md`
3. Memory in `.ai-office/memory/`
4. The current conversation

**Pipeline (non-negotiable):**
- Always start with `/office-route <task>` for any new project or feature request.
- Never bypass routing or jump directly to implementation without PRD, ADR, or plan context when the work is substantial.
- Review important written artifacts before advancing.
- Never say "done" without recorded evidence (tests passed, lint clean, build succeeded) in the status artifact.
- Use `/office-validate <slug> <stage>` to verify quality gates before `/office-advance`.
- Keep diffs small and focused.
- English-only for technical artifacts, variable names, and user-facing strings unless the project explicitly requires another language.

**Artifacts (communication contract):**

| Artifact | Path |
|----------|------|
| Requirements | `.ai-office/docs/prd/<slug>.md` |
| Architecture decisions | `.ai-office/docs/adr/<slug>.md` |
| Macro plan | `.ai-office/docs/runbooks/<slug>-plan.md` |
| Task breakdown | `.ai-office/docs/runbooks/<slug>-tasks.md` |
| Stage state + evidence | `.ai-office/docs/runbooks/<slug>-status.md` |

---

## Task Management

- Move tasks immediately when their state changes.
- Update the task file (status, timestamp, evidence) before moving it to a new column.
- Update `.ai-office/tasks/README.md` counts after every move.
- Required status update format per transition:

  - `TODO → WIP`: `YYYY-MM-DD: Moved to WIP — started implementation`
  - `WIP → REVIEW`: `YYYY-MM-DD: Moved to REVIEW — all acceptance criteria met`
  - `REVIEW → DONE`: add `## Completion Summary` block with reviewer and date
  - `REVIEW → WIP`: `YYYY-MM-DD: Returned to WIP — <feedback items>`

**Anti-patterns:**
- Don't defer task moves.
- Don't rely on implicit completion.
- Don't skip README count sync.

---

## Reliability & Loop Guards

Loop guards prevent infinite dev, QA, and review cycles. Read and enforce these from the `## Loop Guards` table in `<slug>-status.md`:

| Transition | Guard key | Max |
|------------|-----------|-----|
| `qa → dev` (regression) | `qa_iteration` | 2 |
| `review → dev` (revision) | `review_iteration` | 2 |
| `user_acceptance → dev` (UAT) | `uat_iteration` | 1 |

If a guard limit is reached: set `State: blocked`, set `Owner: planner`, and record `blocked_reason` with explicit unblock criteria.

---

## Runtime Selection

- Prefer a single runtime per surface (Node or Bun for backend tooling, Deno for Supabase Edge Functions).
- Avoid mixing runtimes in the same layer without a clear isolation boundary.
- Document the chosen runtime in README and CI; keep lockfiles consistent.

---

## Optional Addons

Project-specific rules are available as opt-in addons. To activate one, add an import line below:

```
# Uncomment to activate:
# @.ai-office/addons/typescript-naming.md
# @.ai-office/addons/supabase.md
# @.ai-office/addons/bun-monorepo.md
# @.ai-office/addons/frontend-react.md
# @.ai-office/addons/react-native.md
# @.ai-office/addons/mcp-usage.md
```
