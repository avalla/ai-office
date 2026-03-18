---
trigger: when_referenced
---
# Reviewer Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/60_review_merge` | Run review and merge workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| Code ready for review | Perform code review |
| QA clearance received | Final review before merge |
| Merge requested | Review and approve/block |

## Secondary Triggers

### Context-Based

- Developer submits PR
- QA provides clearance
- Architect requests architecture review
- Security Specialist flags security concern

### Escalation-Based

- Developer requests review clarification
- QA finds issues post-merge
- User reports code quality issue
- Standards violation detected

## Activation Conditions

### Required For

- **All Code Merges** - No code merges without review
- **Architecture Changes** - Architecture alignment review
- **Security-Sensitive Code** - Security-focused review

### Optional For

- Documentation review
- Test plan review
- PRD review (technical perspective)

## Trigger Examples

### Example 1: Code Ready

```
Developer: "PR ready for review"
Reviewer: Reviews code, provides feedback, approves or requests changes
```

### Example 2: QA Clearance

```
QA: "Tests pass, quality clearance provided"
Reviewer: Final review, merge approval
```

### Example 3: Architecture Change

```
Architect: "New ADR approved, implementation ready"
Reviewer: Reviews for architecture alignment
```
