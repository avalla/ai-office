---
trigger: when_referenced
---
# Architect Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `analyze-repo` | `analyze-repo.md` | Analyze existing codebase structure |
| `project-analysis` | `project-analysis.md` | Deep project analysis |
| `review-document-multisector` | `review-document-multisector.md` | ADR quality validation |
| `security-quickcheck` | `security-quickcheck.md` | Security implications check |

## Skill Usage Patterns

### analyze-repo

**When Used:**
- Understanding existing architecture
- Import project analysis
- Impact assessment for changes

**How Used:**
- Analyze codebase structure
- Identify patterns and anti-patterns
- Map dependencies

### project-analysis

**When Used:**
- New project architecture design
- Feasibility assessment
- Technology fit analysis

**How Used:**
- Deep analysis of requirements
- Technology capability mapping
- Constraint identification

### security-quickcheck

**When Used:**
- Architecture security implications
- Technology security assessment
- Design security validation

**How Used:**
- Quick security scan of proposed architecture
- Identify potential vulnerabilities
- Validate security assumptions

## Skills NOT Used

Architect does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `trace-request-to-code` - Detailed tracing is Developer responsibility
- `generate-migration` - Migration creation is Developer responsibility

## Skill Invocation

Architect invokes skills for architecture validation:

```markdown
1. Design architecture
2. Invoke analyze-repo (if existing project)
3. Invoke security-quickcheck
4. Invoke review-document-multisector
5. Finalize ADR
```
