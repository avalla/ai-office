---
trigger: when_referenced
---
# Release Manager Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `70_release` | `70_release.md` | Release workflow |

## Workflow Responsibilities

### 70_release

**Purpose:** Execute release process

**Steps:**
1. Collect all clearances (CEO, QA, Security, Reviewer)
2. Verify release checklist complete
3. Prepare release notes
4. Execute deployment
5. Monitor deployment status
6. Announce release
7. Update version and changelog

**Outputs:**
- Release notes
- Deployed release
- Changelog update
- Version tag

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `90_postmortem_memory` | Release complete, ready for retrospective |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `60_review_merge` | Code merged, ready for release |
| `50_qa_validate` | QA clearance provided |
| `45_security_pentest` | Security clearance provided |

## Release Checklist

Standard release checklist:

- [ ] CEO authorization
- [ ] QA clearance
- [ ] Security clearance
- [ ] Code review approved
- [ ] Tests passing
- [ ] Release notes prepared
- [ ] Rollback plan documented
- [ ] Stakeholders notified

## Clearance Requirements

| Clearance | From | Required |
|-----------|------|----------|
| CEO Authorization | CEO | Yes |
| Quality Clearance | QA | Yes |
| Security Clearance | Security Specialist | Yes |
| Code Review | Reviewer | Yes |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | Release authorization |
| QA | Quality clearance |
| Security Specialist | Security clearance |
| Reviewer | Code review approval |
| Developer | Deployment support |
| Ops | Post-release monitoring |
