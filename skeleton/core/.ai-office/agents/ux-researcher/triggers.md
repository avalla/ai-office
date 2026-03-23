---
trigger: when_referenced
---
# UX Researcher Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/22_ux_research` | UX research workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| PRD approved | Research user needs |
| Design phase | Validate design decisions |
| Feature release | Usability testing |
| User feedback | Analyze and synthesize |

## Secondary Triggers

### Context-Based

- PM needs user validation
- Designer needs user insights
- QA reports usability issues
- User feedback received

### Escalation-Based

- User complaints about UX
- Low task completion rates
- High support tickets for feature
- Accessibility issues reported

## Activation Conditions

### Required For

- **New Features** - User research for new functionality
- **Major Redesigns** - Usability testing before implementation
- **User Pain Points** - Research to identify root causes

### Optional For

- PRD review (user perspective)
- Design review (usability validation)
- Release review (user impact)

## Trigger Examples

### Example 1: PRD Approved

```
CEO: Approves PRD for checkout flow
UX Researcher: Conducts user interviews, maps user journey, provides insights
```

### Example 2: Design Validation

```
Designer: "Here's the new navigation design"
UX Researcher: Conducts usability testing, reports findings
```

### Example 3: User Feedback

```
Support: "Users can't find the export button"
UX Researcher: Investigates navigation patterns, recommends improvements
```
