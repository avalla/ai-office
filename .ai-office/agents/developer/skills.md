---
trigger: when_referenced
---
# Developer Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `run-tests` | `run-tests.md` | Execute test suite |
| `run-tests-and-summarize` | `run-tests-and-summarize.md` | Test execution with summary |
| `generate-tests` | `generate-tests.md` | Generate test cases |
| `refactor-safe` | `refactor-safe.md` | Safe refactoring with tests |
| `review-diff` | `review-diff.md` | Self-review before submission |
| `trace-request-to-code` | `trace-request-to-code.md` | Map requirements to code |
| `generate-migration` | `generate-migration.md` | Create database migrations |

## Skill Usage Patterns

### run-tests / run-tests-and-summarize

**When Used:**
- After implementation
- After refactoring
- During debugging
- Before submission

**How Used:**
- Run full test suite
- Identify failures
- Fix issues
- Re-run until all pass

### generate-tests

**When Used:**
- New feature implementation
- Bug fix (regression test)
- Coverage improvement

**How Used:**
- Generate test cases from requirements
- Add edge cases
- Ensure coverage

### refactor-safe

**When Used:**
- Code cleanup
- Technical debt reduction
- Performance optimization

**How Used:**
- Identify refactoring target
- Ensure tests cover behavior
- Refactor incrementally
- Verify tests still pass

### trace-request-to-code

**When Used:**
- Understanding existing codebase
- Impact analysis for changes
- Debugging complex issues

**How Used:**
- Map requirement to code location
- Understand code flow
- Identify change points

### generate-migration

**When Used:**
- Database schema changes
- Data migrations
- RLS policy updates

**How Used:**
- Create migration file
- Include rollback
- Test migration

## Skills NOT Used

Developer does NOT use:
- `security-pentest` - Security audits are Security Specialist responsibility
- `review-document-multisector` - Document review is PM/CEO responsibility
- `project-analysis` - Analysis is Planner/Architect responsibility

## Skill Invocation

Developer invokes skills continuously during implementation:

```markdown
1. Understand task
2. Invoke trace-request-to-code (if existing codebase)
3. Implement code
4. Invoke generate-tests
5. Invoke run-tests-and-summarize
6. IF tests fail: Debug and fix
7. Invoke refactor-safe (if cleanup needed)
8. Invoke review-diff (self-review)
9. Submit for review
```
