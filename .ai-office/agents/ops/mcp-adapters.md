---
trigger: when_referenced
---
# Ops MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch postmortem best practices |
| `sequential-thinking` | `sequential-thinking` | Complex incident analysis |

## Adapter Usage Patterns

### fetch

**When Used:**
- Postmortem template research
- Incident analysis best practices
- Process improvement patterns

**Example:**
```
Fetch postmortem best practices for incident documentation
```

### sequential-thinking

**When Used:**
- Complex incident root cause analysis
- Multi-factor process improvement
- Pattern identification

**Example:**
```
Analyze incident root cause:
- Timeline reconstruction
- Contributing factors
- System interactions
- Human factors
→ Identify root cause and prevention
```

## Adapters NOT Used

Ops does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Ops operates at analysis level:

- **No code access** - Ops doesn't read/write code
- **No database access** - Ops doesn't query data
- **No security scanning** - Ops doesn't audit code
- **No testing tools** - Ops doesn't run tests

Ops's role is learning capture and process improvement, not execution.
