---
trigger: when_referenced
---
# PM Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/01_create_project` | Project creation and PRD drafting |

### Workflow Events

| Event | Action |
|-------|--------|
| New project request | Create PRD |
| Feature request | Analyze and document |
| Scope change request | Evaluate impact |
| User feedback | Incorporate into requirements |

## Secondary Triggers

### Context-Based

- User provides new requirements
- CEO requests PRD update
- Architect reports technical constraint
- QA reports user experience issue

### Escalation-Based

- Developer needs requirement clarification
- Reviewer finds specification gap
- User reports missing functionality

## Activation Conditions

### Required For

- **PRD Creation** - All new projects require PM input
- **Feature Specification** - All features need PM documentation
- **Scope Changes** - PM evaluates impact on user value

### Optional For

- Technical discussions (consulted, not lead)
- Testing strategy (consulted for acceptance criteria)
- Release planning (consulted for feature priority)

## Trigger Examples

### Example 1: New Project

```
Router: Routes "Create task management app" to PM
PM: Creates PRD with user stories and acceptance criteria
```

### Example 2: Feature Request

```
User: "Add dark mode to the dashboard"
PM: Analyzes request, writes user story, defines acceptance criteria
```

### Example 3: Scope Change

```
Architect: "Feature X needs database redesign"
PM: Evaluates user impact, proposes alternative, updates PRD
```
