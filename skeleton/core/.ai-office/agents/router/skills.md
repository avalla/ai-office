---
trigger: when_referenced
---
# Router Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `project-analysis` | `project-analysis.md` | Analyze existing project context |
| `trace-request` | `trace-request.md` | Trace request to existing work |

## Skill Usage Patterns

### project-analysis

**When Used:**
- Import project requests
- Context gathering for routing decisions
- Detecting existing project state

**How Used:**
- Quick analysis to determine project type
- Identify existing artifacts
- Check for blocking issues

### trace-request

**When Used:**
- Feature requests on existing projects
- Bug reports
- Requests that may relate to existing work

**How Used:**
- Match request to existing tasks
- Identify related artifacts
- Detect duplicate or related work

## Skills NOT Used

Router does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `security-check` - Security is Security Specialist responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `review-diff` - Review is Reviewer responsibility

## Skill Invocation

Router invokes skills minimally:

```markdown
1. Analyze request
2. IF needs context:
   - Invoke project-analysis (quick mode)
3. IF might relate to existing work:
   - Invoke trace-request
4. Make routing decision
```

## Skill Output Usage

Router uses skill outputs for:
- Routing decisions (not implementation)
- Status file context
- Workflow parameter passing

Router does NOT:
- Modify code
- Create artifacts
- Execute implementation
