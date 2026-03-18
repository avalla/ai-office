---
trigger: when_referenced
---
# Release Manager Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/70_release` | Execute release workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| All clearances complete | Prepare release |
| Release scheduled | Execute release |
| Deployment issue | Coordinate resolution |
| Post-release issue | Coordinate hotfix |

## Secondary Triggers

### Context-Based

- CEO authorizes release
- QA provides quality clearance
- Security Specialist provides security clearance
- Reviewer approves merge

### Escalation-Based

- Deployment failure
- Post-release bug
- Rollback needed
- Hotfix required

## Activation Conditions

### Required For

- **All Releases** - No release without Release Manager
- **Hotfixes** - Emergency releases
- **Rollbacks** - Deployment rollbacks

### Optional For

- Architecture discussions (deployment implications)
- PRD review (release timeline)
- ADR review (deployment complexity)

## Trigger Examples

### Example 1: Release Authorized

```
CEO: Authorizes release v1.2.0
Release Manager: Coordinates deployment, executes release, announces
```

### Example 2: Deployment Failure

```
System: Deployment failed
Release Manager: Executes rollback, coordinates fix, reschedules release
```

### Example 3: Hotfix Needed

```
User: Reports critical production bug
Release Manager: Coordinates hotfix, fast-tracks release, announces fix
```
