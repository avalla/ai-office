---
trigger: when_referenced
---
# Release Manager Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Release notes review |
| `postmortem-update` | `postmortem-update.md` | Post-release retrospective |

## Skill Usage Patterns

### review-document-multisector

**When Used:**
- Release notes review
- Changelog review
- Communication document review

**How Used:**
- Validate release notes completeness
- Check all stakeholder perspectives
- Ensure clarity and accuracy

### postmortem-update

**When Used:**
- Post-release retrospective
- Release issue documentation
- Process improvement capture

**How Used:**
- Document release learnings
- Capture process improvements
- Update memory

## Skills NOT Used

Release Manager does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility
- `task-create` - Task creation is Planner responsibility

## Skill Invocation

Release Manager invokes skills for release coordination:

```markdown
1. Collect clearances
2. Prepare release notes
3. Invoke review-document-multisector (release notes)
4. Execute deployment
5. Announce release
6. Invoke postmortem-update (for retrospective)
```
