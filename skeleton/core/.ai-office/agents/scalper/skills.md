---
trigger: when_referenced
---
# Scalper Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Validate execution playbooks and risk rule clarity |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Execution rulebook review
- Risk limits matrix review
- Monitoring and alerting checklist review

How Used:
- Verify implementation readiness
- Confirm cross-team clarity and risk ownership
- Ensure edge-case conditions are explicitly documented

## Skills NOT Used

Scalper does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

```markdown
1. Draft execution and risk rules
2. Document monitoring requirements
3. Invoke review-document-multisector
4. Hand off to Developer/Security/QA
```
