---
description: Scaffold an artifact document for a pipeline stage. Usage: /office:scaffold <slug> <stage>
---

$ARGUMENTS format: `<slug> <stage>`

- **slug**: project identifier (e.g. `user-profile-edit`)
- **stage**: artifact type to scaffold — `prd` | `adr` | `plan` | `tasks` | `status` | `review` | `runbook`

Output path conventions:

| Stage | Output path |
|-------|-------------|
| `prd` | `.ai-office/docs/prd/<slug>.md` |
| `adr` | `.ai-office/docs/adr/<slug>.md` |
| `plan` | `.ai-office/docs/runbooks/<slug>-plan.md` |
| `tasks` | `.ai-office/docs/runbooks/<slug>-tasks.md` |
| `status` | `.ai-office/docs/runbooks/<slug>-status.md` |
| `review` | `.ai-office/docs/runbooks/<slug>-review.md` |
| `runbook` | `.ai-office/docs/runbooks/<slug>.md` |

---

## Templates

### `prd`
```
# PRD: <slug>

**Created:** <today>
**Status:** Draft
**Owner:** PM

## Problem Statement
> What problem does this solve?

## Goals
-

## Non-Goals
-

## User Stories
- As a ... I want to ... so that ...

## Acceptance Criteria
- [ ]

## Out of Scope
-

## Open Questions
-
```

### `adr`
```
# ADR: <slug>

**Created:** <today>
**Status:** Proposed
**Owner:** Architect

## Context
> What is the technical context and the problem being solved?

## Decision
> What was decided?

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| A | | |
| B | | |

## Consequences
**Positive:**
-

**Negative / Trade-offs:**
-

## References
-
```

### `plan`
```
# Plan: <slug>

**Created:** <today>
**Owner:** Planner

## Objective
> What does done look like?

## Milestones

| # | Milestone | Owner | Target |
|---|-----------|-------|--------|
| 1 | | | |

## Dependencies
-

## Risks
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| | | | |
```

### `tasks`
```
# Task Breakdown: <slug>

**Created:** <today>
**Owner:** Planner

## Tasks

See `.ai-office/tasks/` kanban board for task files.

### Summary
| ID | Title | Priority | Column |
|----|-------|----------|--------|
| | | | BACKLOG |
```

### `status`
```
# <slug> — Status

**State:** router
**Owner:** Unassigned
**Updated:** <today>

## Loop Guards

| Guard | Count | Max |
|-------|-------|-----|
| qa_iteration | 0 | 2 |
| review_iteration | 0 | 2 |
| uat_iteration | 0 | 1 |

## Notes
—

## Review Log

| Date | Owner | State | Evidence |
|------|-------|-------|----------|
| <today> | System | router | Scaffolded |
```

### `review`
```
# Review: <slug>

**Created:** <today>
**Reviewer:** Reviewer

## Technical Review
- [ ] Code follows project conventions
- [ ] No security vulnerabilities
- [ ] Tests cover critical paths
- [ ] No performance regressions
- [ ] TypeScript strict mode, no `any`

## Business Review
- [ ] Acceptance criteria met
- [ ] Edge cases handled
- [ ] No regressions in existing features

## UX Review
- [ ] Consistent with design system
- [ ] Accessible
- [ ] Mobile responsive

## Security Review
- [ ] No secrets hardcoded
- [ ] Inputs validated
- [ ] Auth/authz correct

## Score
**Overall:** /10

## Decision
- [ ] Approve
- [ ] Request changes
- [ ] Escalate

## Notes
```

---

Check if the output file already exists. If it does, warn: "File already exists at `<path>`. Overwrite? (respond with 'yes' to confirm)"

If creating: write the appropriate template to the output path with `<slug>` replaced throughout and `<today>` replaced with today's date. Then confirm: "Scaffolded `<stage>` → `<path>`"
