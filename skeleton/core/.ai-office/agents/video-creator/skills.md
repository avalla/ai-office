---
trigger: when_referenced
---
# Video Creator Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Video documentation review |

## Skill Usage Patterns

### review-document-multisector

**When Used:**
- Video specification review
- Asset documentation review

**How Used:**
- Validate video requirements
- Check accessibility perspective
- Verify technical specifications

## Skills NOT Used

Video Creator does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

Video Creator focuses on video production rather than code skills:

```markdown
1. Understand video requirements
2. Create storyboard
3. Produce video
4. Coordinate with Audio Creator
5. Invoke review-document-multisector (for documentation)
6. Deliver assets
```
