---
name: office-route
description: Route a request to the correct AI Office pipeline and run a discussion phase to capture constraints before planning. Usage: $office-route <request>
disable-model-invocation: true

**Request:** $ARGUMENTS

---

## Pre-check — Agency configured?

Before routing, check if `.ai-office/project.config.md` exists and has a non-empty `agency` field.

If not configured, stop and output:
```
⚠️  No agency configured for this project.

Run $office-setup to profile your project and generate a custom agency.
This takes ~2 minutes and ensures the right agents are assigned to your work.
```

---

## Phase 1 — Classify

Silently determine the request type (do not output this step):

| Request type | Pipeline path |
|---|---|
| New feature / new capability | `discuss → prd → adr → plan → tasks → dev → qa → verify → review → user_acceptance → release` |
| Bug fix | `discuss → dev → qa → verify → review → release` |
| Refactor / cleanup | `discuss → plan → tasks → dev → qa → verify → review → release` |
| Security issue | `discuss → security → dev → qa → verify → review → release` |
| UX / design work | `discuss → ux_research → design_ui → dev → qa → verify → review → release` |
| Quick fix (< 1h, no design) | `dev → release` |
| Import / onboard project | `discuss → create_project → prd → adr → plan → tasks` |
| New full project | `discuss → create_project → prd → adr → plan → tasks → dev → qa → verify → review → user_acceptance → release` |

Also derive:
- **type**: one of the row labels above
- **slug**: kebab-case identifier (e.g. `user-profile-edit`)

---

## Phase 2 — Discussion

> Skip this phase entirely for **Quick fix** requests. Jump to Phase 3.

Ask the following questions in a single message. Tailor which questions appear based on the request type — omit irrelevant ones, add type-specific ones from the table below. Keep the total to 4–6 questions max.

**Universal questions (always ask):**
1. Are there any constraints I should know upfront? (deadline, performance, backward compatibility, scope limits)
2. Are there existing patterns in the codebase this should follow or deliberately break from?
3. Any approaches already ruled out — and why?

**Type-specific additions:**

| Type | Extra questions |
|------|----------------|
| New feature | What does success look like for the end user? Any related features or APIs this touches? |
| Bug fix | How is it manifesting? (error message, repro steps) Is it in production now? Any recent changes that may have caused it? |
| Refactor | What's the driver — performance, readability, test coverage? What's explicitly out of scope? |
| Security issue | Has this been exploited or is it theoretical? What data/endpoints are at risk? |
| UX / design | Who is the target user? Do mockups exist, or starting from scratch? |
| New project | What's the primary tech stack? Any existing code to onboard, or greenfield? |

**Wait for the user's answers before continuing.**

Once answered, write `.ai-office/docs/context/<slug>.md`:

```markdown
# Context: <slug>

**Request:** <original request>
**Date:** <today ISO>
**Type:** <request type>

## Constraints

<user's answer about constraints, or "None stated">

## Existing Patterns

<user's answer, or "None stated">

## Ruled Out

<user's answer, or "None stated">

## Additional Context

<any type-specific answers>
```

---

## Phase 3 — Route

Read `.ai-office/agencies/<agency>/config.md` and use the active agent roster when suggesting assignees.

Output:

```
Type:     <request type>
Slug:     <slug>
Pipeline: <full stage chain>
Context:  .ai-office/docs/context/<slug>.md ✅

Agents: <list active agents relevant to this pipeline>

Next: <exact command>
```

**Next command** by type:
- New feature / project: `Run $office-scaffold <slug> prd` then `Run $office-scaffold <slug> status`
- Bug fix / security: `Run $office-scaffold <slug> status` then `Run $office-task-create <title> ms:M0 labels:<type>`
- Refactor: `Run $office-scaffold <slug> plan` then `Run $office-scaffold <slug> status`
- Quick fix: `Run $office-task-create <title> ms:M0 priority:HIGH`

> The status file (`<slug>-status.md`) is required by `$office-advance`, `$office-run-tests`, and `$office-status`. Always scaffold it before advancing the pipeline.

<!-- ai-office-version: 1.5.0 -->
