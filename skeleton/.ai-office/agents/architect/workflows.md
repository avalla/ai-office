---
trigger: when_referenced
---
# Architect Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `20_arch_adr` | `20_arch_adr.md` | Create Architecture Decision Record |

## Workflow Responsibilities

### 20_arch_adr

**Purpose:** Document architectural decisions

**Steps:**
1. Identify decision need
2. Gather context and constraints
3. Evaluate options
4. Document trade-offs
5. Make recommendation
6. Submit for CEO approval (if major)

**Outputs:**
- ADR document
- Architecture diagrams
- Technology recommendations

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `30_plan_tasks` | Architecture defined |
| `05_planner` | Technical constraints documented |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | PRD approved, needs architecture |
| `40_dev_implement` | Technical decision needed |
| `50_qa_validate` | Performance issues found |

## Document Ownership

Architect owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| ADR | `docs/adr/<slug>.md` | Architecture decisions |
| Architecture Diagrams | Within ADR | Visual documentation |
| Tech Stack Definition | Within ADR | Technology choices |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | ADR approval for major decisions |
| PM | Feasibility assessment |
| Developer | Implementation guidance |
| Security Specialist | Security architecture |
| QA | Testability design |
