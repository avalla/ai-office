---
trigger: when_referenced
---
# Practice Manager Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Validate invoices, billing summaries, and administrative reports before sending to clients or Partner |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Invoice review before sending to client
- Monthly billing report review for Partner
- Matter status summary review for accuracy
- Engagement letter completeness check at client onboarding

How Used:
- Verify all billable hours are correctly attributed
- Check invoice amounts match engagement letter terms
- Confirm all required information is present and accurate
- Catch arithmetic errors or missing line items

## Skills NOT Used

Practice Manager does NOT use:
- `run-tests` — Testing is not applicable to this role
- `generate-tests` — Testing is not applicable to this role
- `refactor-safe` — Code implementation is out of scope
- `generate-migration` — Database work is out of scope

## Skill Invocation

```markdown
1. Compile billing data from time tracking records
2. Draft invoice or billing report
3. Invoke review-document-multisector for accuracy check
4. Send to client or Partner as appropriate
```
