---
trigger: when_referenced
---
# Release Manager MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch release best practices |
| `sequential-thinking` | `sequential-thinking` | Complex release decisions |

## Adapter Usage Patterns

### fetch

**When Used:**
- Release process research
- Best practices discovery
- Version management documentation

**Example:**
```
Fetch semantic versioning best practices for release planning
```

### sequential-thinking

**When Used:**
- Complex release decisions
- Rollback decision analysis
- Hotfix prioritization

**Example:**
```
Analyze release decision:
- Clearance status
- Risk assessment
- Rollback complexity
- Stakeholder impact
→ Make release decision
```

## Adapters NOT Used

Release Manager does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Release Manager operates at coordination level:

- **No code access** - Release Manager doesn't read/write code
- **No database access** - Release Manager doesn't query data
- **No security scanning** - Release Manager doesn't audit code
- **No testing tools** - Release Manager doesn't run tests

Release Manager's role is coordination and communication, not execution.
