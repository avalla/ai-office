---
trigger: when_referenced
---
# Scalper Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `40_dev_implement` | `40_dev_implement.md` | Execution logic and risk-rule implementation support |

## Workflow Responsibilities

### 40_dev_implement

Purpose: Convert execution strategy and risk controls into actionable implementation guidance.

Steps:
1. Receive approved strategy and risk parameters
2. Translate execution conditions into deterministic rules
3. Define guardrails (timeouts, limits, circuit-breakers)
4. Partner with Developer on implementation details
5. Validate observability and metric tracking requirements
6. Hand off for Security and QA validation

Outputs:
- Execution rulebook
- Risk control matrix
- Monitoring and alert requirements
- Post-execution analysis framework

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `45_security_pentest` | Execution rules ready for adversarial/risk review |
| `50_qa_validate` | Execution implementation ready for validation |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `20_arch_adr` | Strategy constraints and architecture approved |
| `30_plan_tasks` | Work items ready for implementation |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Execution Playbook | `docs/runbooks/<slug>-execution-playbook.md` | Rules and guardrails |
| Risk Limits Matrix | `docs/qa/<slug>-risk-limits.md` | Runtime risk boundaries |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Objectives, boundaries, and launch priorities |
| Tokenomics Strategist | Incentive and mechanism constraints |
| Developer | Implementation feasibility and integration |
| Security | Adversarial abuse review |
| QA | Validation scenarios and edge-case checks |
