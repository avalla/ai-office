---
trigger: when_referenced
---
# QA Engineer Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `50_qa_validate` | `50_qa_validate.md` | QA validation workflow |

## Workflow Responsibilities

### 50_qa_validate

**Purpose:** Validate implementation quality

**Steps:**
1. Receive implementation from Developer
2. Review acceptance criteria
3. Run test suite
4. Perform manual testing (if needed)
5. Run E2E tests
6. Run performance tests
7. Document results
8. Provide clearance or report issues

**Outputs:**
- Test results
- Bug reports (if any)
- Quality clearance
- Test plan update (if needed)

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `60_review_merge` | QA clearance provided |
| `70_release` | Quality approved for release |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Implementation ready |
| `45_security_pentest` | Security findings to verify |
| `60_review_merge` | Review feedback to verify |

## Document Ownership

QA Engineer owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Test Plan | `docs/qa/<slug>-testplan.md` | Testing strategy |
| Test Results | Within test plan | Test execution results |
| Bug Reports | Task files | Bug documentation |

## Quality Gates

QA Engineer holds veto authority for:

| Gate | Condition |
|------|-----------|
| Feature Acceptance | Acceptance criteria not met |
| Release | Quality thresholds not met |
| Merge | Tests failing |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Acceptance criteria clarification |
| Developer | Bug reports, test failures |
| Security Specialist | Security test integration |
| Reviewer | Quality standards alignment |
