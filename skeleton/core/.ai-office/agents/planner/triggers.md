---
trigger: when_referenced
---
# Planner Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/05_planner` | Macro planning |
| `/30_plan_tasks` | Task breakdown |

### Workflow Events

| Event | Action |
|-------|--------|
| PRD approved | Create macro plan |
| ADR approved | Break down into tasks |
| Timeline conflict | Re-prioritize and adjust |
| Task blocked | Find alternative path |

## Secondary Triggers

### Context-Based

- CEO requests timeline update
- Developer reports completion
- QA reports blocker
- New feature request

### Escalation-Based

- Developer needs task clarification
- QA finds scope gap
- Release Manager needs timeline
- User requests status

## Activation Conditions

### Required For

- **Macro Planning** - All projects need macro plan
- **Task Breakdown** - All features need task decomposition
- **Timeline Updates** - All timeline changes

### Optional For

- PRD review (consulted for feasibility)
- ADR review (consulted for timeline impact)
- Release planning (consulted for milestone status)

## Trigger Examples

### Example 1: PRD Approved

```
CEO: Approves PRD
Planner: Creates macro plan with milestones and timeline
```

### Example 2: ADR Approved

```
Architect: ADR approved
Planner: Breaks down architecture into implementable tasks
```

### Example 3: Timeline Conflict

```
Developer: "Task X blocked by external dependency"
Planner: Re-sequences tasks, adjusts timeline, escalates if critical
```
