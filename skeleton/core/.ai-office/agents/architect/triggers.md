---
trigger: when_referenced
---
# Architect Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/20_arch_adr` | Create Architecture Decision Record |

### Workflow Events

| Event | Action |
|-------|--------|
| PRD approved | Design system architecture |
| Technical decision needed | Create ADR |
| Performance issues | Analyze and propose solutions |
| Security vulnerability | Redesign affected components |

## Secondary Triggers

### Context-Based

- Developer needs technical guidance
- PM needs feasibility assessment
- Security Specialist needs architecture input
- New technology evaluation required

### Escalation-Based

- Developer reports implementation blocker
- QA reports performance issues
- Security Specialist reports architecture flaw
- Release Manager reports deployment complexity

## Activation Conditions

### Required For

- **ADR Creation** - All major technical decisions
- **System Design** - New projects and major features
- **Technology Selection** - New dependencies and platforms

### Optional For

- Code review (consulted for architecture alignment)
- Testing strategy (consulted for testability)
- Release planning (consulted for deployment architecture)

## Trigger Examples

### Example 1: PRD Approved

```
CEO: Approves PRD for task management app
Architect: Designs system architecture, creates ADR for tech stack
```

### Example 2: Technical Decision

```
Developer: "Should we use PostgreSQL or MongoDB?"
Architect: Evaluates options, creates ADR with recommendation
```

### Example 3: Performance Issue

```
QA: "Dashboard loads in 5 seconds"
Architect: Analyzes architecture, proposes caching strategy
```
