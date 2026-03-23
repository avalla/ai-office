---
trigger: when_referenced
---
# QA Engineer MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `playwright` | `playwright` | E2E testing, browser automation |
| `lighthouse` | `lighthouse` | Performance, accessibility, SEO auditing |
| `ios-simulator` | `ios-simulator` | iOS app testing |
| `fetch` | `fetch` | Fetch testing documentation |
| `sequential-thinking` | `sequential-thinking` | Complex test scenario planning |

## Adapter Usage Patterns

### playwright

**When Used:**
- E2E test execution
- Browser automation testing
- UI interaction testing
- Screenshot capture for bug reports

**Example:**
```
Run E2E test suite for user registration flow
```

**Key Functions:**
- Browser navigation and interaction
- Screenshot capture
- Console log analysis
- Network request inspection

### lighthouse

**When Used:**
- Performance auditing
- Accessibility testing
- SEO validation
- Best practices checking

**Example:**
```
Run Lighthouse audit on dashboard page
```

### ios-simulator

**When Used:**
- React Native iOS testing
- iOS app UI testing
- Screenshot capture for iOS bugs

**Example:**
```
Test iOS app on simulator for UI bugs
```

### fetch

**When Used:**
- Testing documentation research
- Best practices discovery
- Tool documentation lookup

**Example:**
```
Fetch Playwright documentation for new testing patterns
```

## Adapters NOT Used

QA Engineer does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

QA Engineer has focused testing access:

- **Full Playwright access** - All E2E testing capabilities
- **Full Lighthouse access** - All auditing capabilities
- **iOS Simulator access** - iOS testing
- **No code modification** - Tests code, doesn't change it
- **No database modification** - Can query for testing, not modify

QA Engineer's role is validation, not implementation.
