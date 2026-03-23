---
trigger: when_referenced
---
# PM Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `project-analysis` | `project-analysis.md` | Analyze existing project context |
| `review-document-multisector` | `review-document-multisector.md` | PRD quality validation |

## Skill Usage Patterns

### project-analysis

**When Used:**
- Import project requests
- Understanding existing project context
- Detecting current capabilities

**How Used:**
- Analyze project structure
- Identify existing features
- Map user-facing functionality

### review-document-multisector

**When Used:**
- PRD self-review before CEO submission
- Validating requirement completeness
- Cross-functional document check

**How Used:**
- Invoke before PRD submission
- Check all perspectives covered
- Validate against framework standards

## Skills NOT Used

PM does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `security-check` - Security is Security Specialist responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `trace-request-to-code` - Technical tracing is Developer responsibility
- `generate-migration` - Database work is Developer/Architect responsibility

## Skill Invocation

PM invokes skills for documentation quality:

```markdown
1. Create PRD draft
2. Invoke project-analysis (if existing project)
3. Invoke review-document-multisector
4. Address feedback
5. Submit to CEO
```

## Skill Output Usage

PM uses skill outputs for:
- PRD completeness validation
- Feature gap identification
- Requirement prioritization
