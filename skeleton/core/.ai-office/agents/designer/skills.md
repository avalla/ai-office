---
trigger: when_referenced
---
# Designer Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Design spec review |

## Skill Usage Patterns

### review-document-multisector

**When Used:**
- Design specification review
- Design system documentation review

**How Used:**
- Validate design completeness
- Check accessibility perspective
- Verify developer clarity

## Skills NOT Used

Designer does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

Designer focuses on visual tools rather than code skills:

```markdown
1. Understand requirements
2. Create user flows
3. Design wireframes/mockups
4. Invoke review-document-multisector (for specs)
5. Handoff to Developer
```
