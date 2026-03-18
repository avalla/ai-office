---
trigger: when_referenced
---
# Router Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `00_router` | `00_router.md` | Main routing workflow |

## Workflow Responsibilities

### 00_router

**Purpose:** Entry point for all requests

**Steps:**
1. Analyze incoming request
2. Classify request type
3. Select target workflow
4. Initialize status file
5. Trigger target workflow
6. Log routing decision

**Outputs:**
- Status file initialized
- Routing decision documented
- Target workflow triggered

## Workflow Interactions

### Routes To

| Workflow | Condition |
|----------|-----------|
| `01_create_project` | New project request |
| `import-project` | Existing project import |
| `develop-feature` | Feature development |
| `office-investor-report` | Status report generation |
| Bug fix pipeline | Bug fix request |

### Receives From

| Workflow | Condition |
|----------|-----------|
| Any workflow | On completion (for next-step routing) |
| Any workflow | On block (for alternative path) |

## State Management

Router manages the `status.md` file:

```markdown
# Status: {project-slug}

## Current State
- **Workflow:** {workflow-name}
- **Agent:** {agent-name}
- **Status:** {pending|in_progress|blocked|completed}

## Routing Log
- **{timestamp}:** Routed to {workflow} - {reason}
```

## Workflow Chaining

Router can chain workflows:

1. **Sequential:** A → B → C (each completes before next)
2. **Conditional:** A → (B if X, C if Y)
3. **Parallel:** A → (B + C simultaneously)

Chaining is logged in status file with clear dependency tracking.
