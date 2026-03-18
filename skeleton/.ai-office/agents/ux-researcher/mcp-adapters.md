---
trigger: when_referenced
---
# UX Researcher MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `playwright` | `playwright` | Usability testing, user flow simulation |
| `lighthouse` | `lighthouse` | Accessibility and UX auditing |
| `fetch` | `fetch` | Fetch UX research best practices |
| `sequential-thinking` | `sequential-thinking` | Complex user behavior analysis |

## Adapter Usage Patterns

### playwright

**When Used:**
- Automated usability testing
- User flow simulation
- Screenshot capture for analysis
- Interaction pattern testing

**Example:**
```
Simulate user flow through checkout process
```

**Key Functions:**
- `browser_snapshot` - Capture page state for analysis
- `browser_navigate` - Test navigation patterns
- `browser_click` - Test interaction flows

### lighthouse

**When Used:**
- UX performance auditing
- Accessibility auditing
- Best practices validation

**Example:**
```
Run UX audit on landing page
```

### fetch

**When Used:**
- UX research methodology research
- Best practices discovery
- User research patterns

**Example:**
```
Fetch usability testing best practices
```

### sequential-thinking

**When Used:**
- Complex user behavior analysis
- Multi-factor insight synthesis
- Research question prioritization

**Example:**
```
Analyze user behavior pattern:
- Observed actions
- Stated intentions
- Pain points
- Root causes
→ Synthesize actionable insight
```

## Adapters NOT Used

UX Researcher does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `ios-simulator` - iOS testing (QA/Developer)
- `runcomfy` - Image generation (Designer)
- `stitch` - UI generation (Designer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

UX Researcher has focused research access:

- **Playwright access** - Usability testing and flow simulation
- **Lighthouse access** - UX auditing
- **No code modification** - Researcher doesn't write code
- **No database access** - Researcher doesn't query data

UX Researcher's role is user understanding and insight, not implementation.
