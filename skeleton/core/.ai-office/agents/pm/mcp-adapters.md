---
trigger: when_referenced
---
# PM MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch market research, competitor analysis |
| `sequential-thinking` | `sequential-thinking` | Complex prioritization decisions |

## Adapter Usage Patterns

### fetch

**When Used:**
- Market research for PRD
- Competitor feature analysis
- User trend research
- Best practice discovery

**Example:**
```
Fetch competitor app features to inform requirements
```

### sequential-thinking

**When Used:**
- Complex prioritization decisions
- Multi-stakeholder trade-off analysis
- Feature sequencing decisions

**Example:**
```
Analyze feature priorities:
- User value
- Business impact
- Technical complexity
- Dependencies
→ Create prioritized roadmap
```

## Adapters NOT Used

PM does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

PM operates at product level:

- **No code access** - PM doesn't read/write code
- **No database access** - PM doesn't query data
- **No security scanning** - PM doesn't audit code
- **No testing tools** - PM doesn't run tests

PM's role is requirements and prioritization, not execution.
