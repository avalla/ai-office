---
trigger: when_referenced
---
# Planner Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `05_planner` | `05_planner.md` | Macro planning |
| `30_plan_tasks` | `30_plan_tasks.md` | Task breakdown |

## Workflow Responsibilities

### 05_planner

**Purpose:** Create macro project plan

**Steps:**
1. Receive PRD from CEO
2. Analyze requirements
3. Identify milestones
4. Estimate timeline
5. Identify dependencies
6. Create macro plan document
7. Submit for CEO review

**Outputs:**
- Macro plan document
- Milestone definitions
- Timeline estimate

### 30_plan_tasks

**Purpose:** Break down into implementable tasks

**Steps:**
1. Receive ADR from Architect
2. Break down features into tasks
3. Identify dependencies
4. Estimate effort
5. Sequence tasks
6. Create task files
7. Update task board

**Outputs:**
- Task files
- Task board update
- Dependency map

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Tasks ready for implementation |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | PRD approved |
| `20_arch_adr` | ADR approved |
| `50_qa_validate` | Quality issues affecting timeline |
| `60_review_merge` | Review issues affecting timeline |

## Document Ownership

Planner owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Macro Plan | `docs/runbooks/<slug>-plan.md` | Project milestones |
| Task Files | `tasks/TODO/*.md` | Individual tasks |
| Task Board | `tasks/README.md` | Task status summary |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | Timeline approval, escalation |
| PM | Requirements clarification |
| Architect | Architecture breakdown |
| Developer | Task assignment, completion tracking |
| QA | Quality timeline impact |
