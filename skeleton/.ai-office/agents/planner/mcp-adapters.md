---
trigger: when_referenced
---
# Planner MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch planning best practices |
| `sequential-thinking` | `sequential-thinking` | Complex planning decisions |

## Adapter Usage Patterns

### fetch

**When Used:**
- Planning methodology research
- Estimation technique lookup
- Best practices discovery

**Example:**
```
Fetch agile planning best practices for task breakdown
```

### sequential-thinking

**When Used:**
- Complex task sequencing
- Dependency analysis
- Timeline optimization
- Resource allocation decisions

**Example:**
```
Analyze task dependencies:
- Identify critical path
- Find parallelizable work
- Optimize sequence
- Estimate timeline
```

## Adapters NOT Used

Planner does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Planner operates at coordination level:

- **No code access** - Planner doesn't read/write code
- **No database access** - Planner doesn't query data
- **No security scanning** - Planner doesn't audit code
- **No testing tools** - Planner doesn't run tests

Planner's role is planning and tracking, not execution.
