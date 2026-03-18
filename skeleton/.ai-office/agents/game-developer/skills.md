---
trigger: when_referenced
---
# Game Developer Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `run-tests` | `run-tests.md` | Execute game tests |
| `run-tests-and-summarize` | `run-tests-and-summarize.md` | Test execution with summary |
| `generate-tests` | `generate-tests.md` | Generate game tests |
| `refactor-safe` | `refactor-safe.md` | Safe game code refactoring |
| `review-diff` | `review-diff.md` | Code review before commit |
| `security-quickcheck` | `security-quickcheck.md` | Game security check |

## Skill Usage Patterns

### run-tests / run-tests-and-summarize

**When Used:**
- Unit testing game systems
- Integration testing
- Playtest automation
- Performance testing

**How Used:**
- Run automated tests
- Analyze results
- Report issues

### generate-tests

**When Used:**
- New game systems
- Gameplay mechanics
- Edge case coverage

**How Used:**
- Generate test cases
- Add gameplay scenarios
- Ensure coverage

### refactor-safe

**When Used:**
- Game code optimization
- System restructuring
- Performance improvements

**How Used:**
- Refactor with test coverage
- Verify gameplay unchanged
- Optimize performance

### security-quickcheck

**When Used:**
- Multiplayer security
- Anti-cheat measures
- Data protection

**How Used:**
- Scan for vulnerabilities
- Check for exploits
- Validate security measures

## Skills NOT Used

Game Developer does NOT use:
- `security-pentest` - Deep security audits (Security Specialist)
- `generate-migration` - Database work (Developer)
- `project-analysis` - Analysis (Planner/Architect)

## Skill Invocation

Game Developer invokes skills continuously:

```markdown
1. Implement game systems
2. Invoke generate-tests
3. Invoke run-tests-and-summarize
4. IF issues: Debug and fix
5. Invoke refactor-safe (optimization)
6. Invoke review-diff (self-review)
7. Commit changes
```
