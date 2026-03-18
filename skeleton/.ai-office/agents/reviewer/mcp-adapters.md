---
trigger: when_referenced
---
# Reviewer MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `snyk` | `snyk` | Quick security scan during review |
| `fetch` | `fetch` | Fetch coding standards, best practices |
| `sequential-thinking` | `sequential-thinking` | Complex review analysis |

## Adapter Usage Patterns

### snyk

**When Used:**
- Quick security scan during code review
- Dependency vulnerability check
- Code security analysis (SAST)

**Example:**
```
Quick Snyk scan on changed files for security issues
```

### fetch

**When Used:**
- Coding standards lookup
- Best practices research
- Framework documentation

**Example:**
```
Fetch TypeScript best practices for code review reference
```

### sequential-thinking

**When Used:**
- Complex code review analysis
- Multi-file change assessment
- Architecture impact analysis

**Example:**
```
Analyze complex refactoring:
- Impact on existing code
- Breaking change risk
- Test coverage gaps
- Documentation needs
```

## Adapters NOT Used

Reviewer does NOT use:
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Reviewer has focused review access:

- **Limited Snyk access** - Quick scans, not comprehensive audits
- **Read-only code access** - Reviews code, doesn't modify
- **No database access** - Doesn't query or modify data
- **No testing tools** - Doesn't run tests (QA responsibility)

Reviewer's role is analysis and feedback, not execution.
