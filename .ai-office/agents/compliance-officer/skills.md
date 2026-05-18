---
trigger: when_referenced
---
# Compliance Officer Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Verify legal code compliance, GDPR conformity, ethical rules, and deadline accuracy across all document types before Partner review |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Every document that enters the compliance gate (mandatory for all client-facing work)
- Special review for documents touching GDPR-sensitive data
- Compliance audit of multi-document filing packages
- Re-review after Associate Attorney revises a previously flagged document

How Used:
- Check each clause or section against applicable Italian code provisions
- Verify all citations are accurate and current (no superseded law)
- Confirm deadline dates are correctly calculated from triggering events
- Check professional ethics compliance (no prohibited fee arrangements, no conflict of interest)
- Issue compliance certificate or return with specific non-compliance notes

## Skills NOT Used

Compliance Officer does NOT use:
- `run-tests` — Testing is not applicable to this role
- `generate-tests` — Testing is not applicable to this role
- `refactor-safe` — Code refactoring is out of scope
- `generate-migration` — Database migration is out of scope

## Skill Invocation

```markdown
1. Receive formatted document from Paralegal
2. Invoke review-document-multisector
3. Issue compliance certificate (✅ Compliant) or return with itemised issues
4. If returned: specify exact code reference for each issue
5. Re-review revised document before routing to Reviewer
```
