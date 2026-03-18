---
trigger: when_referenced
---
# Developer MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `supabase` | `supabase` | Database operations, migrations |
| `snyk` | `snyk` | Security scanning during development |
| `fetch` | `fetch` | Fetch documentation, libraries |
| `sequential-thinking` | `sequential-thinking` | Complex implementation decisions |
| `playwright` | `playwright` | E2E test development |
| `ios-simulator` | `ios-simulator` | iOS app testing |

## Adapter Usage Patterns

### supabase

**When Used:**
- Database schema changes
- RLS policy implementation
- Edge function development
- Type generation

**Example:**
```
Create migration for new user preferences table
```

### snyk

**When Used:**
- Security scan during development
- Dependency vulnerability check
- Code security analysis

**Example:**
```
Scan code for security vulnerabilities before commit
```

### fetch

**When Used:**
- Library documentation lookup
- API documentation research
- Best practices discovery

**Example:**
```
Fetch React documentation for new hook usage
```

### sequential-thinking

**When Used:**
- Complex algorithm design
- Multi-step implementation planning
- Edge case analysis

**Example:**
```
Plan implementation of complex feature:
- Identify components
- Plan data flow
- Consider edge cases
- Design test strategy
```

### playwright

**When Used:**
- E2E test development
- Browser automation testing
- UI interaction testing

**Example:**
```
Write E2E test for user registration flow
```

### ios-simulator

**When Used:**
- React Native iOS testing
- iOS app debugging
- Screenshot capture for QA

**Example:**
```
Test iOS app on simulator for UI bugs
```

## Adapters NOT Used

Developer does NOT use:
- `lighthouse` - Performance auditing (QA responsibility)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Developer has broad access for implementation:

- **Full code access** - Read and write code
- **Database access** - Create migrations, query data
- **Security scanning** - Run Snyk during development
- **Testing tools** - Run all test types

Developer's role is implementation, with appropriate tooling.
