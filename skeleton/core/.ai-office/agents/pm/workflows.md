---
trigger: when_referenced
---
# PM Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `01_create_project` | `01_create_project.md` | Project creation and PRD drafting |

## Workflow Responsibilities

### 01_create_project

**Purpose:** Create new project with PRD

**Steps:**
1. Receive project request from Router
2. Gather requirements from user
3. Analyze user needs and business context
4. Create PRD document
5. Define user stories and acceptance criteria
6. Submit PRD to CEO for approval

**Outputs:**
- PRD document
- User stories
- Acceptance criteria
- Initial project scope

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | PRD ready for review |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `00_router` | New project routed |
| `05_planner` | Scope feasibility questions |
| `20_arch_adr` | Technical constraint feedback |

## Document Ownership

PM owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| PRD | `docs/prd/<slug>.md` | Product requirements |
| User Stories | Within PRD | Feature specifications |
| Acceptance Criteria | Within PRD | Definition of done |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | PRD approval, strategic direction |
| Architect | Technical feasibility, constraints |
| Planner | Timeline, scope breakdown |
| Developer | Requirement clarification |
| QA | Acceptance criteria validation |
