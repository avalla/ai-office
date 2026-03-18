---
trigger: when_referenced
---
# QA Engineer Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/50_qa_validate` | Run QA validation workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| Implementation complete | Run tests |
| Pre-release | Full QA validation |
| Bug report | Investigate and verify |
| Regression check | Run regression suite |

## Secondary Triggers

### Context-Based

- Developer submits code for review
- Reviewer approves merge
- Release Manager prepares deployment
- User reports bug

### Escalation-Based

- Security Specialist finds vulnerability
- Performance issues detected
- Accessibility issues found
- User experience problems reported

## Activation Conditions

### Required For

- **Pre-release Validation** - All releases require QA clearance
- **Feature Acceptance** - All features need QA sign-off
- **Bug Verification** - All bug fixes need QA verification

### Optional For

- Architecture design (consulted for testability)
- PRD review (consulted for testable requirements)
- Code review (spot-check for test coverage)

## Trigger Examples

### Example 1: Implementation Complete

```
Developer: "Feature X implementation ready"
QA: Runs test suite, validates acceptance criteria, reports results
```

### Example 2: Pre-release

```
Release Manager: "Preparing release v1.2.0"
QA: Runs full validation suite, provides clearance or blocks
```

### Example 3: Bug Report

```
User: "App crashes when clicking button Y"
QA: Reproduces bug, verifies fix, confirms resolution
```
