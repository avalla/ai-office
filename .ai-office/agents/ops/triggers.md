---
trigger: when_referenced
---
# Ops Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/90_postmortem_memory` | Run postmortem and memory update |

### Workflow Events

| Event | Action |
|-------|--------|
| Release complete | Conduct postmortem |
| Incident resolved | Analyze and document |
| Process failure | Analyze and improve |
| Pattern identified | Document as guideline |

## Secondary Triggers

### Context-Based

- Release Manager completes release
- Developer reports recurring issue
- QA identifies quality trend
- User feedback pattern

### Escalation-Based

- Critical incident
- Process breakdown
- Knowledge gap identified
- Improvement opportunity

## Activation Conditions

### Required For

- **Postmortem** - All releases require postmortem
- **Incident Analysis** - All incidents require analysis
- **Process Documentation** - All process changes need documentation

### Optional For

- Architecture review (process implications)
- PRD review (process requirements)
- ADR review (operational implications)

## Trigger Examples

### Example 1: Release Complete

```
Release Manager: "Release v1.2.0 deployed successfully"
Ops: Conducts postmortem, documents learnings, updates memory
```

### Example 2: Incident

```
System: "Production outage for 30 minutes"
Ops: Analyzes incident, documents timeline, proposes prevention
```

### Example 3: Pattern Identified

```
Developer: "Same bug type occurred 3 times this month"
Ops: Analyzes pattern, documents guideline, shares knowledge
```
