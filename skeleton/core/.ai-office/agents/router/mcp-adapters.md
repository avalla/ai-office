---
trigger: when_referenced
---
# Router MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch external documentation |
| `sequential-thinking` | `sequential-thinking` | Complex routing decisions |

## Adapter Usage Patterns

### fetch

**When Used:**
- Fetching workflow documentation
- Retrieving external project context
- Looking up framework updates

**Example:**
```
Fetch latest workflow documentation to ensure routing uses current patterns
```

### sequential-thinking

**When Used:**
- Ambiguous requests requiring analysis
- Multi-step routing decisions
- Complex workflow chaining

**Example:**
```
Analyze request with multiple possible routes
- Consider project context
- Evaluate workflow options
- Select optimal path
```

## Adapters NOT Used

Router does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Router operates with minimal external dependencies:

- **No database access** - Router doesn't query Supabase
- **No security scanning** - Router doesn't run Snyk
- **No browser automation** - Router doesn't use Playwright
- **No testing tools** - Router doesn't run tests

Router's role is coordination, not execution.
