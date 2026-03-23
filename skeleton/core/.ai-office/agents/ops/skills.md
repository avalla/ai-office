---
trigger: when_referenced
---
# Ops Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `postmortem-update` | `postmortem-update.md` | Create postmortem report |
| `review-document-multisector` | `review-document-multisector.md` | Postmortem review |

## Skill Usage Patterns

### postmortem-update

**When Used:**
- After every release
- After every incident
- After process improvement

**How Used:**
- Document what happened
- Analyze root cause
- Propose improvements
- Update memory

### review-document-multisector

**When Used:**
- Postmortem document review
- Process document review

**How Used:**
- Validate postmortem completeness
- Check all perspectives covered
- Ensure actionable recommendations

## Skills NOT Used

Ops does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility
- `task-create` - Task creation is Planner responsibility

## Skill Invocation

Ops invokes skills for learning capture:

```markdown
1. Collect context (release/incident)
2. Analyze events
3. Invoke postmortem-update
4. Invoke review-document-multisector
5. Update memory/knowledge base
6. Share learnings
```
