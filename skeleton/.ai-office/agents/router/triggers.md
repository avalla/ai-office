---
trigger: when_referenced
---
# Router Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/00_router` | Explicit router invocation |
| `/router` | Alias for router invocation |

### Request Patterns

| Pattern | Route To |
|---------|----------|
| "Create a new project" | `01_create_project` workflow |
| "Import existing project" | `import-project` workflow |
| "Add feature to..." | Feature development pipeline |
| "Fix bug in..." | Bug fix pipeline |
| "Generate report" | `office-investor-report` workflow |
| "Develop feature" | `develop-feature` workflow |

## Secondary Triggers

### Context-Based

- New conversation with project-related request
- Request without clear workflow association
- Multiple possible workflows detected

### Escalation-Based

- Other agents unable to classify request
- Workflow completion requiring next-step routing
- Blocked workflow requiring alternative path

## Activation Conditions

### Always Active

Router is the **entry point** for all requests:

1. **First agent activated** for any new request
2. **Required before** any other workflow
3. **Re-activates** when workflow completes or blocks

### Deactivation

Router deactivates after:
- Routing decision is made
- Status file is initialized
- Target workflow is triggered

## Trigger Examples

### Example 1: New Project

```
User: "I want to build a task management app"
Router: Classifies as "new project" → Routes to 01_create_project
```

### Example 2: Feature Request

```
User: "Add dark mode to the dashboard"
Router: Classifies as "feature" → Routes to develop-feature
```

### Example 3: Ambiguous Request

```
User: "The app is slow"
Router: Classifies as "bug/performance" → Routes to bug fix pipeline
        OR escalates to Planner for investigation
```
