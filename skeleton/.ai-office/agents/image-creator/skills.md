---
trigger: when_referenced
---
# Image Creator Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Image documentation review |

## Skill Usage Patterns

### review-document-multisector

**When Used:**
- Image specification review
- Asset documentation review

**How Used:**
- Validate image requirements
- Check accessibility perspective (alt text)
- Verify technical specifications

## Skills NOT Used

Image Creator does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

Image Creator focuses on image production rather than code skills:

```markdown
1. Understand image requirements
2. Create/generate images
3. Optimize and create variants
4. Invoke review-document-multisector (for documentation)
5. Deliver assets
```
