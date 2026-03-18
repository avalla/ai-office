---
trigger: when_referenced
---
# Security Specialist Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `security-check` | `security-check.md` | Comprehensive security check |
| `security-pentest` | `security-pentest.md` | Full penetration testing |
| `security-quickcheck` | `security-quickcheck.md` | Rapid security scan |
| `review-rls` | `review-rls.md` | RLS policy security review |
| `review-diff` | `review-diff.md` | Security-focused code review |

## Skill Usage Patterns

### security-check

**When Used:**
- Comprehensive security audit
- Pre-release security scan
- Full project security assessment

**How Used:**
- Run full security scan
- Analyze all findings
- Document in report

### security-pentest

**When Used:**
- Penetration testing engagement
- Deep security analysis
- Attack surface mapping

**How Used:**
- Define scope
- Execute test cases
- Document findings
- Provide remediation

### security-quickcheck

**When Used:**
- Rapid security scan
- PR security check
- Quick vulnerability assessment

**How Used:**
- Fast scan for common issues
- Flag obvious vulnerabilities
- Recommend deeper analysis if needed

### review-rls

**When Used:**
- Database security review
- RLS policy audit
- Data access control verification

**How Used:**
- Review RLS policies
- Test policy effectiveness
- Identify bypass risks

## Skills NOT Used

Security Specialist does NOT use:
- `run-tests` - Functional testing is QA responsibility
- `generate-tests` - Test creation is Developer responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `project-analysis` - Analysis is Planner/Architect responsibility

## Skill Invocation

Security Specialist invokes skills systematically:

```markdown
1. Define security scope
2. Invoke security-quickcheck (initial scan)
3. Invoke security-check (comprehensive)
4. Invoke security-pentest (deep testing)
5. Invoke review-rls (if database involved)
6. Compile findings into report
7. Track remediation
```
