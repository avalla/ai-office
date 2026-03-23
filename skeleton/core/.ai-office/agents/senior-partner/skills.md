---
trigger: when_referenced
---
# Senior Partner Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Final approval review of all client-facing legal documents — arguments, strategy, legal soundness, and client impact |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Every document submitted for Partner signature (no exceptions)
- Legal opinion review (parere legale) before delivery to client
- Complex contract review before execution
- Court filing review before submission
- Settlement agreement review before client signature

How Used:
- Evaluate legal argument strength and likely judicial reception
- Assess risk language and client exposure
- Check strategic alignment with approved case direction
- Verify Compliance Officer and Reviewer clearances are present
- Approve (sign) or return with specific revision instructions

## Skills NOT Used

Senior Partner does NOT use:
- `run-tests` — Testing is not applicable to this role
- `generate-tests` — Testing is not applicable to this role
- `refactor-safe` — Code refactoring is out of scope
- `generate-migration` — Database migration is out of scope

## Skill Invocation

```markdown
1. Receive document after Reviewer clearance
2. Verify compliance certificate and reviewer sign-off are present
3. Invoke review-document-multisector
4. Decision: APPROVED (sign) or RETURNED (specific revision instructions)
5. If approved: document goes to client or court
6. If returned: document goes back to Associate Attorney
```
