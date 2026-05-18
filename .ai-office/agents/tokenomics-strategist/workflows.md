---
trigger: when_referenced
---
# Tokenomics Strategist Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `20_arch_adr` | `20_arch_adr.md` | Tokenomics architecture and incentive strategy design |

## Workflow Responsibilities

### 20_arch_adr

Purpose: Define and validate token economics as part of system architecture.

Steps:
1. Receive growth and product context from PM/CEO
2. Model utility, incentives, and value capture paths
3. Identify abuse vectors and stress scenarios
4. Produce architecture-aligned tokenomics options
5. Collaborate with Architect/Security on risk constraints
6. Document recommended model with assumptions and KPIs

Outputs:
- Tokenomics model summary
- Incentive risk matrix
- Scenario analysis (base/upside/downside)
- KPI tracking proposal

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Tokenomics model approved for implementation |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | Growth brief approved |
| `05_planner` | Planning requests architecture details |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Tokenomics ADR Appendix | `docs/adr/<slug>-tokenomics.md` | Mechanism and assumptions |
| Incentive Risk Matrix | `docs/qa/<slug>-incentive-risk.md` | Abuse and risk tracking |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | Revenue and strategic boundaries |
| PM | Product scope and growth goals |
| Architect | System-level constraints |
| Security | Economic abuse and adversarial vectors |
| Developer | Implementation handoff inputs |
