---
trigger: when_referenced
---
# CEO MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch market/competitor research |
| `sequential-thinking` | `sequential-thinking` | Complex strategic decisions |

## Adapter Usage Patterns

### fetch

**When Used:**
- Market research for PRD validation
- Competitor analysis
- Technology trend research

**Example:**
```
Fetch competitor pricing to validate business model assumptions
```

### sequential-thinking

**When Used:**
- Complex scope decisions
- Multi-factor trade-off analysis
- Strategic planning

**Example:**
```
Analyze scope change request:
- Business impact
- Timeline impact
- Resource impact
- Risk assessment
→ Make informed decision
```

## Adapters NOT Used

CEO does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

CEO operates at strategic level:

- **No code access** - CEO doesn't read/write code
- **No database access** - CEO doesn't query data
- **No security scanning** - CEO doesn't audit code
- **No testing tools** - CEO doesn't run tests

CEO's role is decision-making, not execution.
