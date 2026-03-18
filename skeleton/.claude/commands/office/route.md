---
description: Route a request to the correct AI Office pipeline stage and suggest next action
---

Analyze the following request and route it to the correct pipeline stage.

**Request:** $ARGUMENTS

## Routing Logic

Apply these rules (first match wins):

| Request type | Pipeline path |
|---|---|
| New feature / new capability | `router → prd → adr → plan → tasks → dev → qa → review → release` |
| Bug fix | `router → dev → qa → review` |
| Refactor / cleanup | `router → plan → tasks → dev → qa → review` |
| Security issue | `router → security → dev → qa → review` |
| UX / design work | `router → ux_research → design_ui → dev → qa → review` |
| Quick fix (< 1h, no design) | `router → dev` |
| Import / onboard project | `router → create_project → prd → adr → plan → tasks` |
| New full project | `router → create_project → prd → adr → plan → tasks → dev` |

## Output

Respond with:

1. **Type detected:** (new feature / bug fix / refactor / etc.)
2. **Suggested slug:** kebab-case identifier for this work (e.g. `user-profile-edit`)
3. **Pipeline path:** full stage chain
4. **Starting stage:** first active stage
5. **Next action:** exact command to run next

Example next actions:
- `Run /office:scaffold <slug> prd` — to scaffold a PRD
- `Run /office:task-create <title>` — to create a task directly
- `Run /office:status <slug>` — to check existing status

Keep the response concise and actionable.
