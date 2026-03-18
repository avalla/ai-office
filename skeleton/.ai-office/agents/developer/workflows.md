---
trigger: when_referenced
---
# Developer Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `40_dev_implement` | `40_dev_implement.md` | Main implementation workflow |

## Workflow Responsibilities

### 40_dev_implement

**Purpose:** Implement tasks according to specifications

**Steps:**
1. Receive task from Planner/WIP queue
2. Understand requirements and acceptance criteria
3. Review architecture guidelines (ADR)
4. Write code
5. Write tests
6. Run tests locally
7. Submit for review

**Outputs:**
- Implemented code
- Unit tests
- Integration tests
- Updated documentation (if needed)

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `50_qa_validate` | Implementation ready for QA |
| `60_review_merge` | Code ready for review |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `30_plan_tasks` | Tasks ready for implementation |
| `20_arch_adr` | Architecture guidelines |
| `50_qa_validate` | Test failures to fix |
| `60_review_merge` | Review feedback to address |

## Task Ownership

Developer owns implementation for:

| Task Type | Responsibility |
|-----------|---------------|
| Feature | Full implementation |
| Bug Fix | Root cause analysis + fix |
| Refactoring | Safe refactoring with tests |
| Technical Debt | Debt reduction |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Architect | Architecture guidance, ADR clarification |
| Security Specialist | Security-sensitive code review |
| QA | Test failures, acceptance validation |
| Reviewer | Code review, merge approval |
