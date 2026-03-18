---
trigger: when_referenced
---
# Audio Creator Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Audio documentation review |

## Skill Usage Patterns

### review-document-multisector

**When Used:**
- Audio specification review
- Asset documentation review

**How Used:**
- Validate audio requirements
- Check accessibility perspective
- Verify technical specifications

## Skills NOT Used

Audio Creator does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

Audio Creator focuses on audio production rather than code skills:

```markdown
1. Understand audio requirements
2. Create/source audio assets
3. Process and optimize
4. Invoke review-document-multisector (for documentation)
5. Deliver assets
```
