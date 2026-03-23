---
name: office-role
description: Display role guidance for an agent in the current pipeline stage. Usage: /office-role <agent-name>
disable-model-invocation: true

$ARGUMENTS format: `<agent-name>`

- **agent-name**: the agent whose role guidance to display (e.g. `developer`, `qa`, `reviewer`, `pm`, `architect`)

Accepted aliases:

| Alias | Resolves to |
|-------|-------------|
| `dev`, `developer` | `developer` |
| `pm`, `product-manager` | `pm` |
| `arch`, `architect` | `architect` |
| `qa`, `tester` | `qa` |
| `rev`, `reviewer` | `reviewer` |
| `sec`, `security`, `security-specialist` | `security-specialist` |
| `ux`, `ux-researcher` | `ux-researcher` |
| `design`, `designer` | `designer` |
| `plan`, `planner` | `planner` |
| `ops`, `devops` | `ops` |
| `release`, `release-manager` | `release-manager` |
| `router` | `router` |

---

## Steps

1. **Resolve agent name**: apply the alias table above.

2. **Read personality file**: read `.ai-office/agents/<agent-name>/personality.md`.
   If it does not exist, try `.ai-office/agents/<agent-name>/`:
   - List available agents in `.ai-office/agents/` and suggest the closest match.
   - Output: `⚠️  Agent '<agent-name>' not found. Available agents: <list>`

3. **Read current pipeline state** (optional enrichment):
   - Read `.ai-office/project.config.md` → `agency`, `project_name`
   - List any `*-status.md` files in `.ai-office/docs/runbooks/` — if exactly one exists, read it and extract `State:`

4. **Display role guidance**:

   ```
   ## Role: <Agent Name>
   **Project:** <project_name> (<agency>)
   **Current stage:** <State> (from status file, or "unknown")

   ---

   <full content of personality.md>

   ---

   ## Stage-Specific Focus
   ```

   Then append stage-specific focus based on the **current stage** (from status file):

   | Stage | Focus for this agent |
   |-------|---------------------|
   | `prd` | Define clear acceptance criteria; challenge scope creep |
   | `adr` | Document trade-offs; prefer reversible decisions |
   | `plan` | Break work into tasks ≤ 1 day; identify blockers early |
   | `dev` | Follow TDD; keep PRs small and focused |
   | `security` | Check OWASP Top 10; validate all inputs; review auth flows |
   | `qa` | Cover happy path, error paths, and edge cases; target coverage ≥ threshold |
   | `review` | Focus on correctness and maintainability; use `/office-review <path>` |
   | `user_acceptance` | Verify against acceptance criteria in PRD; test with realistic data |
   | `release` | Check rollback plan; verify feature flags; confirm monitoring in place |
   | `postmortem` | Blameless analysis; capture action items with owners and due dates |

   If the current stage doesn't match this agent's primary stage, add:
   ```
   > ℹ️  You are viewing <agent-name>'s role but the current stage is `<state>`.
   >    The active agent for `<state>` is `<responsible agent from office-advance mapping>`.
   ```

5. **Related commands**:
   ```
   Related:
   - /office-advance <slug> <evidence>   — move to next stage
   - /office-validate <slug> <stage>     — run stage gate checks
   - /office-task-list                   — see active tasks for this stage
   ```
