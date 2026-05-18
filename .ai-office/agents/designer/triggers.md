---
trigger: when_referenced
---
# Designer Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/25_design_ui` | UI design workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| PRD approved | Design user flows and UI |
| UX research complete | Design based on insights |
| Feature request | Design UI components |
| Design system update | Extend design system |

## Secondary Triggers

### Context-Based

- PM provides user stories
- UX Researcher provides insights
- Developer needs design specs
- QA reports usability issues

### Escalation-Based

- User reports UX issues
- Accessibility compliance needed
- Design inconsistency detected
- Brand guideline violation

## Activation Conditions

### Required For

- **New Features** - All user-facing features need design
- **Design System Updates** - Component library changes
- **Accessibility Fixes** - WCAG compliance design

### Optional For

- PRD review (design feasibility)
- Architecture review (design implications)
- Bug fixes (UI-related only)

## Trigger Examples

### Example 1: PRD Approved

```
CEO: Approves PRD for user dashboard
Designer: Creates user flows, wireframes, and high-fidelity mockups
```

### Example 2: UX Research Complete

```
UX Researcher: "Users struggle with navigation"
Designer: Redesigns navigation based on research insights
```

### Example 3: Accessibility Issue

```
QA: "Color contrast fails WCAG AA"
Designer: Adjusts color palette, updates design system
```
