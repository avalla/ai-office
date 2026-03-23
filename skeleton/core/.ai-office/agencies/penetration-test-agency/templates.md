---
agency: penetration-test-agency
---

# Penetration Test Agency Templates

## Engagement Scope Template

```markdown
# Penetration Test Scope: [Engagement Name]

## Objectives
- Objective 1
- Objective 2

## In-Scope Targets
- Target 1
- Target 2

## Out-of-Scope Targets
- Target A
- Target B

## Rules of Engagement
- Testing window:
- Allowed techniques:
- Prohibited techniques:
- Data handling constraints:

## Access Model
- Accounts/roles provided
- Environments (staging/prod)

## Success Criteria
- [ ] All in-scope targets assessed
- [ ] Findings reproduced with evidence
- [ ] Executive summary delivered
```

## Finding Template

```markdown
# Finding: [ID] [Title]

## Severity
Critical | High | Medium | Low | Info

## Affected Asset
Service/component/endpoint

## Description
Clear description of the vulnerability.

## Impact
Business and technical impact.

## Reproduction Steps
1. Step 1
2. Step 2

## Evidence
- Screenshot/log/HTTP transcript references

## Root Cause
Why the issue exists.

## Remediation
Concrete fix guidance.

## Retest Status
Open | Fixed | Partially Fixed | Risk Accepted
```

## Retest Report Template

```markdown
# Retest Report: [Engagement Name]

## Retest Scope
Which findings were retested.

## Results Summary
| Finding ID | Previous Severity | Current Status | Notes |
|------------|-------------------|----------------|-------|
| F-001 | High | Fixed | Verified in build XYZ |

## Remaining Risks
- Residual risk 1

## Recommendation
Release decision and follow-up actions.
```

## Executive Security Summary Template

```markdown
# Executive Security Summary: [Engagement Name]

## Overall Risk Posture
Green | Yellow | Red

## Top Risks
1. Risk 1
2. Risk 2
3. Risk 3

## Remediation Progress
- Fixed: X
- Remaining: Y

## Release Recommendation
Go | Conditional Go | No-Go

## Required Follow-up
- Action 1 (Owner, ETA)
- Action 2 (Owner, ETA)
```

---

Updated: 2026-03-09
