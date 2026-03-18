---
trigger: when_referenced
---
# Security Specialist MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `snyk` | `snyk` | Primary security scanning tool |
| `fetch` | `fetch` | Fetch security advisories, CVE details |
| `sequential-thinking` | `sequential-thinking` | Complex vulnerability analysis |
| `supabase` | `supabase` | RLS policy review, database security |

## Adapter Usage Patterns

### snyk

**When Used:**
- All security scans
- Dependency vulnerability scanning
- Code security analysis (SAST)
- Container security scanning
- Infrastructure as Code scanning

**Example:**
```
Run Snyk code scan on authentication module
```

**Key Functions:**
- `snyk_code_scan` - SAST scanning
- `snyk_sca_scan` - Dependency scanning
- `snyk_container_scan` - Container security
- `snyk_iac_scan` - IaC security

### fetch

**When Used:**
- CVE research
- Security advisory lookup
- Exploit database research
- Best practices discovery

**Example:**
```
Fetch CVE-2024-1234 details for vulnerability assessment
```

### sequential-thinking

**When Used:**
- Complex vulnerability impact analysis
- Attack chain analysis
- Risk assessment

**Example:**
```
Analyze attack chain:
- Initial vulnerability
- Privilege escalation path
- Data exposure risk
- Business impact
```

### supabase

**When Used:**
- RLS policy review
- Database security audit
- Permission verification

**Example:**
```
Review RLS policies for user data table
```

## Adapters NOT Used

Security Specialist does NOT use:
- `playwright` - E2E testing (QA responsibility)
- `lighthouse` - Performance auditing (QA responsibility)
- `runcomfy` - Image generation (not applicable)
- `stitch` - UI generation (not applicable)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Security Specialist has focused security access:

- **Full Snyk access** - All security scanning capabilities
- **Read-only database** - Security review, not modification
- **Fetch access** - Security research
- **No code modification** - Reports issues, doesn't fix

Security Specialist's role is assessment and guidance, not implementation.
