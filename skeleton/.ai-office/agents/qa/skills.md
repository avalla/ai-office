---
trigger: when_referenced
---
# QA Engineer Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `run-tests` | `run-tests.md` | Execute test suite |
| `run-tests-and-summarize` | `run-tests-and-summarize.md` | Test execution with summary |
| `generate-tests` | `generate-tests.md` | Generate test cases |
| `review-document-multisector` | `review-document-multisector.md` | Test plan review |

## Skill Usage Patterns

### run-tests / run-tests-and-summarize

**When Used:**
- Every QA validation
- Pre-release testing
- Regression testing
- Bug verification

**How Used:**
- Execute full test suite
- Analyze results
- Report failures
- Track coverage

### generate-tests

**When Used:**
- Creating test cases from acceptance criteria
- Expanding test coverage
- Edge case testing

**How Used:**
- Generate tests from requirements
- Add edge cases
- Ensure coverage

### review-document-multisector

**When Used:**
- Test plan review
- Quality documentation review

**How Used:**
- Validate test plan completeness
- Check all perspectives covered

## Skills NOT Used

QA Engineer does NOT use:
- `refactor-safe` - Implementation is Developer responsibility
- `security-pentest` - Security testing is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility
- `trace-request-to-code` - Developer tracing responsibility

## Skill Invocation

QA Engineer invokes skills systematically:

```markdown
1. Review acceptance criteria
2. Invoke generate-tests (if new tests needed)
3. Invoke run-tests-and-summarize
4. Analyze results
5. IF failures: Report bugs to Developer
6. Re-test after fixes
7. Document results in test plan
8. Provide clearance
```
