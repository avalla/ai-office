---
trigger: when_referenced
---
# Architect MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch technology documentation |
| `sequential-thinking` | `sequential-thinking` | Complex architecture decisions |
| `supabase` | `supabase` | Database schema design |
| `snyk` | `snyk` | Dependency security analysis |

## Adapter Usage Patterns

### fetch

**When Used:**
- Technology documentation research
- Best practices discovery
- Architecture pattern research

**Example:**
```
Fetch React 19 documentation to evaluate new features for architecture
```

### sequential-thinking

**When Used:**
- Complex architecture trade-offs
- Multi-option evaluation
- System design decisions

**Example:**
```
Analyze database options:
- PostgreSQL vs MongoDB
- Scalability requirements
- Query patterns
- Team expertise
→ Make documented recommendation
```

### supabase

**When Used:**
- Database schema design
- RLS policy planning
- Migration strategy

**Example:**
```
Design database schema for multi-tenant architecture
```

### snyk

**When Used:**
- Dependency security analysis
- Technology vulnerability check
- Security-conscious technology selection

**Example:**
```
Scan proposed dependencies for known vulnerabilities
```

## Adapters NOT Used

Architect does NOT use:
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Architect operates at design level:

- **Limited code access** - Architect reads code for analysis, doesn't write
- **Database design access** - Can design schemas via Supabase
- **Security scanning access** - Can scan dependencies via Snyk
- **No testing tools** - Architect doesn't run tests

Architect's role is design and documentation, not implementation.
