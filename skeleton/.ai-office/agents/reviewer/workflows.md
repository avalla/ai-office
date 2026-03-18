---
trigger: when_referenced
---
# Reviewer Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `60_review_merge` | `60_review_merge.md` | Review and merge workflow |

## Workflow Responsibilities

### 60_review_merge

**Purpose:** Review code and approve/block merge

**Steps:**
1. Receive code from Developer/QA
2. Review against coding standards
3. Check architectural alignment
4. Verify test coverage
5. Check documentation
6. Provide feedback
7. Approve or request changes
8. Track review in status file

**Outputs:**
- Review feedback
- Merge approval/block
- Standards report (if issues)

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `70_release` | Code merged, ready for release |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Code ready for review |
| `50_qa_validate` | QA clearance provided |
| `45_security_pentest` | Security concerns flagged |

## Review Authority

Reviewer holds merge authority:

| Decision | Condition |
|----------|-----------|
| Approve | All standards met, tests pass |
| Request Changes | Issues found, not blocking |
| Block | Critical issues, security concerns |
| Escalate | Architecture violation, standards conflict |

## Review Checklist

Standard review checklist:

- [ ] Code follows coding standards
- [ ] Tests cover new/changed code
- [ ] No security vulnerabilities
- [ ] Documentation updated
- [ ] No architectural violations
- [ ] No performance regressions
- [ ] Acceptance criteria met

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Developer | Review feedback, merge approval |
| Architect | Architecture alignment check |
| Security Specialist | Security concern review |
| QA | Quality clearance coordination |
