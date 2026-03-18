---
trigger: when_referenced
---
# Developer Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/40_dev_implement` | Begin implementation workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| Tasks ready for implementation | Begin coding |
| Bug report | Investigate and fix |
| Code review feedback | Address and update |
| Architecture defined | Implement according to ADR |

## Secondary Triggers

### Context-Based

- Task moved to WIP
- Architect provides technical guidance
- QA reports test failure
- Reviewer requests changes

### Escalation-Based

- Architect reports architecture violation
- Security Specialist reports vulnerability
- QA reports critical bug
- User reports production issue

## Activation Conditions

### Required For

- **Feature Implementation** - All coding tasks
- **Bug Fixes** - All bug fixes
- **Refactoring** - Code quality improvements
- **Technical Debt** - Debt reduction tasks

### Optional For

- Architecture discussions (consulted for feasibility)
- PRD review (consulted for technical implications)
- Release planning (consulted for implementation status)

## Trigger Examples

### Example 1: Task Ready

```
Planner: Task "Add user authentication" moved to WIP
Developer: Implements authentication according to ADR
```

### Example 2: Bug Report

```
QA: "Login fails with special characters in password"
Developer: Investigates, writes test, fixes bug, submits for review
```

### Example 3: Review Feedback

```
Reviewer: "This function is too complex, suggest breaking it down"
Developer: Refactors function, updates tests, resubmits
```
