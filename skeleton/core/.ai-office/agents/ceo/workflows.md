---
trigger: when_referenced
---
# CEO Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `10_ceo_prd` | `10_ceo_prd.md` | PRD review and approval |

## Workflow Responsibilities

### 10_ceo_prd

**Purpose:** Review and approve Product Requirements Document

**Steps:**
1. Receive PRD from PM
2. Evaluate business alignment
3. Check scope feasibility
4. Consult Architect if technical concerns
5. Approve, reject, or request changes
6. Document decision in status file

**Outputs:**
- Approved PRD (or feedback for revision)
- Status update
- Workflow trigger to Architect (if approved)

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `20_arch_adr` | After PRD approval |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `01_create_project` | PRD draft ready |
| `05_planner` | Timeline conflicts |
| `50_qa_validate` | Quality threshold breach |
| `60_review_merge` | Critical review issues |

## Approval Gates

CEO holds approval authority for:

| Artifact | Approval Type |
|----------|---------------|
| PRD | Full approval |
| ADR (major) | Consultation + approval |
| Release | Authorization |
| Scope Change | Decision |

## Delegation

CEO can delegate to:

| Decision Type | Delegates To |
|---------------|--------------|
| Technical details | Architect |
| Implementation approach | Developer |
| Test strategy | QA |
| Code quality | Reviewer |

CEO does NOT delegate:
- PRD approval
- Release authorization
- Scope changes
- Timeline extensions
