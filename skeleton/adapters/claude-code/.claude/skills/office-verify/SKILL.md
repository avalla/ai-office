---
name: office-verify
description: Actively verify a task's acceptance criteria and diagnose failures. Usage: /office-verify <task-id>
disable-model-invocation: true

$ARGUMENTS format: `<task-id>`

- **task-id**: task ID like `M1_T003`, or partial filename match

This command is run by the `qa` agent after implementation is complete. It actively checks each acceptance criterion, diagnoses failures, and renders a verdict. Unlike `/office-validate`, it does not check pipeline gates — it checks whether the *work itself* is done and correct.

---

## Steps

### 1. Load the task

Find the task file in `.ai-office/tasks/` (any column). Extract:
- **Acceptance Criteria** — the checklist items under `## Acceptance Criteria`
- **Labels** — for context (e.g. `bug`, `auth`, `perf`)
- **Milestone + slug** — to locate related PRD if available

### 2. Load supporting context

Read these if they exist:
- `.ai-office/docs/prd/<slug>.md` — for full requirements and user stories
- `.ai-office/docs/context/<slug>.md` — for constraints and ruled-out approaches
- `.ai-office/project.config.md` — for `test_cmd`, `lint_cmd`, `typecheck_cmd`

### 3. Classify each criterion

For each item in `## Acceptance Criteria`, determine its verification method:

| Method | When to use |
|--------|-------------|
| **auto** | Can be verified by running a command (tests, typecheck, lint, grep) |
| **inspect** | Requires reading source code or an artifact |
| **manual** | Requires human interaction or a browser — describe the exact steps |

### 4. Verify each criterion

Run verification in this order: auto → inspect → manual.

**Auto checks** — run the relevant command and capture output:
- Test pass: run `<test_cmd>`
- No type errors: run `<typecheck_cmd>`
- No lint errors: run `<lint_cmd>`
- Pattern present/absent: grep the relevant files

**Inspect checks** — read the relevant file(s) and assess:
- Feature flag removed, migration applied, endpoint protected, etc.
- If uncertain, mark as ⚠️ WARN with what you observed

**Manual checks** — output a numbered checklist:
```
Manual verification required:
  1. Open <URL or screen> and do <action>
  2. Confirm <expected outcome>
Respond "confirmed" when done, or describe what you saw instead.
```
Wait for the user's response before proceeding.

### 5. Diagnose failures

For each ❌ FAIL item:
- Read the error output or code carefully
- Identify the root cause (not just the symptom)
- Output a specific, actionable diagnosis:

```
❌ FAIL: Unit tests passing
   Error: TypeError in auth/session.ts:42 — cannot read 'userId' of undefined
   Root cause: session object not initialized before access in loginHandler
   Fix: initialize session in middleware before passing to handler
```

Do not just report "tests failed" — identify *why*.

### 6. Verdict

**If all criteria pass (✅ or ⚠️ only):**

```
✅ Verification passed — <N> criteria met

Recommended: move task to REVIEW and advance the pipeline
  /office-task-move <task-id> REVIEW
  /office-advance <slug> "verification passed — <N> criteria met"
```

Update the task file: check off all passing items in `## Acceptance Criteria`.

**If any criterion fails (❌):**

```
❌ Verification failed — <N> passed, <M> failed

Returning to WIP:
  /office-task-move <task-id> WIP

Issues to fix:
  1. <diagnosis for failure 1>
  2. <diagnosis for failure 2>
```

Append to the task's `## History`:
```
- <today ISO>: Verify failed — <N> criteria failed, returned to WIP
```

<!-- ai-office-version: 1.11.0 -->
