---
trigger: when_referenced
---
# Reviewer Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-diff` | `review-diff.md` | Code diff review |
| `review-document-multisector` | `review-document-multisector.md` | Document review |
| `security-quickcheck` | `security-quickcheck.md` | Security scan during review |

## Skill Usage Patterns

### review-diff

**When Used:**
- Every code review
- PR analysis
- Change impact assessment

**How Used:**
- Analyze code changes
- Identify issues
- Provide feedback
- Track review

### review-document-multisector

**When Used:**
- Documentation review
- Multi-perspective document check

**How Used:**
- Validate document quality
- Check all perspectives
- Provide feedback

### security-quickcheck

**When Used:**
- Security-focused code review
- Quick security scan during review

**How Used:**
- Scan for common vulnerabilities
- Flag security concerns
- Recommend Security Specialist review if needed

## Skills NOT Used

Reviewer does NOT use:
- `run-tests` - Test execution is QA responsibility
- `generate-tests` - Test creation is Developer responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-pentest` - Deep security testing is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

Reviewer invokes skills systematically:

```markdown
1. Receive code for review
2. Invoke review-diff
3. Invoke security-quickcheck (if security-sensitive)
4. Compile feedback
5. Approve or request changes
6. Track review in status file
```
