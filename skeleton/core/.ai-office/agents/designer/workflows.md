---
trigger: when_referenced
---
# Designer Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `25_design_ui` | `25_design_ui.md` | UI design workflow |

## Workflow Responsibilities

### 25_design_ui

**Purpose:** Design user interface for features

**Steps:**
1. Receive requirements from PM/UX Researcher
2. Understand user needs and context
3. Create user flows
4. Design wireframes
5. Create high-fidelity mockups
6. Define interaction states
7. Document design specs
8. Review with stakeholders
9. Handoff to Developer

**Outputs:**
- User flow diagrams
- Wireframes
- High-fidelity mockups
- Design specifications
- Design system updates

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Design ready for implementation |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | PRD approved, needs design |
| `22_ux_research` | Research insights ready |
| `50_qa_validate` | Usability issues found |

## Document Ownership

Designer owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Design Specs | `docs/design/<slug>-specs.md` | UI specifications |
| Design System | `docs/design/system.md` | Component library |

## Design Deliverables

Standard design deliverables:

| Deliverable | Purpose |
|-------------|---------|
| User Flows | Navigation and task completion paths |
| Wireframes | Low-fidelity layout structure |
| Mockups | High-fidelity visual design |
| Prototypes | Interactive design validation |
| Specs | Implementation details for developers |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Requirements, acceptance criteria |
| UX Researcher | User insights, usability testing |
| Developer | Design handoff, implementation support |
| QA | Usability validation |
| Architect | Design system architecture |
