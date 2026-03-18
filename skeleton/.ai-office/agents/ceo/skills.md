---
trigger: when_referenced
---
# CEO Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Multi-sector PRD review |

## Skill Usage Patterns

### review-document-multisector

**When Used:**
- PRD review and approval
- ADR review (major decisions)
- Any document requiring multi-perspective validation

**How Used:**
- Invoke for comprehensive document review
- Check business, technical, security, and quality perspectives
- Validate against framework standards

## Skills NOT Used

CEO does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `security-check` - Security is Security Specialist responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `trace-request` - Routing is Router responsibility
- `project-analysis` - Analysis is Planner/Architect responsibility

## Skill Invocation

CEO invokes skills selectively:

```markdown
1. Review document manually
2. IF needs multi-perspective validation:
   - Invoke review-document-multisector
3. Make approval decision
4. Document in status file
```

## Skill Output Usage

CEO uses skill outputs for:
- Approval decisions
- Feedback to other agents
- Status file documentation

CEO does NOT:
- Execute technical skills directly
- Perform code analysis
- Run automated checks
