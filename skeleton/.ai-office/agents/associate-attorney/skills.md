---
trigger: when_referenced
---
# Associate Attorney Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Validate legal memos, contracts, and court filings across legal, compliance, and procedural perspectives before submission to Compliance Officer |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Self-review of drafted document before routing to Compliance Officer
- Legal memo quality check (argument structure, citation completeness)
- Contract review (clause coverage, risk language, enforceability)
- Court filing pre-check (procedural requirements, format, jurisdictional correctness)

How Used:
- Verify legal argument is coherent and supported by cited precedent
- Check all required sections and exhibits are present
- Confirm language is clear, formal Italian is correct
- Identify any compliance red flags before Compliance Officer review

## Skills NOT Used

Associate Attorney does NOT use:
- `run-tests` — Testing is not applicable to this role
- `generate-tests` — Testing is not applicable to this role
- `refactor-safe` — Code refactoring is out of scope
- `generate-migration` — Database migration is out of scope

## Skill Invocation

```markdown
1. Complete legal research and draft document
2. Invoke review-document-multisector on the draft
3. Revise based on review findings
4. Hand off to Paralegal for formatting
5. Route formatted document to Compliance Officer
```
