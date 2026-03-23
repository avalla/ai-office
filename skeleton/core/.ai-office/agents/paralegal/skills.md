---
trigger: when_referenced
---
# Paralegal Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Validate document formatting, citation correctness, and completeness before submission |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Pre-submission document formatting check
- Filing package completeness validation
- Version accuracy review before routing to Compliance Officer

How Used:
- Verify Italian court formatting standards are met
- Check all required sections, signatures, and attachments are present
- Confirm document version matches the latest approved draft

## Skills NOT Used

Paralegal does NOT use:
- `run-tests` — Testing is not applicable to this role
- `generate-tests` — Testing is not applicable to this role
- `refactor-safe` — Code implementation is out of scope
- `generate-migration` — Database work is out of scope

## Skill Invocation

```markdown
1. Receive completed draft from Associate Attorney
2. Format document per Italian court standards
3. Assemble filing package (document + exhibits + cover sheet)
4. Invoke review-document-multisector for completeness check
5. Hand off to Compliance Officer for legal compliance review
```
