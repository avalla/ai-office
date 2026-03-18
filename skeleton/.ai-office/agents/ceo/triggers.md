---
trigger: when_referenced
---
# CEO Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/10_ceo_prd` | CEO PRD review and approval |

### Workflow Events

| Event | Action |
|-------|--------|
| PRD draft complete | Review and approve/reject |
| Major scope change | Evaluate and decide |
| Project milestone | Sign-off required |
| Critical blocker | Escalation handling |

## Secondary Triggers

### Escalation-Based

- Planner reports timeline conflict
- QA reports quality threshold breach
- Security reports critical vulnerability
- Release Manager reports deployment risk

### Decision-Based

- Architect requests ADR approval
- PM requests scope expansion
- Multiple valid technical options require business decision

## Activation Conditions

### Required For

- **PRD Approval** - All PRDs require CEO sign-off
- **ADR Approval** - Major architectural decisions
- **Release Authorization** - Production deployments
- **Scope Changes** - Any change to agreed scope

### Optional For

- Strategic consultation
- Risk assessment
- Timeline negotiation

## Trigger Examples

### Example 1: PRD Review

```
PM: "PRD draft ready for review"
CEO: Reviews PRD, checks business alignment, approves with comments
```

### Example 2: Scope Change

```
Architect: "Feature X requires 2 extra weeks"
CEO: Evaluates business impact, consults user, approves timeline change
```

### Example 3: Critical Blocker

```
QA: "Security vulnerability blocks release"
CEO: Authorizes emergency fix, adjusts timeline, communicates to user
```
